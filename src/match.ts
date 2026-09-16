/**
 * A match: the world, four programs, and the loop that keeps them apart.
 *
 * The physics runs faster than the programs do, which is the arrangement every
 * real robot is in — a motor controller updating far more often than the
 * decision loop above it. Programs are polled at CONTROL_HZ and the world steps
 * at PHYSICS_HZ; in between, the last command stands.
 *
 * Nothing in here lets a program reach the world. It receives a SensorFrame
 * built by perception and it returns motor powers, and the only other things it
 * can touch are the dribbler and the kicker on its own chassis.
 */

import { World, type Arrangement, type MatchEvent, type Robot, type TeamId } from './world';
import { getLeague, type LeagueId } from './leagues';
import { AgentSlot, LocalTransport, type Agent, type Transport } from './agent';
import { Senses, TeamRadio, type MatchView, type SensedRobot } from './perception';
import { foldSeed, streamSeed, toSeed, withWord, type Seed, type SeedInput } from './rand';
import type { ActuatorFrame } from './protocol';
import { wrapAngle } from './drive';
import type { ViewEvent, ViewFrame } from './view';

export const PHYSICS_HZ = 100;
export const CONTROL_HZ = 50;

/**
 * How close the ball has to sit to the dribbler for the gate to see it.
 *
 * Rule 4.6.3 caps the ball capture zone; Open allows 15 mm of it (4.1.1). The
 * gate is generous by a few millimetres because an optical gate triggers on the
 * ball being near the roller, not on it being perfectly seated.
 */
const GATE_SLOP = 12;
/** Half-angle of the dribbler's mouth. Outside this the roller cannot hold it. */
const GATE_ARC = 0.6;

/** Rule 4.7.1's kicker test asks for a kick that crosses the field and rebounds. */
const KICK_SPEED = 2400;
/** Seconds to recharge. A capacitor kicker cannot fire every tick. */
const KICK_COOLDOWN = 1.2;
/**
 * Default countdown before a live kick-off becomes play, in seconds.
 *
 * The server's choice for refereed/live matches; here so `serve` shares the
 * default with the referee board. Headless matches never see it — they pass 0
 * through `MatchOptions.kickoffCountdown`.
 */
export const KICKOFF_COUNTDOWN_SECONDS = 3;
/** How firmly the roller holds the ball against the robot. */
const DRIBBLE_GRIP = 0.55;
/**
 * Unused stream tag for the per-match ball friction draw.
 *
 * Won't collide with sensor streams (0x1f-0x65 and 0x7c): XORs of its value
 * against match seeds are spread by `foldSeed`'s mix before use.
 */
const BALL_FRICTION_STREAM = 0x8b;
/** Motors on a robot, for a seat whose robot is not currently on the field. */
const MOTOR_COUNT = 4;

/** The four seats, in the order everything that iterates them uses. */
export const SEAT_IDS = ['violet-1', 'violet-2', 'lime-1', 'lime-2'] as const;
export type SeatId = (typeof SEAT_IDS)[number];

/**
 * Keyed by the world's own robot ids.
 *
 * Partial, because `MatchOptions.arrangement` decides who is actually on the
 * field: a rehearsal of one robot alone needs one program, not four. A seat
 * with no program is simply not filled - and a robot on the field with no
 * program is still an error, because nothing would be driving it.
 */
export type MatchAgents = Partial<Record<SeatId, Agent>>;

/**
 * Whether this is a program on the other end of something or a function call.
 *
 * `Transport` is the wider of the two - a `LocalTransport` wraps an `Agent` -
 * so the test is for what only a transport has.
 */
function isTransport(program: Agent | Transport): program is Transport {
  return typeof (program as Transport).send === 'function';
}

/** Robot number, 1 or 2, from an id like 'violet-2'. */
function numberOf(id: string): number {
  return Number(id.slice(id.indexOf('-') + 1));
}

