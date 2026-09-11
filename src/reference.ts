/**
 * The reference opponent.
 *
 * This is not a port of the lab's AI, and it could not have been. That one
 * reads exact ball coordinates out of the world, runs potential-field avoidance
 * over the known positions of every opponent, and checks shot lanes with
 * geometry no robot has. Rewriting it to work from sensors is not porting, it
 * is writing a different program — so this is that program, written the way a
 * good team would write it, and its job is to answer the question the boundary
 * was built to ask: can a robot that only sees what a sensor sees still play?
 *
 * It also ships as the worked example. Everything here is code a student could
 * have written, using only the library the league gives them, and it is meant
 * to be read, argued with and beaten.
 */

import { mixOmni, openDrive, wrapAngle, type DriveSpec } from './drive';
import { HALF_LENGTH, HALF_WIDTH, WALL_X, WALL_Z } from './field';
import type { ActuatorFrame, SensorFrame } from './protocol';
import type { Agent } from './agent';

const ROBOT_RADIUS = 110;
/** Matches IR_REFERENCE_RANGE in sensors.ts: strength 1.0 at 200 mm. */
const IR_REFERENCE_RANGE = 200;

export type Role = 'striker' | 'goalie';

interface Estimate {
  x: number;
  z: number;
  /** 0..1. Falls off when the sonars stop agreeing or stop answering. */
  confidence: number;
}

/**
 * Where am I?
 *
 * Nothing tells the robot its position, so it works it out: the compass gives
 * heading, and a sonar pointing mostly along an axis is almost certainly
 * looking at that axis's wall. Pick the beam most aligned with each direction,
 * assume it found the obvious wall, and solve.
 *
 * It is wrong near a corner, wrong when a beam grazes and returns nothing, and
 * wrong whenever another robot is in the way — all of which is why the estimate
 * carries a confidence and why nothing here bets the match on it.
 */
export function locate(frame: SensorFrame): Estimate {
  const heading = frame.compass.heading;
  const beams: { angle: number; range: number }[] = [];
  const push = (offset: number, range: number | null) => {
    if (range !== null) beams.push({ angle: wrapAngle(heading + offset), range });
  };
  push(0, frame.range.front);
  push(Math.PI / 2, frame.range.left);
  push(Math.PI, frame.range.back);
  push(-Math.PI / 2, frame.range.right);

  // A beam is only usable for an axis if it is pointing mostly along it.
  const solve = (
    component: (b: { angle: number }) => number,
    wall: number,
  ): number | null => {
    let best: { value: number; weight: number } | null = null;
    for (const b of beams) {
      const c = component(b);
      if (Math.abs(c) < 0.6) continue;
      // centre + (range + radius) * direction = wall
      const value = Math.sign(c) * wall - (b.range + ROBOT_RADIUS) * c;
      if (!best || Math.abs(c) > best.weight) best = { value, weight: Math.abs(c) };
    }
    return best ? best.value : null;
  };

  const x = solve((b) => Math.cos(b.angle), WALL_X);
  const z = solve((b) => Math.sin(b.angle), WALL_Z);

  return {
    x: clamp(x ?? 0, -HALF_LENGTH, HALF_LENGTH),
    z: clamp(z ?? 0, -HALF_WIDTH, HALF_WIDTH),
    confidence: (x === null ? 0 : 0.5) + (z === null ? 0 : 0.5),
  };
}

/**
 * Where the ball is, including for the moment after it disappears.
 *
 * The infrared ring returns nothing at all when a robot stands in the way, and
 * a robot that stops the instant it loses sight of the ball is useless. So the
 * last sighting is kept in FIELD bearing rather than robot bearing — the robot
 * keeps turning, and a remembered bearing that does not turn with it is worse
 * than no memory at all.
 */
class BallMemory {
  private fieldBearing = 0;
  private range = 500;
  private age = Infinity;

  update(frame: SensorFrame, dt: number): void {
    if (frame.ball) {
      this.fieldBearing = wrapAngle(frame.compass.heading + frame.ball.bearing);
      this.range = IR_REFERENCE_RANGE / Math.sqrt(Math.max(frame.ball.strength, 1e-4));
      this.age = 0;
    } else {
      this.age += dt;
    }
  }

