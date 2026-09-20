/**
 * Measuring a robot program, instead of watching it and forming an impression.
 *
 * Watching a match tells you a robot is bad. It does not tell you that the
 * robot is wholly outside the playing area for a quarter of the match, that
 * every kick-off it takes is illegal, or that half its shots are geometrically
 * perfect and hit a defender at a metre. Those are the things that are wrong,
 * they are all invisible at normal speed, and none of them are guessable from
 * a scoreline.
 *
 * So this plays matches headless at better than ten times real time, samples
 * the world underneath the robots rather than asking them what they think, and
 * then — the part that matters — turns the numbers into named findings. A
 * table of percentages is a thing to interpret. "Your striker is wholly out of
 * play 26% of the time, and rule 5.7.1.6 removes a robot for thirty seconds
 * when that lasts 0.8 s" is a thing to fix.
 *
 * Everything here reads the world and nothing writes to it. A harness that can
 * change the match is not measuring it.
 */

import { MatchServer } from '../infra/server';
import { Match } from '../match/match';
import { referenceTeam } from '../infra/reference';
import { botRoster } from '../match/bots';
import { HALF_LENGTH, HALF_WIDTH } from '../sim/field';
import { MOUNT_RADIUS } from '../sim/drive';
import { formatSeedValue, type SeedInput } from '../sim/rand';
import type { MatchAgents } from '../match/match';
import type { TeamId, World } from '../sim/world';
import type { Transport } from '../match/agent';

// ------------------------------------------------------------------- options

export interface BenchOptions {
  /** Which seats the programs under test take. */
  team: TeamId | 'both';
  /** Who fills the other side: 'reference', or the name of a built-in bot. */
  opponent: string;
  seeds: SeedInput[];
  halfSeconds: number;
  /**
   * Noise, drift and camera latency off. False by default, matching the
   * server's own default: a program has to be measured in the world it will
   * actually play in. The noise-free mode is a diagnostic, not a fair one.
   */
  idealSensors: boolean;
  port: number;
  /**
   * A command that starts the programs. `{url}` is replaced with the address
   * they should connect to. Left out, the bench waits for them instead and
   * prints the address to connect to.
   */
  spawn?: string;
  /** How long to wait for the seats to fill, seconds. */
  connectTimeout: number;
  /**
   * Goal difference that ends a match, or `null` for no limit — the default.
   *
   * **Off here, unlike everywhere else.** The bench is a measuring instrument
   * rather than a competition, and the mercy rule truncates the thing it
   * measures: it only ever takes goals off whoever is winning, so an
   * aggregate-goals comparison moves asymmetrically the moment it fires. The
   * duel rig in `scratch/` gates a champion on exactly such a ratio, and a
   * result measured under a cap is not comparable with one measured without.
   *
   * Set it to turn the rule on for a run that wants a venue's conditions.
   */
  mercyMargin?: number | null;
}

/**
 * How long a finished shot waits to learn whether it scored.
 *
 * The referee confirms a goal about 0.15-0.22s after the ball crosses,
 * measured over full matches. Half a second covers that with room, and is far
 * short of the restart, so nothing else can be mistaken for the same goal.
 */
const GOAL_SETTLE_SECONDS = 0.5;

export const DEFAULT_OPTIONS: BenchOptions = {
  team: 'violet',
  opponent: 'reference',
  seeds: [1, 2, 3],
  halfSeconds: 90,
  idealSensors: false,
  port: 0,
  connectTimeout: 30,
  mercyMargin: null,
};

// --------------------------------------------------------------- telemetry

export interface RobotTelemetry {
  id: string;
  team: TeamId;
  /** Whether this robot is one of the programs under test. */
  tested: boolean;
  /** Mean distance up the field towards the goal this robot's team attacks. */
  meanX: number;
  meanZ: number;
  /** Per cent of the match with the ball against the dribbler. */
  possession: number;
  /** Per cent within a robot's length of the ball. */
  nearBall: number;
  attackThird: number;
  ownThird: number;
  /** Per cent with any part of the robot past a line. Normal near the goal. */
  outsideLines: number;
  /** Per cent wholly outside the playing area. Rule 5.7.1.6 territory. */
  whollyOut: number;
  /** Per cent with the wheels turning and the robot not moving. */
  stalled: number;
  metresTravelled: number;
  meanSpeed: number;
  /** Control cycles where no fresh command arrived, and the worst unbroken run. */
  missed: number;
  worstRun: number;
  errors: number;
  /** Times the referee took this robot off, by rule. */
  removals: Record<string, number>;
  /**
   * Per cent of ticks this robot told its team mate where the ball was
   * (rule 4.2.5) - any `say` whose body carried a non-null `ball`, whatever
   * shape a program chooses to put it in. Ground truth is what a program
   * actually put on the wire, not whether it meant to.
   */
  relayed: number;
  /**
   * Per cent of ticks another robot's shell sat on the line between this one
   * and the ball - a geometric stand-in for "the IR ring is almost certainly
   * occluded right now", computed from the world rather than from any
   * sensor's own noise model.
   */
  blocked: number;
  /**
   * Of the ticks counted in `blocked`, the per cent where the team mate was
   * relaying a ball position at the same tick - the number that actually says
   * whether the radio is covering the blind spots it exists for, rather than
   * just being switched on.
   */
  covered: number;
}

export interface KickOffTelemetry {
  team: TeamId;
  /** The robot that had to strike the ball. */
  striker: string;
  resolution: 'struck' | 'rolled-clear' | 'illegal' | 'timeout' | 'removed';
  /** Seconds from kick-off until the kicker fired, 0 if it never did. */
  timeToStrike: number;
  /** Furthest the ball got from centre while the striker was still touching it. */
  maxCarry: number;
  /** Ball distance from centre when the referee called it (illegal only). */
  carryAtCall: number;
  /**
   * Smallest heading error to the ball while touching it, degrees. Below ~34°
   * (0.6 rad, the gate's arc) the ball was physically in the gate and the
   * kicker could have fired; above it the approach was pointing the wrong way.
   */
  headingErrorDeg: number;
  /** Whether the striker ever asked for the kicker during the window. */
  kickerRequested: boolean;
  /** Whether the kicker was ever charged (cooldown zero) during the window. */
  everCharged: boolean;
  /** Ticks the ball actually sat in the gate (arc and within the mouth). */
  gateHeldTicks: number;
  /** Ticks it was fireable: asked for, charged, and in the gate at once. */
  fireableTicks: number;
  /** Length of the window, seconds from kick-off to resolution. */
  windowSec: number;
  /** Closest the striker ever got to the ball, mm contact-to-contact. */
  closestGap: number;
}

export interface KickTelemetry {
  total: number;
  goals: number;
  /** On target when it left, and it went in off the back wall. */
  intoMouth: number;
  /** On target when it left, and it ended up out of play. Something blocked it. */
  blockedOut: number;
  /** Not on target when it left. The program fired at something that was not the goal. */
  offTarget: number;
  stoppedInPlay: number;
  meanRange: number;
}

export interface BallTelemetry {
  /** Mean distance up the field towards the goal the tested side attacks. */
  meanX: number;
  inTestedAttackThird: number;
  inTestedOwnThird: number;
  outOfPlay: number;
  overSideline: number;
  overEndline: number;
  /** Who touched it last before it left, by robot id. */
  outByRobot: Record<string, number>;
  /** Out of plays where the ball was travelling fast: a shot rather than a dribble. */
  outWhileFast: number;
  /**
   * Spatial histogram of ball position along the pitch (-1000 mm to +1000 mm),
   * signed towards the attacking goal of the team under test.
   */
  distribution?: {
    parkedPercent: number;
    bins: { min: number; max: number; label: string; percent: number }[];
  };
}

export interface SensorAudit {
  /** Per cent of ticks the ring saw the ball at all. */
  irVisible: number;
  irBearingErrorDeg: number;
  /** Per cent of sightings where strength read 1.0 and carried no range. */
  irSaturated: number;
  cameraBallVisible: number;
  cameraRangeErrorMm: number;
  /** Per cent of sonar beams that came back with nothing. */
  sonarSilent: number;
  /** Per cent of ticks with at least one downward sensor over the white line. */
  lineUnderChassis: number;
}

export interface MatchScore {
  seed: SeedInput;
  for: number;
  against: number;
  half1?: { for: number; against: number };
  half2?: { for: number; against: number };
}

export interface BenchResult {
  matches: number;
  halfSeconds: number;
  idealSensors: boolean;
  opponent: string;
  tested: string[];
  /** Goals, per match, for and against the programs under test. */
  goalsFor: number;
  goalsAgainst: number;
  /** Goals per match in Half 1, for and against the programs under test. */
  half1GoalsFor?: number;
  half1GoalsAgainst?: number;
  /** Goals per match in Half 2, for and against the programs under test. */
  half2GoalsFor?: number;
  half2GoalsAgainst?: number;
  /** Referee calls per match, by kind. */
  calls: Record<string, number>;
  /** Calls per match charged to the team under test. */
  callsAgainstUs: Record<string, number>;
  ball: BallTelemetry;
  kicks: Record<string, KickTelemetry>;
  robots: Record<string, RobotTelemetry>;
  /** Every kick-off observed, across all seeds, with how it was resolved. */
  kickoffs: KickOffTelemetry[];
  findings: Finding[];
  /** Per-seed scorelines, so a result that hangs on one match is obvious. */
  scores: MatchScore[];
}