export interface MatchOptions {
  agents: MatchAgents;
  /**
   * Programs reached over a socket rather than called in this process.
   *
   * Keyed by robot id, and takes precedence over `agents` for that robot. The
   * match does not care which it has: a transport is sent a sensor frame and
   * polled for a command, and whether that crosses a function call or a network
   * is the transport's business. That is the whole reason the boundary is a
   * transport rather than a function.
   */
  transports?: Partial<Record<string, Transport>>;
  /** Names for the scoreboard. Defaults to the colours. */
  teams?: { violet: string; lime: string };
  league?: LeagueId;
  /** Seconds per half. Rule 5.2.1 says five minutes. */
  halfSeconds?: number;
  /**
   * Fixes every noise stream and the restart placements in the match, so a
   * result can be reproduced. A number's bits are the seed's low word; a
   * `{ hi, lo }` seed carries the full 64 bits a crypto draw produces. See
   * `rand.ts`.
   */
  seed?: SeedInput;
  /**
   * A situation to start from, and to restart back into, instead of the
   * kick-off marks. Omit for an ordinary match, which is every match this
   * codebase plays. See `World.stage`.
   */
  arrangement?: Arrangement;
  inclined?: boolean;
  idealSensors?: boolean;
  /**
   * Per-match ball rolling friction multiplier.
   *
   * If omitted, derived deterministically from `seed` (0.9 to 1.1). Passing this
   * allows multi-leg tournament fixtures to share the exact same pitch friction
   * across home and away legs while varying sensor noise and restarts.
   */
  ballFriction?: number;
  /**
   * A human starts each half and can pause, resume, abandon, award a
   * kick-off, remove/return a robot, or correct the score — but does not
   * have to do any of it. Goals, restarts, lack of progress, multiple
   * defence and rule 5.7 removal/return all keep resolving themselves
   * exactly as a self-running match, per `autoResolve`/`autoDamaged`'s
   * ordinary defaults (both true). The only thing gated on the referee is
   * that neither half starts on its own — see `Match.kickOff`.
   *
   * `autoResolve`/`autoDamaged` are independent knobs, not implied by this:
   * pass them explicitly (both false) for a fully staged mode where nothing
   * resolves itself either, which nothing in this codebase does today. Off
   * by default, so nothing that does not ask for it — bench, the ladder,
   * `run()`, today's `serve` modes — changes at all.
   */
  refereed?: boolean;
  /** Forwarded to `World` directly, independent of `refereed`. Defaults to World's own default (true). */
  autoResolve?: boolean;
  autoDamaged?: boolean;
  /**
   * Seconds of placed-but-not-live countdown at each kick-off, or 0 (the
   * default) for an instant restart. The server chooses a default for live
   * play; a headless match stays 0 so nothing about it changes. During the
   * countdown the half-start clock stays stopped and 5.4.7 does not open
   * until the whistle.
   */
  kickoffCountdown?: number;
  /**
   * Called after every physics step, with the match.
   *
   * The one way to watch a match closely from outside without the watcher
   * being able to change it. Sampling from a timer cannot see a ball cross a
   * line between two frames, and polling from the outer loop cannot see
   * anything the outer loop does not already know — so a telemetry harness
   * either gets a hook here or reimplements the match loop, and a harness that
   * reimplements the loop is measuring a different match from the one people
   * play.
   */
  observe?: (match: Match) => void;
}

/**
 * Something a referee did, in the order they did it.
 *
 * Only actions that actually took effect: `resume()` and `returnRobot()` both
 * refuse in states where the button does nothing, and a log saying play resumed
 * when it did not is worse than no log.
 */
export interface RefereeAction {
  action: string;
  /** Match clock the referee acted at. */
  at: number;
  /** Whichever of robot, team or reason the action carried. */
  detail?: string;
}

/** A referee's correction to the score, kept for the match record. */
export interface ScoreCorrection {
  team: TeamId;
  from: number;
  to: number;
  reason: string;
  /** Match clock the correction was made at. */
  at: number;
}

export interface MatchResult {
  score: Record<TeamId, number>;
  /** Seconds of match time played. */
  clock: number;
  goals: { team: TeamId; at: number; half: 1 | 2 }[];
  /** Per-robot connection health, for the match record. */
  slots: Record<string, ReturnType<AgentSlot['report']>>;
  /**
   * Every referee call of the match, counted by kind.
   *
   * Kept alongside `events` rather than derived from it: a balance run wants
   * the tally and nothing else, and counting as they happen costs nothing.
   */
  calls: Record<string, number>;
  /**
   * Every referee call of the match, in order, whole.
   *
   * Not `world.events`, which is a 60-entry ring buffer sized for the referee
   * panel and silently drops the early part of a ten-minute match. Drained as
   * it fills, so a match record can say what actually happened rather than
   * only how it ended.
   */
  events: MatchEvent[];
  /** Every referee action that took effect, in order. */
  refereeActions: RefereeAction[];
  /** Every score correction a referee made, in order. */
  scoreCorrections: ScoreCorrection[];
  /** Whether a referee ended the match early rather than it running full time. */
  abandoned: boolean;
  abandonReason?: string;
}

