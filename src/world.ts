/**
 * Match state and the rule detectors that watch it.
 *
 * The detectors deliberately raise *candidate* events rather than deciding
 * them. Most RCJA gameplay rules are written around referee judgement -
 * "substantially affects the game" (5.11.1), "greater power to force"
 * (5.6.1.3), "a reasonable amount of time" (5.6.1.1) - and a simulator that
 * silently made those calls would be teaching referees the wrong lesson. So
 * the world surfaces the geometry and the timers, and the human decides.
 */

import {
  GOAL_MOUTH_X,
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  NEUTRAL_OFFSET,
  NEUTRAL_POINTS,
  PENALTY_DEPTH,
  PENALTY_WIDTH,
  inPenaltyBox,
  nearestNeutralPoint,
  withinGoalMouth,
  type GoalSide,
  type Point,
} from './field';
import { ballDiameter, type League } from './leagues';
import {
  BALL_BOUNCE,
  collideBodies,
  BALL_ROBOT_BOUNCE,
  collideWithPerimeter,
  separateBodies,
  distance,
  speed,
  stepBall,
  type Body,
} from './physics';
import { openDrive, stepDrive, type DriveSpec } from './drive';
import { placementJitter } from './rand';

export type TeamId = 'violet' | 'lime';

export interface Robot extends Body {
  id: string;
  team: TeamId;
  /** Heading in radians; 0 points towards +x. */
  heading: number;
  /** Rule 5.8: a robot nominated as goalie is treated differently in 5.11.2. */
  isGoalie: boolean;
  /** Off the field under rule 5.7. */
  removed: boolean;
  /** Seconds remaining of the 5.7.2 stand-down. */
  penaltyRemaining: number;
  /** Rule under which robot was removed (e.g. '5.7.1.6'). */
  removalRule?: string;
  /** Reason for removal. */
  removalReason?: string;
  /** Seconds this robot has been continuously inside its own goal area (5.7.1.2). */
  inGoalAreaFor: number;
  /** Seconds this robot has been wholly within the out area (5.7.1.6). */
  whollyOutFor: number;
  /**
   * Seconds since this robot last touched an opponent. Rule 5.7.1.6 does not
   * apply to a robot an opponent pushed out, so the referee - and here the
   * simulator - has to know whether one just did.
   */
  sinceOpponentContact: number;
  /** Seconds a goalie has remained on the goal line with a stationary ball in the box (5.8.2/5.8.3). */
  inactiveGoalieFor: number;
  /** Driven by a human rather than the AI. */
  manual: boolean;

  /**
   * Yaw rate, rad/s. In the lab a robot's heading was set directly by whatever
   * was steering it; here it is a consequence of the motors, so it has to be
   * integrated like any other velocity.
   */
  omega: number;
  /** This robot's drivetrain. */
  drive: DriveSpec;
  /** The command standing right now: one power per motor, -1..1. */
  motors: number[];
  /**
   * Each wheel's surface speed from the last step, mm/s. Kept on the robot
   * because the encoders read it, and they read the wheel rather than the
   * robot's actual motion - which is the whole reason odometry drifts.
   */
  wheelSpeeds: number[];
}

/** One robot's place on the field, as an arrangement asks for it. */
/**
 * Somewhere sensible for a robot being put on the field with no history.
 *
 * Its own half, facing the other one, robot 2 further back than robot 1. Used
 * by a practice field putting a robot into a situation it was not part of, and
 * by a match server showing the robots that have connected before there is a
 * match to place them for.
 */
export function defaultSpot(id: string): { x: number; z: number; heading: number } {
  const side = id.startsWith('violet') ? -1 : 1;
  return {
    x: side * (id.endsWith('-2') ? 1500 : 600),
    z: 0,
    heading: side < 0 ? 0 : Math.PI,
  };
}

export interface PlacedRobot {
  /** One of `violet-1`, `violet-2`, `lime-1`, `lime-2`. */
  id: string;
  x: number;
  z: number;
  /** Radians; 0 points towards +x. */
  heading: number;
  /**
   * Rule 5.8's nomination, and nothing else.
   *
   * Not a role and not a behaviour: no part of the simulator treats robot 1
   * and robot 2 differently, and this flag is read only by the 5.11.2
   * detector and by which robot 5.11.2 takes off. A standard kick-off
   * nominates robot 2 because a team has to nominate somebody; an
   * arrangement says so itself.
   */
  isGoalie: boolean;
}

/**
 * A situation to put on the field: who is on it, where, and where the ball is.
 *
 * The roster is whichever ids are listed, so one robot alone, or one a side,
 * is an arrangement like any other rather than a mode. A world with an
 * arrangement staged restarts back into it instead of onto the kick-off
 * marks - see `World.stage`.
 */
export interface Arrangement {
  robots: PlacedRobot[];
  ball: { x: number; z: number; vx?: number; vz?: number };
}

export type EventKind =
  | 'goal'
  | 'ball-out-of-play'
  | 'lack-of-progress'
  | 'possible-multiple-defence'
  | 'possible-damaged'
  | 'kickoff'
  | 'kickoff-live'
  | 'illegal-kickoff'
  | 'paused'
  | 'resumed'
  | 'score-corrected'
  | 'mercy';

export interface MatchEvent {
  kind: EventKind;
  /** Rule number this event hangs off, for the referee panel. */
  rule: string;
  message: string;
  /** Robot the referee would be acting on, where there is one. */
  robotId?: string;
  team?: TeamId;
  at: number;
}

export interface MatchConfig {
  league: League;
  /** Rule 5.2.1: two 5-minute halves, or 10-minute halves by TOC discretion. */
  halfLengthSeconds: number;
  /**
   * Varies the legal freedom in where robots stand at a restart.
   *
   * Rule 5.4.2 lets the kicking team stand anywhere on its own half and 5.4.5
   * only asks that part of each non-kicking robot is in the box, so exactly
   * where they go is the referee's and the team's business, not a constant.
   * Using it matters more than it looks: without it every restart is identical,
   * and with noise off that made every MATCH identical - the seed reached only
   * the noise streams, so a seeded run was one match repeated, and a bench or
   * ladder averaging over seeds was averaging over a single sample.
   *
   * Omit for the fixed, exactly-on-the-marks placement.
   */
  placementSeed?: number;
  /** Rule 2.1.2: whether the out area is inclined, which changes 5.9.1. */
  inclined: boolean;
  /**
   * When false, detectors still report what they see but do not act on it:
   * the ball is not moved to a neutral point and a goal does not trigger a
   * kick-off. A staged situation has to hold the arrangement the author set
   * up, otherwise it resets itself out from under whoever is looking at it —
   * not something either a self-running or a refereed match wants; both
   * leave this at its default. Defaults to true.
   */
  autoResolve?: boolean;
  /**
   * Whether the simulator itself applies the "damaged" rules, or only reports
   * them. True (the default, for both a self-running and a refereed match)
   * so robots that drive off the field are actually taken off, as 5.7.1.6
   * requires, and returned the moment their stand-down is served. A referee
   * can still remove or return a robot by hand at any time regardless — this
   * only controls whether the simulator also does it on its own.
   * Defaults to autoResolve.
   */
  autoDamaged?: boolean;
  /**
   * Rule 4.2.5 & 4.2.6: inter-robot wireless communication.
   * Defaults to league.commsAllowed, and can be disabled per referee request (4.2.6).
   */
  commsEnabled?: boolean;
  /**
   * Seconds of placed-but-not-live countdown at each kick-off.
   *
   * The robots are placed and the ball is on the spot, but the kick-off is not
   * live — 5.4.7 is not armed — until the countdown reaches zero and the
   * whistle blows. Advances in `step()`, so it is real match time, not wall
   * time. Omit, or pass 0, for the instant restart every headless match always
   * used.
   */
  kickoffCountdown?: number;
  /**
   * A multiplier on the ball's rolling resistance, drawn per match from the
   * seed so no two matches roll the same. Friction is a property of the
   * carpet, and carpets differ: at ±10% around `BALL_ROLL_DECEL` a full kick
   * still carries goal to goal while a gentle knock dies a little sooner or
   * later, which is enough that a robot cannot just assume last match's
   * physics. Omit for the nominal coefficient (every match identical).
   */
  ballFriction?: number;
}

/** Rule 4.1.1: every league caps the robot at a 220 mm cylinder. */
const ROBOT_RADIUS = 110;

/**
 * Separation passes per step. Four is enough to settle the worst case on this
 * field: a robot squeezed between two opponents and a wall.
 */
const CONTACT_PASSES = 8;

/**
 * How long the ball may sit stuck between robots before rule 5.6.1.2 applies.
 * The rule says "a reasonable amount of time" and leaves it to the referee.
 */
