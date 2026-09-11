/**
 * Turning the world into what a robot can actually perceive of it.
 *
 * Every function here throws information away. That is the point: the lab's AI
 * reads exact ball coordinates out of the world object, and a competition robot
 * must not, because no robot on a real field can. What makes a sensor
 * interesting to program against is not the reading, it is the specific way the
 * reading is wrong — a bearing quantised to sixteen sectors, a range that
 * vanishes off a wall struck at a shallow angle, a heading that drifts all half.
 *
 * Noise is deterministic, seeded per robot per match. A match that cannot be
 * replayed cannot be disputed, and a student debugging an intermittent fault
 * needs it to happen again.
 */

import {
  HALF_LENGTH,
  HALF_WIDTH,
  LINE_THICKNESS,
  MARKING_THICKNESS,
  NEUTRAL_POINTS,
  PENALTY_DEPTH,
  PENALTY_WIDTH,
  WALL_X,
  WALL_Z,
  goalMouth,
} from './field';
import { wrapAngle } from './drive';
import type {
  BallReading,
  CameraReading,
  LineReading,
  RangeReading,
  Sighting,
  Surface,
} from './protocol';

/** The robot's own radius, rule 4.1.2's 220 mm cylinder. */
const ROBOT_RADIUS = 110;

// ---------------------------------------------------------------- randomness

/**
 * Seeded xorshift, one stream per sensor per robot.
 *
 * Math.random would make a match impossible to replay, and replay is what a
 * §6.1.3 protest rests on.
 */
export class Noise {
  private state: number;

  constructor(seed: number) {
    // Zero is a fixed point of xorshift, so never let it be the seed.
    this.state = seed >>> 0 || 0x2f6e2b1;
  }

  /** Uniform in 0..1. */
  next(): number {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.state = s >>> 0;
    return this.state / 0x100000000;
  }

  /** Roughly normal, mean 0, given standard deviation. Sum of three uniforms. */
  gaussian(sd: number): number {
    const u = this.next() + this.next() + this.next() - 1.5;
    return u * 2 * sd;
  }
}

// ------------------------------------------------------------------ geometry

export interface Pose {
  x: number;
  z: number;
  heading: number;
}

/** Bearing from a pose to a point, in the robot frame. */
export function bearingTo(from: Pose, tx: number, tz: number): number {
  return wrapAngle(Math.atan2(tz - from.z, tx - from.x) - from.heading);
}

export function rangeTo(from: { x: number; z: number }, tx: number, tz: number): number {
  return Math.hypot(tx - from.x, tz - from.z);
}

/**
 * Whether a circle of the given radius blocks the straight line from a to b.
 *
 * Used for infrared occlusion and for deciding whether the camera can see a
 * goal. Distance from the blocker's centre to the segment, the standard way.
 */
export function blocks(
  a: { x: number; z: number },
  b: { x: number; z: number },
  blocker: { x: number; z: number },
  radius: number,
): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return false;
  let t = ((blocker.x - a.x) * dx + (blocker.z - a.z) * dz) / len2;
  // Only something BETWEEN the two ends can block.
  if (t <= 0 || t >= 1) return false;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + dx * t;
  const cz = a.z + dz * t;
  return Math.hypot(blocker.x - cx, blocker.z - cz) < radius;
}

// ----------------------------------------------------------------- IR seeker

/**
 * Sectors in the infrared ring.
 *
 * Sixteen phototransistors around the chassis is the common build, and it is
 * what fixes the resolution of everything downstream: 22.5° of ambiguity, which
 * is about 100 mm of lateral error at half a field. Teams that want better
 * bearing than this have to get it by moving and comparing, which is a real
 * technique and worth having to discover.
 */
const IR_SECTORS = 16;

/**
 * Ranges beyond which the ball is lost in the noise floor. The Elekit RCJ-05
 * is detectable across the diagonal of the field but not reliably.
 */
const IR_MAX_RANGE = 2200;
/** Range at which strength reads 1.0. */
const IR_REFERENCE_RANGE = 200;

