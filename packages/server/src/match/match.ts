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

import { World, type Arrangement, type MatchEvent, type Robot, type TeamId } from '../sim/world';
import { getLeague, type LeagueId } from '@rcja/shared/leagues';
import { AgentSlot, LocalTransport, type Agent, type Transport } from './agent';
import { Senses, TeamRadio, type MatchView, type SensedRobot } from '../sim/perception';
import { foldSeed, streamSeed, toSeed, withWord, type Seed, type SeedInput } from '../sim/rand';
import type { ActuatorFrame } from './protocol';
import { wrapAngle } from '../sim/drive';
import { kickBall } from '../sim/physics';
import {
  type HalfTime, type ViewEvent, type ViewFrame,
  type MatchResult, type RefereeAction, type ScoreCorrection,
  type RobotStats, type SlotReport,
} from '@rcja/shared/view';
import { GOAL_MOUTH_X, HALF_GOAL_SHELL, HALF_LENGTH, PENALTY_DEPTH } from '../sim/field';

// Re-export so callers of match.ts keep working without import changes.
export type { MatchResult, RefereeAction, ScoreCorrection, RobotStats, SlotReport };

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
 * How hard the roller draws the ball in at full power, mm/s.
 *
 * A dribbler holds the ball by spinning it backwards: the carpet turns that
 * backspin into a pull into the mouth. So the roller works on the ball's spin
 * as well as its speed, and this is the backspin it asks for, as the speed the
 * ball would roll towards the robot at.
 */
const DRIBBLE_PULL = 300;
/**
 * Unused stream tag for the per-match ball friction draw.
 *
 * Won't collide with sensor streams (0x1f-0x65 and 0x7c): XORs of its value
 * against match seeds are spread by `foldSeed`'s mix before use.
 */
const BALL_FRICTION_STREAM = 0x8b;
/** Motors on a robot, for a seat whose robot is not currently on the field. */
const MOTOR_COUNT = 4;
/**
 * Goal difference at which a match is over, whatever the clock says.
 *
 * Not a rule number: the RCJA rules have no mercy rule, and this is a venue's
 * decision about its own day rather than something 5.x asks for. It is a
 * default here rather than a setting every caller passes because it applies to
 * every match that is *played* — fixtures, the hall demo, the batch
 * `tournament`, a one-off `match`.
 *
 * Three callers pass `null`, and they are the three that are not playing a
 * match at all:
 *
 * - **a practice field**, a rehearsal with no result to shorten — ending one
 *   because the reference agent ran away with it would be taking the field off
 *   the team who booked it;
 * - **the bench** and **the ladder**, which are measuring instruments. The
 *   rule only ever takes goals off whoever is winning, so it moves an
 *   aggregate-goals comparison asymmetrically and cuts the tail off a score
 *   distribution — which is the thing both of them exist to look at.
 */
export const DEFAULT_MERCY_MARGIN = 10;

/**
 * Five minutes between the halves, at a venue that has not said otherwise.
 *
 * Long enough for a team to walk to their laptop, find the line, push it and
 * watch their robot come back up; short enough that a referee with eight
 * fixtures still gets through the day. A referee who does not need it skips it
 * the moment both teams say they are ready.
 */
export const DEFAULT_HALF_TIME_SECONDS = 300;

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
  /**
   * Goal difference that ends the match, or `null` for no limit.
   *
   * Defaults to `DEFAULT_MERCY_MARGIN`. A match ended this way is finished, not
   * abandoned: it counts, it is written down, and `MatchResult.mercy` says why
   * it was shorter than the clock.
   */
  mercyMargin?: number | null;
  /**
   * Seconds of half-time between the two halves, or 0 (the default) for none.
   *
   * Zero by default and sent in by the hub from `rules.halfTimeSeconds`, the
   * same way `mercyMargin` is: a laptop running `--referee` keeps the break it
   * has always had — as long as the referee takes — and every fixture at a
   * venue gets the one the venue set, whatever a particular arena was started
   * with.
   *
   * Only a refereed match ever has one. `run()` and `playFast` decide for
   * themselves when a half ends and have nobody to wait for.
   */
  halfTimeSeconds?: number;
  /**
   * A scoreline the match starts from, and why.
   *
   * Recorded as ordinary score corrections at clock 0, so a match that kicks
   * off 3-0 carries the reason in its own record rather than starting at a
   * score nobody can account for. The pre-game penalty clock is the only thing
   * that sets it; every other caller starts at nil-nil and never passes this.
   */
  penalties?: { violet: number; lime: number; reason: string };
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
   * How long one robot may sit on a motionless ball, unopposed, before rule
   * 5.6 takes it off them. Defaults to the simulator's 8 seconds; 0 turns the
   * test off, which restores unlimited possession.
   *
   * A setting rather than a constant because 5.6 does not describe this ball:
   * no opponent is contesting it, so 5.6.1.2 does not apply, and a robot is
   * touching it, so "no robot has any chance of locating the ball" is plainly
   * false. What to do about it is the referee's call, and referees differ.
   */
  heldBallSeconds?: number;
  /**
   * How long a person takes to carry the ball to a neutral point, as a range
   * each placement draws from. See `MatchConfig.ballPlacementSeconds`.
   */
  ballPlacementSeconds?: { min: number; max: number };
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
  /** Seconds until the next match will automatically start (e.g. in a demo arena). */
  nextMatchIn?: number;
}