export interface Finding {
  severity: 'high' | 'medium' | 'low';
  /** Robot id, team, or 'match'. */
  subject: string;
  code: string;
  message: string;
  /** What to do about it, when there is a specific thing. */
  advice?: string;
}

// ------------------------------------------------------------------ sampling

const NEAR_BALL = 80;
const THIRD = HALF_LENGTH / 3;

interface Accumulator {
  samples: number;
  x: number;
  z: number;
  possession: number;
  nearBall: number;
  attackThird: number;
  ownThird: number;
  outsideLines: number;
  whollyOut: number;
  stalled: number;
  travelled: number;
  speed: number;
  lastX: number;
  lastZ: number;
  removals: Record<string, number>;
  wasRemoved: boolean;
  relayed: number;
  blocked: number;
  blockedCovered: number;
}

function blank(x: number, z: number): Accumulator {
  return {
    samples: 0, x: 0, z: 0, possession: 0, nearBall: 0, attackThird: 0, ownThird: 0,
    outsideLines: 0, whollyOut: 0, stalled: 0, travelled: 0, speed: 0,
    lastX: x, lastZ: z, removals: {}, wasRemoved: false,
    relayed: 0, blocked: 0, blockedCovered: 0,
  };
}

/** Whether a `say` payload told the team mate a ball position, in any shape. */
export function relaying(say: unknown): boolean {
  if (!say || typeof say !== 'object') return false;
  return (say as { ball?: unknown }).ball != null;
}

/** Squared distance from point P to the segment AB, and where along it. */
function pointToSegment(
  px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): { t: number; dist: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return { t, dist: Math.hypot(px - cx, pz - cz) };
}

/**
 * Whether some other robot's shell sits between this one and the ball.
 *
 * A ground-truth stand-in for "the IR ring cannot see the ball right now",
 * the same reasoning `sense.py`'s `Locator` and `obstacle_range` use for
 * sonar occlusion, applied here to the ball sightline instead: an obstruction
 * strictly between the two, close enough to the line between them to plausibly
 * block a ring reading. Whichever robot causes it, a team mate with a clear
 * view is the thing that can fix it - an opponent standing in the way blocks
 * the ring exactly as well as this robot's own team mate does.
 */
export function ballBlocked(
  robot: { id: string; x: number; z: number },
  ball: { x: number; z: number; radius: number },
  others: readonly { id: string; x: number; z: number; radius: number; removed: boolean }[],
): boolean {
  for (const o of others) {
    if (o.id === robot.id || o.removed) continue;
    const { t, dist } = pointToSegment(o.x, o.z, robot.x, robot.z, ball.x, ball.z);
    if (t > 0.05 && t < 0.95 && dist < o.radius + ball.radius) return true;
  }
  return false;
}

/** The other robot on this one's own team, e.g. `violet-1` -> `violet-2`. */
export function partnerId(id: string): string {
  const dash = id.lastIndexOf('-');
  const team = id.slice(0, dash);
  const number = id.slice(dash + 1);
  return `${team}-${number === '1' ? '2' : '1'}`;
}

/**
 * One match's worth of ground truth, gathered a physics step at a time.
 *
 * Sampled from the world rather than from the sensor frames on purpose. The
 * question a harness answers is "what did the robot actually do", and a robot
 * that believes it is on its own goal line while standing on the halfway mark
 * will report the goal line. The one place that reads sensors is the audit,
 * and it reads them precisely so it can be compared against the truth beside
 * it.
 */
export class Sampler {
  readonly robots = new Map<string, Accumulator>();
  readonly kicks = new Map<string, KickTelemetry>();
  ballSamples = 0;
  ballParked = 0;
  readonly ballHist: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  ballX = 0;
  ballAttack = 0;
  ballOwn = 0;
  outOfPlay = 0;
  overSideline = 0;
  overEndline = 0;
  outWhileFast = 0;
  readonly outByRobot: Record<string, number> = {};
  readonly calls: Record<string, number> = {};
  readonly callsByTeam: Record<string, Record<string, number>> = {};

  private lastTouch = 'none';
  private previous = { x: 0, z: 0, vx: 0, vz: 0 };
  private seenEvents = new Set<unknown>();
  private shot: { by: string; range: number; onTarget: boolean } | null = null;
  /**
   * A finished shot, waiting to find out whether it was a goal.
   *
   * The score does not move at the instant the ball crosses the line - the
   * referee takes about two tenths of a second to confirm it, measured. So by
   * the time the score changes the ball is long out of play and the shot that
   * put it there has already been resolved as something else. Deciding at the
   * moment the ball leaves play is therefore too early, and deciding when the
   * score moves is too late; the shot has to wait out the gap.
   */
  private settling: {
    shot: { by: string; range: number; onTarget: boolean };
    outcome: keyof KickTelemetry;
    at: number;
  } | null = null;
  /** Each side's score as of the last tick, kept apart rather than summed. */
  private scoreSoFar = { violet: 0, lime: 0 };
  readonly kickoffs: KickOffTelemetry[] = [];
  private pendingKO: {
    team: TeamId;
    striker: string;
    struck: boolean;
    timeToStrike: number;
    maxCarry: number;
    lastBallSpeed: number;
    minArc: number;
    kickerRequested: boolean;
    everCharged: boolean;
    gateHeldTicks: number;
    fireableTicks: number;
    minGap: number;
    windowSec: number;
    trace: string[];
  } | null = null;

  constructor(private readonly testedSide: TeamId) {}

  /**
   * Which way is "up the field" for this team, right now.
   *
   * Not a constant, and this is the whole point: rule 1.4/5.4 swaps the ends at
   * half-time, so a fixed `violet ? 1 : -1` names a direction on the carpet
   * rather than a direction of attack, and is wrong for the entire second half.
   * Taking it per tick from the world is what makes "the attacking third" mean
   * the same thing in both halves — otherwise a keeper that never leaves its
   * own goal measures as spending half the match in the opposition's.
   */
  private attackSignFor(world: World, team: TeamId): number {
    return world.attackingGoal(team) === 'yellow' ? 1 : -1;
  }