const STALL_SECONDS = 4;

/**
 * The lack-of-progress test proper: if the ball has not moved this far in this
 * long while robots are on it, it is not progressing. "A reasonable amount of
 * time" is the referee's, per 5.6.1.1.
 */
const PROGRESS_WINDOW = 5;
const PROGRESS_DISTANCE = 320;

/**
 * Rule 5.6.1.1: no robot has any chance of locating the ball.
 *
 * The case that forced this was a ball that rolled into the goal and stopped
 * short of the back wall. Not a goal - 5.5.1 wants the back wall struck - and
 * not out of play either, because the out-of-play test exempts the goal mouth
 * so that a ball on its way in is not called out before it can score. Nothing
 * resolved it and nothing could: 5.5.2 notes that robots are built so the
 * crossbar keeps them out of the goal, so no robot can ever reach it. The
 * match simply stopped being a match.
 *
 * Three seconds is enough to be sure a ball that entered the goal has finished
 * rolling. In open field the ball has to be beyond anyone's reach and staying
 * that way for longer, because there a robot might still be on its way.
 */
const UNREACHABLE_IN_GOAL_SECONDS = 3;
const UNREACHABLE_SECONDS = 8;
/** Edge-to-edge gap beyond which nobody is about to arrive. */
const UNREACHABLE_DISTANCE = 400;

/** Robot mass in grams, by league weight cap (rule 4.1.1). */
function robotMass(league: League): number {
  return league.maxWeightKg * 1000;
}

function ballMass(league: League): number {
  // Appendix A.8: 130-150 g for the IR ball. Appendix B.5: 46 g for the golf ball.
  return league.ball === 'ir-74' ? 140 : 46;
}

/** A robot as an arrangement asks for it, at rest and undamaged. */
function makeRobot(spec: PlacedRobot, mass: number): Robot {
  return {
    id: spec.id,
    team: spec.id.startsWith('violet') ? 'violet' : 'lime',
    x: spec.x,
    z: spec.z,
    vx: 0,
    vz: 0,
    radius: ROBOT_RADIUS,
    mass,
    heading: spec.heading,
    isGoalie: spec.isGoalie,
    removed: false,
    penaltyRemaining: 0,
    removalRule: undefined,
    removalReason: undefined,
    inGoalAreaFor: 0,
    whollyOutFor: 0,
    sinceOpponentContact: 99,
    inactiveGoalieFor: 0,
    manual: false,
    omega: 0,
    drive: openDrive(),
    motors: [0, 0, 0, 0],
    wheelSpeeds: [0, 0, 0, 0],
  };
}

/**
 * Push any two robots that start inside each other apart, along the field.
 *
 * Along x rather than the line between them, because at a restart the pair
 * that can collide is a keeper and its own striker, both on the goal axis, and
 * the striker is the one with somewhere to go: back up the field, where its
 * own half continues. Moving them sideways would take the striker off the box
 * front that rule 5.4.5 wants part of it on.
 */
function separateAtRestart(robots: Robot[]): void {
  for (let i = 0; i < robots.length; i++) {
    for (let j = i + 1; j < robots.length; j++) {
      const a = robots[i]!;
      const b = robots[j]!;
      const need = a.radius + b.radius;
      const gap = Math.hypot(a.x - b.x, a.z - b.z);
      if (gap >= need) continue;
      // The one nearer its own goal stays; the other backs up the field.
      const [keep, move] = Math.abs(a.x) > Math.abs(b.x) ? [a, b] : [b, a];
      const dz = move.z - keep.z;
      const room = Math.sqrt(Math.max(0, need * need - dz * dz));
      move.x = keep.x - Math.sign(keep.x || 1) * room;
    }
  }
}



export class World {
  readonly config: MatchConfig;
  ball: Body;
  robots: Robot[] = [];
  events: MatchEvent[] = [];

  clock = 0;
  half: 1 | 2 = 1;
  running = false;
  score: Record<TeamId, number> = { violet: 0, lime: 0 };
  /** Rule 4.2.5 / 4.2.6: whether inter-robot communication is currently active. */
  commsEnabled: boolean;
  /** Timestamp of most recent packet sent per team, for visual feedback. */
  commsActivity: Record<TeamId, number> = { violet: -99, lime: -99 };
  /** The robot that last had physical contact or kicked the ball, and when. */
  lastBallTouch: { robotId: string; team: TeamId; at: number } | null = null;

  /**
   * Flips every physics tick. Robot-robot collisions and separation are
   * resolved one pair at a time against state the previous pair just left
   * behind, so a robot touching two others in the same tick (a keeper
   * shoved while also on the ball, say) resolves differently depending on
   * which pair goes first - and `actives` is always ordered
   * violet-1/violet-2/lime-1/lime-2, never shuffled by which end either team
   * is currently defending. See `Match.slotOrderFlipped` for the sibling fix
   * this mirrors, and `pairOrder` below.
   */
  private pairOrderFlipped = false;

  /**
   * The arrangement restarts go back to, or null for the kick-off marks.
   *
   * Set by `stage`. Null for every match this codebase plays - a rehearsal is
   * the only thing that stages anything, and nothing else can tell.
   */
  private staged: Arrangement | null = null;
  /**
   * Who is on the field at a kick-off, or null for the usual four.
   *
   * A staged situation sets it, so that a rehearsal switched back to ordinary
   * kick-offs restarts the robots actually in it rather than conjuring the
   * other three back out of nowhere. Null for every match.
   */
  private roster: string[] | null = null;

  /** Seconds the ball has been effectively stationary and contested (5.6.1.2). */
  private stalledFor = 0;
  /** Seconds the ball has been at rest with nobody able to get to it (5.6.1.1). */
  private unreachableFor = 0;
  /** Where the ball was PROGRESS_WINDOW ago, for the lack-of-progress test. */
  private progressMark: Point = { x: 0, z: 0 };
  private sinceProgressMark = 0;
  /** How many times lack of progress has been called since the last restart (5.6.2). */
  lackOfProgressCount = 0;
  /** Suppresses the 5.11.1 detector per team so it reports once, not per frame. */
  private multipleDefenceCooldown: Record<TeamId, number> = { violet: 0, lime: 0 };
  /** Rule 5.11.1: Sustained duration both defenders have been directly blocking the goal. */
  private multipleDefenceDwell: Record<TeamId, number> = { violet: 0, lime: 0 };
  /** Rule 5.6.1.3: Forcing detection variables. */
  private forcingDuration = 0;
  lastForcingTeam: TeamId | null = null;
  sinceForcing = 999;
  /** Seconds since the last kick-off, so 5.4.5 placement is not read as 5.11.1. */
  sinceKickOff = 0;
  /**
   * Seconds left of a placed-but-not-live kick-off countdown. Ticked down in
   * `step()`; reaching zero opens 5.4.7 and starts the clock. How long the
   * countdown runs is the host's choice (`config.kickoffCountdown`), not the
   * world's. 0 when none is in progress, which is every headless match.
   */
  countdownSeconds = 0;
  /**
   * A referee's pause, kept separate from `running`: a kick-off countdown
   * leaves the clock stopped (`running=false`) without being a pause, and a
   * pause freezes the countdown, so the two cannot be read off one flag.
   */
  paused = false;
  kickingOffTeam: TeamId = 'violet';
  private kickOffPending = false;
  /**
   * Consecutive illegal kick-offs, whichever side committed them.
   *
   * Awarding the kick-off to the other team is right once. Doing it every time
   * loops forever when both sides carry the ball off the spot, which is what
   * two ordinary ball-chasing robots do: a ladder run hit 194 illegal kick-offs
   * and 203 restarts in one four-minute match, and no football was played at
   * all. After a couple of attempts the referee has to let the game go.
   */
  private consecutiveIllegalKickOffs = 0;
  /**
   * Without auto-resolution the ball stays where it went out, so the detector
   * would fire on every frame. Latched until the ball is placed again.
   */
  private reportedOutOfPlay = false;

  /** Count of restarts placed, providing stateless, order-independent jitter. */
  private restartCount = 0;

  /**
   * Per-match ball rolling friction multiplier. Derived from the match seed
   * so the same seed always produces the same physics.
   */
  private readonly ballFriction: number;
  /** Per-match ball-wall restitution. Separate from robot-robot bounce. */
  private readonly ballBounce: number;

  constructor(config: MatchConfig) {
    this.config = config;
    this.commsEnabled = config.commsEnabled ?? config.league.commsAllowed;
    this.ballFriction = config.ballFriction ?? 1;
    this.ballBounce = BALL_BOUNCE;
    const r = ballDiameter(config.league) / 2;
    this.ball = { x: 0, z: 0, vx: 0, vz: 0, radius: r, mass: ballMass(config.league) };
    this.resetRobots();
  }