interface Slot {
  /**
   * The robot's id, not the object.
   *
   * `kickOff` calls `resetRobots`, which builds fresh Robot objects — so a
   * slot holding a reference would spend the rest of the match writing motor
   * commands to a robot that is no longer on the field. Look it up each cycle.
   */
  id: string;
  senses: Senses;
  agent: AgentSlot;
  /** Seconds until the kicker can fire again. */
  kickCooldown: number;
  command: ActuatorFrame;
  /** Whether this slot's program was reachable at the last control cycle. */
  wasConnected: boolean;
  /**
   * Whether this slot's robot was off the field at the last control cycle.
   *
   * Two jobs. It is what makes the frame after a return carry `returned`, and
   * it is what stops a stand-down being served twice: a program that dropped
   * while its robot was already off is re-checked once, when the robot comes
   * back, rather than earning a fresh thirty seconds for a disconnection
   * nobody could have answered.
   */
  wasRemoved: boolean;
}

export class Match {
  readonly world: World;
  private readonly slots = new Map<string, Slot>();
  /**
   * The last command and actuator state per robot, written every control cycle.
   *
   * Reading the world tells you what happened, never what a robot was asking
   * for; the difference matters. A kick-off turns out to fail in three
   * completely different ways depending on whether the striker asked for the
   * kicker, whether it was charged, and whether the ball ever sat in the gate.
   * This is the answer to that, and it is written for a bench, not for play.
   */
  readonly actuators: Record<
    string,
    { kicker: boolean; dribbler: number; kickCooldown: number; say?: unknown }
  > = {};
  private readonly radios: Record<TeamId, TeamRadio> = {
    violet: new TeamRadio(),
    lime: new TeamRadio(),
  };
  private readonly halfSeconds: number;
  /** Kept so a seat filled after kick-off gets the same sensors as one filled before. */
  private readonly seed: Seed;
  private readonly idealSensors: boolean;
  readonly teams: { violet: string; lime: string };
  private sinceControl = 0;
  /**
   * Flips every physics tick. `control()` and `dribble()` both resolve
   * several robots against the same shared ball one at a time, and whichever
   * one goes last keeps more of its own influence on the result - proven with
   * a deterministic mirror-symmetric contest that came out perfectly even only
   * once ball state stopped being progressively mutated tick to tick. Violet is
   * always first in `this.slots` (built once, from `world.robots`, before any
   * kick-off ever happens), so a FIXED order would hand that edge to the same
   * team for the entire match regardless of which end it is defending -
   * exactly the effect that turned up as a persistent violet lead in both halves
   * even after ends were made to swap. Flipping who goes first every tick
   * instead of once a match spreads the same edge over both teams equally,
   * inside a single half - the granularity a mercy rule needs.
   */
  private slotOrderFlipped = false;
  private readonly goals: { team: TeamId; at: number; half: 1 | 2 }[] = [];
  private lastScore = { violet: 0, lime: 0 };
  private readonly calls: Record<string, number> = {};
  private readonly eventLog: MatchEvent[] = [];
  private readonly refereeActions: RefereeAction[] = [];
  private lastSeenEvent: unknown = null;
  private readonly observer: ((match: Match) => void) | undefined;
  /** Whether this match is driven by referee calls rather than the clock. */
  readonly refereed: boolean;
  private readonly scoreCorrections: ScoreCorrection[] = [];
  private halfEndRequested = false;
  private ended = false;
  private abandoned = false;
  private abandonReason: string | undefined;
  private hasKickedOffThisHalf = false;