export interface IrOptions {
  /** Other robots that might be in the way. */
  blockers: readonly { x: number; z: number }[];
}

/**
 * What the ring sees of the ball.
 *
 * Returns null when a robot is in the way. That is the single most important
 * imperfection in the whole suite: it means possession is not just about being
 * close to the ball, it is about having a clear line to it, and it is why a
 * robot that only ever drives straight at the ball gets shut out by a defender
 * standing still.
 */
export function readIr(
  pose: Pose,
  ball: { x: number; z: number },
  opts: IrOptions,
  noise: Noise,
): BallReading | null {
  const range = rangeTo(pose, ball.x, ball.z);
  if (range > IR_MAX_RANGE) return null;

  for (const b of opts.blockers) {
    if (blocks(pose, ball, b, ROBOT_RADIUS * 0.85)) return null;
  }

  const exact = bearingTo(pose, ball.x, ball.z);
  const sector = (2 * Math.PI) / IR_SECTORS;
  // Quantise, after a little jitter, so a ball sitting exactly on a sector
  // boundary flickers between the two the way a real ring does.
  const jittered = exact + noise.gaussian(sector * 0.12);
  // Fold the index into 0..15 before converting back, or the sector directly
  // behind the robot reports as both +pi and -pi and the ring appears to have
  // one more sector than it has.
  const index = ((Math.round(jittered / sector) % IR_SECTORS) + IR_SECTORS) % IR_SECTORS;
  const bearing = wrapAngle(index * sector);

  const ideal = (IR_REFERENCE_RANGE / Math.max(range, 1)) ** 2;
  const strength = clamp01(ideal * (1 + noise.gaussian(0.06)));

  return { bearing, strength };
}

// ------------------------------------------------------------------- compass

/**
 * Compass and gyro, fused the way a team would fuse them.
 *
 * The error that matters is not the noise, it is the drift: a gyro integrated
 * over a five-minute half walks away from north, and a robot that trusts it
 * blindly ends up defending the wrong goal. Slow enough to be invisible in
 * testing and fast enough to matter by the end of a half, which is exactly the
 * bug teams actually hit.
 */
const COMPASS_NOISE = 0.012;
/**
 * Tuned so a five-minute half walks the heading a few degrees — enough that a
 * robot dead-reckoning off the compass ends the half aiming visibly wide, and
 * little enough that a team testing for thirty seconds sees nothing wrong.
 * That gap is deliberate: it is the bug, and finding it is the lesson.
 */
const DRIFT_RATE = 0.05;

export class CompassState {
  drift = 0;
  private target = 0;

  step(dt: number, noise: Noise): void {
    // A slowly wandering target, so drift meanders rather than marching.
    this.target += noise.gaussian(DRIFT_RATE * 8) * dt;
    this.drift += (this.target - this.drift) * Math.min(1, dt * 0.5);
  }

  read(heading: number, noise: Noise): number {
    return wrapAngle(heading + this.drift + noise.gaussian(COMPASS_NOISE));
  }
}

// -------------------------------------------------------------- line sensors

/** Reflectance of each surface, before noise. White line is bright. */
const REFLECTANCE: Record<Surface, number> = { carpet: 0.22, line: 0.86, marking: 0.06 };
const LINE_NOISE = 0.04;

/**
 * How many downward sensors sit around the chassis, and how far out.
 *
 * Eight is a common ring. Sitting them at the rim rather than the centre is
 * what lets a robot know which way it is crossing the line, and is why the
 * bearing of each is part of the reading.
 */
const LINE_SENSOR_COUNT = 8;
const LINE_SENSOR_RADIUS = 95;