  /** Whether a kick-off is under way, and whose it is. Rule 5.4.7 turns on it. */
  get restart(): { pending: boolean; team: TeamId | null; countdown: number } {
    const underWay = this.kickOffPending || this.countdownActive;
    return {
      pending: this.kickOffPending,
      team: underWay ? this.kickingOffTeam : null,
      countdown: this.countdownSeconds,
    };
  }

  /** Whether a kick-off has been placed but the whistle has not blown. */
  get countdownActive(): boolean {
    return this.countdownSeconds > 0;
  }

  /**
   * Rule 1.4/5.4: ends swap at half-time. The cyan goal and the yellow goal
   * are fixed physical places on the field (-x and +x respectively, per
   * field.ts) - what changes each half is which team is standing in front of
   * which one.
   */
  private get endsSwapped(): boolean {
    return this.half === 2;
  }

  /** Which goal this team currently defends. Fixed for a half, not for the match. */
  defendingGoal(team: TeamId): GoalSide {
    const first = team === 'violet' ? 'cyan' : 'yellow';
    if (!this.endsSwapped) return first;
    return first === 'cyan' ? 'yellow' : 'cyan';
  }

  /** Which goal this team currently attacks. Fixed for a half, not for the match. */
  attackingGoal(team: TeamId): GoalSide {
    return this.defendingGoal(team) === 'cyan' ? 'yellow' : 'cyan';
  }

  /**
   * Rule 5.4: both teams on their defensive half, non-kicking team in the box.
   *
   * Or, on a staged world, whatever was staged. A restart on a staged world
   * puts the situation back the way whoever set it up left it rather than back
   * on the kickoff marks - which is what makes a rehearsal repeat itself
   * without anything driving it: a goal, a ball out of play and a referee's
   * kick-off all already come through here.
   */
  resetRobots(kickingOff: TeamId = 'violet'): void {
    this.applyArrangement(this.staged ?? this.kickoffArrangement(kickingOff), kickingOff);
  }

  /**
   * Hold this arrangement instead of the kickoff marks, and put it out now.
   *
   * The whole of a staged situation is this one substitution. Nothing else in
   * the world knows it is staged: the detectors still watch, the rules still
   * fire, and `config.autoResolve` still decides whether anything acts on
   * them - so a rehearsal is the same football as a match, started from
   * somewhere else.
   */
  stage(arrangement: Arrangement): void {
    this.setArrangement(arrangement);
    this.applyArrangement(arrangement, this.kickingOffTeam);
  }

  /**
   * Change where restarts go back to without disturbing the field now.
   *
   * The difference matters constantly on a practice field: nudging the ball
   * across it is a change to the situation, but it is not a reason to teleport
   * the robots back to where they started - which is exactly what applying the
   * whole arrangement would do to everything the one drag did not touch.
   */
  setArrangement(arrangement: Arrangement): void {
    this.staged = arrangement;
    this.roster = arrangement.robots.map((r) => r.id);
  }

  /** Back to ordinary kickoffs. The field is left exactly as it stands. */
  unstage(): void {
    this.staged = null;
  }

  /**
   * Put a robot where this says, now - adding it to the field if it is not
   * already on it.
   *
   * The one operation behind both dragging a robot across the field and
   * putting one out that was not in the situation at all, because from the
   * world's side those are the same thing. It does not touch `staged`: where
   * a restart goes back to is the caller's business, and a nudge mid-play is
   * not necessarily a change to the situation being rehearsed.
   */
  place(spec: PlacedRobot): void {
    const existing = this.robots.find((r) => r.id === spec.id);
    if (existing) {
      existing.x = spec.x;
      existing.z = spec.z;
      existing.heading = spec.heading;
      existing.isGoalie = spec.isGoalie;
      existing.vx = 0;
      existing.vz = 0;
      existing.omega = 0;
      return;
    }
    this.robots.push(makeRobot(spec, robotMass(this.config.league)));
    if (this.roster && !this.roster.includes(spec.id)) this.roster.push(spec.id);
  }

  /**
   * Take a robot out of the situation entirely.
   *
   * Not rule 5.7: a robot removed under 5.7 is still in the match, off the
   * field, serving a stand-down and drawn as such. This one was never in the
   * arrangement - a rehearsal of one robot alone has three seats that are
   * simply not part of it - so it leaves no trace on the field at all.
   */
  takeOff(robotId: string): void {
    const at = this.robots.findIndex((r) => r.id === robotId);
    if (at === -1) return;
    this.robots.splice(at, 1);
    this.roster = this.robots.map((r) => r.id);
  }

  /** The arrangement a restart currently goes back to, or null for the marks. */
  get stagedArrangement(): Arrangement | null {
    return this.staged;
  }

  /** Where everyone stands for a kick-off, all four robots, ball on the spot. */
  private kickoffArrangement(kickingOff: TeamId): Arrangement {
    // +1 if this team is currently camped on the +x side of the field (i.e.
    // defends the yellow goal this half), -1 if on the -x side. Swaps with
    // `endsSwapped`, unlike the goal colours themselves.
    const sideSign = (team: TeamId): 1 | -1 => (this.defendingGoal(team) === 'cyan' ? -1 : 1);

    const goalieX = HALF_LENGTH - PENALTY_DEPTH / 2;
    // The kicking-off team may sit anywhere on its own half (5.4.2); the other
    // team must have part of each robot in the penalty box (5.4.5).
    // Rule 5.4.5 asks for *part* of each non-kicking robot in the penalty box,
    // so its centre sits just outside the line with its body overlapping. That
    // also keeps the 5.11.1 detector, which tests the centre, quiet at kick-off.
    const boxEdge = HALF_LENGTH - PENALTY_DEPTH;
    // The box runs from boxEdge towards the goal, so a centre just short of
    // the line still overlaps it by most of the robot's 110 mm radius.
    // Rule 5.4.7: The robot kicking off must make a clear strike of the ball
    // and it must roll clear by at least 50 mm, or the robot must start at
    // least 50 mm from the ball.
    // Both leagues have kickers, so the robot can start right behind the ball
    // at a ~15 mm standoff, because it makes a clear strike (>2000 mm/s).
    const bRadius = this.ball.radius;
    const standoff = 15;
    const kickoffX = ROBOT_RADIUS + bRadius + standoff;
    const violetSign = sideSign('violet');
    const limeSign = sideSign('lime');
    // The waiting striker has to clear its own keeper as well as overlap the
    // box. At `boxEdge - 45` it sat 195 mm from the keeper on `goalieX`, and
    // two 110 mm robots need 220 - so the separation pass shoved them apart on
    // the first step and the restart was never the one the referee set. Only
    // the non-kicking team was ever affected, because it is the only one with
    // two robots placed near each other.
    //
    // Backing off to a clear 220 keeps rule 5.4.5 satisfied: the body still
    // overlaps the box line at `boxEdge`, which is what the rule asks for -
    // part of each non-kicking robot inside the box, not all of it.
    const waiting = Math.min(boxEdge - 45, goalieX - 2 * ROBOT_RADIUS);

    // The legal slack, rule by rule.
    //
    // 5.4.2 lets the kicking team stand anywhere on its own half, and 5.4.5
    // only asks that part of each non-kicking robot is in the box - so none of
    // these positions is prescribed to the millimetre, and pretending they are
    // is what made every restart, and with noise off every match, identical.
    //
    // Each robot draws its own offsets, so the variation has no direction of
    // its own: over many restarts both ends see the same distribution. The
    // amounts are deliberately small - enough that no two restarts play out
    // the same, not so much that a team's opening is a different problem each
    // time.
    const rIdx = this.restartCount;
    const pSeed = this.config.placementSeed;
    const jitter = (key: number, mm: number): number =>
      placementJitter(pSeed, rIdx, key) * mm;

    // The striker taking the kick-off keeps its standoff: 5.4.7 is decided by
    // the gap to the ball, so that is the one number not to move. Across the
    // ball is free.
    const kickerZ = jitter(0, 35);
    // The waiting striker has the whole width of the box front to wait on, and
    // room to stand off the line, as long as its body still overlaps the box.
    const waitingZ = jitter(1, 220);
    const waitingBack = jitter(2, 30);
    const strikerFor = (team: TeamId, sign: 1 | -1): { x: number; z: number } =>
      kickingOff === team
        ? { x: sign * kickoffX, z: kickerZ }
        : { x: sign * (waiting - Math.abs(waitingBack)), z: waitingZ };

    // A keeper may stand anywhere in front of its goal; off-centre is normal.
    // Drawn per keeper with symmetric keys (violet: 3, 4; lime: 5, 6) so
    // evaluation order never introduces a bias.
    const keeperFor = (isViolet: boolean, sign: 1 | -1): { x: number; z: number } => {
      const baseKey = isViolet ? 3 : 5;
      return {
        x: sign * (goalieX + Math.abs(jitter(baseKey, 25))),
        z: jitter(baseKey + 1, 60),
      };
    };

    const violetS = strikerFor('violet', violetSign);
    const violetK = keeperFor(true, violetSign);
    const limeS = strikerFor('lime', limeSign);
    const limeK = keeperFor(false, limeSign);
    // Facing up the field, towards this team's current attacking end.
    const facing = (sign: 1 | -1): number => (sign < 0 ? 0 : Math.PI);

    const out: PlacedRobot[] = [
      { id: 'violet-1', x: violetS.x, z: violetS.z, heading: facing(violetSign), isGoalie: false },
      { id: 'violet-2', x: violetK.x, z: violetK.z, heading: facing(violetSign), isGoalie: true },
      { id: 'lime-1', x: limeS.x, z: limeS.z, heading: facing(limeSign), isGoalie: false },
      { id: 'lime-2', x: limeK.x, z: limeK.z, heading: facing(limeSign), isGoalie: true },
    ];
    const roster = this.roster;
    return {
      robots: roster ? out.filter((r) => roster.includes(r.id)) : out,
      ball: { x: 0, z: 0 },
    };
  }