// MatchResult, RefereeAction, ScoreCorrection, RobotStats are now in @rcja/shared/view.
// See the re-exports at the top of this file.

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
  /** `world.kickOffs` as of this slot's last frame. */
  seenKickOffs: number;
  /** Frames left with the start button up. See `BUTTON_UP_FRAMES`. */
  buttonUp: number;
}

/**
 * How long a restart holds the start button up, in control frames.
 *
 * At every kick-off a real team picks the robot up, puts it on its mark and
 * presses start, and that press is the only way the robot learns a restart
 * happened. A headless match restarts in zero time, so without this the
 * button would never leave the down position and a robot could not tell a
 * kick-off from open play. Two frames, not one, so a program pacing its loop
 * a little slower than the frame rate still sees it.
 */
const BUTTON_UP_FRAMES = 2;

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
  /**
   * The clock the radio link runs on: every control cycle, stoppages included.
   *
   * Not the match clock, because a packet's age is what a robot is told and
   * the match clock stops when the referee stops play. Aged on it, a message
   * sent before a stoppage stayed the same age for as long as the stoppage
   * lasted, which was both wrong about the radio and a way to read the match
   * clock off it. Robots' own clocks (`SensorFrame.time`) tick the same way.
   */
  private linkTime = 0;
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
  private readonly goals: { team: TeamId; at: number; half: 1 | 2; robotId?: string }[] = [];
  private lastScore = { violet: 0, lime: 0 };
  private readonly calls: Record<string, number> = {};
  private readonly eventLog: MatchEvent[] = [];
  private readonly refereeActions: RefereeAction[] = [];
  private lastSeenEvent: unknown = null;
  private readonly observer: ((match: Match) => void) | undefined;
  /** Whether this match is driven by referee calls rather than the clock. */
  readonly refereed: boolean;
  private readonly scoreCorrections: ScoreCorrection[] = [];
  private readonly mercyMargin: number | null;
  /** See `MatchOptions.halfTimeSeconds`. */
  private readonly halfTimeSeconds: number;
  /**
   * When half-time began, in **wall** milliseconds, or `null` outside one.
   *
   * Wall clock rather than match seconds, for the reason the pre-game penalty
   * clock is (`pregame.ts`): a team walking to a laptop to fix a line of
   * Python lives in wall time, and the match clock is stopped anyway. It does
   * not pause, which costs nothing — see `halfTimeHolds`, where the only thing
   * that happens at zero is that a gate opens.
   */
  private halfTimeSince: number | null = null;
  /** Which sides have said they are ready to play the second half. */
  private readonly saidReady = { violet: false, lime: false };
  private halfEndRequested = false;
  private ended = false;
  private mercied = false;
  private abandoned = false;
  private abandonReason: string | undefined;
  private hasKickedOffThisHalf = false;
  readonly robotStats: Record<string, RobotStats> = {
    'violet-1': { goals: 0, saves: 0, shots: 0, penalties: 0 },
    'violet-2': { goals: 0, saves: 0, shots: 0, penalties: 0 },
    'lime-1': { goals: 0, saves: 0, shots: 0, penalties: 0 },
    'lime-2': { goals: 0, saves: 0, shots: 0, penalties: 0 },
  };
  private shotInFlight: {
    targetGoal: 'cyan' | 'yellow';
    shooterId?: string;
    at: number;
  } | null = null;
  private readonly lastSaveAt: Record<string, number> = {};
  private readonly lastShotAt: Record<string, number> = {};

  private ensureStats(id: string): RobotStats {
    let s = this.robotStats[id];
    if (!s) {
      s = { goals: 0, saves: 0, shots: 0, penalties: 0 };
      this.robotStats[id] = s;
    }
    return s;
  }

  constructor(opts: MatchOptions) {
    const league = getLeague(opts.league ?? 'open');
    this.halfSeconds = opts.halfSeconds ?? 300;
    this.mercyMargin = opts.mercyMargin === undefined ? DEFAULT_MERCY_MARGIN : opts.mercyMargin;
    this.halfTimeSeconds = Math.max(0, opts.halfTimeSeconds ?? 0);
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
      heldBallSeconds: opts.heldBallSeconds,
      ballPlacementSeconds: opts.ballPlacementSeconds,
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

    // Goals owed before a ball is kicked. Last, because a correction touches
    // the world and emits an event, and both have to exist first. Through
    // `correctScore` rather than straight into the score so the reason travels
    // with them into the match record — and so the mercy rule sees them, which
    // is what makes a match nobody can win end before it is played.
    const owed = opts.penalties;
    if (owed) {
      for (const team of ['violet', 'lime'] as const) {
        if (owed[team] > 0) this.correctScore(team, owed[team], owed.reason);
      }
    }
  }

  private readonly sensedRobotsBuffer: SensedRobot[] = [];
  private readonly viewBall = { x: 0, z: 0 };
  private readonly cachedMatchView: MatchView = {
    clock: 0,
    playing: false,
    ball: this.viewBall,
    robots: this.sensedRobotsBuffer,
    kickoff: { pending: false, team: null, countdown: 0 },
  };
  private readonly cachedOrderedSlots: Slot[] = [];

  /** What perception is allowed to see. Built fresh each control cycle. */
  private view(): MatchView {
    const active = this.world.active();
    this.sensedRobotsBuffer.length = 0;
    for (let i = 0; i < active.length; i++) {
      const r = active[i]!;
      this.sensedRobotsBuffer.push({
        id: r.id,
        team: r.team,
        number: numberOf(r.id),
        x: r.x,
        z: r.z,
        heading: r.heading,
      });
    }
    this.cachedMatchView.clock = this.world.clock;
    this.cachedMatchView.playing = this.world.running;
    // A ball in somebody's hand is not on the field to be sensed. The view
    // keeps its own object and hands out null, so nothing here allocates.
    this.viewBall.x = this.world.ball.x;
    this.viewBall.z = this.world.ball.z;
    this.cachedMatchView.ball = this.world.ballInPlay ? this.viewBall : null;
    this.cachedMatchView.kickoff = this.world.restart;
    return this.cachedMatchView;
  }

  /** The live robot for a slot, after any reset replaced the objects. */
  private robotFor(id: string): Robot | undefined {
    return this.world.robots.find((r) => r.id === id);
  }

  /** All four slots, in an order that alternates tick to tick. See `slotOrderFlipped`. */
  private orderedSlots(): Slot[] {
    this.cachedOrderedSlots.length = 0;
    for (const slot of this.slots.values()) {
      this.cachedOrderedSlots.push(slot);
    }
    if (this.slotOrderFlipped) {
      this.cachedOrderedSlots.reverse();
    }
    return this.cachedOrderedSlots;
  }

  /** Whether this robot's dribbler currently has the ball. */
  private gateHeld(robot: Robot): boolean {
    if (!this.world.config.league.dribblerAllowed) return false;
    // Nothing to hold, kick or drag while the ball is off the field.
    if (!this.world.ballInPlay) return false;
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
    this.linkTime += dt;
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
        });
        // Beside the pitch in somebody's hands, but still switched on - and
        // when it goes back on, somebody presses start.
        slot.senses.idle(dt);
        slot.buttonUp = BUTTON_UP_FRAMES;
        slot.wasConnected = slot.agent.transport.connected ?? true;
        continue;
      }

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

      if (slot.seenKickOffs !== this.world.kickOffs) {
        slot.seenKickOffs = this.world.kickOffs;
        slot.buttonUp = BUTTON_UP_FRAMES;
      }
      const lifted = slot.buttonUp > 0;
      if (lifted) slot.buttonUp--;

      const held = this.gateHeld(robot);
      const number = numberOf(robot.id);
      const frame = slot.senses.read({
        view,
        self: { id: robot.id, team: robot.team, number, x: robot.x, z: robot.z, heading: robot.heading },
        wheelSpeeds: robot.wheelSpeeds,
        omega: robot.omega,
        held,
        messages: this.world.commsEnabled ? this.radios[robot.team].deliver(number, this.linkTime) : [],
        attackDirection: this.world.attackingGoal(robot.team) === 'yellow' ? 1 : -1,
        dt,
        lifted,
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
        this.radios[robot.team].send(number, command.say, this.linkTime);
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
    kickBall(this.world.ball, robot);
    this.world.lastBallTouch = { robotId: robot.id, team: robot.team, at: this.world.clock };
    this.world.lastTouchByTeam[robot.team] = { robotId: robot.id, at: this.world.clock };
    this.ensureStats(robot.id).shots++;
    this.lastShotAt[robot.id] = this.world.clock;
  }

  /**
   * Rule 4.6.6: the dribbler holds the ball against the robot.
   *
   * Modelled as drag towards the robot's own motion rather than as a rigid
   * attachment, so the ball can still be knocked away by an opponent — which is
   * what makes possession contestable rather than absolute.
   *
   * The motion is that of the point of the robot where the ball sits, not of
   * its centre, so a robot turning with the ball carries it round. And the
   * roller spins the ball backwards (DRIBBLE_PULL), which the carpet turns
   * into a draw into the mouth.
   */
  private dribble(dt: number): void {
    for (const slot of this.orderedSlots()) {
      const power = slot.command.dribbler ?? 0;
      const robot = this.robotFor(slot.id);
      if (power <= 0 || !robot || robot.removed) continue;
      if (!this.gateHeld(robot)) continue;
      const grip = Math.min(1, DRIBBLE_GRIP * power * dt * PHYSICS_HZ);
      const ball = this.world.ball;
      const px = robot.vx - robot.omega * (ball.z - robot.z);
      const pz = robot.vz + robot.omega * (ball.x - robot.x);
      // Spin as the speed it would roll at, pulled towards backspin.
      const rollX = ball.vx - ball.slipVx;
      const rollZ = ball.vz - ball.slipVz;
      const pull = DRIBBLE_PULL * power;
      const spinX = rollX + (px - pull * Math.cos(robot.heading) - rollX) * grip;
      const spinZ = rollZ + (pz - pull * Math.sin(robot.heading) - rollZ) * grip;
      ball.vx += (px - ball.vx) * grip;
      ball.vz += (pz - ball.vz) * grip;
      ball.slipVx = ball.vx - spinX;
      ball.slipVz = ball.vz - spinZ;
      this.world.lastBallTouch = { robotId: robot.id, team: robot.team, at: this.world.clock };
      this.world.lastTouchByTeam[robot.team] = { robotId: robot.id, at: this.world.clock };
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
    this.detectShotBeforeStep();
    this.world.step(dt);
    this.detectSaveAfterStep();
    this.recordGoals();
    this.recordCalls();
    this.observer?.(this);
  }

  private detectShotBeforeStep(): void {
    const ball = this.world.ball;
    const speed = Math.hypot(ball.vx, ball.vz);
    if (speed < 300) return;

    // Cyan goal mouth sits at -GOAL_MOUTH_X (-915)
    if (ball.vx < -250) {
      const t = (-GOAL_MOUTH_X - ball.x) / ball.vx;
      if (t > 0 && t < 2.5) {
        const crossZ = ball.z + ball.vz * t;
        if (Math.abs(crossZ) <= HALF_GOAL_SHELL + 10) {
          const attackingTeam: TeamId = this.world.defendingGoal('violet') === 'cyan' ? 'lime' : 'violet';
          const shooterId = this.world.lastBallTouch?.team === attackingTeam
            ? this.world.lastBallTouch.robotId
            : this.world.lastTouchByTeam[attackingTeam]?.robotId;
          this.shotInFlight = { targetGoal: 'cyan', shooterId, at: this.world.clock };
          if (shooterId && (this.world.clock - (this.lastShotAt[shooterId] ?? -99) > 1.0)) {
            this.lastShotAt[shooterId] = this.world.clock;
            this.ensureStats(shooterId).shots++;
          }
        }
      }
    } else if (ball.vx > 250) {
      // Yellow goal mouth sits at +GOAL_MOUTH_X (+915)
      const t = (GOAL_MOUTH_X - ball.x) / ball.vx;
      if (t > 0 && t < 2.5) {
        const crossZ = ball.z + ball.vz * t;
        if (Math.abs(crossZ) <= HALF_GOAL_SHELL + 10) {
          const attackingTeam: TeamId = this.world.defendingGoal('violet') === 'yellow' ? 'lime' : 'violet';
          const shooterId = this.world.lastBallTouch?.team === attackingTeam
            ? this.world.lastBallTouch.robotId
            : this.world.lastTouchByTeam[attackingTeam]?.robotId;
          this.shotInFlight = { targetGoal: 'yellow', shooterId, at: this.world.clock };
          if (shooterId && (this.world.clock - (this.lastShotAt[shooterId] ?? -99) > 1.0)) {
            this.lastShotAt[shooterId] = this.world.clock;
            this.ensureStats(shooterId).shots++;
          }
        }
      }
    }
  }

  private detectSaveAfterStep(): void {
    if (!this.shotInFlight) return;
    if (this.world.clock - this.shotInFlight.at > 2.5) {
      this.shotInFlight = null;
      return;
    }
    // If a goal was scored in this step, do not count it as a save
    if (this.world.score.violet > this.lastScore.violet || this.world.score.lime > this.lastScore.lime) {
      this.shotInFlight = null;
      return;
    }

    const targetGoal = this.shotInFlight.targetGoal;
    const defTeam: TeamId = this.world.defendingGoal('violet') === targetGoal ? 'violet' : 'lime';
    const ball = this.world.ball;

    for (const robot of this.world.robots) {
      if (robot.team !== defTeam || robot.removed) continue;
      // In or near the defending penalty area
      const inDefArea = Math.abs(robot.x) > HALF_LENGTH - PENALTY_DEPTH - 60;
      if (!inDefArea && !robot.isGoalie) continue;

      const dist = Math.hypot(robot.x - ball.x, robot.z - ball.z);
      const touched = this.world.lastBallTouch?.robotId === robot.id &&
        Math.abs(this.world.clock - this.world.lastBallTouch.at) < 0.05;
      if (touched || dist <= robot.radius + ball.radius + 30) {
        if (this.world.clock - (this.lastSaveAt[robot.id] ?? -99) > 1.0) {
          this.lastSaveAt[robot.id] = this.world.clock;
          this.ensureStats(robot.id).saves++;
        }
        this.shotInFlight = null;
        break;
      }
    }
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
      if (event.robotId && (event.kind === 'possible-damaged' || event.kind === 'illegal-kickoff')) {
        this.ensureStats(event.robotId).penalties++;
      }
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
        this.shotInFlight = null;
        const lastGoalEvent = [...this.world.events].reverse().find((e) => e.kind === 'goal' && e.team === team);
        let robotId = lastGoalEvent?.robotId;
        if (!robotId) {
          // Fallback if no attacker was credited (e.g. own goal or untracked deflection)
          const teamTouch = this.world.lastTouchByTeam?.[team];
          robotId = teamTouch?.robotId ?? `${team}-1`;
        }
        this.goals.push({ team, at: this.world.clock, half: this.world.half, robotId });
        this.ensureStats(robotId).goals++;
      }
    }
    this.checkMercy();
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
      seenKickOffs: 0,
      buttonUp: 0,
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
    this.ensureStats(robotId).penalties++;
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

  /**
   * The break between the halves, named.
   *
   * It has always been here — the loop driving a refereed match opens the
   * second half stopped and waits for a whistle that may be five minutes off —
   * but nothing said so, nothing timed it, and nothing was allowed to happen
   * in it. What it is for is the one window in a match where a team may
   * correct their code, so it needs a clock everybody can see and a gate that
   * keeps the second half from starting while somebody is still typing.
   *
   * Called by the loop, not by a referee: half-time is what the end of the
   * first half *is*, not something anybody decides.
   */
  beginHalfTime(): void {
    if (this.halfTimeSeconds <= 0 || this.ended) return;
    this.halfTimeSince = Date.now();
    this.saidReady.violet = false;
    this.saidReady.lime = false;
    this.recordRefereeAction('half-time', `${this.halfTimeSeconds}s`);
  }

  /** A team saying they are ready to play the second half. */
  sayReady(team: TeamId): void {
    if (this.halfTimeSince === null) return;
    this.saidReady[team] = true;
    this.recordRefereeAction('ready', `${this.teams[team]} are ready`);
  }

  /** Half-time is over, because the second half has started. */
  endHalfTime(): void {
    this.halfTimeSince = null;
  }

  /** The break as a screen shows it, or `null` when there is not one. */
  halfTime(now = Date.now()): HalfTime | null {
    if (this.halfTimeSince === null) return null;
    const elapsed = Math.max(0, (now - this.halfTimeSince) / 1000);
    return {
      since: new Date(this.halfTimeSince).toISOString(),
      seconds: this.halfTimeSeconds,
      remaining: Math.max(0, this.halfTimeSeconds - elapsed),
      ready: { ...this.saidReady },
      over: elapsed >= this.halfTimeSeconds,
    };
  }

  /**
   * Why the second half may not kick off yet, or `null` if it may.
   *
   * A referee may skip half-time the moment both teams say they are ready, and
   * once the five minutes are up they may kick off whatever anybody has said.
   * So this only ever holds the whistle for as long as half-time itself lasts:
   * it is a gate that opens by itself, not authority taken off a referee.
   *
   * A sentence rather than a boolean, because it is answered straight back to
   * the person who pressed the button.
   */
  halfTimeHolds(now = Date.now()): string | null {
    const halfTime = this.halfTime(now);
    if (!halfTime || halfTime.over) return null;
    const waiting = (['violet', 'lime'] as const).filter((team) => !halfTime.ready[team]);
    if (waiting.length === 0) return null;
    const names = waiting.map((team) => this.teams[team]).join(' and ');
    const left = Math.ceil(halfTime.remaining);
    return (
      `${names} ${waiting.length > 1 ? 'have' : 'has'} not said they are ready; ` +
      `half-time has ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`
    );
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

  /**
   * End the match if one side is too far ahead for the rest to be football.
   *
   * Called wherever the score moves, which is two places: a goal, and a
   * referee's correction. Not an abandonment — an abandoned fixture is left
   * unwritten and replayed, and this is a finished match that counts — so it
   * sets the same three flags `endMatch()` does and nothing else.
   *
   * Once only. A ten-goal lead stays a ten-goal lead, and a second call would
   * put a second banner on the screen for the same thing.
   */
  private checkMercy(): void {
    if (this.mercyMargin === null || this.mercied || this.ended) return;
    const margin = Math.abs(this.world.score.violet - this.world.score.lime);
    if (margin < this.mercyMargin) return;
    const ahead = this.world.score.violet > this.world.score.lime ? 'violet' : 'lime';
    this.mercied = true;
    this.ended = true;
    this.halfEndRequested = true;
    this.world.running = false;
    this.world.emit({
      kind: 'mercy',
      rule: '\u2014',
      team: ahead,
      message: `${this.teams[ahead]} lead by ${margin} \u2014 the match is over.`,
    });
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Whether the mercy rule is what ended it. */
  get isMercied(): boolean {
    return this.mercied;
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
    // And move the goal counter with it. `recordGoals` works off the gap
    // between the score and what it has already written down, so a correction
    // that did not say so here manufactured a goal per point awarded — with no
    // robot attached to any of them — and a correction downwards swallowed the
    // next real goal instead. Neither was visible from the scoreboard, which is
    // why it survived: only `MatchResult.goals` was ever wrong.
    this.lastScore[team] = to;
    this.world.emit({
      kind: 'score-corrected',
      rule: '—',
      team,
      message: `Score corrected: ${team} ${from} → ${to}. ${reason}`,
    });
    this.recordRefereeAction('correct-score', `${team} ${from} → ${to}: ${reason}`);
    this.checkMercy();
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
      // Carried on the frame rather than fetched, so the referee's console and
      // the hall screen count the break down off the stream they already have.
      ...(this.halfTimeSince === null ? {} : { halfTime: this.halfTime()! }),
      score: { ...this.world.score },
      ball: {
        x: this.world.ball.x,
        z: this.world.ball.z,
        radius: this.world.ball.radius,
        ...(this.world.ballInPlay ? {} : { absent: true }),
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
      // Until the mercy rule there was nothing a headless match could do to end
      // itself, so this loop never asked. `playRefereed` in `server.ts` has
      // always asked, because a referee could — the check was missing here, in
      // `playFast` and in the realtime loop for exactly as long as ending early
      // was a referee's privilege.
      if (this.ended) break;
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
      while (this.world.clock < until && !this.ended) this.step(dt);
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
      ...(this.mercied ? { mercy: true } : {}),
      robotStats: {
        'violet-1': { ...this.ensureStats('violet-1') },
        'violet-2': { ...this.ensureStats('violet-2') },
        'lime-1': { ...this.ensureStats('lime-1') },
        'lime-2': { ...this.ensureStats('lime-2') },
      },
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