/** Which surface is under a point on the carpet. */
export function surfaceAt(x: number, z: number): Surface {
  // Rule 2.1.1: 50 mm white line marks the border of the playing area.
  const onLineX = Math.abs(Math.abs(x) - (HALF_LENGTH + LINE_THICKNESS / 2)) <= LINE_THICKNESS / 2;
  const onLineZ = Math.abs(Math.abs(z) - (HALF_WIDTH + LINE_THICKNESS / 2)) <= LINE_THICKNESS / 2;
  const insideX = Math.abs(x) <= HALF_LENGTH + LINE_THICKNESS;
  const insideZ = Math.abs(z) <= HALF_WIDTH + LINE_THICKNESS;
  if ((onLineX && insideZ) || (onLineZ && insideX)) return 'line';

  // 25 mm black markings: penalty boxes and neutral points.
  const half = MARKING_THICKNESS / 2;
  for (const p of NEUTRAL_POINTS) {
    if (Math.hypot(x - p.x, z - p.z) <= MARKING_THICKNESS * 2) return 'marking';
  }
  const boxFront = HALF_LENGTH - PENALTY_DEPTH;
  if (Math.abs(z) <= PENALTY_WIDTH / 2 + half && Math.abs(Math.abs(x) - boxFront) <= half) {
    return 'marking';
  }
  if (Math.abs(x) >= boxFront - half && Math.abs(Math.abs(z) - PENALTY_WIDTH / 2) <= half) {
    return 'marking';
  }
  return 'carpet';
}

export function readLines(pose: Pose, noise: Noise): LineReading[] {
  const out: LineReading[] = [];
  for (let i = 0; i < LINE_SENSOR_COUNT; i++) {
    const bearing = wrapAngle((i * 2 * Math.PI) / LINE_SENSOR_COUNT);
    const a = pose.heading + bearing;
    const sx = pose.x + Math.cos(a) * LINE_SENSOR_RADIUS;
    const sz = pose.z + Math.sin(a) * LINE_SENSOR_RADIUS;
    const surface = surfaceAt(sx, sz);
    out.push({
      bearing,
      surface,
      value: clamp01(REFLECTANCE[surface] + noise.gaussian(LINE_NOISE)),
    });
  }
  return out;
}

// --------------------------------------------------------------- ultrasonics

/**
 * Ultrasonic range finders, with the failure that defines them.
 *
 * A sonar pulse hitting a flat wall at a shallow angle reflects away rather
 * than back, and the sensor reports nothing at all. Robots that navigate by
 * sonar work beautifully square to a wall and lose the plot in a corner, and
 * any team that has built one recognises it immediately.
 */
const SONAR_MAX_RANGE = 2400;
const SONAR_NOISE = 6;
/** Beyond this angle of incidence the echo is lost. */
const SONAR_GRAZING = (65 * Math.PI) / 180;

/** Distance from a pose to the perimeter along a field-frame direction. */
function wallDistance(pose: Pose, worldAngle: number): { dist: number; incidence: number } | null {
  const dx = Math.cos(worldAngle);
  const dz = Math.sin(worldAngle);
  let best: { dist: number; incidence: number } | null = null;

  const candidates: { t: number; nx: number; nz: number }[] = [];
  if (dx > 1e-9) candidates.push({ t: (WALL_X - pose.x) / dx, nx: -1, nz: 0 });
  if (dx < -1e-9) candidates.push({ t: (-WALL_X - pose.x) / dx, nx: 1, nz: 0 });
  if (dz > 1e-9) candidates.push({ t: (WALL_Z - pose.z) / dz, nx: 0, nz: -1 });
  if (dz < -1e-9) candidates.push({ t: (-WALL_Z - pose.z) / dz, nx: 0, nz: 1 });

  for (const c of candidates) {
    if (c.t <= 0) continue;
    if (best && c.t >= best.dist) continue;
    // Angle between the beam and the wall's normal.
    const cosInc = -(dx * c.nx + dz * c.nz);
    best = { dist: c.t, incidence: Math.acos(Math.max(-1, Math.min(1, cosInc))) };
  }
  return best;
}