  /** Put an arrangement out on the field and reset everything a restart resets. */
  private applyArrangement(arrangement: Arrangement, kickingOff: TeamId): void {
    this.restartCount++;
    this.lastBallTouch = null;
    // A robot still serving a 5.7 stand-down does not get a free pass just
    // because some restart repositions everyone else - only returnRobot()
    // (5.7.4) brings it back, automatically or by a referee's hand. Without
    // this, any kick-off - including a referee's own, at the top of a half -
    // would silently reinstate a robot mid-penalty.
    const stillRemoved = new Map(
      this.robots
        .filter((r) => r.removed)
        .map((r) => [
          r.id,
          {
            penaltyRemaining: r.penaltyRemaining,
            removalRule: r.removalRule,
            removalReason: r.removalReason,
          },
        ]),
    );
    const existingRobots = new Map(this.robots.map((r) => [r.id, r]));
    const mass = robotMass(this.config.league);

    this.robots = arrangement.robots.map((spec) => {
      const existing = existingRobots.get(spec.id);
      if (existing) {
        existing.x = spec.x;
        existing.z = spec.z;
        existing.vx = 0;
        existing.vz = 0;
        existing.heading = spec.heading;
        existing.isGoalie = spec.isGoalie;
        existing.mass = mass;
        existing.radius = ROBOT_RADIUS;
        existing.omega = 0;
        existing.drive = openDrive();
        existing.motors = [0, 0, 0, 0];
        existing.wheelSpeeds = [0, 0, 0, 0];
        existing.inGoalAreaFor = 0;
        existing.whollyOutFor = 0;
        existing.sinceOpponentContact = 99;
        existing.inactiveGoalieFor = 0;
        existing.manual = false;
        existing.removed = false;
        existing.penaltyRemaining = 0;
        existing.removalRule = undefined;
        existing.removalReason = undefined;
        return existing;
      }
      return makeRobot(spec, mass);
    });
    // Whatever the draw, nobody starts inside anybody: the separation pass
    // would otherwise shove them apart before the whistle and the restart
    // would not be the one that was set. Only ever the two of a non-kicking
    // team are close enough for this to bite at a kick-off - a hand-placed
    // arrangement can put any pair on top of each other, and gets the same
    // treatment rather than a different one.
    separateAtRestart(this.robots);
    for (const robot of this.robots) {
      const was = stillRemoved.get(robot.id);
      if (!was) continue;
      robot.removed = true;
      robot.penaltyRemaining = was.penaltyRemaining;
      robot.removalRule = was.removalRule;
      robot.removalReason = was.removalReason;
    }

    this.ball.x = arrangement.ball.x;
    this.ball.z = arrangement.ball.z;
    this.ball.vx = arrangement.ball.vx ?? 0;
    this.ball.vz = arrangement.ball.vz ?? 0;
    this.stalledFor = 0;
    this.lackOfProgressCount = 0;
    this.progressMark = { x: this.ball.x, z: this.ball.z };
    this.sinceProgressMark = 0;
    this.sinceKickOff = 0;
    this.kickingOffTeam = kickingOff;
    this.kickOffPending = false;
    this.multipleDefenceCooldown = { violet: 0, lime: 0 };
    this.multipleDefenceDwell = { violet: 0, lime: 0 };
    this.forcingDuration = 0;
    this.lastForcingTeam = null;
    this.sinceForcing = 999;
    this.reportedOutOfPlay = false;
  }

  active(): Robot[] {
    return this.robots.filter((r) => !r.removed);
  }

  /** `list`, in an order that alternates tick to tick. See `pairOrderFlipped`. */
  private pairOrder(list: Robot[]): Robot[] {
    return this.pairOrderFlipped ? [...list].reverse() : list;
  }

  emit(event: Omit<MatchEvent, 'at'>): void {
    this.events.push({ ...event, at: this.clock });
    if (this.events.length > 60) this.events.shift();
  }

  step(dt: number): void {
    this.pairOrderFlipped = !this.pairOrderFlipped;
    if (this.running) this.clock += dt;
    this.sinceKickOff += dt;
    if (this.countdownSeconds > 0 && !this.paused) {
      this.countdownSeconds = Math.max(0, this.countdownSeconds - dt);
      if (this.countdownSeconds === 0) this.blowWhistle();
    }
    for (const team of ['violet', 'lime'] as const) {
      this.multipleDefenceCooldown[team] = Math.max(0, this.multipleDefenceCooldown[team] - dt);
    }

    for (const robot of this.robots) {
      if (robot.removed) {
        // Rule 5.7.2: at least thirty seconds off the field.
        robot.penaltyRemaining = Math.max(0, robot.penaltyRemaining - dt);
        // 5.7.4: repaired and returned with the referee's permission. A
        // self-running match grants it as soon as the time is served.
        if (this.autoDamaged && robot.penaltyRemaining === 0) this.returnRobot(robot.id);
        continue;
      }
      // The motors move the robot now. Everything after this - collisions,
      // separation passes, the walls - is unchanged, so a robot that has been
      // shoved still behaves exactly as the lab's referee training shows it.
      robot.wheelSpeeds = stepDrive(robot, robot.drive, robot.motors, dt).wheelSpeeds;
    }

    stepBall(this.ball, dt, this.ballFriction);

    const actives = this.active();

    // One impulse pass, so a collision exchanges momentum exactly once.
    //
    // Every robot resolves against the SAME pre-pass ball state and the
    // resulting corrections are summed, rather than each robot in turn
    // resolving against whatever the previous one just left behind. Two
    // robots contesting the ball in one tick is an even fight; letting the
    // first one move the ball out from under the second - or hand it a
    // head start - made whichever seat `actives` happened to reach last
    // (always the same one, since active robots are always ordered
    // violet-1/violet-2/lime-1/lime-2) systematically win the ball's
    // outgoing velocity in a tie, with no such contest ever intended.
    const ballBefore = { ...this.ball };
    let ballDX = 0;
    let ballDZ = 0;
    let ballDVX = 0;
    let ballDVZ = 0;
    for (const robot of actives) {
      const recess = dribblerRecess(robot, ballBefore, this.config.league);
      const ballTrial = { ...ballBefore };
      if (collideBodies(robot, ballTrial, recess, BALL_ROBOT_BOUNCE)) {
        ballDX += ballTrial.x - ballBefore.x;
        ballDZ += ballTrial.z - ballBefore.z;
        ballDVX += ballTrial.vx - ballBefore.vx;
        ballDVZ += ballTrial.vz - ballBefore.vz;
        this.lastBallTouch = { robotId: robot.id, team: robot.team, at: this.clock };
      }
    }
    this.ball.x += ballDX;
    this.ball.z += ballDZ;
    this.ball.vx += ballDVX;
    this.ball.vz += ballDVZ;
    for (const robot of actives) robot.sinceOpponentContact += dt;
    const robotPairOrder = this.pairOrder(actives);
    for (let i = 0; i < robotPairOrder.length; i++) {
      for (let j = i + 1; j < robotPairOrder.length; j++) {
        const a = robotPairOrder[i]!;
        const b = robotPairOrder[j]!;
        if (collideBodies(a, b) && a.team !== b.team) {
          a.sinceOpponentContact = 0;
          b.sinceOpponentContact = 0;
        }
      }
    }

    // Then several separation passes against each other and the walls. A robot
    // pinned between an opponent and the wall - which is exactly the forcing
    // situation in rule 5.6.1.3 - cannot be resolved in one pass, and robots
    // visibly merging into one another destroys the point of a referee view.
    for (let pass = 0; pass < CONTACT_PASSES; pass++) {
      for (let i = 0; i < robotPairOrder.length; i++) {
        for (let j = i + 1; j < robotPairOrder.length; j++) {
          separateBodies(robotPairOrder[i]!, robotPairOrder[j]!);
        }
      }
      for (const robot of this.pairOrder(actives)) {
        const recess = dribblerRecess(robot, this.ball, this.config.league);
        separateBodies(robot, this.ball, recess);
        collideWithPerimeter(robot, false);
      }
    }

    // Allow entry with the physics' own margin (half a radius), not the full
    // post plane: only a ball that could actually get inside the goal opens
    // the mouth.
    const goalBound = Math.abs(this.ball.z) <= HALF_GOAL_WIDTH - this.ball.radius * 0.5;
    const hit = collideWithPerimeter(this.ball, goalBound, this.ballBounce);

    this.detectGoal(hit);
    this.detectUnreachable(dt);
    this.detectBallOutOfPlay();
    this.detectIllegalKickOff();
    this.detectStall(dt);
    this.detectForcing(dt);
    this.detectRobotStates(dt);
  }