  step(match: Match): void {
    const world = match.world;
    if (!world.running) return;
    const ball = world.ball;
    const testedSign = this.attackSignFor(world, this.testedSide);

    // Referee calls, read out of a ring buffer that drops its oldest entries,
    // so identity rather than an index is what says whether one is new.
    for (const event of world.events) {
      if (this.seenEvents.has(event)) continue;
      this.seenEvents.add(event);
      this.calls[event.kind] = (this.calls[event.kind] ?? 0) + 1;
      const team = (event as { team?: string }).team;
      if (team) {
        (this.callsByTeam[team] ??= {})[event.kind] =
          ((this.callsByTeam[team] ??= {})[event.kind] ?? 0) + 1;
      }
      if (event.kind === 'ball-out-of-play') {
        // The referee has already moved the ball by now, so where it went out
        // is the position from the step before this one.
        this.outOfPlay++;
        if (Math.abs(this.previous.z) > HALF_WIDTH) this.overSideline++;
        else if (Math.abs(this.previous.x) > HALF_LENGTH) this.overEndline++;
        if (Math.hypot(this.previous.vx, this.previous.vz) > 800) this.outWhileFast++;
        this.outByRobot[this.lastTouch] = (this.outByRobot[this.lastTouch] ?? 0) + 1;
      }
      if (event.kind === 'possible-damaged') {
        const id = (event as { robotId?: string }).robotId;
        const rule = event.rule;
        if (id) {
          const acc = this.robots.get(id);
          if (acc) acc.removals[rule] = (acc.removals[rule] ?? 0) + 1;
        }
      }
      if (event.kind === 'kickoff') {
        const team = (event as { team?: TeamId }).team;
        if (team) this.openKickOff(world, team);
      }
      if (event.kind === 'illegal-kickoff') {
        const team = (event as { team?: TeamId }).team;
        if (team && this.pendingKO?.team === team) {
          this.closeKickOff('illegal', Math.hypot(ball.x, ball.z));
        }
      }
    }

    this.trackKickOff(match);
    this.trackKick(match);

    this.ballSamples++;
    const signedX = ball.x * testedSign;
    // Signed towards the goal under attack, not towards +x, so the two halves
    // average together instead of cancelling out.
    this.ballX += signedX;
    if (signedX > THIRD) this.ballAttack++;
    if (signedX < -THIRD) this.ballOwn++;

    if (Math.abs(ball.x) < 1 && Math.abs(ball.z) < 1) {
      this.ballParked++;
    } else {
      const idx = Math.max(0, Math.min(9, Math.floor((signedX + 1000) / 200)));
      this.ballHist[idx] = (this.ballHist[idx] ?? 0) + 1;
    }

    for (const robot of world.robots) {
      const acc = this.robots.get(robot.id) ?? blank(robot.x, robot.z);
      this.robots.set(robot.id, acc);
      if (robot.removed) {
        acc.wasRemoved = true;
        continue;
      }
      acc.samples++;
      acc.x += robot.x * this.attackSignFor(world, robot.team);
      acc.z += robot.z;
      const gap = Math.hypot(ball.x - robot.x, ball.z - robot.z);
      if (gap < robot.radius + ball.radius + NEAR_BALL) acc.nearBall++;
      if (gap <= robot.radius + ball.radius + 12) {
        const bearing = Math.atan2(ball.z - robot.z, ball.x - robot.x) - robot.heading;
        if (Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) < 0.6) acc.possession++;
        this.lastTouch = robot.id;
      }
      if (
        Math.abs(robot.x) + robot.radius > HALF_LENGTH ||
        Math.abs(robot.z) + robot.radius > HALF_WIDTH
      ) {
        acc.outsideLines++;
      }
      if (
        Math.abs(robot.x) - robot.radius > HALF_LENGTH ||
        Math.abs(robot.z) - robot.radius > HALF_WIDTH
      ) {
        acc.whollyOut++;
      }
      const speed = Math.hypot(robot.vx, robot.vz);
      acc.speed += speed;
      /*
       * Wheels turning with the chassis going nowhere: a scrum, or a robot
       * pushing something it cannot move.
       *
       * The rotation has to come out first. A robot turning on the spot has
       * every wheel running at omega x the mount radius and no translation at
       * all, which is not a stall — it is a robot turning on the spot, and
       * counting it as one reported a perfectly healthy keeper as stuck for a
       * fifth of the match. What is left after subtracting the turn is wheel
       * travel the robot did not convert into going anywhere.
       */
      const turning = robot.wheelSpeeds.reduce((a, w) => a + Math.abs(w), 0) / 4;
      const fromSpin = Math.abs(robot.omega) * MOUNT_RADIUS;
      if (turning - fromSpin > 180 && speed < 40) acc.stalled++;
      acc.travelled += Math.hypot(robot.x - acc.lastX, robot.z - acc.lastZ);
      acc.lastX = robot.x;
      acc.lastZ = robot.z;
      const sign = this.attackSignFor(world, robot.team);
      if (robot.x * sign > THIRD) acc.attackThird++;
      if (robot.x * sign < -THIRD) acc.ownThird++;

      if (relaying(match.actuators[robot.id]?.say)) acc.relayed++;
      if (ballBlocked(robot, ball, world.robots)) {
        acc.blocked++;
        if (relaying(match.actuators[partnerId(robot.id)]?.say)) acc.blockedCovered++;
      }
    }

    this.previous = { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz };
  }

  /**
   * Kicks, and what became of them.
   *
   * A discharge is not reported anywhere, so it is inferred: nothing else on
   * this field takes the ball from walking pace to better than two metres a
   * second in one step. Whether the shot was on target is answered from the
   * ball's position and the shooter's heading at that instant, which separates
   * the two very different faults. A shot that was never on target means the
   * program fired at something that was not the goal. A shot that WAS on
   * target and still went out means something got in the way — and a blocked
   * shot from a metre out rebounds into the out area about half the time,
   * which under rule 5.9.2 hands the ball back on a neutral point.
   */
  private trackKick(match: Match): void {
    const world = match.world;
    const ball = world.ball;
    const was = Math.hypot(this.previous.vx, this.previous.vz);
    const now = Math.hypot(ball.vx, ball.vz);

    if (now > 2000 && was < 1500) {
      let by = 'unknown';
      let best = Infinity;
      for (const robot of world.robots) {
        if (robot.removed) continue;
        const gap = Math.hypot(ball.x - robot.x, ball.z - robot.z);
        if (gap < best) {
          best = gap;
          by = robot.id;
        }
      }
      const shooter = world.robots.find((r) => r.id === by);
      if (shooter) {
        const dx = Math.cos(shooter.heading);
        const dz = Math.sin(shooter.heading);
        const goalX = dx > 0 ? HALF_LENGTH : -HALF_LENGTH;
        /*
         * A kick fired within a few degrees of the goal line is not a shot at
         * any range: the distance to a line you are running parallel to goes
         * to infinity, and it reported a thirty-metre shot on a field two
         * metres long. Anything this square to the end of the field is aimed
         * at a sideline, so it is off target and its range is not a number
         * worth having.
         */
        const square = Math.abs(dx) < 0.08;
        const travel = square ? 0 : (goalX - ball.x) / dx;
        const crossZ = travel > 0 ? ball.z + dz * travel : NaN;
        if (this.shot) this.record(this.shot, 'stoppedInPlay');
        this.shot = {
          by,
          range: travel > 0 ? travel : 0,
          onTarget: !square && travel > 0 && Math.abs(crossZ) < 204,
        };
      }
    }

    // Whoever scored, it was not whoever happened to kick next. Settle any
    // shot that is waiting on the referee before looking at this tick.
    if (this.settling) {
      const scorer = world.score.violet > this.scoreSoFar.violet
        ? 'violet'
        : world.score.lime > this.scoreSoFar.lime
          ? 'lime'
          : null;
      if (scorer) {
        // A goal, and it belongs to the shot that was in the air - but only if
        // that shot came from the side that scored. Crediting it regardless is
        // what made the table report the two teams' goals almost exactly
        // swapped: the kick after a goal is the kick-OFF, and a kick-off is
        // taken by the team that just conceded.
        this.record(
          this.settling.shot,
          this.settling.shot.by.startsWith(scorer) ? 'goals' : this.settling.outcome,
        );
        this.settling = null;
      } else if (world.clock - this.settling.at > GOAL_SETTLE_SECONDS) {
        this.record(this.settling.shot, this.settling.outcome);
        this.settling = null;
      }
    }
    this.scoreSoFar = { violet: world.score.violet, lime: world.score.lime };

    if (!this.shot) return;
    if (Math.abs(ball.x) > HALF_LENGTH || Math.abs(ball.z) > HALF_WIDTH) {
      const intoMouth = Math.abs(ball.z) < 220 && Math.abs(ball.x) > HALF_LENGTH;
      // Not recorded yet: the referee has not said whether this was a goal.
      this.settling = {
        shot: this.shot,
        outcome: intoMouth ? 'intoMouth' : this.shot.onTarget ? 'blockedOut' : 'offTarget',
        at: world.clock,
      };
      this.shot = null;
    } else if (now < 250) {
      this.record(this.shot, this.shot.onTarget ? 'stoppedInPlay' : 'offTarget');
      this.shot = null;
    }
  }

  /**
   * Kick-offs, and how they resolved.
   *
   * A kick-off is a window: the kicker must open a 50 mm gap to the ball
   * before the striker carries it more than 120 mm off the centre spot. The
   * referee's check is four lines of geometry, which tells you nothing about
   * *why* a kick-off went wrong. The interesting questions are whether the
   * kicker ever fired — it is usually still charging a second or so after a
   * restart — how long the striker waited before firing, and how far the ball
   * was carried in the meantime. A discharge is not reported anywhere, so it
   * is inferred from the ball's velocity jumping past two metres a second,
   * the same way :meth:`trackKick` does.
   */
  private openKickOff(world: World, team: TeamId): void {
    this.closeKickOff('timeout');
    this.pendingKO = {
      team,
      striker:
        world.robots.find((r) => r.team === team && !r.isGoalie && !r.removed)?.id ?? '',
      struck: false,
      timeToStrike: 0,
      maxCarry: 0,
      lastBallSpeed: Math.hypot(world.ball.vx, world.ball.vz),
      minArc: Infinity,
      kickerRequested: false,
      everCharged: false,
      gateHeldTicks: 0,
      fireableTicks: 0,
      minGap: Infinity,
      windowSec: 0,
      trace: [] as string[],
    };
  }

  private closeKickOff(resolution: KickOffTelemetry['resolution'], carryAtCall = 0): void {
    if (!this.pendingKO) return;
    if (process.env.RJC_TRACE_KO && resolution === 'illegal') {
      // eslint-disable-next-line no-console
      console.error(`KO ${resolution} ${this.pendingKO.striker}:`);
      for (const line of this.pendingKO.trace) console.error(`  ${line}`);
    }
    this.kickoffs.push({
      team: this.pendingKO.team,
      striker: this.pendingKO.striker,
      resolution,
      timeToStrike: this.pendingKO.struck ? this.pendingKO.timeToStrike : 0,
      maxCarry: Math.round(this.pendingKO.maxCarry),
      carryAtCall: Math.round(carryAtCall),
      headingErrorDeg:
        this.pendingKO.minArc === Infinity ? 0 : Math.round((this.pendingKO.minArc * 180) / Math.PI),
      kickerRequested: this.pendingKO.kickerRequested,
      everCharged: this.pendingKO.everCharged,
      gateHeldTicks: this.pendingKO.gateHeldTicks,
      fireableTicks: this.pendingKO.fireableTicks,
      windowSec: Math.round(this.pendingKO.windowSec * 100) / 100,
      closestGap: Math.round(this.pendingKO.minGap === Infinity ? -1 : this.pendingKO.minGap),
    });
    this.pendingKO = null;
  }

  private trackKickOff(match: Match): void {
    const world = match.world;
    const pending = this.pendingKO;
    if (!pending) return;
    const ball = world.ball;
    const speed = Math.hypot(ball.vx, ball.vz);
    // A discharge first, so a strike that clears the window the same tick it
    // fires is still counted as struck.
    if (speed > 2000 && pending.lastBallSpeed < 1500) {
      pending.struck = true;
      pending.timeToStrike = world.sinceKickOff;
    }
    pending.lastBallSpeed = speed;
    const act = match.actuators[pending.striker];

    const striker = world.robots.find((r) => r.id === pending.striker);
    if (striker) {
      const gap =
        Math.hypot(ball.x - striker.x, ball.z - striker.z) - (striker.radius + ball.radius);
      pending.minGap = Math.min(pending.minGap, gap);
      // The referee's own "still touching" line (5.4.7): carry is ball carried
      // while the striker is within 35 mm of it.
      if (gap < 35) {
        pending.maxCarry = Math.max(pending.maxCarry, Math.hypot(ball.x, ball.z));
        const bearingToBall = Math.atan2(ball.z - striker.z, ball.x - striker.x);
        const arc = Math.abs(
          Math.atan2(
            Math.sin(bearingToBall - striker.heading),
            Math.cos(bearingToBall - striker.heading),
          ),
        );
        pending.minArc = Math.min(pending.minArc, arc);
        const gateSlop = 12; // GATE_SLOP: the ball must sit within this many mm of contact.
        const held = arc < 0.6 && gap <= gateSlop;
        if (held) pending.gateHeldTicks++;
        // The kicker does not fire on geometry alone: the exact instant it
        // leaves needs kicker requested, a charged solenoid, and the gate held
        // all on the same tick. Anything else fires later or not at all, so
        // this is the one number that proves a request was genuinely lost.
        if (act && held && act.kicker && act.kickCooldown === 0) pending.fireableTicks++;
        if (process.env.RJC_TRACE_KO) {
          pending.trace.push(
            `t=${world.sinceKickOff.toFixed(2)} gap=${gap.toFixed(0)}` +
              ` arc=${((arc * 180) / Math.PI).toFixed(1)}° held=${held} carry=${Math.hypot(ball.x, ball.z).toFixed(0)}` +
              ` kicker=${act?.kicker ?? '-'} cd=${act?.kickCooldown?.toFixed(2) ?? '-'}` +
              ` sx=${striker.x.toFixed(0)} sz=${striker.z.toFixed(0)} bx=${ball.x.toFixed(0)} bz=${ball.z.toFixed(0)}`,
          );
        }
      }
    }

    if (act) {
      if (act.kicker) pending.kickerRequested = true;
      if (act.kickCooldown === 0) pending.everCharged = true;
    }
    pending.windowSec = world.sinceKickOff;

    if (!world.restart.pending) {
      // The referee cleared the window without calling a foul: the striker
      // opened the 50 mm gap, the striker was removed, or three seconds
      // elapsed with nothing happening.
      const stillPresent = world.robots.some((r) => r.id === pending.striker && !r.removed);
      this.closeKickOff(
        pending.struck
          ? 'struck'
          : !stillPresent
            ? 'removed'
            : world.sinceKickOff > 3
              ? 'timeout'
              : 'rolled-clear',
      );
    }
  }

  /** Kicks that were on target when they left, for averaging the range over. */
  readonly aimed = new Map<string, number>();

  private record(
    shot: { by: string; range: number; onTarget: boolean },
    outcome: keyof KickTelemetry,
  ): void {
    const bag = this.kicks.get(shot.by) ?? {
      total: 0, goals: 0, intoMouth: 0, blockedOut: 0, offTarget: 0, stoppedInPlay: 0, meanRange: 0,
    };
    bag.total++;
    (bag[outcome] as number)++;
    // Averaged over the shots that were aimed somewhere, so the number means
    // "how far out does this robot shoot from" rather than being dragged
    // around by kicks that were never going to the goal at all.
    if (shot.onTarget) {
      bag.meanRange += shot.range;
      this.aimed.set(shot.by, (this.aimed.get(shot.by) ?? 0) + 1);
    }
    this.kicks.set(shot.by, bag);
  }
}

