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
import { ballDiameter, type League } from '@rcja/shared/leagues';
import {
  BALL_BOUNCE,
  collideBodies,
  BALL_ROBOT_BOUNCE,
  collideWithPerimeter,
  separateBodies,
  distance,
  speed,
  stepBall,
  sweptBallCollision,
  type Body,
} from './physics';
import { openDrive, stepDrive, type DriveSpec } from './drive';
import { placementJitter } from './rand';
import {
  type TeamId,
  type EventKind,
  type MatchEvent,
} from '@rcja/shared/view';

// Re-export shared types so existing imports of world.TeamId etc. keep working.
export type { TeamId, EventKind, MatchEvent };

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
  /**
   * How long one robot may sit on a motionless ball, unopposed, before 5.6
   * takes it off them. Defaults to HELD_BALL_SECONDS; 0 or a negative number
   * turns the test off and restores unlimited possession.
   *
   * A setting rather than a constant because it is the one 5.6 window that is
   * a judgement about how the game should play rather than a reading of the
   * rule book. 5.6 does not describe this ball at all - no opponent is
   * contesting it, so 5.6.1.2 does not apply, and a robot is touching it, so
   * "no robot has any chance of locating the ball" is plainly false. What to
   * do about it is the referee's, and referees differ.
   */
  heldBallSeconds?: number;
  /**
   * How long a person takes to carry the ball to a neutral point when 5.6.2
   * or 5.9.2 moves it, drawn per placement from this range off the match
   * seed. Defaults to BALL_PLACEMENT_SECONDS; a max of 0 puts it down in the
   * same tick, which is what every match did before this existed.
   *
   * While it is in somebody's hand the ball is not on the field: nothing
   * touches it, no rule about it can fire, and no robot can sense it.
   */
  ballPlacementSeconds?: { min: number; max: number };
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
 * A displacement test on its own is a speed limit in disguise, and that is the
 * false call this pair of constants exists to stop.
 *
 * 320 mm in 5 s is 64 mm/s of NET travel, so a ball edged steadily down the
 * field slower than that was called for lack of progress while it was plainly
 * going somewhere - which is most of what a contested ball being worked out of
 * a corner looks like.
 *
 * Straightness tells the two apart: net displacement over the distance the
 * ball actually rolled. A ball rattling between robots covers metres and ends
 * up where it started, so its straightness is near zero. A ball being walked
 * slowly down the field covers the same ground in one direction, so its
 * straightness is near one, and it is progressing however slowly.
 *
 * Below PROGRESS_MIN_PATH the ball has barely rolled at all. There is no
 * direction to measure and nothing that could be called progress, so the
 * straightness let-off does not apply.
 */
const PROGRESS_STRAIGHTNESS = 0.6;
const PROGRESS_MIN_PATH = 120;

/**
 * How much ground the ball has to range over before it is plainly not stuck.
 *
 * `PROGRESS_DISTANCE` is measured from a single mark, so it asks whether the
 * ball ENDED UP anywhere - and a ball being hammered back and forth across a
 * goalmouth never ends up anywhere while never once being stuck. Reported from
 * a real match, repeatedly, as a ball kicked into the goal mouth and called
 * for lack of progress while it was moving the whole time. Measured, those
 * windows had the ball at a mean of 205-346 mm/s with peaks over 2 m/s,
 * ranging over a box 389-604 mm across.
 *
 * The bounding box is what tells them apart, and the separation is not close:
 * across 168 calls, windows where the ball was genuinely stopped had a span of
 * ZERO at the 90th percentile. At 350 mm this lets off seven calls and not one
 * of them was on a still ball.
 *
 * Deliberately not a speed test. The old speed shortcut reset the window on any
 * instantaneous flicker over 60 mm/s, which a jostled ball crosses constantly,
 * and removing it is why this function was rewritten. A ball rattling inside a
 * robot's width still covers no ground and is still called.
 */
const PROGRESS_SPAN = 350;

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

/**
 * The other half of 5.6.1.1, and the hole the distance test left: a stopped
 * ball with robots standing around it that none of them is going after.
 *
 * Distance alone cannot see it. A robot parked 200 mm from a dead ball is of
 * no more use to it than one at the far end of the field, but it kept the gap
 * under UNREACHABLE_DISTANCE, so 5.6.1.1 stayed quiet - and with no opponent
 * within PROGRESS_DISTANCE, 5.6.1.2 was not looking either. The ball could sit
 * there for the rest of the half and no rule would ever speak.
 *
 * What settles it is whether the gap to the nearest robot is still closing.
 * REACH_PROGRESS is deliberately far larger than any jitter: a robot actually
 * heading for the ball crosses it in well under a second, and one that has
 * lost the ball never crosses it at all.
 *
 * Inside POSSESSION_GAP the ball is at a robot's feet. That is possession, and
 * a ball being fought over belongs to 5.6.1.2, not here.
 */
const POSSESSION_GAP = 30;
const REACH_PROGRESS = 150;
const NEGLECTED_SECONDS = 5;

/**
 * And the last way a ball can go nowhere: one robot sitting on it, unopposed,
 * doing nothing with it.
 *
 * This was untouchable by every test above. No opponent is within
 * PROGRESS_DISTANCE, so 5.6.1.2 is not watching. The ball is inside
 * POSSESSION_GAP, so the neglected test reads possession and stands off. And
 * possession is the right reading right up until it isn't: measured over a bot
 * round-robin, the longest a ball ever went without getting anywhere was a
 * spinner sitting on it for 240 seconds - the whole match - with the referee
 * saying nothing, and 28% of every dead spell past eight seconds had this
 * shape.
 *
 * So possession earns rope, not the match. Longer than NEGLECTED_SECONDS,
 * because a robot that has the ball has earned a moment to line something up,
 * and a robot lining something up is not what this is about.
 */