  /** Rule 5.5.1: a goal is scored when the ball strikes the back wall of the goal. */
  private get autoResolve(): boolean {
    return this.config.autoResolve !== false;
  }

  private get autoDamaged(): boolean {
    return this.config.autoDamaged ?? this.autoResolve;
  }

  private detectGoal(hit: ReturnType<typeof collideWithPerimeter>): void {
    if (hit !== 'goal-back') return;
    const scoringSide: GoalSide = this.ball.x > 0 ? 'yellow' : 'cyan';
    // Whichever team does NOT currently defend that goal scored in it. Not a
    // fixed violet/lime flip: which team defends which goal swaps at half-time
    // (rule 1.4/5.4), even though the goals' own colours and places don't.
    const scorer: TeamId = this.defendingGoal('violet') === scoringSide ? 'lime' : 'violet';

    // Rule 5.6.1.3: If a goal is scored as a direct result of forcing, it will be disallowed!
    if (this.lastForcingTeam === scorer && this.sinceForcing < 0.8) {
      this.emit({
        kind: 'lack-of-progress',
        rule: '5.6.1.3',
        team: scorer,
        message: `Goal disallowed! Ball was forced through an opposition defender in the penalty box (Rule 5.6.1.3). Ball moved to neutral point.`,
      });
      this.lastForcingTeam = null;
      this.sinceForcing = 999;
      this.forcingDuration = 0;
      if (this.autoResolve) {
        this.callLackOfProgress();
      } else {
        this.running = false;
      }
      return;
    }

    this.score[scorer] += 1;
    let scoringRobotId: string | undefined = undefined;
    if (this.lastBallTouch && this.clock - this.lastBallTouch.at < 6.0 && this.lastBallTouch.team === scorer) {
      scoringRobotId = this.lastBallTouch.robotId;
    }
    this.emit({
      kind: 'goal',
      rule: '5.5.1',
      team: scorer,
      robotId: scoringRobotId,
      message: `Goal to ${scorer === 'violet' ? 'Violet' : 'Lime'}. Ball struck the back wall of the goal.`,
    });
    if (this.autoResolve) this.kickOff(scorer === 'violet' ? 'lime' : 'violet');
    else this.running = false;
  }

  /**
   * Rule 5.9.1: the ball is out of play once it leaves the playing area.
   * Both leagues judge it the same way. A ball on its way into the goal is
   * not out of play.
   */
  private detectBallOutOfPlay(): void {
    const b = this.ball;
    if (withinGoalMouth(b.z) && Math.abs(b.x) > HALF_LENGTH) return;

    const out = Math.abs(b.x) > HALF_LENGTH + b.radius || Math.abs(b.z) > HALF_WIDTH + b.radius;
    if (!out) return;

    if (!this.autoResolve) {
      if (this.reportedOutOfPlay) return;
      this.reportedOutOfPlay = true;
      this.running = false;
      this.emit({
        kind: 'ball-out-of-play',
        rule: '5.9.1',
        message: 'Ball is out of play.',
      });
      return;
    }

    const target = nearestNeutralPoint({ x: b.x, z: b.z }, this.occupiedNeutralPoints());
    this.placeBall(target);
    this.emit({
      kind: 'ball-out-of-play',
      rule: '5.9.2',
      message: 'Ball out of play. Moved to the nearest neutral point.',
    });
  }

  /**
   * Rule 5.6.1.1: the ball is somewhere no robot is going to get to.
   *
   * Deliberately separate from the scrum test in `detectStall`, which is
   * 5.6.1.2 and is about a ball surrounded by robots. This is the opposite
   * shape: a ball nobody is near, and nobody is coming for.
   */
  private detectUnreachable(dt: number): void {
    if (!this.running || this.countdownActive || this.kickOffPending || speed(this.ball) > 40) {
      this.unreachableFor = 0;
      return;
    }

    // Inside the goal mouth and past the goal line. The crossbar keeps robots
    // out, so this is not a matter of waiting longer - it will never be
    // reached, and the only question is how long to be sure it has stopped.
    const inGoal =
      Math.abs(this.ball.x) > HALF_LENGTH && withinGoalMouth(this.ball.z);

    let nearest = Infinity;
    for (const robot of this.active()) {
      nearest = Math.min(nearest, distance(robot, this.ball) - robot.radius - this.ball.radius);
    }

    if (!inGoal && nearest < UNREACHABLE_DISTANCE) {
      this.unreachableFor = 0;
      return;
    }

    this.unreachableFor += dt;
    const limit = inGoal ? UNREACHABLE_IN_GOAL_SECONDS : UNREACHABLE_SECONDS;
    if (this.unreachableFor < limit) return;
    this.unreachableFor = 0;

    const reason = inGoal
      ? 'Ball is in the goal without striking the back wall, and no robot can reach it past the crossbar.'
      : 'No robot has any chance of locating the ball.';

    if (this.autoResolve) {
      // 5.6.2: nearest neutral point, and the centre if it happens again.
      this.callLackOfProgress({ rule: '5.6.1.1', reason });
    } else {
      this.emit({
        kind: 'lack-of-progress',
        rule: '5.6.1.1',
        message: `${reason} Lack of Progress is available to the referee.`,
      });
    }
  }