  /** Null once the memory is too old to act on. */
  seen(frame: SensorFrame, maxAge = 1.2): { bearing: number; range: number } | null {
    if (this.age > maxAge) return null;
    return {
      bearing: wrapAngle(this.fieldBearing - frame.compass.heading),
      range: this.range,
    };
  }

  get fresh(): boolean {
    return this.age === 0;
  }

  reset(): void {
    this.age = Infinity;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Get off the line.
 *
 * The first version of this agent ignored the line sensors entirely and it
 * showed: robots drove fully into the out area between nine and forty times a
 * match, which under 5.7.1.6 is a removal every time, and the ball went out
 * thirty-odd times because nobody stopped chasing it over the edge.
 *
 * The white line is 50 mm wide and sits just outside the playing area, so by
 * the time a rim sensor sees it the robot has one wheel out. Returning a
 * bearing to run in, rather than just stopping, is what keeps a robot that
 * arrives at speed from coasting out anyway.
 */
export function escapeLine(frame: SensorFrame): number | null {
  let ex = 0;
  let ez = 0;
  let hits = 0;
  for (const sensor of frame.lines) {
    if (sensor.surface !== 'line') continue;
    hits++;
    // Run opposite whichever sensor found it.
    ex -= Math.cos(sensor.bearing);
    ez -= Math.sin(sensor.bearing);
  }
  if (hits === 0) return null;
  // Every sensor lit at once means the robot is square on a corner and the
  // vectors cancel; back out the way it came rather than dithering.
  if (Math.hypot(ex, ez) < 0.2) return Math.PI;
  return Math.atan2(ez, ex);
}

export interface ReferenceOptions {
  /** 'cyan' attacks +x; 'yellow' attacks -x. */
  team: 'cyan' | 'yellow';
  number: 1 | 2;
  role?: Role;
  drive?: DriveSpec;
  /** Slows and blunts the robot, for building a ladder of practice opponents. */
  skill?: number;
  name?: string;
}

export class ReferenceAgent implements Agent {
  readonly name: string;
  private readonly drive: DriveSpec;
  private readonly ball = new BallMemory();
  private readonly role: Role;
  private readonly skill: number;
  private lastClock = 0;
  private thinkHold = 0;
  private lastCommand: ActuatorFrame = { motors: [0, 0, 0, 0] };

  constructor(private readonly opts: ReferenceOptions) {
    this.drive = opts.drive ?? openDrive();
    this.role = opts.role ?? (opts.number === 2 ? 'goalie' : 'striker');
    this.skill = opts.skill ?? 1;
    this.name = opts.name ?? `reference-${opts.team}${opts.number}-${this.role}`;
  }

  reset(): void {
    this.ball.reset();
    this.lastClock = 0;
    this.thinkHold = 0;
    this.lastCommand = { motors: [0, 0, 0, 0] };
  }

  /** Which way is the opponent's goal, in field radians. */
  private get attackX(): number {
    return this.opts.team === 'cyan' ? HALF_LENGTH : -HALF_LENGTH;
  }

  private get defendX(): number {
    return -this.attackX;
  }

  tick(frame: SensorFrame): ActuatorFrame {
    const dt = Math.max(1e-3, frame.clock - this.lastClock);
    this.lastClock = frame.clock;
    this.ball.update(frame, dt);

    /*
     * A weaker opponent thinks less often, as well as moving more slowly.
     *
     * Scaling speed alone turned out not to make a ladder: a slower robot
     * overshoots the ball less and plays about as well, and a 0.45-skill team
     * beat a full-strength one half the time. Running the decision loop at a
     * fraction of the rate is a handicap that actually costs something, and it
     * is also the honest way a cheaper robot is worse - its control loop is
     * slower, so it acts on staler information.
     */
    if (this.skill < 1) {
      this.thinkHold -= 1;
      if (this.thinkHold > 0) return this.lastCommand;
      this.thinkHold = Math.round(1 / this.skill);
    }
    const command = this.decide(frame);
    this.lastCommand = command;
    return command;
  }

  private decide(frame: SensorFrame): ActuatorFrame {

    if (!frame.playing) return { motors: [0, 0, 0, 0] };

    // Nothing else matters while a wheel is over the line. 5.7.1.6 takes a
    // robot wholly in the out area off the field for thirty seconds, which
    // costs far more than any ball ever chased over the edge.
    const escape = escapeLine(frame);
    if (escape !== null) {
      return { motors: mixOmni(this.drive, escape, 1, 0), dribbler: 1 };
    }

    const me = locate(frame);
    const seen = this.ball.seen(frame);

    if (!seen) return this.hunt(frame);
    return this.role === 'goalie' ? this.keep(frame, me, seen) : this.strike(frame, me, seen);
  }

  /**
   * Lost the ball: turn on the spot and look for it.
   *
   * Turning rather than driving is deliberate. The ring covers every direction,
   * so a robot that cannot see the ball is almost always being blocked rather
   * than facing the wrong way, and driving blind is how robots end up in the
   * out area under 5.7.1.6.
   */
  private hunt(frame: SensorFrame): ActuatorFrame {
    const towardsOwnHalf = wrapAngle(
      Math.atan2(0, this.defendX) - frame.compass.heading,
    );
    return {
      motors: mixOmni(this.drive, towardsOwnHalf, 0.25 * this.skill, 0.45),
      dribbler: 1,
    };
  }

  /**
   * Attack: come at the ball from the side away from our own goal.
   *
   * Driving straight at the ball pushes it wherever the robot happens to be
   * pointing, which as often as not is our own net. The offset is what turns
   * chasing into attacking, and it is the first thing a team discovers.
   */
  private strike(
    frame: SensorFrame,
    me: Estimate,
    seen: { bearing: number; range: number },
  ): ActuatorFrame {
    const heading = frame.compass.heading;

    /*
     * Which way is their goal, in field radians.
     *
     * This used to be worked out from an estimated position, and it was the
     * worst bug in the agent: `locate` falls back to the centre of the field
     * when the sonars cannot solve - grazing beams, or another robot in the
     * way - and a striker that believes it is at the centre circle when it is
     * not will happily push the ball into its own net. Against an opponent
     * that stood still it scored eleven own goals in two minutes.
     *
     * The fix is to stop needing the position. The attacking direction is a
     * fixed field bearing, the compass gives heading, and everything else can
     * be done relative to the ball - so the striker now works in its own frame
     * and only refines the aim when it is confident of where it is.
     */
    const straightAtGoal = this.attackX > 0 ? 0 : Math.PI;
    let toGoal = straightAtGoal;
    if (me.confidence >= 1) {
      const bx = me.x + Math.cos(heading + seen.bearing) * seen.range;
      const bz = me.z + Math.sin(heading + seen.bearing) * seen.range;
      // Bend the aim towards the middle of the goal rather than its near post.
      toGoal = Math.atan2(-bz * 0.35, this.attackX - bx);
    }

    // Everything from here is in the robot's own frame: where the ball is,
    // and the point behind it on the line towards their goal.
    const toGoalLocal = wrapAngle(toGoal - heading);
    const ballX = Math.cos(seen.bearing) * seen.range;
    const ballZ = Math.sin(seen.bearing) * seen.range;
    const standoff = clamp(seen.range * 0.8, 120, 260);
    const targetX = ballX - Math.cos(toGoalLocal) * standoff;
    const targetZ = ballZ - Math.sin(toGoalLocal) * standoff;

    const behind = Math.hypot(targetX, targetZ) < 90;
    const approach = Math.atan2(targetZ, targetX);

    // Face the goal while doing it, so the dribbler and kicker point the right
    // way when the ball arrives.
    const spin = clamp(toGoalLocal * 0.9, -1, 1);
    const bearing = behind ? seen.bearing : approach;
    const speed = (behind ? 1 : 0.85) * this.skill;

    const goal = frame.camera.goals[this.opts.team === 'cyan' ? 'yellow' : 'cyan'];
    const lined = goal !== null && Math.abs(goal.bearing) < 0.2;

    return {
      motors: mixOmni(this.drive, bearing, speed, spin),
      dribbler: 1,
      kicker: frame.ballGate.held && lined,
      say: { role: 'striker' as const, sure: me.confidence >= 1 },
    };
  }

  /**
   * Keep goal: hold the line, track the ball across it, clear when it arrives.
   *
   * Staying on the line rather than chasing is also what keeps the goalie out
   * of 5.11 multiple defence — two robots of one team inside their own penalty
   * area is a removal, so the keeper has a reason beyond tactics to stay put.
   */
  private keep(
    frame: SensorFrame,
    me: Estimate,
    seen: { bearing: number; range: number },
  ): ActuatorFrame {
    const heading = frame.compass.heading;
    const bx = me.x + Math.cos(heading + seen.bearing) * seen.range;
    const bz = me.z + Math.sin(heading + seen.bearing) * seen.range;

    // Sit just off the goal line, shadowing the ball across it.
    const holdX = this.defendX + (this.attackX > 0 ? 180 : -180);
    const holdZ = clamp(bz * 0.7, -190, 190);

    /*
     * Only charge the ball from the goal side of it.
     *
     * The first version charged whenever the ball was close, and scored 25 own
     * goals in a match where the opposition stood still: a keeper that drives
     * at a ball sitting between itself and its own net pushes it in. Which
     * side of the ball the keeper is on matters more than how near it is, and
     * this is the bug every team writes once.
     */
    const upfield = Math.sign(this.attackX);
    const goalSide = upfield * (bx - me.x) > 0;
    const ballIsClose = seen.range < 320;

    if (ballIsClose && goalSide) {
      // Clear it: drive through the ball, away from our goal.
      const away = wrapAngle(Math.atan2(-bz * 0.3, this.attackX - bx) - heading);
      return {
        motors: mixOmni(this.drive, seen.bearing, 1 * this.skill, clamp(away * 0.8, -1, 1)),
        dribbler: 1,
        kicker: frame.ballGate.held,
        say: { role: 'goalie' as const, active: true },
      };
    }

    if (!goalSide) {
      /*
       * The ball is behind us, between the keeper and its own net. Getting back
       * past it is the only priority — but not straight back, which was the
       * second version of this bug: driving at the goal line with the ball in
       * the way simply carries it in. Go round, by aiming at a point offset
       * across the field from the ball, on whichever side we are already
       * nearer, and only then come back to the line.
       */
      const detourSide = me.z >= bz ? 1 : -1;
      const detourZ = clamp(bz + detourSide * 300, -HALF_WIDTH + 140, HALF_WIDTH - 140);
      const detourX = this.defendX + upfield * 120;
      const away = wrapAngle(Math.atan2(detourZ - me.z, detourX - me.x) - heading);
      return {
        motors: mixOmni(this.drive, away, 1 * this.skill, 0),
        dribbler: 0,
        say: { role: 'goalie' as const, active: false },
      };
    }

    const toHold = wrapAngle(Math.atan2(holdZ - me.z, holdX - me.x) - heading);
    const distance = Math.hypot(holdX - me.x, holdZ - me.z);
    const speed = clamp(distance / 300, 0, 1) * this.skill;
    // Face up the field so a save deflects forwards rather than inwards.
    const spin = clamp(wrapAngle(Math.atan2(0, this.attackX - me.x) - heading) * 0.9, -1, 1);

    return {
      motors: mixOmni(this.drive, toHold, speed, spin),
      dribbler: 1,
      say: { role: 'goalie' as const, active: false },
    };
  }
}

/** A full team of two: a striker and a keeper. */
export function referenceTeam(team: 'cyan' | 'yellow', skill = 1) {
  return {
    [`${team}-1`]: new ReferenceAgent({ team, number: 1, role: 'striker', skill }),
    [`${team}-2`]: new ReferenceAgent({ team, number: 2, role: 'goalie', skill }),
  } as Record<string, ReferenceAgent>;
}
