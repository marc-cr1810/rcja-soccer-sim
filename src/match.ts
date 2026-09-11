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

import { World, type Robot, type TeamId } from './world';
import { getLeague, type LeagueId } from './leagues';
import { AgentSlot, LocalTransport, type Agent, type Transport } from './agent';
import { Senses, TeamRadio, type MatchView, type SensedRobot } from './perception';
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
/** How firmly the roller holds the ball against the robot. */
const DRIBBLE_GRIP = 0.55;

/** Keyed by the world's own robot ids. */
export interface MatchAgents {
  'cyan-1': Agent;
  'cyan-2': Agent;
  'yellow-1': Agent;
  'yellow-2': Agent;
}

/** Robot number, 1 or 2, from an id like 'cyan-2'. */
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
  teams?: { cyan: string; yellow: string };
  league?: LeagueId;
  /** Seconds per half. Rule 5.2.1 says five minutes. */
  halfSeconds?: number;
  /** Fixes every noise stream in the match, so a result can be reproduced. */
  seed?: number;
  inclined?: boolean;
  idealSensors?: boolean;
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

export interface MatchResult {
  score: Record<TeamId, number>;
  /** Seconds of match time played. */
  clock: number;
  goals: { team: TeamId; at: number }[];
  /** Per-robot connection health, for the match record. */
  slots: Record<string, ReturnType<AgentSlot['report']>>;
  /**
   * Every referee call of the match, counted by kind.
   *
   * Not taken from world.events, which is a 60-entry ring buffer sized for the
   * referee panel and silently drops the early part of a ten-minute match.
   * Counting restarts is the whole point of a balance run, so they are tallied
   * as they happen.
   */
  calls: Record<string, number>;
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
}

export class Match {
  readonly world: World;
  private readonly slots = new Map<string, Slot>();
  private readonly radios: Record<TeamId, TeamRadio> = {
    cyan: new TeamRadio(),
    yellow: new TeamRadio(),
  };
  private readonly halfSeconds: number;
  readonly teams: { cyan: string; yellow: string };
  private sinceControl = 0;
  private readonly goals: { team: TeamId; at: number }[] = [];
  private lastScore = { cyan: 0, yellow: 0 };
  private readonly calls: Record<string, number> = {};
  private lastSeenEvent: unknown = null;
  private readonly observer: ((match: Match) => void) | undefined;

  constructor(opts: MatchOptions) {
    const league = getLeague(opts.league ?? 'open');
    this.halfSeconds = opts.halfSeconds ?? 300;
    this.teams = opts.teams ?? { cyan: 'Cyan', yellow: 'Yellow' };
    this.world = new World({
      league,
      halfLengthSeconds: this.halfSeconds,
      inclined: opts.inclined ?? false,
      commsEnabled: league.commsAllowed,
    });
    this.world.resetRobots('cyan');

    this.observer = opts.observe;

    const seed = opts.seed ?? 1;
    const byId = opts.agents as unknown as Record<string, Agent>;
    for (const robot of this.world.robots) {
      const agent = byId[robot.id];
      if (!agent && !opts.transports?.[robot.id]) {
        throw new Error(`no program for robot ${robot.id}`);
      }
      this.slots.set(robot.id, {
        id: robot.id,
        senses: new Senses(
          seed * 2654435761 + hash(robot.id),
          robot.motors.length,
          opts.idealSensors ?? false,
        ),
        agent: new AgentSlot(
          opts.transports?.[robot.id] ?? new LocalTransport(agent!, robot.motors.length),
        ),
        kickCooldown: 0,
        command: { motors: [0, 0, 0, 0] },
        wasConnected: true,
      });
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

  /** Whether this robot's dribbler currently has the ball. */
  private gateHeld(robot: Robot): boolean {
    if (!this.world.config.league.dribblerAllowed) return false;
    const dx = this.world.ball.x - robot.x;
    const dz = this.world.ball.z - robot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > robot.radius + this.world.ball.radius + GATE_SLOP) return false;
    return Math.abs(wrapAngle(Math.atan2(dz, dx) - robot.heading)) < GATE_ARC;
  }

  private control(dt: number): void {
    const view = this.view();
    for (const slot of this.slots.values()) {
      const robot = this.robotFor(slot.id);
      if (!robot) continue;
      slot.kickCooldown = Math.max(0, slot.kickCooldown - dt);
      if (robot.removed) {
        robot.motors = [0, 0, 0, 0];
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

      const held = this.gateHeld(robot);
      const number = numberOf(robot.id);
      const frame = slot.senses.read({
        view,
        self: { id: robot.id, team: robot.team, number, x: robot.x, z: robot.z, heading: robot.heading },
        wheelSpeeds: robot.wheelSpeeds,
        held,
        messages: this.world.commsEnabled ? this.radios[robot.team].deliver(number, this.world.clock) : [],
        dt,
      });

      const command = slot.agent.poll(frame);
      slot.command = command;
      robot.motors = command.motors;

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
    for (const slot of this.slots.values()) {
      const power = slot.command.dribbler ?? 0;
      const robot = this.robotFor(slot.id);
      if (power <= 0 || !robot || robot.removed) continue;
      if (!this.gateHeld(robot)) continue;
      const grip = Math.min(1, DRIBBLE_GRIP * power * dt * PHYSICS_HZ);
      this.world.ball.vx += (robot.vx - this.world.ball.vx) * grip;
      this.world.ball.vz += (robot.vz - this.world.ball.vz) * grip;
    }
  }

  step(dt: number): void {
    this.sinceControl += dt;
    const period = 1 / CONTROL_HZ;
    if (this.sinceControl >= period) {
      this.control(this.sinceControl);
      this.sinceControl = 0;
    }
    this.dribble(dt);
    this.world.step(dt);
    this.recordGoals();
    this.recordCalls();
    this.observer?.(this);
  }

  /**
   * Count referee calls as they are emitted.
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
      const kind = events[i]!.kind;
      this.calls[kind] = (this.calls[kind] ?? 0) + 1;
    }
    this.lastSeenEvent = events[events.length - 1];
  }

  private recordGoals(): void {
    for (const team of ['cyan', 'yellow'] as const) {
      while (this.world.score[team] > this.lastScore[team]) {
        this.lastScore[team]++;
        this.goals.push({ team, at: this.world.clock });
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
    const dt = 1 / PHYSICS_HZ;
    for (const half of [1, 2] as const) {
      this.world.half = half;
      // Rule 1.4/5.4: the team that did not kick off the first half starts the
      // second, and sides swap. Swapping sides is the reason every pairing is
      // played twice in a tournament rather than trusting one match.
      this.world.kickOff(half === 1 ? 'cyan' : 'yellow');
      this.resetAgents();

      this.world.running = true;
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