  /**
   * Rule 5.6: Lack of Progress.
   *
   * The referee calls Lack of Progress if:
   * - 5.6.1.2: The ball is STUCK between MULTIPLE opposing robots for a reasonable amount of time.
   *
   * If the ball is moving freely (> 60 mm/s) or being controlled by a single robot/team in
   * possession, it is actively in play and NOT in a lack-of-progress condition.
   */
  private detectStall(dt: number): void {
    if (!this.running || this.countdownActive || this.kickOffPending) return;
    const ballSpd = speed(this.ball);

    /*
     * There is deliberately no "the ball is moving, so play is fine" shortcut
     * here any more, and removing it is the whole point of this function.
     *
     * It used to reset the progress window whenever the ball briefly went
     * faster than 60 mm/s, which is a contradiction: a displacement test
     * exists precisely to catch a ball that is moving and going nowhere. A
     * ball being jostled in a scrum crosses 60 mm/s every second or so, so the
     * five-second window restarted before it could ever complete, and then had
     * to run a further five from scratch. Measured, the ball could sit inside
     * a 320 mm circle for 9.8 seconds before the referee said anything -
     * twice the time this rule believes it is enforcing, and long enough that
     * anyone watching has already decided the referee is asleep.
     *
     * Speed needs no special case. A ball that is genuinely going somewhere
     * leaves the circle on its own, which moves the mark, which resets the
     * window. The test regulates itself.
     */
    const contesting = this.active().filter(
      (r) => distance(r, this.ball) < r.radius + this.ball.radius + 25,
    );
    const hasViolet = contesting.some((r) => r.team === 'violet');
    const hasLime = contesting.some((r) => r.team === 'lime');
    const isOpposingContest = hasViolet && hasLime;

    // Rule 5.6.1.2: Ball stuck between MULTIPLE opposing robots in a scrum.
    if (isOpposingContest && ballSpd < 40) {
      this.stalledFor += dt;
      if (this.stalledFor > STALL_SECONDS) {
        this.stalledFor = 0;
        if (this.autoResolve) {
          this.callLackOfProgress();
        } else {
          this.emit({
            kind: 'lack-of-progress',
            rule: '5.6.1.2',
            message:
              'Ball has been stuck between opposing robots. Lack of Progress is available to the referee.',
          });
        }
        return;
      }
    } else {
      this.stalledFor = Math.max(0, this.stalledFor - dt * 2);
    }

    /*
     * Rule 5.6.1.1, asked continuously rather than on a timetable: has the
     * ball left a PROGRESS_DISTANCE circle in the last PROGRESS_WINDOW
     * seconds?
     *
     * Progress resets the clock the moment it happens, instead of at the end
     * of whatever fixed window the ball happened to be in. A window that only
     * looks at its own two endpoints cannot tell a ball that crossed the field
     * from one that went out and came back, and it reads the wrong answer for
     * a ball that was somewhere else when the window opened.
     */
    if (distance(this.ball, this.progressMark) > PROGRESS_DISTANCE) {
      this.progressMark = { x: this.ball.x, z: this.ball.z };
      this.sinceProgressMark = 0;
    } else {
      this.sinceProgressMark += dt;
    }

    /*
     * A ball sitting in a penalty box while that team's keeper ignores it is
     * the keeper's offence, not a neutral one.
     *
     * Both rules describe this, and they cannot both happen: 5.6.1.1 moves the
     * ball after five seconds, and 5.8.3 takes the keeper off after eight - so
     * whichever fires first makes the other unreachable. The referee watching
     * a keeper let a ball sit at its feet calls the keeper, so 5.8.3 is given
     * its full window and the progress clock waits. If the keeper comes out,
     * its timer clears and this resumes on the next tick.
     */
    if (this.active().some((r) => r.isGoalie && (r.inactiveGoalieFor ?? 0) > 0)) {
      return;
    }

    if (this.sinceProgressMark >= PROGRESS_WINDOW) {
      this.progressMark = { x: this.ball.x, z: this.ball.z };
      this.sinceProgressMark = 0;
      if (this.autoResolve) {
        this.callLackOfProgress();
      } else {
        this.emit({
          kind: 'lack-of-progress',
          rule: '5.6.1.1',
          message: `Ball has not progressed in ${PROGRESS_WINDOW} seconds. Lack of Progress is available to the referee.`,
        });
      }
      return;
    }
  }

  /**
   * Rule 5.6.1.3: A robot using greater power to "force" the ball past an
   * opposition robot that is in its penalty box.
   */
  private detectForcing(dt: number): void {
    if (!this.running || this.countdownActive) return;

    let forcingAttacker: Robot | null = null;
    let forcedDefender: Robot | null = null;

    const actives = this.active();
    for (const attacker of actives) {
      const ballDist = distance(attacker, this.ball);
      if (ballDist > attacker.radius + this.ball.radius + 25) continue;

      const oppTeam: TeamId = attacker.team === 'violet' ? 'lime' : 'violet';
      const oppGoal = this.defendingGoal(oppTeam);
      const sign = oppGoal === 'cyan' ? -1 : 1;
      const facingGoal = Math.cos(attacker.heading) * sign > 0.3;
      const drivingTowardsGoal = attacker.vx * sign > 25 || (facingGoal && attacker.vx * sign >= -10);
      if (!drivingTowardsGoal) continue;

      for (const defender of actives) {
        if (defender.team !== oppTeam) continue;
        if (!inPenaltyBox(defender, oppGoal)) continue;

        const distAttDef = distance(attacker, defender);
        const directContact = distAttDef <= attacker.radius + defender.radius + 15;
        const ballPinched =
          distAttDef <= attacker.radius + defender.radius + 2 * this.ball.radius + 15 &&
          distance(this.ball, defender) <= defender.radius + this.ball.radius + 15;

        if (directContact || ballPinched) {
          forcingAttacker = attacker;
          forcedDefender = defender;
          break;
        }
      }
      if (forcingAttacker) break;
    }

    if (forcingAttacker) {
      this.forcingDuration += dt;
      this.lastForcingTeam = forcingAttacker.team;
      this.sinceForcing = 0;

      if (this.forcingDuration > 1.2) {
        this.forcingDuration = 0;
        this.emit({
          kind: 'lack-of-progress',
          rule: '5.6.1.3',
          team: forcingAttacker.team,
          robotId: forcingAttacker.id,
          message: `Lack of Progress: ${labelFor(forcingAttacker)} called for forcing against ${labelFor(forcedDefender!)} in the penalty box (Rule 5.6.1.3).`,
        });
        if (this.autoResolve) {
          this.callLackOfProgress();
        } else {
          this.running = false;
        }
      }
    } else {
      this.forcingDuration = Math.max(0, this.forcingDuration - dt * 2);
      this.sinceForcing += dt;
    }
  }

  callForcing(team?: TeamId): void {
    this.emit({
      kind: 'lack-of-progress',
      rule: '5.6.1.3',
      team,
      message: 'Referee called Lack of Progress for forcing in the penalty box (Rule 5.6.1.3).',
    });
    this.callLackOfProgress();
  }