export const HELD_BALL_SECONDS = 8;

/**
 * Half a second is a quick hand close to the spot; two is an unhurried walk
 * round the field. See `MatchConfig.ballPlacementSeconds`.
 */
export const BALL_PLACEMENT_SECONDS = { min: 0.5, max: 2.0 } as const;

/** The `placementJitter` slot the placement delay draws from, clear of every robot's. */
const BALL_PLACEMENT_KEY = 0xba11;

/**
 * Why the ball is not on the field, when it is not.
 *
 * `hand`: somebody is carrying it to a neutral point, and puts it down when
 * `remaining` runs out. `off`: a practice field has taken it away, and it
 * stays away - through restarts and restages - until it is switched back on.
 */
export type BallAway =
  | { kind: 'hand'; remaining: number; from: Point; toCentre: boolean }
  | { kind: 'off' };

/**
 * Rule 5.6.1.3: how long a robot has to be shoving before it is forcing.
 *
 * `FORCING_SECONDS` is the offence - hold a defender in its own box that long
 * while driving at goal and the referee stops play. `FORCING_GOAL_SECONDS` is
 * the lower bar a goal has to clear to be disallowed as "a direct result of
 * forcing", because a goal scored at 1.2 s can never happen: the referee has
 * already blown up for it.
 *
 * Any bar at all is the fix. The disallow used to key off `lastForcingTeam`,
 * which is set on ANY tick where an attacker with the ball touches a defender
 * in the box - so a striker who so much as brushed the keeper on the way past
 * lost the goal. Measured over champion and reference play: 163 goals
 * disallowed, 22% of every goal scored, of which 75 were disallowed on a
 * SINGLE TICK of contact, the median contact was 0.04 s, and not one had gone
 * on long enough to be the offence the rule describes.
 *
 * Reported from a real match as a striker beating the keeper and the goal
 * being turned into a lack-of-progress restart at the centre spot.
 */