// ------------------------------------------------------------------- running

function opponentAgents(opponent: string, side: TeamId): Record<string, unknown> {
  if (opponent === 'reference') return referenceTeam(side);
  const bot = botRoster().find((b) => b.name === opponent);
  if (!bot) {
    const names = ['reference', ...botRoster().map((b) => b.name)].join(', ');
    throw new Error(`unknown opponent "${opponent}". try: ${names}`);
  }
  const [one, two] = bot.make(side);
  return { [`${side}-1`]: one, [`${side}-2`]: two };
}

function seatsFor(team: BenchOptions['team']): string[] {
  if (team === 'both') return ['violet-1', 'violet-2', 'lime-1', 'lime-2'];
  return [`${team}-1`, `${team}-2`];
}

/**
 * Play the matches and return everything that happened.
 *
 * The programs are reached the same way a real match reaches them, over the
 * same socket on the same protocol, because a harness that talked to them any
 * other way would be measuring a robot nobody is going to field.
 */
export async function runBench(
  partial: Partial<BenchOptions> = {},
  log: (line: string) => void = () => {},
): Promise<BenchResult> {
  const opts: BenchOptions = { ...DEFAULT_OPTIONS, ...partial };
  const seats = seatsFor(opts.team);
  const testedSide: TeamId = opts.team === 'both' ? 'violet' : opts.team;
  const otherSide: TeamId = testedSide === 'violet' ? 'lime' : 'violet';

  const server = new MatchServer({
    port: opts.port,
    realtime: false,
    idealSensors: opts.idealSensors,
  });
  const port = await server.listen();
  /*
   * A plain TCP address, deliberately, and not `server.agentSocketUrl`.
   *
   * That Unix socket exists for a sandboxed, network-less submission at match
   * time. Nothing here is sandboxed: `--spawn` runs a command the user typed
   * through a shell, and with no `--spawn` this address is printed for a
   * person to paste into their own robot. Both need somewhere anything can
   * dial. Handing out `unix://...?path=` instead worked only for programs
   * built on `python/machine/_ws.py`, which understands that convention -
   * every other language, including the one-line Node agents this file's own
   * tests use, cannot open it at all, and a person cannot type it.
   */
  const url = `ws://localhost:${port}/agent`;

  let child: import('node:child_process').ChildProcess | null = null;
  try {
    if (opts.spawn) {
      const { spawn } = await import('node:child_process');
      child = spawn(opts.spawn.replaceAll('{url}', url), { shell: true, stdio: 'ignore' });
      log(`  started: ${opts.spawn.replaceAll('{url}', url)}`);
    } else {
      log(`  waiting for ${seats.join(', ')} on ${url}`);
    }

    await waitForSeats(server, seats, opts.connectTimeout);
    log(`  seats filled: ${seats.join(', ')}`);

    const samplers: Sampler[] = [];
    const scores: BenchResult['scores'] = [];
    const slotReports: Record<string, { missed: number; worstRun: number; errors: number }> = {};

    for (const seed of opts.seeds) {
      const sampler = new Sampler(testedSide);
      samplers.push(sampler);

      const agents = {
        ...(opts.team === 'both' ? referenceTeam('violet') : {}),
        ...(opts.team === 'both'
          ? referenceTeam('lime')
          : { ...opponentAgents(opts.opponent, otherSide), ...referenceTeam(testedSide) }),
      } as unknown as MatchAgents;

      // Only the seats under test are driven from outside. Anything else that
      // happens to be connected is ignored rather than quietly replacing the
      // opponent, which is what makes `--team violet` mean what it says even
      // when the launcher started all four robots.
      const all = server.agents.transports();
      const transports = Object.fromEntries(
        seats.filter((id) => all[id]).map((id) => [id, all[id]!]),
      );

      const result = await server.play({
        agents,
        transports,
        halfSeconds: opts.halfSeconds,
        seed,
        idealSensors: opts.idealSensors,
        mercyMargin: opts.mercyMargin ?? null,
        observe: (match) => sampler.step(match),
      });

      const h1For = result.goals.filter((g) => g.team === testedSide && g.half === 1).length;
      const h1Against = result.goals.filter((g) => g.team === otherSide && g.half === 1).length;
      const h2For = result.goals.filter((g) => g.team === testedSide && g.half === 2).length;
      const h2Against = result.goals.filter((g) => g.team === otherSide && g.half === 2).length;

      scores.push({
        seed,
        for: result.score[testedSide],
        against: result.score[otherSide],
        half1: { for: h1For, against: h1Against },
        half2: { for: h2For, against: h2Against },
      });
      for (const id of seats) {
        const slot = result.slots[id];
        if (!slot) continue;
        const bag = (slotReports[id] ??= { missed: 0, worstRun: 0, errors: 0 });
        bag.missed += slot.missed;
        bag.worstRun = Math.max(bag.worstRun, slot.worstRun);
        bag.errors += slot.errors;
      }
      log(
        `  seed ${formatSeedValue(seed)}: ${result.score[testedSide]} - ${result.score[otherSide]}` +
          `  (H1: ${h1For}-${h1Against}, H2: ${h2For}-${h2Against})`,
      );
    }

    return aggregate(opts, seats, testedSide, samplers, scores, slotReports);
  } finally {
    child?.kill();
    await server.close();
  }
}