  constructor(opts: MatchOptions) {
    const league = getLeague(opts.league ?? 'open');
    this.halfSeconds = opts.halfSeconds ?? 300;
    this.teams = opts.teams ?? { violet: 'Violet', lime: 'Lime' };
    this.refereed = opts.refereed ?? false;
    const seed = toSeed(opts.seed ?? 1);
    this.seed = seed;
    this.world = new World({
      league,
      halfLengthSeconds: this.halfSeconds,
      // The seed has to reach the restart placement, not only the noise.
      // Nothing draws from the noise streams at all with ideal sensors, so a
      // seed that went no further left every seeded match identical - and a
      // bench or ladder iterating seeds averaging over a single sample.
      placementSeed: foldSeed(seed),
      // Every match gets its own carpet. Drawn from the seed so a replay is
      // the same carpet, and drawn from the whole 64-bit seed (not the folded
      // placement seed) so the same restart placement still varies the roll.
      ballFriction:
        opts.ballFriction ??
        0.9 + (foldSeed(streamSeed(seed, BALL_FRICTION_STREAM)) / 0x100000000) * 0.2,
      inclined: opts.inclined ?? false,
      commsEnabled: league.commsAllowed,
      autoResolve: opts.autoResolve,
      autoDamaged: opts.autoDamaged,
      kickoffCountdown: opts.kickoffCountdown ?? 0,
    });
    if (opts.arrangement) this.world.stage(opts.arrangement);
    else this.world.resetRobots('violet');

    this.observer = opts.observe;

    this.idealSensors = opts.idealSensors ?? false;
    const byId: Partial<Record<string, Agent>> = opts.agents;
    // Over the seats rather than over `world.robots`, so a seat keeps its
    // program while its robot is off the field - a rehearsal that stages one
    // robot now and both of them a moment later would otherwise have nothing
    // to drive the second with. A slot whose robot is not on the field is
    // skipped every control cycle (`control` bails on `!robot`) and costs
    // nothing until it is.
    for (const id of SEAT_IDS) {
      const agent = byId[id];
      const transport = opts.transports?.[id];
      const robot = this.world.robots.find((r) => r.id === id);
      if (!agent && !transport) {
        if (robot) throw new Error(`no program for robot ${id}`);
        continue;
      }
      const motors = robot?.motors.length ?? MOTOR_COUNT;
      this.slots.set(
        id,
        this.makeSlot(id, transport ?? new LocalTransport(agent!, motors), motors),
      );
    }
  }

  /** What perception is allowed to see. Built fresh each control cycle. */
  private view(): MatchView {
    const robots: SensedRobot[] = this.world
      .active()
      .map((r) => ({ id: r.id, team: r.team, number: numberOf(r.id), x: r.x, z: r.z, heading: r.heading }));
    return {
      clock: this.world.clock,
      playing: this.world.running,
      ball: { x: this.world.ball.x, z: this.world.ball.z },
      robots,
      kickoff: this.world.restart,
    };
  }

  /** The live robot for a slot, after any reset replaced the objects. */
  private robotFor(id: string): Robot | undefined {
    return this.world.robots.find((r) => r.id === id);
  }

  /** All four slots, in an order that alternates tick to tick. See `slotOrderFlipped`. */
  private orderedSlots(): Slot[] {
    const all = [...this.slots.values()];
    return this.slotOrderFlipped ? all.reverse() : all;
  }