const FORCING_SECONDS = 1.2;
const FORCING_GOAL_SECONDS = 0.6;

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
  /** Most recent touch per team, so deflected shots do not erase the shooter's attribution. */
  lastTouchByTeam: Record<TeamId, { robotId: string; at: number } | null> = { violet: null, lime: null };

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
  private readonly scratchBallBefore: Body = { x: 0, z: 0, vx: 0, vz: 0, radius: 0, mass: 0 };
  private readonly scratchBallTrial: Body = { x: 0, z: 0, vx: 0, vz: 0, radius: 0, mass: 0 };
  private readonly activeRobotsBuffer: Robot[] = [];
  private readonly orderedActivesBuffer: Robot[] = [];

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
  /** Closest any robot has come to the ball since `unreachableFor` last reset. */
  private reachMark = Infinity;
  /** Where the ball was PROGRESS_WINDOW ago, for the lack-of-progress test. */
  private progressMark: Point = { x: 0, z: 0 };
  private sinceProgressMark = 0;
  /** Where the ball was last tick, to integrate how far it has actually rolled. */
  private progressPrev: Point = { x: 0, z: 0 };
  /** Distance the ball has rolled since `progressMark`, path length not displacement. */
  private pathSinceMark = 0;
  /** Which window the progress clock is running under; a change restarts it. */
  private progressKind: 'contested' | 'held' | null = null;
  /** The ball's bounding box since `progressMark`, for the `PROGRESS_SPAN` test. */
  private spanMinX = 0;
  private spanMaxX = 0;
  private spanMinZ = 0;
  private spanMaxZ = 0;
  /** How many times lack of progress has been called since the last restart (5.6.2). */
  lackOfProgressCount = 0;
  /** Whether the ball now in the goal has already been counted. See `detectGoal`. */
  private goalGiven = false;
  /**
   * The longest this forcing episode has run, not how much is left of it.
   *
   * `forcingDuration` decays once the shoving stops, at twice the rate it
   * built up, so by the time a goal arrives it says almost nothing about what
   * happened just before. The peak is what 5.6.1.3 is asking about.
   */
  private forcingPeak = 0;
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
   * Kick-offs so far. Every one is somebody lifting their robots, putting them
   * down on their marks and pressing start again; the match turns a change in
   * this into the start button going up for a moment. See `Match.buttonUp`.
   */
  kickOffs = 0;
  /**
   * Without auto-resolution the ball stays where it went out, so the detector
   * would fire on every frame. Latched until the ball is placed again.
   */
  private reportedOutOfPlay = false;

  /** Count of restarts placed, providing stateless, order-independent jitter. */
  private restartCount = 0;
  /** Why the ball is off the field, or null while it is on it. */
  private ballAway: BallAway | null = null;
  /** Count of placements by hand, the placement delay's analogue of `restartCount`. */
  private liftCount = 0;

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

  /**
   * Whether the ball is on the field at all. False while a person is carrying
   * it to a neutral point, or while a practice field has it switched off:
   * nothing can touch it, no rule about it can fire, and no robot senses it.
   */
  get ballInPlay(): boolean {
    return this.ballAway === null;
  }

  /** Why the ball is off the field, or null while it is on it. */
  get ballAwayReason(): BallAway['kind'] | null {
    return this.ballAway?.kind ?? null;
  }

  /**
   * Take the ball off the field, or put it back.
   *
   * For a practice field that wants to see what its robots do with no ball.
   * Off survives restarts and restages; nothing but this brings it back. On
   * puts it down where `at` says, as a placement by hand does.
   */
  setBallOnField(on: boolean, at: Point = { x: 0, z: 0 }): void {
    if (!on) {
      this.ballAway = { kind: 'off' };
      this.ball.vx = 0;
      this.ball.vz = 0;
      return;
    }
    if (this.ballAway?.kind !== 'off') return;
    this.ballAway = null;
    this.placeBall(at);
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
    this.lastTouchByTeam = { violet: null, lime: null };
    // A restart puts every robot in the arrangement back on the field,
    // including one still serving a 5.7 stand-down: the damage call ends at
    // the next kick-off, and the robot takes its kick-off position like the
    // rest rather than sitting out the remainder beside the pitch. Reusing
    // `existing` below and clearing its removal is the whole of that.
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

    // A restart puts the ball on its spot, so nobody is still carrying it.
    // Switched off stays off: a practice field with no ball restages with none.
    if (this.ballAway?.kind === 'hand') this.ballAway = null;
    this.ball.x = arrangement.ball.x;
    this.ball.z = arrangement.ball.z;
    this.ball.vx = arrangement.ball.vx ?? 0;
    this.ball.vz = arrangement.ball.vz ?? 0;
    this.resetProgressClocks();
    this.lackOfProgressCount = 0;
    this.sinceKickOff = 0;
    this.kickingOffTeam = kickingOff;
    this.kickOffPending = false;
    this.multipleDefenceCooldown = { violet: 0, lime: 0 };
    this.multipleDefenceDwell = { violet: 0, lime: 0 };
    this.forcingDuration = 0;
    this.forcingPeak = 0;
    this.lastForcingTeam = null;
    this.sinceForcing = 999;
    this.reportedOutOfPlay = false;
    this.active();
  }

  active(): Robot[] {
    this.activeRobotsBuffer.length = 0;
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i]!;
      if (!r.removed) this.activeRobotsBuffer.push(r);
    }
    return this.activeRobotsBuffer;
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

    this.stepBallAway(dt);
    const ballLive = this.ballInPlay;

    const ballX0 = this.ball.x;
    const ballZ0 = this.ball.z;
    if (ballLive) stepBall(this.ball, dt, this.ballFriction);

    this.activeRobotsBuffer.length = 0;
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i]!;
      if (!r.removed) this.activeRobotsBuffer.push(r);
    }
    const actives = this.activeRobotsBuffer;

    let sweptHit: ReturnType<typeof sweptBallCollision> = null;
    if (ballLive && Math.hypot(this.ball.vx, this.ball.vz) > 1000) {
      const goalBound = Math.abs(this.ball.z) <= HALF_GOAL_WIDTH - this.ball.radius * 0.5;
      sweptHit = sweptBallCollision(
        this.ball,
        ballX0,
        ballZ0,
        this.ball.x,
        this.ball.z,
        actives,
        goalBound,
        this.ballBounce,
      );
      if (sweptHit?.hit === 'robot' && sweptHit.robotId) {
        const robotId = sweptHit.robotId;
        const r = actives.find((a) => a.id === robotId);
        if (r) {
          this.lastBallTouch = { robotId: r.id, team: r.team, at: this.clock };
          this.lastTouchByTeam[r.team] = { robotId: r.id, at: this.clock };
        }
      }
    }

    // One impulse pass, so a collision exchanges momentum exactly once.
    //
    // Every robot resolves against the SAME pre-pass ball state and the
    // resulting corrections are summed, rather than each robot in turn
    // resolving against whatever the previous one just left behind.
    this.scratchBallBefore.x = this.ball.x;
    this.scratchBallBefore.z = this.ball.z;
    this.scratchBallBefore.vx = this.ball.vx;
    this.scratchBallBefore.vz = this.ball.vz;
    this.scratchBallBefore.radius = this.ball.radius;
    this.scratchBallBefore.mass = this.ball.mass;
    this.scratchBallBefore.y = this.ball.y;
    this.scratchBallBefore.vy = this.ball.vy;

    let ballDX = 0;
    let ballDZ = 0;
    let ballDVX = 0;
    let ballDVZ = 0;
    for (let i = 0; ballLive && i < actives.length; i++) {
      const robot = actives[i]!;
      const recess = dribblerRecess(robot, this.scratchBallBefore, this.config.league);
      this.scratchBallTrial.x = this.scratchBallBefore.x;
      this.scratchBallTrial.z = this.scratchBallBefore.z;
      this.scratchBallTrial.vx = this.scratchBallBefore.vx;
      this.scratchBallTrial.vz = this.scratchBallBefore.vz;
      this.scratchBallTrial.radius = this.scratchBallBefore.radius;
      this.scratchBallTrial.mass = this.scratchBallBefore.mass;
      this.scratchBallTrial.y = this.scratchBallBefore.y;
      this.scratchBallTrial.vy = this.scratchBallBefore.vy;

      if (collideBodies(robot, this.scratchBallTrial, recess, BALL_ROBOT_BOUNCE)) {
        ballDX += this.scratchBallTrial.x - this.scratchBallBefore.x;
        ballDZ += this.scratchBallTrial.z - this.scratchBallBefore.z;
        ballDVX += this.scratchBallTrial.vx - this.scratchBallBefore.vx;
        ballDVZ += this.scratchBallTrial.vz - this.scratchBallBefore.vz;
        this.lastBallTouch = { robotId: robot.id, team: robot.team, at: this.clock };
        this.lastTouchByTeam[robot.team] = { robotId: robot.id, at: this.clock };
      }
    }
    this.ball.x += ballDX;
    this.ball.z += ballDZ;
    this.ball.vx += ballDVX;
    this.ball.vz += ballDVZ;
    for (let i = 0; i < actives.length; i++) actives[i]!.sinceOpponentContact += dt;

    this.orderedActivesBuffer.length = 0;
    if (this.pairOrderFlipped) {
      for (let i = actives.length - 1; i >= 0; i--) this.orderedActivesBuffer.push(actives[i]!);
    } else {
      for (let i = 0; i < actives.length; i++) this.orderedActivesBuffer.push(actives[i]!);
    }
    const robotPairOrder = this.orderedActivesBuffer;

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
    let isScrum = false;
    for (let pass = 0; pass < CONTACT_PASSES; pass++) {
      let anyMoved = false;
      let contacts = 0;
      for (let i = 0; i < robotPairOrder.length; i++) {
        for (let j = i + 1; j < robotPairOrder.length; j++) {
          if (separateBodies(robotPairOrder[i]!, robotPairOrder[j]!)) {
            anyMoved = true;
            contacts++;
          }
        }
      }
      for (let i = 0; i < robotPairOrder.length; i++) {
        const robot = robotPairOrder[i]!;
        const recess = dribblerRecess(robot, this.ball, this.config.league);
        if (ballLive && separateBodies(robot, this.ball, recess)) anyMoved = true;
        if (collideWithPerimeter(robot, false)) anyMoved = true;
      }
      if (pass === 0 && contacts >= 2) {
        isScrum = true;
      }
      if (!anyMoved) break;
    }

    // Adaptive substepping for multi-body scrums (e.g. 3 or 4 robots pinned in a corner):
    // If multiple robots remained in contact, run a secondary micro-relaxation pass
    // to guarantee sub-millimeter overlap without oscillation.
    if (isScrum) {
      for (let subPass = 0; subPass < 4; subPass++) {
        let subMoved = false;
        for (let i = 0; i < robotPairOrder.length; i++) {
          for (let j = i + 1; j < robotPairOrder.length; j++) {
            if (separateBodies(robotPairOrder[i]!, robotPairOrder[j]!)) subMoved = true;
          }
        }
        for (let i = 0; i < robotPairOrder.length; i++) {
          const robot = robotPairOrder[i]!;
          const recess = dribblerRecess(robot, this.ball, this.config.league);
          if (ballLive && separateBodies(robot, this.ball, recess)) subMoved = true;
          if (collideWithPerimeter(robot, false)) subMoved = true;
        }
        if (!subMoved) break;
      }
    }

    // Allow entry with the physics' own margin (half a radius), not the full
    // post plane: only a ball that could actually get inside the goal opens
    // the mouth.
    //
    // Every rule about the ball asks again whether there is one: a detector
    // earlier in the list can send it off in somebody's hand, and the ones
    // after it must not go on judging a ball nobody can play.
    if (ballLive) {
      const goalBound = Math.abs(this.ball.z) <= HALF_GOAL_WIDTH - this.ball.radius * 0.5;
      const hit = collideWithPerimeter(this.ball, goalBound, this.ballBounce);
      this.detectGoal(sweptHit?.hit === 'goal-back' || hit === 'goal-back');
    }
    if (this.ballInPlay) this.detectUnreachable(dt);
    if (this.ballInPlay) this.detectBallOutOfPlay();
    if (this.ballInPlay) this.detectIllegalKickOff();
    if (this.ballInPlay) this.detectStall(dt);
    if (this.ballInPlay) this.detectForcing(dt);
    this.detectRobotStates(dt);
  }

  /**
   * Rule 5.5.1: a goal is scored when the ball is completely over the goal
   * line, between the posts.
   *
   * This used to hang the goal on the ball striking the BACK WALL, and that is
   * a far stricter thing than it sounds. The goal is 74 mm deep and the open
   * league's ball is 42 mm across, so a ball that has fully crossed the line
   * has about 32 mm of travel left to reach the wall - and carpet takes that
   * back off a ball at a walking pace. Measured over a bot round-robin, 433 of
   * the 434 balls that died inside the goal had COMPLETELY crossed the line
   * and simply run out of momentum in there. None of them was given.
   *
   * They did not even look like near misses from the side of the pitch: a
   * robot walks the ball in, the ball is plainly in the goal, and three
   * seconds later the referee announces that no robot can reach it past the
   * crossbar and puts it back on a neutral point.
   *
   * The back wall stays in as a fast path, because a ball can cross the whole
   * goal inside one tick and the swept test is what catches that. Anything
   * that reaches the back wall has crossed the line on the way, so the two can
   * never disagree.
   */
  private get autoResolve(): boolean {
    return this.config.autoResolve !== false;
  }

  private get autoDamaged(): boolean {
    return this.config.autoDamaged ?? this.autoResolve;
  }

  private detectGoal(struckBackWall: boolean): void {
    // Completely over the line: the trailing edge is past it, not just the
    // centre. A ball resting ON the line is not a goal, and 5.6.1.1 is still
    // what frees that one, since the crossbar keeps every robot off it.
    const whollyOver =
      Math.abs(this.ball.x) - this.ball.radius > HALF_LENGTH && withinGoalMouth(this.ball.z);

    /*
     * Crossing the line is a STATE, and the back wall was an EVENT. That is
     * the one thing that has to be handled here rather than falling out of the
     * change: a ball over the line goes on being over the line for as long as
     * it sits there, so without a latch every tick is another goal.
     *
     * It only shows up where a goal does not restart the match - a practice
     * field set to freeze, or anything else with `autoResolve` off. A
     * self-running match kicks off again and hides it. Found at five goals for
     * one shot.
     */
    if (!struckBackWall && !whollyOver) {
      if (Math.abs(this.ball.x) <= HALF_LENGTH) this.goalGiven = false;
      return;
    }
    if (this.goalGiven) return;
    this.goalGiven = true;
    const scoringSide: GoalSide = this.ball.x > 0 ? 'yellow' : 'cyan';
    // Whichever team does NOT currently defend that goal scored in it. Not a
    // fixed violet/lime flip: which team defends which goal swaps at half-time
    // (rule 1.4/5.4), even though the goals' own colours and places don't.
    const scorer: TeamId = this.defendingGoal('violet') === scoringSide ? 'lime' : 'violet';

    // Rule 5.6.1.3: If a goal is scored as a direct result of forcing, it will be disallowed!
    if (
      this.lastForcingTeam === scorer &&
      this.sinceForcing < 0.8 &&
      this.forcingPeak >= FORCING_GOAL_SECONDS
    ) {
      this.emit({
        kind: 'lack-of-progress',
        rule: '5.6.1.3',
        team: scorer,
        message: `Goal disallowed! Ball was forced through an opposition defender in the penalty box (Rule 5.6.1.3). Ball moved to neutral point.`,
      });
      this.lastForcingTeam = null;
      this.sinceForcing = 999;
      this.forcingDuration = 0;
      this.forcingPeak = 0;
      if (this.autoResolve) {
        this.callLackOfProgress();
      } else {
        this.running = false;
      }
      return;
    }

    this.score[scorer] += 1;
    let scoringRobotId: string | undefined = undefined;
    const teamTouch = this.lastTouchByTeam[scorer];
    if (teamTouch && this.clock - teamTouch.at < 10.0) {
      scoringRobotId = teamTouch.robotId;
    } else if (this.lastBallTouch && this.clock - this.lastBallTouch.at < 10.0 && this.lastBallTouch.team === scorer) {
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

    this.liftBall(false);
    this.emit({
      kind: 'ball-out-of-play',
      rule: '5.9.2',
      message: 'Ball out of play. Moved to the nearest neutral point.',
    });
  }

  /**
   * Every 5.6 clock, back to zero, with the ball wherever it now is.
   *
   * These are all measuring the same thing - how long this ball has been going
   * nowhere - so anything that makes the question fresh has to clear all of
   * them together. Leaving one running is how the referee ends up calling
   * twice for one incident, the second time within a tick of the first.
   */
  private resetProgressClocks(): void {
    this.stalledFor = 0;
    this.unreachableFor = 0;
    this.reachMark = Infinity;
    this.restartProgressWindow();
    this.progressKind = null;
  }

  /**
   * Start the displacement window again, here, now.
   *
   * `progressPrev` is reset with the rest and not left to the tick loop,
   * because the path integral is a sum of one-tick steps and a window that
   * begins with a stale `progressPrev` books the whole jump from wherever the
   * ball used to be as distance travelled. One bogus step is enough: 682 mm of
   * travel that never happened, on the opening tick, dragged straightness from
   * 1.0 down to 0.27 and called a ball that was moving cleanly down the field.
   *
   * That only surfaced once the window could restart without also taking the
   * displacement branch, which had been quietly swallowing the bad step.
   */
  private restartProgressWindow(): void {
    this.progressMark = { x: this.ball.x, z: this.ball.z };
    this.progressPrev = { x: this.ball.x, z: this.ball.z };
    this.sinceProgressMark = 0;
    this.pathSinceMark = 0;
    this.spanMinX = this.ball.x;
    this.spanMaxX = this.ball.x;
    this.spanMinZ = this.ball.z;
    this.spanMaxZ = this.ball.z;
  }

  /**
   * The team of the robot with the ball at its feet, if exactly one team has.
   *
   * Null when nobody is on it, and null when both teams are - that is a pin,
   * and the 5.6.1.2 stall branch above is the test for it.
   */
  private holdingRobot(): TeamId | null {
    let holder: TeamId | null = null;
    for (let i = 0; i < this.activeRobotsBuffer.length; i++) {
      const r = this.activeRobotsBuffer[i]!;
      const gap = distance(r, this.ball) - r.radius - this.ball.radius;
      if (gap > POSSESSION_GAP) continue;
      if (holder !== null && holder !== r.team) return null;
      holder = r.team;
    }
    return holder;
  }

  /**
   * Rule 5.8.3 is already running against a keeper letting the ball sit at its
   * feet.
   *
   * Both rules describe that ball and they cannot both have it: 5.6 moves the
   * ball, which puts it out of reach of the keeper 5.8.3 was about to punish.
   * The referee watching a keeper ignore a ball in its own box calls the
   * keeper, so 5.8.3 gets its full window and the 5.6 clocks wait. The timer
   * only ticks while the ball is in that keeper's own box, so this is narrower
   * than it looks.
   */
  private get goalieClockRunning(): boolean {
    for (let i = 0; i < this.activeRobotsBuffer.length; i++) {
      const r = this.activeRobotsBuffer[i]!;
      if (r.isGoalie && (r.inactiveGoalieFor ?? 0) > 0) return true;
    }
    return false;
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
      this.reachMark = Infinity;
      return;
    }

    // Inside the goal mouth and past the goal line. The crossbar keeps robots
    // out, so this is not a matter of waiting longer - it will never be
    // reached, and the only question is how long to be sure it has stopped.
    const inGoal =
      Math.abs(this.ball.x) > HALF_LENGTH && withinGoalMouth(this.ball.z);

    let nearest = Infinity;
    for (let i = 0; i < this.activeRobotsBuffer.length; i++) {
      const robot = this.activeRobotsBuffer[i]!;
      nearest = Math.min(nearest, distance(robot, this.ball) - robot.radius - this.ball.radius);
    }

    if (!inGoal) {
      // At a robot's feet: possession, and a ball being fought over is 5.6.1.2.
      // Still closing: somebody is going after it, so it is not abandoned. The
      // opening tick has reachMark at Infinity and only sets the mark.
      //
      // `nearest` is Infinity when every robot has been removed, and Infinity
      // is not less than Infinity minus anything - without the finite test an
      // empty field reads as somebody forever closing in on the ball.
      const closing = Number.isFinite(nearest) && nearest <= this.reachMark - REACH_PROGRESS;
      if (nearest <= POSSESSION_GAP || closing) {
        this.unreachableFor = 0;
        this.reachMark = nearest;
        return;
      }
    }

    const neglected = !inGoal && nearest < UNREACHABLE_DISTANCE;
    // The keeper gets called before the ball is moved out from under it.
    if (neglected && this.goalieClockRunning) return;

    this.unreachableFor += dt;
    const limit = inGoal
      ? UNREACHABLE_IN_GOAL_SECONDS
      : neglected
        ? NEGLECTED_SECONDS
        : UNREACHABLE_SECONDS;
    if (this.unreachableFor < limit) return;
    this.unreachableFor = 0;
    this.reachMark = Infinity;

    const reason = inGoal
      ? 'Ball is in the goal without striking the back wall, and no robot can reach it past the crossbar.'
      : neglected
        ? 'Ball has been sitting untouched with no robot closing on it.'
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
    // Nothing that happens while the ball is not in play is progress or the
    // lack of it, and the path integral below would otherwise swallow every
    // jump the referee makes between whistles.
    if (!this.running || this.countdownActive || this.kickOffPending) {
      this.resetProgressClocks();
      return;
    }
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
    let hasVioletPin = false;
    let hasLimePin = false;
    let hasVioletContest = false;
    let hasLimeContest = false;

    const pinThresh = this.ball.radius + 25;
    const contestThresh = PROGRESS_DISTANCE;

    for (let i = 0; i < this.activeRobotsBuffer.length; i++) {
      const r = this.activeRobotsBuffer[i]!;
      const d = distance(r, this.ball);
      if (d < r.radius + pinThresh) {
        if (r.team === 'violet') hasVioletPin = true;
        if (r.team === 'lime') hasLimePin = true;
      }
      if (d < contestThresh) {
        if (r.team === 'violet') hasVioletContest = true;
        if (r.team === 'lime') hasLimeContest = true;
      }
      if (hasVioletPin && hasLimePin && hasVioletContest && hasLimeContest) break;
    }
    const isPushedPinched = hasVioletPin && hasLimePin;
    const isOpposingContest = hasVioletContest && hasLimeContest;

    // Rule 5.6.1.2: Ball stuck between MULTIPLE opposing robots in a scrum.
    if (isPushedPinched && ballSpd < 40) {
      this.stalledFor += dt;
      if (this.stalledFor > STALL_SECONDS) {
        this.stalledFor = 0;
        const reason = 'Ball has been stuck between opposing robots.';
        if (this.autoResolve) {
          this.callLackOfProgress({ rule: '5.6.1.2', reason });
        } else {
          this.emit({
            kind: 'lack-of-progress',
            rule: '5.6.1.2',
            message: `${reason} Lack of Progress is available to the referee.`,
          });
        }
        return;
      }
    } else {
      this.stalledFor = Math.max(0, this.stalledFor - dt * 2);
    }

    /*
     * Rule 5.6.1.2 (moving scrum): has the ball left a PROGRESS_DISTANCE
     * circle in the last PROGRESS_WINDOW seconds while opposing robots
     * are contesting it?
     *
     * If there is no opposing contest, the ball is actively in play
     * (e.g. dribbled, held, or passed by a single robot or team) and
     * cannot be called for lack of progress under 5.6.1.2.
     * We reset the window so that a future contest starts with a full clock.
     */
    /*
     * Unopposed, but not necessarily fine.
     *
     * If a robot has the ball at its feet this is possession, and possession
     * gets the same displacement test as a scrum on a longer window - not a
     * free pass. Measured over a bot round-robin, a free pass was worth up to
     * 240 seconds of a robot sitting on the ball with the referee silent.
     *
     * Displacement is what to measure and not speed, for the same reason as
     * everywhere else in this function: a robot spinning on the spot with the
     * ball against it is moving the ball quickly and taking it nowhere.
     *
     * If nobody has it either, the ball is loose and unwatched, and
     * detectUnreachable is the test for that.
     */
    const heldLimit = this.config.heldBallSeconds ?? HELD_BALL_SECONDS;
    const heldByOne = heldLimit > 0 && !isOpposingContest && this.holdingRobot() !== null;
    const kind = isOpposingContest ? 'contested' : heldByOne ? 'held' : null;

    if (kind === null) {
      this.restartProgressWindow();
      this.progressKind = null;
      return;
    }

    /*
     * The clock restarts when the situation under it changes, because the two
     * situations are not judged on the same window and banked time does not
     * convert between them.
     *
     * Without this, a striker who walked the ball up the field unopposed spent
     * seconds against the eight-second held rope, and the moment a keeper came
     * out to meet it the rope became five - so a contest less than a second
     * old was called for a stall that had not happened during it. Seen in a
     * real match as a call in front of the goal mouth with a goal coming, and
     * reproduced at 0.83 seconds of contest. An opponent arriving is the
     * clearest sign a ball is about to be fought over rather than stuck, which
     * makes an instant call on their arrival exactly backwards.
     */
    if (kind !== this.progressKind) {
      this.progressKind = kind;
      this.restartProgressWindow();
    }

    /*
     * The step is measured here and not at the top of the function, after
     * every branch that could have restarted the window has had its say.
     *
     * Measured up front it is a step from wherever the ball was under the
     * PREVIOUS window, and on the tick a window restarts that is not a step
     * the new window took. `restartProgressWindow` moves `progressPrev` to the
     * ball, so this reads 0 on such a tick rather than the jump.
     */
    if (distance(this.ball, this.progressMark) > PROGRESS_DISTANCE) {
      this.restartProgressWindow();
    } else {
      this.sinceProgressMark += dt;
      this.pathSinceMark += distance(this.ball, this.progressPrev);
      this.spanMinX = Math.min(this.spanMinX, this.ball.x);
      this.spanMaxX = Math.max(this.spanMaxX, this.ball.x);
      this.spanMinZ = Math.min(this.spanMinZ, this.ball.z);
      this.spanMaxZ = Math.max(this.spanMaxZ, this.ball.z);
      /*
       * Ranged over real ground, wherever it happens to be standing now.
       *
       * Only while the ball is CONTESTED, and the difference is the whole
       * point. Two opponents moving a ball over half a metre of goalmouth are
       * playing it; the rule is asking whether it is stuck between them, and
       * it plainly is not. One robot alone is being asked a different
       * question - whether it is taking the ball anywhere - and a robot
       * spinning the ball in a circle around itself covers a big box while
       * getting nowhere at all. That one is still a stall, and displacement
       * is the right measure for it.
       */
      if (kind === 'contested') {
        const span = Math.hypot(this.spanMaxX - this.spanMinX, this.spanMaxZ - this.spanMinZ);
        if (span > PROGRESS_SPAN) this.restartProgressWindow();
      }
    }
    this.progressPrev = { x: this.ball.x, z: this.ball.z };

    // A ball sitting in a penalty box while that team's keeper ignores it is
    // the keeper's offence, not a neutral one, and 5.8.3 gets to call it first.
    if (this.goalieClockRunning) return;

    // Contested or held, the question is the same and only the rope differs.
    const window = isOpposingContest ? PROGRESS_WINDOW : heldLimit;
    if (this.sinceProgressMark >= window) {
      /*
       * How straight the window was decides whether this is a stall or just a
       * slow ball. Straightness is meaningless below PROGRESS_MIN_PATH - a
       * ball that never rolled has no direction - so that case falls through
       * to the call, which is right: a ball that has not moved in five seconds
       * between opposing robots is the plainest stall there is.
       */
      const straightness =
        this.pathSinceMark > PROGRESS_MIN_PATH
          ? distance(this.ball, this.progressMark) / this.pathSinceMark
          : 0;
      this.restartProgressWindow();
      // Slow, but going somewhere. Let it have another window to get there.
      if (straightness >= PROGRESS_STRAIGHTNESS) return;

      // 5.6 does not describe a held ball - no opponent is contesting it, so
      // 5.6.1.2 is not it, and a robot is touching it, so 5.6.1.1 is not
      // either. It is the bare rule, and the message says what was seen.
      const rule = isOpposingContest ? '5.6.1.2' : '5.6';
      const reason = isOpposingContest
        ? `Ball has not progressed in ${window} seconds between opposing robots.`
        : `Ball has not progressed in ${window} seconds with one robot on it and nobody contesting.`;
      if (this.autoResolve) {
        this.callLackOfProgress({ rule, reason });
      } else {
        this.emit({
          kind: 'lack-of-progress',
          rule,
          message: `${reason} Lack of Progress is available to the referee.`,
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
      this.forcingPeak = Math.max(this.forcingPeak, this.forcingDuration);
      this.lastForcingTeam = forcingAttacker.team;
      this.sinceForcing = 0;

      if (this.forcingDuration > FORCING_SECONDS) {
        this.forcingDuration = 0;
        this.forcingPeak = 0;
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
      // The episode is over once it is too old to taint a goal anyway.
      if (this.sinceForcing >= 0.8) this.forcingPeak = 0;
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
    const actives = this.activeRobotsBuffer;
    for (let i = 0; i < actives.length; i++) {
      const robot = actives[i]!;
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
        const ballInBox = this.ballInPlay && inPenaltyBox(this.ball, own);
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
        // No ball on the field is no active play for them to affect either.
        const ballInDefendingHalf =
          this.ballInPlay &&
          (this.defendingGoal(team) === 'cyan' ? this.ball.x <= 150 : this.ball.x >= -150);
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
        let forcingOpponent: Robot | undefined;
        for (let i = 0; i < this.activeRobotsBuffer.length; i++) {
          const opp = this.activeRobotsBuffer[i]!;
          if (opp.team !== oppTeam) continue;
          const hasBall = distance(opp, this.ball) <= opp.radius + this.ball.radius + 35;
          let pushingDefenders = false;
          for (let j = 0; j < defenders.length; j++) {
            const d = defenders[j]!;
            if (
              distance(opp, d) <= opp.radius + d.radius + 25 ||
              (hasBall && distance(this.ball, d) <= d.radius + this.ball.radius + 20)
            ) {
              pushingDefenders = true;
              break;
            }
          }
          if (hasBall && pushingDefenders && opp.vx * sign > 50) {
            forcingOpponent = opp;
            break;
          }
        }

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
    const actives = this.active();
    const result: Robot[] = [];
    for (let i = 0; i < actives.length; i++) {
      const r = actives[i]!;
      if (r.team === team && inPenaltyBox(r, own) && Math.abs(r.z) <= maxGoalZ) {
        result.push(r);
      }
    }
    return result;
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
      const actives = this.active();
      const inBox: Robot[] = [];
      for (let i = 0; i < actives.length; i++) {
        const r = actives[i]!;
        if (r.team === team && inPenaltyBox(r, own)) inBox.push(r);
      }
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
      if (ballCollision) return true;
      const actives = this.active();
      for (let i = 0; i < actives.length; i++) {
        const r = actives[i]!;
        if (r.id !== excludeId && Math.hypot(p.x - r.x, p.z - r.z) < target.radius + r.radius + 20) {
          return true;
        }
      }
      return false;
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

  private occupiedNeutralPoints(): readonly Point[] {
    return this.activeRobotsBuffer;
  }

  placeBall(p: Point): void {
    // A ball put down by anyone is no longer on its way anywhere. Switched
    // off is different: only `setBallOnField` brings that one back.
    if (this.ballAway?.kind === 'hand') this.ballAway = null;
    this.ball.x = p.x;
    this.ball.z = p.z;
    // Wherever it has been put, it is not a goal that has already been given.
    this.goalGiven = false;
    this.ball.vx = 0;
    this.ball.vz = 0;
    this.kickOffPending = false;
    this.reportedOutOfPlay = false;
    // Placing the ball is a discontinuous move, not progress. Without this the
    // progress test measures the referee's own intervention and concludes the
    // ball is doing fine - and the clocks it does not clear carry the old
    // incident into the new position and call it again straight away.
    this.resetProgressClocks();
  }

  /**
   * 5.6.2 and 5.9.2: somebody picks the ball up to put it on a neutral point.
   *
   * Where it goes is decided when it is put down (`stepBallAway`), not here:
   * the rule asks for an unoccupied point, and which points are unoccupied is
   * a question about the moment the ball arrives. A second call while it is
   * already in hand keeps a centre placement a centre placement.
   */
  private liftBall(toCentre: boolean): void {
    if (this.ballAway?.kind === 'off') return;
    const range = this.config.ballPlacementSeconds ?? BALL_PLACEMENT_SECONDS;
    const from = { x: this.ball.x, z: this.ball.z };
    if (range.max <= 0) {
      this.putBallDown(from, toCentre);
      return;
    }
    const min = Math.max(0, Math.min(range.min, range.max));
    const u =
      this.config.placementSeed === undefined
        ? 0.5
        : (placementJitter(this.config.placementSeed, this.liftCount, BALL_PLACEMENT_KEY) + 1) / 2;
    this.liftCount++;
    const already = this.ballAway?.kind === 'hand' ? this.ballAway : null;
    this.ballAway = {
      kind: 'hand',
      remaining: min + u * (range.max - min),
      from: already?.from ?? from,
      toCentre: toCentre || (already?.toCentre ?? false),
    };
    this.ball.vx = 0;
    this.ball.vz = 0;
  }

  /** The hand's clock. A person's walk does not stop because the game clock has. */
  private stepBallAway(dt: number): void {
    const away = this.ballAway;
    if (away?.kind !== 'hand') return;
    away.remaining -= dt;
    if (away.remaining > 0) return;
    this.ballAway = null;
    this.putBallDown(away.from, away.toCentre);
  }

  private putBallDown(from: Point, toCentre: boolean): void {
    this.placeBall(toCentre ? { x: 0, z: 0 } : nearestNeutralPoint(from, this.occupiedNeutralPoints()));
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
    this.liftBall(again);
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
    const isFree = (c: Point): boolean => {
      for (let i = 0; i < this.activeRobotsBuffer.length; i++) {
        const r = this.activeRobotsBuffer[i]!;
        if (distance(r, c) < r.radius * 2 + 20) return false;
      }
      return true;
    };
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
    this.kickOffs++;
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
  const dx = ball.x - robot.x;
  const dz = ball.z - robot.z;
  const maxReach = robot.radius + ball.radius + 20;
  if (Math.abs(dx) > maxReach || Math.abs(dz) > maxReach) return 0;
  if (dx * dx + dz * dz > maxReach * maxReach) return 0;

  const toBall = Math.atan2(dz, dx);
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