  /** Timers behind rules 5.7.1.2 and 5.7.1.6, plus the 5.11 geometry test. */
  private detectRobotStates(dt: number): void {
    for (const robot of this.active()) {
      // Rule 5.7.1.2 is about the GOAL AREA - inside the goal itself - not the
      // penalty box. Testing the box flagged every goalie holding a legal
      // position on its line every twenty seconds.
      const inOwnGoalArea =
        Math.abs(robot.x) + robot.radius >= GOAL_MOUTH_X - 10 &&
        Math.abs(robot.z) < HALF_GOAL_WIDTH;
      robot.inGoalAreaFor = inOwnGoalArea ? robot.inGoalAreaFor + dt : 0;
      if (robot.inGoalAreaFor > 20) {
        robot.inGoalAreaFor = 0;
        if (this.autoDamaged) {
          this.removeRobot(
            robot.id,
            '5.7.1.2',
            'Robot remained in the goal area for more than 20 seconds.',
          );
        } else {
          this.emit({
            kind: 'possible-damaged',
            rule: '5.7.1.2',
            robotId: robot.id,
            team: robot.team,
            message: `${labelFor(robot)} has been in the goal area more than 20 seconds.`,
          });
        }
      }

      // Rule 5.8.2 / 5.8.3: Goalie must respond forward to intercept the ball.
      if (robot.isGoalie) {
        const own = this.defendingGoal(robot.team);
        const ballInBox = inPenaltyBox(this.ball, own);
        const ballSlow = Math.hypot(this.ball.vx, this.ball.vz) < 40;
        // On its line, measured off the goal mouth rather than off the
        // playing area: the mouth is what physically stops the robot, so this
        // is the same "hard up against the goal" test as the 5.7.1.2 one above.
        const goalieOnLine = Math.abs(robot.x) + robot.radius > GOAL_MOUTH_X - 10;
        if (ballInBox && ballSlow && goalieOnLine) {
          robot.inactiveGoalieFor = (robot.inactiveGoalieFor ?? 0) + dt;
          if (robot.inactiveGoalieFor > 8) {
            robot.inactiveGoalieFor = 0;
            if (this.autoDamaged) {
              this.removeRobot(
                robot.id,
                '5.8.3',
                'Goalie failed to respond to the ball with forward movement down the field (Rule 5.8.2/5.8.3).',
              );
            } else {
              this.emit({
                kind: 'possible-damaged',
                rule: '5.8.3',
                robotId: robot.id,
                team: robot.team,
                message: `${labelFor(robot)} failed to respond forward to a ball in its penalty box.`,
              });
            }
          }
        } else {
          robot.inactiveGoalieFor = 0;
        }
      }

      // Rule 5.7.1.6, Lightweight and Open only: the WHOLE robot in the out
      // area. The rule carves out a robot an opponent pushed out, or one that
      // made an attempt to stay on, and lets the referee nudge it back on.
      if (this.config.league.fullyOutIsDamaged) {
        const whollyOut =
          Math.abs(robot.x) - robot.radius > HALF_LENGTH ||
          Math.abs(robot.z) - robot.radius > HALF_WIDTH;
        robot.whollyOutFor = whollyOut ? robot.whollyOutFor + dt : 0;

        if (robot.whollyOutFor > 0.8) {
          robot.whollyOutFor = 0;
          const pushedOut = robot.sinceOpponentContact < 1.5;

          if (pushedOut) {
            // "The referee may have to slightly push the robot back onto the
            // field at their discretion."
            robot.x = clampAbs(robot.x, HALF_LENGTH - robot.radius * 0.5);
            robot.z = clampAbs(robot.z, HALF_WIDTH - robot.radius * 0.5);
            this.emit({
              kind: 'possible-damaged',
              rule: '5.7.1.6',
              robotId: robot.id,
              team: robot.team,
              message: `${labelFor(robot)} was pushed wholly into the out area by an opponent. The exception applies; nudged back on.`,
            });
          } else if (this.autoDamaged) {
            this.removeRobot(
              robot.id,
              '5.7.1.6',
              'The whole robot entered the out area with no opponent involved.',
            );
          } else {
            this.emit({
              kind: 'possible-damaged',
              rule: '5.7.1.6',
              robotId: robot.id,
              team: robot.team,
              message: `${labelFor(robot)} is wholly inside the out area, with no opponent contact. Was it attempting to stay on?`,
            });
          }
        }
      }
    }

    for (const team of ['violet', 'lime'] as const) {
      // Rule 5.4.5 legitimately puts both defenders on the box at kick-off, so
      // the detector stays quiet until play has actually developed.
      if (!this.running || this.countdownActive || this.sinceKickOff < 3) continue;
      if (this.multipleDefenceCooldown[team] > 0) continue;

      const defenders = this.multipleDefenceCandidates(team);
      if (defenders.length > 1) {
        // Rule 5.11.1: Must "substantially affect the game". If the ball is
        // in the opponent's half, defenders in the box do not affect active play.
        const ballInDefendingHalf =
          this.defendingGoal(team) === 'cyan' ? this.ball.x <= 150 : this.ball.x >= -150;
        if (!ballInDefendingHalf) {
          this.multipleDefenceDwell[team] = 0;
          continue;
        }

        // Rule 5.11.1: Minimise moving robots. Dwell time ensures momentary transits
        // or clipping the penalty box while turning do not trigger relocation.
        this.multipleDefenceDwell[team] = (this.multipleDefenceDwell[team] ?? 0) + dt;
        if (this.multipleDefenceDwell[team] < 1.0) {
          continue;
        }

        this.multipleDefenceDwell[team] = 0;

        // Rule 5.6.1.4: Attacker using greater power to force two opposing robots
        // into their penalty box takes priority over Multiple Defence.
        const oppTeam: TeamId = team === 'violet' ? 'lime' : 'violet';
        const sign = this.defendingGoal(team) === 'cyan' ? -1 : 1;
        const forcingOpponent = this.active().find((opp) => {
          if (opp.team !== oppTeam) return false;
          const hasBall = distance(opp, this.ball) <= opp.radius + this.ball.radius + 35;
          const pushingDefenders = defenders.some(
            (d) =>
              distance(opp, d) <= opp.radius + d.radius + 25 ||
              (hasBall && distance(this.ball, d) <= d.radius + this.ball.radius + 20),
          );
          return hasBall && pushingDefenders && opp.vx * sign > 50;
        });

        if (forcingOpponent) {
          this.multipleDefenceCooldown[team] = 6;
          this.emit({
            kind: 'lack-of-progress',
            rule: '5.6.1.4',
            team: oppTeam,
            robotId: forcingOpponent.id,
            message: `Lack of Progress (Rule 5.6.1.4 takes priority over 5.11): ${labelFor(forcingOpponent)} forced defending robots into penalty box. Ball moved to neutral point.`,
          });
          if (this.autoResolve) {
            this.callLackOfProgress();
          } else {
            this.running = false;
          }
          continue;
        }

        if (this.autoResolve) {
          this.callMultipleDefence(team);
        } else {
          this.multipleDefenceCooldown[team] = 8;
          this.emit({
            kind: 'possible-multiple-defence',
            rule: '5.11.1',
            team,
            message: `Two ${team === 'violet' ? 'Violet' : 'Lime'} robots are directly blocking the goal in their penalty area and substantially affecting play (Rule 5.11.1). Move the non-goalie to centre.`,
          });
          this.running = false;
        }
      } else {
        this.multipleDefenceDwell[team] = 0;
      }
    }
  }

  /**
   * Rule 5.11.1: Defenders in their penalty area taking up a defensive
   * position directly blocking the goal mouth (|z| <= HALF_GOAL_WIDTH + 50).
   *
   * Outfield robots out in the wings of the penalty area (|z| > 275 mm)
   * are not directly blocking the goal and do not trigger multiple defence.
   */
  multipleDefenceCandidates(team: TeamId): Robot[] {
    const own = this.defendingGoal(team);
    const maxGoalZ = HALF_GOAL_WIDTH + 50;
    return this.active().filter(
      (r) => r.team === team && inPenaltyBox(r, own) && Math.abs(r.z) <= maxGoalZ,
    );
  }

  /**
   * Rule 5.11.2: the robot with the least influence on play is moved to the
   * centre; where a goalie is involved, the other robot is moved. Returns the
   * robot the rule points at, as a suggestion for the referee.
   */
  suggestMultipleDefenceRemoval(team: TeamId): Robot | null {
    let candidates = this.multipleDefenceCandidates(team);
    if (candidates.length < 2) {
      // If called manually by referee when multiple defenders are in the penalty box
      const own = this.defendingGoal(team);
      const inBox = this.active().filter((r) => r.team === team && inPenaltyBox(r, own));
      if (inBox.length < 2) return null;
      candidates = inBox;
    }
    const nonGoalies = candidates.filter((r) => !r.isGoalie);
    const pool = nonGoalies.length > 0 ? nonGoalies : candidates;
    // Furthest from the ball has least influence on play.
    return [...pool].sort((a, b) => distance(b, this.ball) - distance(a, this.ball))[0]!;
  }

  /**
   * Rule 5.11.2: moves the penalized robot to the centre of the field (0, 0),
   * or a fallback halfway neutral point if the centre is occupied.
   */
  callMultipleDefence(team: TeamId): boolean {
    const target = this.suggestMultipleDefenceRemoval(team);
    if (!target) return false;

    let dest: Point = { x: 0, z: 0 };
    const isOccupied = (p: Point, excludeId: string) => {
      const ballCollision = Math.hypot(p.x - this.ball.x, p.z - this.ball.z) < target.radius + this.ball.radius + 20;
      const robotCollision = this.active().some(
        (r) => r.id !== excludeId && Math.hypot(p.x - r.x, p.z - r.z) < target.radius + r.radius + 20,
      );
      return ballCollision || robotCollision;
    };

    if (isOccupied(dest, target.id)) {
      const np1: Point = { x: 0, z: -NEUTRAL_OFFSET };
      const np2: Point = { x: 0, z: NEUTRAL_OFFSET };
      const np1Free = !isOccupied(np1, target.id);
      const np2Free = !isOccupied(np2, target.id);
      if (np1Free && np2Free) {
        const d1 = Math.hypot(np1.x - this.ball.x, np1.z - this.ball.z);
        const d2 = Math.hypot(np2.x - this.ball.x, np2.z - this.ball.z);
        dest = d1 >= d2 ? np1 : np2;
      } else if (np1Free) {
        dest = np1;
      } else if (np2Free) {
        dest = np2;
      }
    }

    target.x = dest.x;
    target.z = dest.z;
    target.vx = 0;
    target.vz = 0;
    target.omega = 0;
    // Rule 5.7.4 principle: not positioned to its advantage -> face own defending goal
    target.heading = this.defendingGoal(target.team) === 'cyan' ? Math.PI : 0;

    this.multipleDefenceCooldown[team] = 8;
    this.emit({
      kind: 'possible-multiple-defence',
      rule: '5.11.2',
      team,
      robotId: target.id,
      message: `${labelFor(target)} moved to ${dest.z === 0 ? 'the centre of the field' : 'the halfway neutral point'}${target.isGoalie ? '' : ' (least influence on play)'}.`,
    });
    return true;
  }

  private occupiedNeutralPoints(): Point[] {
    return this.active().map((r) => ({ x: r.x, z: r.z }));
  }

  placeBall(p: Point): void {
    this.ball.x = p.x;
    this.ball.z = p.z;
    this.ball.vx = 0;
    this.ball.vz = 0;
    this.kickOffPending = false;
    this.reportedOutOfPlay = false;
    // Placing the ball is a discontinuous move, not progress. Without this the
    // progress test measures the referee's own intervention and concludes the
    // ball is doing fine.
    this.progressMark = { x: p.x, z: p.z };
    this.sinceProgressMark = 0;
  }