export function readRange(pose: Pose, noise: Noise): RangeReading {
  const one = (offset: number): number | null => {
    const hit = wallDistance(pose, wrapAngle(pose.heading + offset));
    if (!hit) return null;
    const dist = hit.dist - ROBOT_RADIUS;
    if (dist > SONAR_MAX_RANGE || dist < 0) return null;
    if (hit.incidence > SONAR_GRAZING) return null;
    return Math.max(0, dist + noise.gaussian(SONAR_NOISE));
  };
  return {
    front: one(0),
    left: one(Math.PI / 2),
    back: one(Math.PI),
    right: one(-Math.PI / 2),
  };
}

// -------------------------------------------------------------------- camera

/**
 * The camera runs slower than the control loop, and that is the whole lesson.
 *
 * A control loop at 50 Hz reading a camera at 30 fps sees the same frame twice
 * about half the time. A team that treats every tick's sighting as new
 * information builds a controller that oscillates. `fresh` is there so they can
 * tell, and getting them to look at it is most of the point.
 */
const CAMERA_FPS = 30;
const CAMERA_FOV = (62 * Math.PI) / 180;
const CAMERA_BEARING_NOISE = 0.02;
/** Range from a monocular camera is an estimate off apparent size, and poor. */
const CAMERA_RANGE_ERROR = 0.09;

export class CameraState {
  private sinceFrame = Infinity;
  private last: CameraReading = {
    goals: { cyan: null, yellow: null },
    ball: null,
    fresh: false,
  };

  step(dt: number): boolean {
    this.sinceFrame += dt;
    if (this.sinceFrame >= 1 / CAMERA_FPS) {
      this.sinceFrame = 0;
      return true;
    }
    return false;
  }

  read(
    pose: Pose,
    ball: { x: number; z: number },
    blockers: readonly { x: number; z: number }[],
    noise: Noise,
    fresh: boolean,
  ): CameraReading {
    if (!fresh) return { ...this.last, fresh: false };

    const see = (tx: number, tz: number, occludable: boolean): Sighting | null => {
      const bearing = bearingTo(pose, tx, tz);
      if (Math.abs(bearing) > CAMERA_FOV / 2) return null;
      if (occludable) {
        for (const b of blockers) {
          if (blocks(pose, { x: tx, z: tz }, b, ROBOT_RADIUS * 0.85)) return null;
        }
      }
      const range = rangeTo(pose, tx, tz);
      return {
        bearing: wrapAngle(bearing + noise.gaussian(CAMERA_BEARING_NOISE)),
        range: Math.max(0, range * (1 + noise.gaussian(CAMERA_RANGE_ERROR))),
      };
    };

    const cyan = goalMouth('cyan');
    const yellow = goalMouth('yellow');
    this.last = {
      // A goal is a wide target high on the wall; a robot does not hide it.
      goals: { cyan: see(cyan.x, cyan.z, false), yellow: see(yellow.x, yellow.z, false) },
      ball: see(ball.x, ball.z, true),
      fresh: true,
    };
    return this.last;
  }
}

// ------------------------------------------------------------------ encoders

/**
 * Wheel rotation, accumulated.
 *
 * Reported in radians of wheel rotation, which is what a quadrature encoder
 * counts. It drifts against the robot's real position and nothing here fixes
 * that, because nothing on a real robot fixes it either: a wheel that slips
 * under a shove, or an omni roller taking a sideways push, turns a different
 * amount from the distance the robot travelled.
 */
export const WHEEL_RADIUS = 25;
/** A 360-count encoder resolves about a hundredth of a radian. */
const ENCODER_STEP = (2 * Math.PI) / 360;

export class EncoderState {
  readonly counts: number[];

  constructor(motors: number) {
    this.counts = new Array<number>(motors).fill(0);
  }

  step(wheelSpeeds: readonly number[], dt: number): void {
    for (let i = 0; i < this.counts.length; i++) {
      this.counts[i]! += ((wheelSpeeds[i] ?? 0) / WHEEL_RADIUS) * dt;
    }
  }

  read(): number[] {
    return this.counts.map((c) => Math.round(c / ENCODER_STEP) * ENCODER_STEP);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