/**
 * Wait for exactly these seat ids to connect — not necessarily all four.
 *
 * "Connected", not "present". A seat outlives the socket that claimed it,
 * because during a match a program going quiet is rule 5.7's business rather
 * than a withdrawal — so a caller that restarts a program and then waits for
 * its seat was answered instantly by the seat the *old* program left behind,
 * and went on to play a match against a transport with nothing on the end of
 * it. Waiting for a live one is what every caller here already meant.
 */
export function waitForSeats(server: MatchServer, seats: string[], timeout: number): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  const live = (have: Partial<Record<string, Transport>>, id: string): boolean =>
    have[id] !== undefined && have[id]!.connected !== false;
  return new Promise((ok, fail) => {
    const poll = (): void => {
      const have = server.agents.transports();
      if (seats.every((s) => live(have, s))) {
        ok();
        return;
      }
      if (Date.now() > deadline) {
        const missing = seats.filter((s) => !live(have, s));
        fail(new Error(`no program connected for ${missing.join(', ')} within ${timeout}s`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

// --------------------------------------------------------------- aggregating

const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10);

function aggregate(
  opts: BenchOptions,
  seats: string[],
  testedSide: TeamId,
  samplers: Sampler[],
  scores: BenchResult['scores'],
  slotReports: Record<string, { missed: number; worstRun: number; errors: number }>,
): BenchResult {
  const n = samplers.length;
  const sum = <T>(pick: (s: Sampler) => T extends number ? number : never): number =>
    samplers.reduce((a, s) => a + (pick(s) as unknown as number), 0);

  const ballSamples = sum((s) => s.ballSamples as never);
  const calls: Record<string, number> = {};
  const callsAgainstUs: Record<string, number> = {};
  for (const sampler of samplers) {
    for (const [kind, count] of Object.entries(sampler.calls)) {
      calls[kind] = (calls[kind] ?? 0) + count / n;
    }
    for (const [kind, count] of Object.entries(sampler.callsByTeam[testedSide] ?? {})) {
      callsAgainstUs[kind] = (callsAgainstUs[kind] ?? 0) + count / n;
    }
  }
  for (const key of Object.keys(calls)) calls[key] = Math.round(calls[key]! * 10) / 10;
  for (const key of Object.keys(callsAgainstUs)) {
    callsAgainstUs[key] = Math.round(callsAgainstUs[key]! * 10) / 10;
  }

  const outByRobot: Record<string, number> = {};
  for (const sampler of samplers) {
    for (const [id, count] of Object.entries(sampler.outByRobot)) {
      outByRobot[id] = Math.round(((outByRobot[id] ?? 0) + count / n) * 10) / 10;
    }
  }

  const robots: Record<string, RobotTelemetry> = {};
  const ids = new Set<string>();
  for (const sampler of samplers) for (const id of sampler.robots.keys()) ids.add(id);
  for (const id of ids) {
    const parts = samplers.map((s) => s.robots.get(id)).filter((a): a is Accumulator => !!a);
    const samples = parts.reduce((a, p) => a + p.samples, 0);
    const removals: Record<string, number> = {};
    for (const part of parts) {
      for (const [rule, count] of Object.entries(part.removals)) {
        removals[rule] = Math.round(((removals[rule] ?? 0) + count / n) * 10) / 10;
      }
    }
    const slot = slotReports[id];
    robots[id] = {
      id,
      team: id.startsWith('violet') ? 'violet' : 'lime',
      tested: seats.includes(id),
      meanX: Math.round(parts.reduce((a, p) => a + p.x, 0) / Math.max(1, samples)),
      meanZ: Math.round(parts.reduce((a, p) => a + p.z, 0) / Math.max(1, samples)),
      possession: pct(parts.reduce((a, p) => a + p.possession, 0), samples),
      nearBall: pct(parts.reduce((a, p) => a + p.nearBall, 0), samples),
      attackThird: pct(parts.reduce((a, p) => a + p.attackThird, 0), samples),
      ownThird: pct(parts.reduce((a, p) => a + p.ownThird, 0), samples),
      outsideLines: pct(parts.reduce((a, p) => a + p.outsideLines, 0), samples),
      whollyOut: pct(parts.reduce((a, p) => a + p.whollyOut, 0), samples),
      stalled: pct(parts.reduce((a, p) => a + p.stalled, 0), samples),
      metresTravelled: Math.round(parts.reduce((a, p) => a + p.travelled, 0) / n / 1000),
      meanSpeed: Math.round(parts.reduce((a, p) => a + p.speed, 0) / Math.max(1, samples)),
      missed: Math.round((slot?.missed ?? 0) / n),
      worstRun: slot?.worstRun ?? 0,
      errors: Math.round((slot?.errors ?? 0) / n),
      removals,
      relayed: pct(parts.reduce((a, p) => a + p.relayed, 0), samples),
      blocked: pct(parts.reduce((a, p) => a + p.blocked, 0), samples),
      covered: pct(
        parts.reduce((a, p) => a + p.blockedCovered, 0),
        parts.reduce((a, p) => a + p.blocked, 0),
      ),
    };
  }

  const kicks: Record<string, KickTelemetry> = {};
  const aimedCounts: Record<string, number> = {};
  for (const sampler of samplers) {
    for (const [id, bag] of sampler.kicks) {
      const into = (kicks[id] ??= {
        total: 0, goals: 0, intoMouth: 0, blockedOut: 0, offTarget: 0, stoppedInPlay: 0, meanRange: 0,
      });
      into.total += bag.total;
      into.goals += bag.goals;
      into.intoMouth += bag.intoMouth;
      into.blockedOut += bag.blockedOut;
      into.offTarget += bag.offTarget;
      into.stoppedInPlay += bag.stoppedInPlay;
      into.meanRange += bag.meanRange;
      aimedCounts[id] = (aimedCounts[id] ?? 0) + (sampler.aimed.get(id) ?? 0);
    }
  }
  for (const [id, bag] of Object.entries(kicks)) {
    bag.meanRange = Math.round(bag.meanRange / Math.max(1, aimedCounts[id] ?? 0));
    for (const key of ['total', 'goals', 'intoMouth', 'blockedOut', 'offTarget', 'stoppedInPlay'] as const) {
      bag[key] = Math.round((bag[key] / n) * 10) / 10;
    }
  }

  const totalParked = sum((s) => s.ballParked as never);
  const histCounts = Array.from({ length: 10 }, (_, i) =>
    sum((s) => (s.ballHist[i] ?? 0) as never),
  );
  const BIN_RANGES: [number, number, string][] = [
    [-1000, -800, 'own goal'],
    [-800, -600, 'def zone'],
    [-600, -400, 'def third'],
    [-400, -200, 'def mid'],
    [-200, 0, 'def centre'],
    [0, 200, 'att centre'],
    [200, 400, 'att mid'],
    [400, 600, 'att third'],
    [600, 800, 'att zone'],
    [800, 1000, 'opp goal'],
  ];
  const distribution = {
    parkedPercent: pct(totalParked, ballSamples),
    bins: BIN_RANGES.map(([min, max, label], i) => ({
      min,
      max,
      label,
      percent: pct(histCounts[i] ?? 0, ballSamples),
    })),
  };

  const result: BenchResult = {
    matches: n,
    halfSeconds: opts.halfSeconds,
    idealSensors: opts.idealSensors,
    opponent: opts.team === 'both' ? 'itself' : opts.opponent,
    tested: seats,
    goalsFor: Math.round((scores.reduce((a, s) => a + s.for, 0) / n) * 10) / 10,
    goalsAgainst: Math.round((scores.reduce((a, s) => a + s.against, 0) / n) * 10) / 10,
    half1GoalsFor: Math.round((scores.reduce((a, s) => a + (s.half1?.for ?? 0), 0) / n) * 10) / 10,
    half1GoalsAgainst: Math.round((scores.reduce((a, s) => a + (s.half1?.against ?? 0), 0) / n) * 10) / 10,
    half2GoalsFor: Math.round((scores.reduce((a, s) => a + (s.half2?.for ?? 0), 0) / n) * 10) / 10,
    half2GoalsAgainst: Math.round((scores.reduce((a, s) => a + (s.half2?.against ?? 0), 0) / n) * 10) / 10,
    calls,
    callsAgainstUs,
    ball: {
      meanX: Math.round(sum((s) => s.ballX as never) / Math.max(1, ballSamples)),
      inTestedAttackThird: pct(sum((s) => s.ballAttack as never), ballSamples),
      inTestedOwnThird: pct(sum((s) => s.ballOwn as never), ballSamples),
      outOfPlay: Math.round((sum((s) => s.outOfPlay as never) / n) * 10) / 10,
      overSideline: Math.round((sum((s) => s.overSideline as never) / n) * 10) / 10,
      overEndline: Math.round((sum((s) => s.overEndline as never) / n) * 10) / 10,
      outWhileFast: Math.round((sum((s) => s.outWhileFast as never) / n) * 10) / 10,
      outByRobot,
      distribution,
    },
    kicks,
    robots,
    kickoffs: samplers.flatMap((s) => s.kickoffs),
    findings: [],
    scores,
  };
  result.findings = diagnose(result);
  return result;
}

// ------------------------------------------------------------------ findings

/**
 * Turn the numbers into things to fix.
 *
 * Every check here came from a fault that was actually in a robot in this
 * repository, that was invisible watching the match, and that took a
 * measurement to find. They are written as "this number is wrong, here is the
 * rule it breaks, here is what the fix looked like" rather than as thresholds,
 * because a threshold tells you a number is high and a finding tells you what
 * to do on Monday.
 *
 * Thresholds are deliberately forgiving. A harness that cries wolf gets
 * ignored, and a robot that is 2% worse than ideal at something is a robot
 * that is fine.
 */
/**
 * Everything worth telling a team about a run, worst first.
 *
 * Exported so the calibration of the gates can be tested against made-up
 * scorelines. A finding that never fires is as useless as one that always
 * does, and neither shows up in a run against a robot that plays well.
 */
export function diagnose(r: BenchResult): Finding[] {
  const found: Finding[] = [];
  const add = (f: Finding): void => {
    found.push(f);
  };
  const tested = r.tested.map((id) => r.robots[id]).filter((x): x is RobotTelemetry => !!x);
  const perMatch = (n: number): string => `${n.toFixed(1)} per match`;

  // -- rules the referee is already punishing ------------------------------

  const illegal = r.callsAgainstUs['illegal-kickoff'] ?? 0;
  const kickoffs = r.calls['kickoff'] ?? 0;
  if (illegal > 0.5) {
    const side = r.tested[0]?.slice(0, r.tested[0].indexOf('-')) ?? 'violet';
    const ours = r.kickoffs.filter((k) => k.team === side);
    const bad = ours.filter((k) => k.resolution === 'illegal');
    const maxCarry = bad.length > 0 ? Math.max(...bad.map((k) => k.carryAtCall || k.maxCarry)) : 0;
    let detail = '';
    if (bad.length > 0) {
      const neverAsked = bad.every((k) => !k.kickerRequested);
      const neverCharged = bad.every((k) => !k.everCharged);
      const neverHeld = bad.every((k) => k.gateHeldTicks === 0);
      const maxArc = Math.max(0, ...bad.map((k) => k.headingErrorDeg));
      if (neverAsked) {
        detail =
          ` In every one the striker never even asked for the kicker — the kick-off branch was not ` +
          `running while the window was open, so the robot simply pushed the ball ${maxCarry} mm off ` +
          'the centre spot instead of striking it.';
      } else if (neverCharged) {
        detail =
          ` The striker asked for the kicker the whole time but the window closed before it ever ` +
          `finished recharging — the ball was carried ${maxCarry} mm in ${bad[0]!.windowSec}s, a fraction ` +
          'of the recharge time. The striker must have been shoving the ball while it waited instead of ' +
          'standing square on it: whatever it was steering by had it pushing for the whole window.';
      } else if (neverHeld) {
        detail =
          ` The striker asked for the kicker and it was charged, but the ball never sat in the gate — ` +
          `its heading stayed up to ${maxArc}° off the line to the ball while touching it, so it pushed ` +
          'past instead of holding.';
      } else {
        detail =
          ' The striker asked, charged, and had the ball in the gate at once, yet the kicker never ' +
          'discharged — the request must not be reaching the kicker every tick.';
      }
    }
    add({
      severity: 'high',
      subject: 'team',
      code: 'illegal-kickoff',
      message: `${perMatch(illegal)} illegal kick-offs charged to you, out of ${kickoffs.toFixed(1)} kick-offs (rule 5.4.7).${detail}`,
      advice:
        'A kick-off must be a strike. Pushing cannot work: robot and ball separate by ' +
        'position here, so a shoved ball travels with you and the 50 mm gap never opens. ' +
        'Meet the ball ONCE until the gate says it is held, then STOP and hold the kicker ' +
        'request — the kicker is usually still charging at a restart. If the direction you ' +
        'approach from is wrong, the gate never engages and you push the ball around the ' +
        'centre spot; at a restart your position is fixed, so aim for the ball from the ' +
        'restart geometry, not from a stale position fix.',
    });
  }

  for (const robot of tested) {
    if (robot.whollyOut > 1) {
      add({
        severity: robot.whollyOut > 5 ? 'high' : 'medium',
        subject: robot.id,
        code: 'wholly-out',
        message: `wholly outside the playing area ${robot.whollyOut}% of the match (rule 5.7.1.6 removes a robot that stays there 0.8 s).`,
        advice:
          'Steer by your position estimate, not by the line sensors: the ring reports that ' +
          'the line is underneath you and cannot say which side of it you are on, so ' +
          '"drive away from the line" is right inside the field and drives you off it ' +
          'outside. And stop early — an unpowered robot coasts about 140 mm, so a limit ' +
          'that only forbids going further out is already too late.',
      });
    }
    const removals = Object.entries(robot.removals);
    if (removals.length > 0) {
      add({
        severity: 'high',
        subject: robot.id,
        code: 'removed',
        message: `taken off by the referee: ${removals.map(([rule, n]) => `${rule} ${n}x`).join(', ')} per match.`,
      });
    }
    if (robot.errors > 0) {
      add({
        severity: 'high',
        subject: robot.id,
        code: 'crashing',
        message: `${robot.errors} ticks per match ended in an exception. The last command stands when that happens, so the robot drives on regardless.`,
      });
    }
  }

  // -- is the program even keeping up --------------------------------------

  const cycles = r.halfSeconds * 2 * 50;
  for (const robot of tested) {
    if (robot.missed > cycles * 0.1) {
      add({
        severity: robot.missed > cycles * 0.3 ? 'high' : 'medium',
        subject: robot.id,
        code: 'slow',
        message: `missed ${robot.missed} of ${cycles} control cycles (${pct(robot.missed, cycles)}%), worst unbroken run ${robot.worstRun}.`,
        advice:
          'The previous command stands on a missed cycle, so this is a robot acting on ' +
          'stale decisions. Check the loop is not doing something expensive.',
      });
    }
  }

  // -- driving into things --------------------------------------------------

  for (const robot of tested) {
    if (robot.stalled < 12) continue;
    const nearTheBall = robot.nearBall > 20;
    add({
      severity: robot.stalled > 25 ? 'high' : 'medium',
      subject: robot.id,
      code: 'stalling',
      message: `wheels turning with the robot not moving ${robot.stalled}% of the match.`,
      advice: nearTheBall
        ? 'A scrum over the ball. Rule 5.6.1.2 eventually calls lack of progress on it, ' +
          'and shoving harder never resolves one: notice it and go sideways.'
        : 'Not over the ball, so this is a robot driving into a wall or holding a ' +
          'position by pushing against something. It costs nothing in goals and ' +
          'everything in the time it takes to get anywhere.',
    });
  }

  // -- possession and territory --------------------------------------------

  const striker = tested.find((x) => x.id.endsWith('-1'));
  const keeper = tested.find((x) => x.id.endsWith('-2'));

  if (striker) {
    // The ratio is the tell, not the number. A striker that is never near the
    // ball has a different problem from one that is always near it and never
    // holding it — the second is arriving from the wrong side, every time.
    if (striker.nearBall > 25 && striker.possession < striker.nearBall * 0.28) {
      add({
        severity: 'medium',
        subject: striker.id,
        code: 'no-possession',
        message: `within reach of the ball ${striker.nearBall}% of the match but holding it only ${striker.possession}%.`,
        advice:
          'Near the ball without holding it is a robot arriving from the wrong side. ' +
          'Steer by how far round the ball you are from the line to the goal, and let ' +
          'that angle bend your approach continuously — a threshold ("am I behind it ' +
          'yet?") sits on a noisy quantity and chatters between two plans.',
      });
    }
    if (striker.attackThird < 4 && r.goalsFor < 3) {
      add({
        severity: 'medium',
        subject: striker.id,
        code: 'never-attacks',
        message: `in the attacking third only ${striker.attackThird}% of the match (${striker.meanX} mm up the field on average).`,
      });
    }
  }

  if (keeper) {
    if (keeper.nearBall < 2 && r.ball.inTestedOwnThird > 15) {
      add({
        severity: 'medium',
        subject: keeper.id,
        code: 'absent-keeper',
        message: `within reach of the ball only ${keeper.nearBall}% of the match, though the ball is in your third ${r.ball.inTestedOwnThird}% of it.`,
        advice:
          'Rule 5.8.2 requires a keeper to respond to a ball in its own penalty box with ' +
          'forward movement, and 5.8.3 removes one that does not.',
      });
    }
    if (keeper.attackThird > 8) {
      add({
        severity: 'medium',
        subject: keeper.id,
        code: 'wandering-keeper',
        message: `in the attacking third ${keeper.attackThird}% of the match (${keeper.meanX} mm up the field on average).`,
        advice:
          'The goal it left is bigger than the ball it is chasing. A keeper that ' +
          'dribbles its own clearance up the field is a keeper that is not in goal.',
      });
    }
  }

  // -- teamwork ---------------------------------------------------------------
  // The interesting number is not "blocked" on its own - a robot occluded from
  // the ball some of the time is normal on a crowded field - it is whether the
  // team mate was covering for it when it happened. Forgiving thresholds, same
  // reasoning as the rest of this function: a robot blocked 3% of the match
  // with no relay to show for it has a real gap, not a rounding error.
  for (const robot of tested) {
    if (robot.blocked < 3) continue;
    if (robot.covered < 50) {
      add({
        severity: robot.covered < 20 ? 'medium' : 'low',
        subject: robot.id,
        code: 'uncovered',
        message:
          `blocked from its own view of the ball ${robot.blocked}% of the match, and its ` +
          `team mate was relaying a position for only ${robot.covered}% of those ticks.`,
        advice:
          'Blocked is usually the team mate standing in the way, which is exactly the case ' +
          'radio communication (rule 4.2.5) exists for. If the team mate only relays while ' +
          'confident of its own position, check whether that gate is filtering out relays ' +
          'that would still have been better than nothing.',
      });
    }
  }

  // -- giving the ball away -------------------------------------------------

  const ourOuts = r.tested.reduce((a, id) => a + (r.ball.outByRobot[id] ?? 0), 0);
  if (ourOuts > 8) {
    const shots = r.tested.reduce((a, id) => a + (r.kicks[id]?.blockedOut ?? 0) + (r.kicks[id]?.offTarget ?? 0), 0);
    add({
      severity: ourOuts > 18 ? 'high' : 'medium',
      subject: 'team',
      code: 'ball-out',
      message:
        `you put the ball out of play ${perMatch(ourOuts)} ` +
        `(${r.ball.overSideline.toFixed(1)} over a sideline, ${r.ball.overEndline.toFixed(1)} over an end line; ` +
        `${shots.toFixed(1)} of them were your own kicks).`,
      advice:
        'Every one is a neutral-point restart under rule 5.9.2 — possession handed back ' +
        'for nothing. Most are not wild shots but a robot steadily dribbling the ball ' +
        'over a touchline it never checked: bend the direction you are pushing so the ' +
        'BALL stays in play, not just the robot.',
    });
  }

  for (const id of r.tested) {
    const bag = r.kicks[id];
    if (!bag || bag.total < 2) continue;
    if (bag.offTarget > bag.total * 0.22) {
      add({
        severity: 'high',
        subject: id,
        code: 'wild-shooting',
        message: `${bag.offTarget.toFixed(1)} of ${bag.total.toFixed(1)} kicks per match were not aimed at the goal when they left.`,
        advice:
          'The kicker fires along the robot\'s HEADING, not along the line from the ball ' +
          'to wherever you were aiming. Ray-cast from the ball along the current heading ' +
          'and check it reaches the mouth before it reaches a sideline; do not fire ' +
          'otherwise.',
      });
    } else if (bag.blockedOut > bag.total * 0.3) {
      add({
        severity: 'medium',
        subject: id,
        code: 'blocked-shooting',
        message: `${bag.blockedOut.toFixed(1)} of ${bag.total.toFixed(1)} kicks per match were on target when they left and still went out — mean range ${bag.meanRange} mm.`,
        advice:
          'Something is in the way. A sonar reads the distance to whatever came back ' +
          'first, so an echo that arrives sooner than the wall behind it is a robot: ' +
          'that is how you see a defender. Carry the ball closer, or go round.',
      });
    }
  }

  // -- and the headline -----------------------------------------------------

  if (r.goalsFor === 0) {
    add({
      severity: 'high',
      subject: 'team',
      code: 'no-goals',
      message: `no goals in ${r.matches} matches against ${r.opponent}.`,
    });
  }
  /*
   * The two ends of the field are the same game. Is this program playing them
   * that way?
   *
   * Rule 1.4/5.4 swaps ends at half-time and nothing else about the match
   * changes, so for a team under test half 1 and half 2 ARE its two attack
   * directions - which makes the split already in `scores` the measurement,
   * with no extra matches to play. It is a weak measurement and it is reported
   * as one: goals inside a single match are not independent, so one runaway
   * half contributes several correlated goals and the totals overstate how
   * much has actually been seen. The gate is deliberately coarse for that
   * reason, and the wording asks rather than concludes.
   *
   * It is still worth saying. The defect it looks for is silent - a robot with
   * a sign missing plays a perfectly competent half and an incoherent one, and
   * the half it plays well is whichever end the author happened to test at.
   *
   * Skipped for `--team both`: then the tested programs are on both sides of
   * the match, both halves contain both attack directions, and the split means
   * nothing.
   */
  const onBothSides =
    r.tested.some((id) => id.startsWith('violet')) && r.tested.some((id) => id.startsWith('lime'));
  const halves = r.scores.filter((s) => s.half1 && s.half2);
  if (!onBothSides && halves.length >= 3) {
    const oneEnd = halves.reduce((n, s) => n + s.half1!.for, 0);
    const otherEnd = halves.reduce((n, s) => n + s.half2!.for, 0);
    const total = oneEnd + otherEnd;
    const gap = Math.abs(oneEnd - otherEnd);
    /*
     * Scale the bar with the evidence, rather than picking a ratio.
     *
     * A fixed ratio is wrong at both ends of the sample size. "Three quarters
     * of the goals at one end" fires on 7-3, which is a coin landing the same
     * way ten times out of a possible thirty-four in a hundred - and, tested
     * against the run that started all this, it does NOT fire on 82-33, which
     * was a real bug and is only 71%. A ratio cannot tell those apart because
     * it throws away `total`.
     *
     * Two standard deviations of a fair coin is `sqrt(total)`; the extra half
     * again is for goals inside a match not being independent, which makes the
     * raw count overstate how much has been seen. So: `3 * sqrt(total)`. That
     * fires on 82-33 (gap 49 against a bar of 32), stays quiet on the same
     * agent after the fix (gap 15 against 33), quiet on 7-3, and quiet on a
     * balanced two hundred - which is the behaviour wanted from all four.
     */
    if (total >= 10 && gap >= 3 * Math.sqrt(total)) {
      add({
        severity: 'low',
        subject: 'team',
        code: 'one-sided',
        message:
          `scored ${oneEnd} attacking one end and ${otherEnd} attacking the other ` +
          `(${total} goals over ${halves.length} matches). Nothing about the game changes at ` +
          `half-time except which way you are going, so a gap this size is worth a look - ` +
          `though goals in one match lean on each other, so treat it as a question and not a verdict.`,
        advice:
          'Every rule that reads an x or a z needs to know which way you are attacking, and each ' +
          'one signed by hand is a chance to miss one. Work in attack-relative coordinates ' +
          'instead: GoalFrame.to_frame() turns the field so the goal you are shooting at is ' +
          'always at +x, and both halves become the same code with no sign to remember. See ' +
          '"You change ends at half-time, and your code does not" in python/README.md.',
      });
    }
  }

  const spread = r.scores.map((s) => s.for - s.against);
  if (r.matches > 2 && Math.min(...spread) < 0 && Math.max(...spread) > 0) {
    add({
      severity: 'low',
      subject: 'match',
      code: 'inconsistent',
      message: `results swing either way across seeds (${spread.map((d) => (d > 0 ? `+${d}` : d)).join(', ')}); one match is not evidence here.`,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return found.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ----------------------------------------------------------------- reporting

const BAR = '─'.repeat(74);

/**
 * Calls that are somebody's fault.
 *
 * A kick-off carries a team because somebody takes it, and a goal carries one
 * because somebody scored it; neither is a mark against them. Listing
 * everything that happens to name a team put "kickoff 1" under the heading
 * "charged to you", which is the sort of thing that teaches a reader to stop
 * reading the line.
 */
const OFFENCES = new Set([
  'illegal-kickoff',
  'lack-of-progress',
  'possible-damaged',
  'possible-multiple-defence',
]);

function row(label: string, ...cells: (string | number)[]): string {
  return `  ${label.padEnd(16)}${cells.map((c) => String(c).padStart(10)).join('')}`;
}

/**
 * The report a person reads, and the one a language model reads.
 *
 * Deliberately the same text for both. A model given a wall of JSON spends its
 * context parsing it and its attention on whichever number happens to be
 * first; a model given the same short table and a list of named faults gets to
 * spend both on the robot. `--json` is there for anything that wants to store
 * or diff the numbers, not as the thing to read.
 */
export function formatBench(r: BenchResult, baseline?: BenchResult): string {
  const out: string[] = [];
  const delta = (now: number, was: number | undefined, better: 'up' | 'down'): string => {
    if (was === undefined || Math.abs(now - was) < 0.05) return '';
    const diff = now - was;
    const good = better === 'up' ? diff > 0 : diff < 0;
    const sign = diff > 0 ? '+' : '';
    return ` ${good ? '▲' : '▼'}${sign}${Math.round(diff * 10) / 10}`;
  };

  out.push('');
  out.push(
    `  ${r.matches} matches of 2x${r.halfSeconds}s v ${r.opponent}` +
      `   sensors ${r.idealSensors ? 'ideal' : 'noisy'}   testing ${r.tested.join(' ')}`,
  );
  const halfBreakdown =
    r.half1GoalsFor !== undefined && r.half2GoalsFor !== undefined
      ? `   (H1: ${r.half1GoalsFor}-${r.half1GoalsAgainst}, H2: ${r.half2GoalsFor}-${r.half2GoalsAgainst})`
      : '';
  const scoreDetails = r.scores
    .map((s) =>
      s.half1 && s.half2 && r.scores.length <= 4
        ? `${s.for}-${s.against} [${s.half1.for}-${s.half1.against}, ${s.half2.for}-${s.half2.against}]`
        : `${s.for}-${s.against}`,
    )
    .join('  ');
  out.push(`  ${BAR}`);
  out.push(
    `  SCORE  ${r.goalsFor} - ${r.goalsAgainst} per match` +
      delta(r.goalsFor, baseline?.goalsFor, 'up') +
      halfBreakdown +
      `      (${scoreDetails})`,
  );

  // -- what the referee had to do ------------------------------------------
  const callLine = Object.entries(r.calls)
    .filter(([kind]) => kind !== 'goal')
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join('   ');
  out.push('');
  out.push(`  referee, per match:  ${callLine || 'nothing'}`);
  const ours = Object.entries(r.callsAgainstUs).filter(([k]) => OFFENCES.has(k));
  if (ours.length > 0) {
    out.push(`  charged to you:      ${ours.map(([k, v]) => `${k} ${v}`).join('   ')}`);
  }
  const side = r.tested[0]?.slice(0, r.tested[0].indexOf('-')) ?? 'violet';
  const kt = r.kickoffs.filter((k) => k.team === side);
  if (kt.length > 0) {
    const byRes = (res: string): number => kt.filter((k) => k.resolution === res).length;
    const struck = kt.filter((k) => k.resolution === 'struck');
    const wait =
      struck.length > 0
        ? `, avg ${(struck.reduce((a, k) => a + k.timeToStrike, 0) / struck.length).toFixed(2)}s to fire`
        : '';
    const maxCarry = Math.max(0, ...kt.map((k) => k.maxCarry));
    const badArc = kt.filter((k) => k.resolution === 'illegal');
    const act =
      badArc.length > 0
        ? ` [${badArc.every((k) => k.kickerRequested) ? 'ask' : 'no-ask'},` +
          `${badArc.every((k) => k.everCharged) ? 'charge' : 'no-charge'},` +
          `gate-tick ${Math.max(...badArc.map((k) => k.gateHeldTicks))},` +
          `firable ${Math.max(...badArc.map((k) => k.fireableTicks))},` +
          `win ${Math.min(...badArc.map((k) => k.windowSec)).toFixed(2)}s,` +
          `arc ${Math.max(...badArc.map((k) => k.headingErrorDeg))}°,` +
          `gap ${Math.min(...badArc.map((k) => k.closestGap))} mm]`
        : '';
    out.push(
      `  kick-offs (yours):   ${kt.length}   struck ${byRes('struck')}${wait}   rolled ${byRes('rolled-clear')}   illegal ${byRes('illegal')}${act}` +
        `   timeout ${byRes('timeout')}   max carry ${maxCarry} mm`,
    );
  }
  out.push(
    `  ball out of play:    ${r.ball.outOfPlay}` +
      delta(r.ball.outOfPlay, baseline?.ball.outOfPlay, 'down') +
      `   (${r.ball.overSideline} sideline, ${r.ball.overEndline} end line, ${r.ball.outWhileFast} while travelling fast)`,
  );
  out.push(
    `  ball up-field:       ${r.ball.meanX} mm   in your attacking third ${r.ball.inTestedAttackThird}%` +
      `   in your own ${r.ball.inTestedOwnThird}%`,
  );
  if (r.ball.distribution) {
    const dist = r.ball.distribution;
    out.push(`  ball distribution:   centre spot (parked): ${dist.parkedPercent}%`);
    const maxBar = 20;
    for (const b of dist.bins) {
      const barLen = Math.min(maxBar, Math.round((b.percent / 100) * maxBar * 3));
      const bar = '█'.repeat(barLen);
      const range = `[${String(b.min).padStart(5)}, ${String(b.max).padStart(5)}]`;
      out.push(`    ${range} ${b.label.padEnd(11)} ${b.percent.toFixed(1).padStart(5)}%  ${bar}`);
    }
  }

  // -- teamwork ---------------------------------------------------------------
  // "relayed" is ground truth from the wire (a `say` with a `ball` in it, any
  // shape); "blocked" and "covered" are ground truth from the world (another
  // robot's shell on the ball sightline, and whether the team mate was
  // relaying at that same tick) - not a strategy's own opinion of itself.
  out.push('');
  out.push(row('team radio', 'relay%', 'blkd%', 'cov%'));
  for (const id of Object.keys(r.robots).sort()) {
    const q = r.robots[id]!;
    const mark = q.tested ? '*' : ' ';
    out.push(row(`${mark}${id}`, q.relayed, q.blocked, q.blocked > 0 ? q.covered : '—'));
  }

  // -- per robot ------------------------------------------------------------
  out.push('');
  out.push(row('', 'poss%', 'near%', 'attack%', 'own%', 'out%', 'stall%', 'up-field'));
  for (const id of Object.keys(r.robots).sort()) {
    const q = r.robots[id]!;
    const mark = q.tested ? '*' : ' ';
    out.push(
      row(
        `${mark}${id}`,
        q.possession,
        q.nearBall,
        q.attackThird,
        q.ownThird,
        q.whollyOut,
        q.stalled,
        q.meanX,
      ) + (q.tested ? delta(q.possession, baseline?.robots[id]?.possession, 'up') : ''),
    );
  }

  // -- kicks ----------------------------------------------------------------
  const kickers = Object.entries(r.kicks).filter(([, b]) => b.total > 0);
  if (kickers.length > 0) {
    out.push('');
    out.push(row('kicks', 'fired', 'goals', 'saved', 'blkd-out', 'off-tgt', 'range'));
    for (const [id, b] of kickers.sort()) {
      out.push(
        row(
          `${r.robots[id]?.tested ? '*' : ' '}${id}`,
          b.total,
          b.goals,
          b.intoMouth,
          b.blockedOut,
          b.offTarget,
          b.meanRange,
        ),
      );
    }
  }

  // -- timing ---------------------------------------------------------------
  const cycles = r.halfSeconds * 2 * 50;
  const slow = r.tested
    .map((id) => r.robots[id])
    .filter((q): q is RobotTelemetry => !!q && q.missed > 0);
  if (slow.length > 0) {
    out.push('');
    out.push(
      `  cycles missed:       ${slow
        .map((q) => `${q.id} ${q.missed}/${cycles}${q.worstRun > 3 ? ` (worst run ${q.worstRun})` : ''}`)
        .join('   ')}`,
    );
  }

  // -- findings -------------------------------------------------------------
  out.push('');
  out.push(`  ${BAR}`);
  if (r.findings.length === 0) {
    out.push('  nothing flagged.');
  } else {
    for (const f of r.findings) {
      const tag = f.severity === 'high' ? '!!' : f.severity === 'medium' ? ' !' : '  ';
      out.push(`  ${tag} ${f.subject}: ${f.message}`);
      if (f.advice) {
        for (const line of wrap(f.advice, 66)) out.push(`        ${line}`);
      }
    }
  }
  out.push('');
  return out.join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