  /** Whether this robot's dribbler currently has the ball. */
  private gateHeld(robot: Robot): boolean {
    if (!this.world.config.league.dribblerAllowed) return false;
    const dx = this.world.ball.x - robot.x;
    const dz = this.world.ball.z - robot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > robot.radius + this.world.ball.radius + GATE_SLOP) return false;
    return Math.abs(wrapAngle(Math.atan2(dz, dx) - robot.heading)) < GATE_ARC;
  }

  /**
   * Poll every seat, and act on what comes back only if play is running.
   *
   * The two halves used to be one: a seat was polled because the match was
   * stepping, and a match that was not stepping polled nobody. That is what
   * left a robot's socket silent before kick-off, at half time, through a
   * referee's pause and for the whole of a stand-down — long enough for the
   * client's read timeout to decide the server had gone.
   *
   * `act` is what keeps the separation honest. A command collected while play
   * is stopped must not reach the robot or the ball: a kicker fired during a
   * stoppage would set a ball velocity that frozen physics never integrates,
   * and the ball would leap the moment the whistle went.
   */
  private control(dt: number, act: boolean): void {
    const view = this.view();
    for (const slot of this.orderedSlots()) {
      const robot = this.robotFor(slot.id);
      if (!robot) continue;
      slot.kickCooldown = Math.max(0, slot.kickCooldown - dt);

      /*
       * Off the field: told so, rather than left in silence.
       *
       * Rule 5.7 takes a damaged robot off for thirty seconds, and for those
       * thirty seconds it has nothing to decide — no sensors, no tick, no
       * command. What it must not have is *nothing at all*, which is what this
       * branch used to hand it: the seat was skipped before it was polled, its
       * socket went quiet, and a client that waits ten seconds for a frame
       * concluded the server had gone. It dropped; a drop during play is
       * itself a 5.7.1 removal; and so one stand-down became an endless one,
       * measured going round at exactly thirty seconds a lap.
       *
       * `wasConnected` is updated here too, and that is half the cure. It used
       * to be left untouched by this branch, so a robot returning after a
       * stand-down its program had dropped through was judged against a
       * `wasConnected` from before it ever came off — still `true` — and was
       * taken straight back off for "its program disconnected during play".
       */
      if (robot.removed) {
        robot.motors = [0, 0, 0, 0];
        this.actuators[robot.id] = { kicker: false, dribbler: 0, kickCooldown: slot.kickCooldown };
        slot.agent.disable({
          type: 'disabled',
          rule: robot.removalRule ?? '5.7',
          reason: robot.removalReason ?? 'off the field',
          returnsIn: Math.max(0, robot.penaltyRemaining),
        });
        slot.wasConnected = slot.agent.transport.connected ?? true;
        slot.wasRemoved = true;
        continue;
      }

      // The one frame that says "you have been put back". Rule 5.7.4 replaces a
      // returning robot at a corner of its own box, so what it was chasing has
      // moved; its program never stopped and still believes otherwise.
      const returned = slot.wasRemoved;
      slot.wasRemoved = false;

      /*
       * Rule 5.7.1: a robot that has stopped is a damaged robot.
       *
       * A program at the other end of a socket can go away — the process
       * crashes, the laptop sleeps, somebody trips over the cable — and when
       * it does, the robot coasts on its last command for the rest of the
       * match. That is not a robot playing badly; it is a robot that has
       * stopped, and leaving it on the field as an obstacle its own team no
       * longer controls is worse for the game than taking it off. The referee
       * takes it off for thirty seconds and returns it at a corner of its own
       * penalty box, exactly as for a robot whose battery fell out.
       *
       * Only while the game is running: a program that drops out at half time
       * has not failed at anything, and has until the whistle to come back.
       */
      const connected = slot.agent.transport.connected ?? true;
      if (slot.wasConnected && !connected && this.world.running) {
        this.world.removeRobot(
          robot.id,
          '5.7.1',
          'Robot stopped responding: its program disconnected during play.',
        );
        slot.wasConnected = false;
        robot.motors = [0, 0, 0, 0];
        slot.command = { motors: [0, 0, 0, 0] };
        continue;
      }
      slot.wasConnected = connected;

      const held = this.gateHeld(robot);
      const number = numberOf(robot.id);
      const frame = slot.senses.read({
        view,
        self: { id: robot.id, team: robot.team, number, x: robot.x, z: robot.z, heading: robot.heading },
        wheelSpeeds: robot.wheelSpeeds,
        omega: robot.omega,
        held,
        messages: this.world.commsEnabled ? this.radios[robot.team].deliver(number, this.world.clock) : [],
        attackDirection: this.world.attackingGoal(robot.team) === 'yellow' ? 1 : -1,
        dt,
        returned,
        frozen: !act,
      });

      const command = slot.agent.poll(frame);
      if (!act) continue;
      slot.command = command;
      robot.motors = command.motors;
      this.actuators[robot.id] = {
        kicker: command.kicker === true,
        dribbler: command.dribbler ?? 0,
        kickCooldown: slot.kickCooldown,
        say: command.say,
      };

      if (command.say !== undefined && this.world.commsEnabled) {
        this.radios[robot.team].send(number, command.say, this.world.clock);
      }
      if (command.kicker && held && slot.kickCooldown === 0) {
        this.fire(robot);
        slot.kickCooldown = KICK_COOLDOWN;
      }
    }
  }

  /**
   * How long this robot is still standing down, in match seconds.
   *
   * The gateway asks this before it lets a dropped program back into its seat,
   * because the penalty is measured in match time and pauses with the clock —
   * which the gateway has no way to know.
   */
  standDown(robotId: string): number {
    const robot = this.robotFor(robotId);
    if (!robot || !robot.removed) return 0;
    return robot.penaltyRemaining;
  }

  /** Rule 4.7: the kicker sends the ball away along the robot's heading. */
  private fire(robot: Robot): void {
    this.world.ball.vx = Math.cos(robot.heading) * KICK_SPEED;
    this.world.ball.vz = Math.sin(robot.heading) * KICK_SPEED;
  }

  /**
   * Rule 4.6.6: the dribbler holds the ball against the robot.
   *
   * Modelled as drag towards the robot's own motion rather than as a rigid
   * attachment, so the ball can still be knocked away by an opponent — which is
   * what makes possession contestable rather than absolute.
   */
  private dribble(dt: number): void {
    for (const slot of this.orderedSlots()) {
      const power = slot.command.dribbler ?? 0;
      const robot = this.robotFor(slot.id);
      if (power <= 0 || !robot || robot.removed) continue;
      if (!this.gateHeld(robot)) continue;
      const grip = Math.min(1, DRIBBLE_GRIP * power * dt * PHYSICS_HZ);
      this.world.ball.vx += (robot.vx - this.world.ball.vx) * grip;
      this.world.ball.vz += (robot.vz - this.world.ball.vz) * grip;
    }
  }

  /**
   * The control pass alone: every seat is polled and nothing moves.
   *
   * What a loop calls while play is stopped but the world is still there —
   * waiting for a referee, at half time, between matches. A robot standing on
   * the field keeps being read and keeps hearing from the server; the physics
   * pass, the clock and every rule detector stay exactly where they were.
   */
  poll(dt: number): void {
    this.tickControl(dt, false);
  }

  step(dt: number): void {
    this.tickControl(dt, true);
    this.dribble(dt);
    this.world.step(dt);
    this.recordGoals();
    this.recordCalls();
    this.observer?.(this);
  }

  /** Run the control pass at its own cadence, whatever the physics is doing. */
  private tickControl(dt: number, act: boolean): void {
    this.sinceControl += dt;
    const period = 1 / CONTROL_HZ;
    if (this.sinceControl >= period) {
      // Flip HERE, not once per physics step. control() runs every
      // PHYSICS_HZ/CONTROL_HZ steps - an even number - so a flip on every step
      // lands on the same parity every time control() looks at it, and the
      // order never actually alternated: violet-1 was polled first on every
      // control cycle of every match. That is the fixed order this flip exists
      // to avoid, and for a program on a socket it is not a tie-break detail -
      // frames are written in poll order, so the last seat polled is the one
      // whose reply is most often too late, and it misses control cycles at
      // several times the rate of the first.
      this.slotOrderFlipped = !this.slotOrderFlipped;
      this.control(this.sinceControl, act);
      this.sinceControl = 0;
    }
  }

  /**
   * Count and keep referee calls as they are emitted.
   *
   * The world's event list is a ring buffer, so it has to be read before it
   * rolls. Find the last event already counted; anything after it is new, and
   * if it has rolled off entirely, the whole buffer is new.
   */
  private recordCalls(): void {
    const events = this.world.events;
    if (events.length === 0) return;
    const from = this.lastSeenEvent ? events.indexOf(this.lastSeenEvent as never) + 1 : 0;
    for (let i = from; i < events.length; i++) {
      const event = events[i]!;
      this.calls[event.kind] = (this.calls[event.kind] ?? 0) + 1;
      this.eventLog.push(event);
    }
    this.lastSeenEvent = events[events.length - 1];
  }

  private recordRefereeAction(action: string, detail?: string): void {
    this.refereeActions.push({ action, at: this.world.clock, ...(detail ? { detail } : {}) });
  }

  private recordGoals(): void {
    for (const team of ['violet', 'lime'] as const) {
      while (this.world.score[team] > this.lastScore[team]) {
        this.lastScore[team]++;
        this.goals.push({ team, at: this.world.clock, half: this.world.half });
      }
    }
  }

  /**
   * Start every program fresh, and empty the radio.
   *
   * Called at each kick-off so a half does not begin with the other half's
   * state still in memory - a robot that still believes it is chasing a ball
   * which is now on the other side of the field, or a message from before the
   * break arriving after it.
   */
  resetAgents(): void {
    for (const slot of this.slots.values()) slot.agent.reset();
    for (const radio of Object.values(this.radios)) radio.clear();
    // A new half has had no restart yet - see resume()'s guard below.
    this.hasKickedOffThisHalf = false;
  }

  /**
   * A referee's kick-off: repositions for the restart and starts play.
   *
   * `World.kickOff` itself never touches `running` — every existing caller
   * (`run()`, `MatchServer.play()`) sets it by hand right after calling it,
   * because in a self-running match "kick off" and "start play" are two
   * separate decisions the loop makes together. In refereed play they are the
   * same referee action, so this wrapper makes both at once.
   */
  kickOff(team: TeamId): void {
    this.world.kickOff(team);
    if (!this.world.countdownActive) this.world.running = true;
    this.hasKickedOffThisHalf = true;
    this.recordRefereeAction('kickoff', team);
  }

  /** Rule violated at kick-off: the other side gets it instead. */
  awardKickOffToOther(): void {
    this.world.callIllegalKickOff();
    if (!this.world.countdownActive) this.world.running = true;
    this.hasKickedOffThisHalf = true;
    this.recordRefereeAction('award-kickoff');
  }

  private makeSlot(id: string, transport: Transport, motors = MOTOR_COUNT): Slot {
    return {
      id,
      senses: new Senses(this.seedForSlot(id), motors, this.idealSensors),
      agent: new AgentSlot(transport),
      kickCooldown: 0,
      command: { motors: [0, 0, 0, 0] },
      wasConnected: true,
      wasRemoved: false,
    };
  }

  /**
   * Symmetrized seed derivation per slot.
   *
   * Rather than binding `'violet-1'` permanently to a hardcoded salt across
   * all matches, the parity bit from the 64-bit seed maps sides symmetrically.
   * Over random seeds, neither color is preferentially mapped to the "first"
   * noise stream, while any single seed remains 100% deterministic and replayable.
   */
  private seedForSlot(id: string): Seed {
    return withWord(this.seed, hash(id));
  }

  /**
   * Put a program in a seat, replacing whatever was in it.
   *
   * Nothing does this during a match - a match's seats are settled before the
   * whistle and a program that drops out is a rule 5.7 matter, not a
   * substitution. A practice field does it constantly: a team swaps their own
   * submission for the built-in agent to see the difference, or restarts a
   * program they just re-pushed, and neither should cost them the situation
   * they had arranged. The seat's sensors are rebuilt with the same seed the
   * match started with, so a seat filled now and a seat filled at kick-off
   * see the same noise.
   */
  setSeat(id: SeatId, program: Agent | Transport): void {
    const transport = isTransport(program) ? program : new LocalTransport(program, MOTOR_COUNT);
    this.slots.set(id, this.makeSlot(id, transport));
  }

  /** Empty a seat. Its robot, if it is on the field, stops where it stands. */
  clearSeat(id: SeatId): void {
    const robot = this.robotFor(id);
    if (robot) robot.motors = [0, 0, 0, 0];
    this.slots.delete(id);
  }

  /** Whether this seat has a program in it. */
  hasSeat(id: SeatId): boolean {
    return this.slots.has(id);
  }

  /**
   * Put a situation on the field, and make it what restarts go back to.
   *
   * Not a referee action and not recorded as one - nothing stages anything
   * during a scored match. A seat whose robot the arrangement leaves off keeps
   * its program and simply has nothing to drive until it is staged back on.
   */
  stage(arrangement: Arrangement): void {
    this.world.stage(arrangement);
  }

  /** Change what restarts go back to, leaving the field where it is. */
  setArrangement(arrangement: Arrangement): void {
    this.world.setArrangement(arrangement);
  }

  /** Back to ordinary kick-offs, leaving the field as it stands. */
  unstage(): void {
    this.world.unstage();
  }

  /** Rule 5.7: take a robot off for the reason given. */
  removeRobot(robotId: string, rule: string, reason: string): void {
    this.world.removeRobot(robotId, rule, reason);
    this.recordRefereeAction('remove-robot', `${robotId} (${rule}): ${reason}`);
  }

  /** Rule 5.7.4: return a robot once the referee is satisfied it is fixed. Refuses early. */
  returnRobot(robotId: string): boolean {
    const returned = this.world.returnRobot(robotId);
    if (returned) this.recordRefereeAction('return-robot', robotId);
    return returned;
  }

  /** Stop play without ending anything — a referee's whistle. */
  pause(): void {
    if (!this.world.running) return;
    this.world.running = false;
    // A pause also freezes any kick-off countdown in flight, so the referee
    // can talk a team down and still give them their full restart.
    this.world.paused = true;
    this.world.emit({ kind: 'paused', rule: '—', message: 'Play paused by referee.' });
    this.recordRefereeAction('pause');
  }

  /**
   * Restart play after a pause.
   *
   * Refuses before this half has actually been kicked off: found live, a
   * referee clicking Resume instead of Kick Off at the top of a half would
   * otherwise start play with every robot wherever the last half left it,
   * skipping the rule 5.4 restart placement entirely.
   *
   * Also refuses while a half-start kick-off is still counting down unpaused:
   * that is a restart waiting for its whistle, not a paused match, and
   * Resume ending the countdown would hand the striker an instant 5.4.7
   * strike window with no warning.
   */
  resume(): void {
    if (this.world.running || !this.hasKickedOffThisHalf) return;
    if (this.world.countdownActive && !this.world.paused) return;
    this.world.paused = false;
    this.world.running = true;
    this.world.emit({ kind: 'resumed', rule: '—', message: 'Play resumed by referee.' });
    this.recordRefereeAction('resume');
  }

  /** A referee skipping the kick-off wait: end the countdown and play now. */
  skipKickoffCountdown(): void {
    this.world.skipKickoffCountdown();
    this.recordRefereeAction('skip-kickoff-countdown');
  }

  /** End the current half early. The loop driving the match checks this once per frame. */
  endHalf(): void {
    this.halfEndRequested = true;
    this.world.running = false;
    this.recordRefereeAction('end-half', `half ${this.world.half}`);
  }

  /** Read and clear the end-half request. */
  consumeHalfEndRequest(): boolean {
    const requested = this.halfEndRequested;
    this.halfEndRequested = false;
    return requested;
  }

  /** End the match after the current half — no second half is played. */
  endMatch(): void {
    this.ended = true;
    this.halfEndRequested = true;
    this.world.running = false;
    this.recordRefereeAction('end-match');
  }

  /** End the match immediately, for a reason recorded against the result. */
  abandon(reason: string): void {
    this.abandoned = true;
    this.abandonReason = reason;
    this.ended = true;
    this.halfEndRequested = true;
    this.world.running = false;
    this.recordRefereeAction('abandon', reason);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isAbandoned(): boolean {
    return this.abandoned;
  }

  /** Correct the score, with a reason recorded against the match. */
  correctScore(team: TeamId, to: number, reason: string): void {
    if (!Number.isInteger(to) || to < 0) {
      throw new Error(`score correction must be a non-negative whole number, got ${to}`);
    }
    const from = this.world.score[team];
    this.scoreCorrections.push({ team, from, to, reason, at: this.world.clock });
    this.world.score[team] = to;
    this.world.emit({
      kind: 'score-corrected',
      rule: '—',
      team,
      message: `Score corrected: ${team} ${from} → ${to}. ${reason}`,
    });
    this.recordRefereeAction('correct-score', `${team} ${from} → ${to}: ${reason}`);
  }

  /**
   * The match as a spectator sees it.
   *
   * Built fresh each time rather than kept live, because it crosses a socket
   * and anything shared by reference stops being true the moment the world
   * steps again. Only the last few referee calls are included: a viewer needs
   * a banner, not a log, and the whole event list would be most of the frame.
   */
  snapshot(): ViewFrame {
    const events: ViewEvent[] = this.world.events.slice(-4).map((e) => ({
      kind: e.kind,
      rule: e.rule,
      message: e.message,
      at: e.at,
      team: e.team,
    }));
    return {
      clock: this.world.clock,
      half: this.world.half,
      running: this.world.running,
      kickoff: {
        countdown: this.world.countdownSeconds,
        team: this.world.restart.team,
      },
      score: { ...this.world.score },
      ball: {
        x: this.world.ball.x,
        z: this.world.ball.z,
        y: this.world.ball.y,
        radius: this.world.ball.radius,
      },
      robots: this.world.robots.map((r) => ({
        id: r.id,
        team: r.team,
        x: r.x,
        z: r.z,
        heading: r.heading,
        radius: r.radius,
        removed: r.removed,
        isGoalie: r.isGoalie,
        penaltyRemaining: r.penaltyRemaining,
        removalRule: r.removalRule,
        removalReason: r.removalReason,
      })),
      commsEnabled: this.world.commsEnabled,
      commsActivity: { ...this.world.commsActivity },
      events,
      teams: this.teams,
    };
  }

  /** The league in play, sent once when a viewer joins. */
  get league() {
    return this.world.config.league;
  }

  /** Seconds in a half, for the clock on the scoreboard. */
  get halfLength(): number {
    return this.halfSeconds;
  }

  /** Play both halves and hand back the result. */
  run(): MatchResult {
    if (this.refereed) {
      throw new Error('a refereed match is driven by referee calls, not run()');
    }
    const dt = 1 / PHYSICS_HZ;
    for (const half of [1, 2] as const) {
      this.world.half = half;
      // Rule 1.4/5.4: the team that did not kick off the first half starts the
      // second, and sides swap. Swapping sides is the reason every pairing is
      // played twice in a tournament rather than trusting one match.
      this.world.kickOff(half === 1 ? 'violet' : 'lime');
      this.resetAgents();

      // With a countdown the kick-off is placed but not live: the whistle
      // inside `step` starts the clock. Headless matches have no countdown,
      // so nothing about them changes.
      if (!this.world.countdownActive) this.world.running = true;
      const until = this.world.clock + this.halfSeconds;
      while (this.world.clock < until) this.step(dt);
      this.world.running = false;
    }
    return this.result();
  }

  result(): MatchResult {
    const slots: MatchResult['slots'] = {};
    for (const [id, slot] of this.slots) slots[id] = slot.agent.report();
    return {
      score: { ...this.world.score },
      clock: this.world.clock,
      goals: [...this.goals],
      slots,
      calls: { ...this.calls },
      events: [...this.eventLog],
      refereeActions: [...this.refereeActions],
      scoreCorrections: [...this.scoreCorrections],
      abandoned: this.abandoned,
      abandonReason: this.abandonReason,
    };
  }
}

/** Small stable hash, so a robot id contributes the same seed every run. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