  /** Rule 5.6.2: first call to the nearest neutral point, thereafter the centre. */
  /**
   * @param because  Why it was called, as the rule that was actually broken
   *   and a sentence a spectator can read. 5.6.2 is only the remedy, and a
   *   screen that says "Lack of Progress. Ball moved." tells the hall nothing
   *   about what it just watched.
   */
  callLackOfProgress(because?: { rule: string; reason: string }): void {
    this.lackOfProgressCount += 1;
    const again = this.lackOfProgressCount > 1;
    const target = again
      ? { x: 0, z: 0 }
      : nearestNeutralPoint({ x: this.ball.x, z: this.ball.z }, this.occupiedNeutralPoints());
    this.placeBall(target);
    const moved = again
      ? 'Ball moved to the centre of the field.'
      : 'Ball moved to the nearest neutral point.';
    this.emit({
      kind: 'lack-of-progress',
      rule: because?.rule ?? '5.6.2',
      message: because ? `${because.reason} ${moved}` : `Lack of Progress. ${moved}`,
    });
  }

  /** Rule 5.7: remove a robot, standing it down for the 5.7.2 period. */
  removeRobot(robotId: string, rule: string, reason: string): void {
    const robot = this.robots.find((r) => r.id === robotId);
    if (!robot || robot.removed) return;
    robot.removed = true;
    robot.vx = 0;
    robot.vz = 0;
    robot.omega = 0;
    // Rule 5.7.2: thirty seconds, or one minute for ten-minute halves.
    robot.penaltyRemaining = this.config.halfLengthSeconds >= 600 ? 60 : 30;
    robot.removalRule = rule;
    robot.removalReason = reason;
    this.emit({
      kind: 'possible-damaged',
      rule,
      robotId,
      team: robot.team,
      message: `${labelFor(robot)} removed. ${reason}`,
    });
  }

  /**
   * Rule 5.7.4: returned to an unoccupied corner of its own penalty box,
   * not positioned to its advantage.
   */
  returnRobot(robotId: string): boolean {
    const robot = this.robots.find((r) => r.id === robotId);
    if (!robot || !robot.removed) return false;
    if (robot.penaltyRemaining > 0) return false;

    const own = this.defendingGoal(robot.team);
    const sign = own === 'cyan' ? -1 : 1;
    const cornerX = sign * (HALF_LENGTH - PENALTY_DEPTH + robot.radius);
    const corners: Point[] = [
      { x: cornerX, z: -PENALTY_WIDTH / 2 + robot.radius },
      { x: cornerX, z: PENALTY_WIDTH / 2 - robot.radius },
    ];
    // 5.7.4, and its note: an unoccupied corner of the robot's own penalty
    // box, or a neutral point if the box is fully occupied. If nothing is
    // free the robot waits rather than being placed on top of another one.
    const isFree = (c: Point): boolean =>
      !this.active().some((r) => distance(r, c) < r.radius * 2 + 20);
    const free = corners.find(isFree) ?? NEUTRAL_POINTS.find(isFree);
    if (!free) return false;

    robot.removed = false;
    robot.x = free.x;
    robot.z = free.z;
    robot.vx = 0;
    robot.vz = 0;
    robot.omega = 0;
    robot.penaltyRemaining = 0;
    robot.removalRule = undefined;
    robot.removalReason = undefined;
    // Facing the ball would advantage it, so it is turned to face its own goal.
    robot.heading = own === 'cyan' ? Math.PI : 0;
    robot.inGoalAreaFor = 0;
    robot.whollyOutFor = 0;
    return true;
  }

  kickOff(team: TeamId): void {
    this.resetRobots(team);
    this.countdownSeconds = this.config.kickoffCountdown ?? 0;
    this.paused = false;
    if (this.countdownSeconds === 0) {
      const striker = this.robots.find((r) => r.team === team && !r.isGoalie);
      this.kickOffPending = striker
        ? distance(striker, this.ball) - (striker.radius + this.ball.radius) < 50
        : false;
    }
    this.emit({
      kind: 'kickoff',
      rule: '5.4',
      team,
      message: `Kick-off to ${team === 'violet' ? 'Violet' : 'Lime'}.`,
    });
  }

  private blowWhistle(): void {
    this.paused = false;
    this.running = true;
    const striker = this.robots.find((r) => r.team === this.kickingOffTeam && !r.isGoalie);
    this.kickOffPending = striker
      ? distance(striker, this.ball) - (striker.radius + this.ball.radius) < 50
      : false;
    this.sinceKickOff = 0;
    this.emit({
      kind: 'kickoff-live',
      rule: '5.4',
      message: 'Play is live.',
    });
  }

  /** A referee skipping the kick-off wait: end the countdown and blow the whistle now. */
  skipKickoffCountdown(): void {
    if (this.countdownSeconds <= 0) return;
    this.countdownSeconds = 0;
    this.blowWhistle();
  }

  /**
   * Rule 5.4.7: The robot kicking off must make a clear strike of the ball and
   * it must roll clear of the robot by at least 50 mm or the robot must start
   * at least 50 mm from the ball. An illegal kick off will result in the
   * opposing team being granted the kick off.
   */
  private detectIllegalKickOff(): void {
    if (!this.kickOffPending || !this.running) return;

    if (this.sinceKickOff > 3) {
      this.kickOffPending = false;
      return;
    }

    const striker = this.robots.find(
      (r) => r.team === this.kickingOffTeam && !r.isGoalie && !r.removed,
    );
    if (!striker) {
      this.kickOffPending = false;
      return;
    }

    const gap = distance(striker, this.ball) - (striker.radius + this.ball.radius);
    // 5.4.7: If the ball has rolled clear of the robot by at least 50 mm, the kick-off was legal!
    if (gap >= 50) {
      this.kickOffPending = false;
      this.consecutiveIllegalKickOffs = 0;
      return;
    }

    // If the robot started within 50 mm, it was required to make a clear strike.
    // An illegal kick-off occurs if the ball is carried/dribbled away from the centre (> 120 mm)
    // or across the halfway line without having rolled 50 mm clear.
    const ballDistFromCenter = Math.hypot(this.ball.x, this.ball.z);
    const crossedHalf =
      this.attackingGoal(this.kickingOffTeam) === 'yellow' ? striker.x > 0 : striker.x < 0;
    const isCarrying = gap < 35 && (ballDistFromCenter > 120 || crossedHalf);

    if (isCarrying) {
      const offendingTeam = this.kickingOffTeam;
      const awardedTeam: TeamId = offendingTeam === 'violet' ? 'lime' : 'violet';
      this.kickOffPending = false;

      // Two re-takes is enough. Beyond that, play on: a restart nobody can
      // execute legally is worse for the game than a kick-off nobody earned.
      if (++this.consecutiveIllegalKickOffs > 2) {
        this.emit({
          kind: 'illegal-kickoff',
          rule: '5.4.7',
          team: offendingTeam,
          message: 'Repeated illegal kick-offs; referee plays on.',
        });
        return;
      }
      this.emit({
        kind: 'illegal-kickoff',
        rule: '5.4.7',
        team: offendingTeam,
        robotId: striker.id,
        message: `Illegal kick-off by ${offendingTeam === 'violet' ? 'Violet' : 'Lime'}. Ball was carried without rolling 50 mm clear. Kick-off awarded to ${awardedTeam === 'violet' ? 'Violet' : 'Lime'}.`,
      });
      if (this.autoResolve) {
        this.kickOff(awardedTeam);
      } else {
        this.running = false;
      }
    }
  }

  callIllegalKickOff(): void {
    const offendingTeam = this.kickingOffTeam;
    const awardedTeam: TeamId = offendingTeam === 'violet' ? 'lime' : 'violet';
    this.kickOffPending = false;
    this.emit({
      kind: 'illegal-kickoff',
      rule: '5.4.7',
      team: offendingTeam,
      message: `Referee called illegal kick-off by ${offendingTeam === 'violet' ? 'Violet' : 'Lime'}. Kick-off awarded to ${awardedTeam === 'violet' ? 'Violet' : 'Lime'}.`,
    });
    this.kickOff(awardedTeam);
  }
}

function clampAbs(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

/** Rule 4.6.4: effective depth of the dribbler recess on the front of the robot. */
export function dribblerRecess(robot: Robot, ball: Body, league: League): number {
  if (!league.dribblerAllowed) return 0;
  const toBall = Math.atan2(ball.z - robot.z, ball.x - robot.x);
  let off = Math.abs(toBall - robot.heading);
  while (off > Math.PI) off = Math.abs(off - Math.PI * 2);
  if (off > 0.6) return 0;
  const capture = Math.min(league.ballCaptureMm, ball.radius) * 0.5;
  return capture * (1 - off / 0.6);
}

export function labelFor(robot: Robot): string {
  const team = robot.team === 'violet' ? 'Violet' : 'Lime';
  const n = robot.id.endsWith('1') ? '1' : '2';
  return `${team} ${n}`;
}
