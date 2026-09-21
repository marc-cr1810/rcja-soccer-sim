/**
 * Turning the world into what a robot can actually perceive of it.
 *
 * Every function here throws information away. That is the point: the lab's AI
 * reads exact ball coordinates out of the world object, and a competition robot
 * must not, because no robot on a real field can. What makes a sensor
 * interesting to program against is not the reading, it is the specific way the
 * reading is wrong — a bearing quantised to a ring of sectors, a range that
 * vanishes off a wall struck at a shallow angle, a heading that drifts all half.
 *
 * Noise is deterministic, seeded per robot per match. A match that cannot be
 * replayed cannot be disputed, and a student debugging an intermittent fault
 * needs it to happen again.
 */

import {
  CROSSBAR_HEIGHT,
  GOAL_MOUTH_X,
  HALF_GOAL_WIDTH,
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
import { mix32, streamSeed, toSeed, unitNormal, type SeedInput } from './rand';
import type {
  BallReading,
  Blob,
  CameraReading,
  LineReading,
  RangeReading,
  Sighting,
  Surface,
} from '../match/protocol';

/** The robot's own radius, rule 4.1.2's 220 mm cylinder. */
const ROBOT_RADIUS = 110;

// ---------------------------------------------------------------- randomness

/**
 * Seeded xoshiro128++, one stream per sensor per robot.
 *
 * Math.random would make a match impossible to replay, and replay is what a
 * §6.1.3 protest rests on. The four-word state is spread by a splitmix-style
 * expansion of the 64-bit seed key, which is the seeding the generator's
 * author recommends; the step itself is additions, a rotation and three xors.
 * Replacements for the old xorshift were tested the way anything replacing a
 * number a season's replays depend on gets tested: cross-checked against an
 * independent implementation, with a golden vector pinned in the test suite.
 *
 * A seed key is only 64 bits, and 2^64 states when fewer than 2^128 of them
 * are ever drawn is not a deficit for a match: two matches are not going to
 * collide into the same noise, and if a match has to be replayed exactly, the
 * seed is right there in the record.
 */
export class Noise {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: SeedInput) {
    const s = toSeed(seed);
    let state = s.lo;
    const expand = (): number => {
      state = (state + 0x9e3779b9) >>> 0;
      return mix32(state ^ s.hi);
    };
    this.a = expand();
    this.b = expand();
    this.c = expand();
    this.d = expand();
    // All-zero state is the one pair xoshiro cannot step, same trap as the
    // old xorshift had. Make it not happen rather than detect it later.
    if ((this.a | this.b | this.c | this.d) === 0) {
      this.a = 0x9e3779b9;
      this.c = 0x6d2b79f5;
    }
  }

  /** Uniform in 0..1. */
  next(): number {
    return this.next32() / 0x100000000;
  }

  /** The xoshiro128++ step, returning a 32-bit word. Blackman's generator. */
  private next32(): number {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const d = this.d;
    const result = (rotl(a + d, 7) + a) >>> 0;
    const t = (b << 9) >>> 0;
    this.c = (c ^ a) >>> 0;
    this.d = (d ^ b) >>> 0;
    this.b = (b ^ this.c) >>> 0;
    this.a = (a ^ this.d) >>> 0;
    this.c = (this.c ^ t) >>> 0;
    this.d = rotl(this.d, 11);
    return result;
  }

  /** Exactly normal, mean 0, given standard deviation. */
  gaussian(sd: number): number {
    return unitNormal(this.next()) * sd;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
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
 * A ring of phototransistors around the chassis is the common build, and it is
 * what fixes the resolution of everything downstream: at twenty-four of them,
 * 15° of ambiguity, which is about 70 mm of lateral error at half a field.
 * Teams that want better bearing than this have to get it by moving and
 * comparing, which is a real technique and worth having to discover.
 */
export const IR_SECTORS = 24;

/**
 * Ranges beyond which the ball is lost in the noise floor. The Elekit RCJ-05
 * is detectable across the diagonal of the field but not reliably.
 */
const IR_MAX_RANGE = 2200;
/**
 * Range at which strength reads 1.0, and therefore the range below which it
 * reads 1.0 and says nothing further.
 *
 * This is the contact distance — the robot's 110 mm shell plus the ball's
 * radius — and it is deliberately no larger. A real ring does saturate when
 * the ball is against the chassis, so the plateau is honest; where it was
 * dishonest was its width. At 200 mm the reading went flat 70 mm before the
 * ball could touch anything, which is the exact band in which a program has
 * to decide whether it is behind the ball, whether to fire, and how wide to
 * stand off. Half of every sighting in a match falls inside it.
 *
 * Programs converting strength back to a range should use this constant, and
 * should treat any reading at 1.0 as "at the mouth, distance unknown" rather
 * than as a measurement. The camera is the sensor with a real range on it.
 */
export const IR_REFERENCE_RANGE = 131;

export interface IrOptions {
  /** Other robots that might be in the way. */
  blockers: readonly { x: number; z: number }[];
  ideal?: boolean;
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
  out?: BallReading,
): BallReading | null {
  const range = rangeTo(pose, ball.x, ball.z);
  if (range > IR_MAX_RANGE) return null;

  for (const b of opts.blockers) {
    if (blocks(pose, ball, b, ROBOT_RADIUS * 0.85)) return null;
  }

  const exact = bearingTo(pose, ball.x, ball.z);
  const sector = (2 * Math.PI) / IR_SECTORS;
  let bearing: number;
  let strength: number;
  const idealStrength = (IR_REFERENCE_RANGE / Math.max(range, 1)) ** 2;

  if (opts.ideal) {
    // Clean 24-sector resolution with zero angular jitter
    const index = ((Math.round(exact / sector) % IR_SECTORS) + IR_SECTORS) % IR_SECTORS;
    bearing = wrapAngle(index * sector);
    strength = clamp01(idealStrength);
  } else {
    // Quantise, after a little jitter, so a ball sitting exactly on a sector
    // boundary flickers between the two the way a real ring does.
    const jittered = exact + noise.gaussian(sector * 0.12);
    // Fold the index into 0..IR_SECTORS-1 before converting back
    const index = ((Math.round(jittered / sector) % IR_SECTORS) + IR_SECTORS) % IR_SECTORS;
    bearing = wrapAngle(index * sector);
    strength = clamp01(idealStrength * (1 + noise.gaussian(0.06)));
  }

  if (out) {
    out.bearing = bearing;
    out.strength = strength;
    return out;
  }
  return { bearing, strength };
}

// ------------------------------------------------------------------- compass

/**
 * The heading a fused compass+gyro would give a team - not the raw gyro
 * itself, see `GyroState` below for that.
 *
 * The error that matters is not the noise, it is the drift: a heading
 * integrated from a gyro over a five-minute half walks away from north, and a
 * robot that trusts it blindly ends up defending the wrong goal. Slow enough
 * to be invisible in testing and fast enough to matter by the end of a half,
 * which is exactly the bug teams actually hit.
 */
const COMPASS_NOISE = 0.012;
/**
 * Tuned so a five-minute half walks the heading about five degrees — enough
 * that a robot dead-reckoning off the compass ends the half aiming visibly
 * wide, and little enough that a team testing for thirty seconds sees nothing
 * wrong. That gap is deliberate: it is the bug, and finding it is the lesson.
 * The occasional seed drifts to ten or fifteen degrees by the end of a half;
 * a tacking team spots the bias, a closed-heading team does not.
 */
const DRIFT_RATE = 0.005;

export class CompassState {
  drift = 0;
  private target = 0;

  step(dt: number, noise: Noise, ideal = false): void {
    if (ideal) {
      this.drift = 0;
      this.target = 0;
      return;
    }
    // A slowly wandering target, so drift meanders rather than marching.
    this.target += noise.gaussian(DRIFT_RATE * 8) * dt;
    this.drift += (this.target - this.drift) * Math.min(1, dt * 0.5);
  }

  read(heading: number, noise: Noise, ideal = false): number {
    if (ideal) {
      return wrapAngle(heading);
    }
    return wrapAngle(heading + this.drift + noise.gaussian(COMPASS_NOISE));
  }
}

// --------------------------------------------------------------------- gyro

/**
 * The raw gyroscope, unfused with anything.
 *
 * Unlike the compass, this is a rate, not an angle, and a rate does not
 * drift the way an angle does - there is nothing here to wrap. What it has
 * instead is a bias that wanders, the way a cheap MEMS gyro's zero-rate
 * output actually does. Read every tick as an instantaneous rate - a damping
 * term, say - and the bias barely matters; it is a small constant offset on
 * a number nothing ever accumulates. Integrate it into a heading, the way a
 * strategy might integrate the compass, and the bias compounds every tick
 * instead of being bounded by one: over a five-minute half that is a heading
 * error worse than the compass ever produces, from a sensor that looked
 * perfectly steady in a thirty-second test.
 */
const GYRO_NOISE = 0.05;
/**
 * Tuned, the same way `DRIFT_RATE` was, by running it out over many seeds: a
 * thirty-second test walks the bias about two and a half degrees if
 * integrated, invisible next to the noise on any one reading. A five-minute
 * half walks it close to sixty degrees on average, and past a full
 * half-turn on an unlucky seed - both several times worse than the compass
 * ever gets, which is the point: read the rate directly, the way `sense.py`'s
 * `GyroRate` does, and leave integration to people with a compass to pin it
 * to.
 */
const GYRO_BIAS_DRIFT_RATE = 0.0004;

export class GyroState {
  bias = 0;
  private target = 0;

  step(dt: number, noise: Noise, ideal = false): void {
    if (ideal) {
      this.bias = 0;
      this.target = 0;
      return;
    }
    this.target += noise.gaussian(GYRO_BIAS_DRIFT_RATE * 8) * dt;
    this.bias += (this.target - this.bias) * Math.min(1, dt * 0.5);
  }

  read(trueOmega: number, noise: Noise, ideal = false): number {
    if (ideal) {
      return trueOmega;
    }
    return trueOmega + this.bias + noise.gaussian(GYRO_NOISE);
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
  const markingRadiusSq = (MARKING_THICKNESS * 2) ** 2;
  for (const p of NEUTRAL_POINTS) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz <= markingRadiusSq) return 'marking';
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

export function readLines(pose: Pose, noise: Noise, ideal = false, out?: LineReading[]): LineReading[] {
  const result = out ?? [];
  for (let i = 0; i < LINE_SENSOR_COUNT; i++) {
    const bearing = wrapAngle((i * 2 * Math.PI) / LINE_SENSOR_COUNT);
    const a = pose.heading + bearing;
    const sx = pose.x + Math.cos(a) * LINE_SENSOR_RADIUS;
    const sz = pose.z + Math.sin(a) * LINE_SENSOR_RADIUS;
    const surface = surfaceAt(sx, sz);
    const value = ideal ? REFLECTANCE[surface] : clamp01(REFLECTANCE[surface] + noise.gaussian(LINE_NOISE));
    const item = result[i];
    if (item) {
      item.bearing = bearing;
      item.surface = surface;
      item.value = value;
    } else {
      result[i] = { bearing, surface, value };
    }
  }
  result.length = LINE_SENSOR_COUNT;
  return result;
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
  let bestDist = Infinity;
  let bestCosInc = 0;

  if (dx > 1e-9) {
    const t = (WALL_X - pose.x) / dx;
    if (t > 0 && t < bestDist) {
      bestDist = t;
      bestCosInc = dx;
    }
  } else if (dx < -1e-9) {
    const t = (-WALL_X - pose.x) / dx;
    if (t > 0 && t < bestDist) {
      bestDist = t;
      bestCosInc = -dx;
    }
  }

  if (dz > 1e-9) {
    const t = (WALL_Z - pose.z) / dz;
    if (t > 0 && t < bestDist) {
      bestDist = t;
      bestCosInc = dz;
    }
  } else if (dz < -1e-9) {
    const t = (-WALL_Z - pose.z) / dz;
    if (t > 0 && t < bestDist) {
      bestDist = t;
      bestCosInc = -dz;
    }
  }

  if (bestDist === Infinity) return null;
  return { dist: bestDist, incidence: Math.acos(Math.max(-1, Math.min(1, bestCosInc))) };
}

/** Distance from a pose to another robot cylinder along a field-frame direction. */
function obstacleDistance(
  pose: Pose,
  worldAngle: number,
  blockers: readonly { x: number; z: number }[],
): { dist: number; incidence: number } | null {
  const dx = Math.cos(worldAngle);
  const dz = Math.sin(worldAngle);
  let best: { dist: number; incidence: number } | null = null;
  const r2 = ROBOT_RADIUS * ROBOT_RADIUS;

  for (const b of blockers) {
    const vx = b.x - pose.x;
    const vz = b.z - pose.z;
    const proj = vx * dx + vz * dz;
    if (proj <= 0) continue;
    const perp2 = vx * vx + vz * vz - proj * proj;
    if (perp2 >= r2) continue;

    const d = Math.sqrt(r2 - perp2);
    const t = proj - d;
    if (t <= 0) continue;
    if (best && t >= best.dist) continue;

    // Angle of incidence on the cylinder surface
    const sinInc = Math.sqrt(perp2) / ROBOT_RADIUS;
    const incidence = Math.asin(Math.max(-1, Math.min(1, sinInc)));
    best = { dist: t, incidence };
  }
  return best;
}

export function readRange(
  pose: Pose,
  noise: Noise,
  blockers: readonly { x: number; z: number }[] = [],
  ideal = false,
  out?: RangeReading,
): RangeReading {
  const one = (offset: number): number | null => {
    const angle = wrapAngle(pose.heading + offset);
    const hitWall = wallDistance(pose, angle);
    const hitObs = obstacleDistance(pose, angle, blockers);

    let hit = hitWall;
    if (hitObs && (!hit || hitObs.dist < hit.dist)) {
      hit = hitObs;
    }
    if (!hit) return null;
    const dist = hit.dist - ROBOT_RADIUS;
    if (dist > SONAR_MAX_RANGE || dist < 0) return null;
    if (!ideal && hit.incidence > SONAR_GRAZING) return null;
    return ideal ? Math.max(0, dist) : Math.max(0, dist + noise.gaussian(SONAR_NOISE));
  };
  const front = one(0);
  const left = one(Math.PI / 2);
  const back = one(Math.PI);
  const right = one(-Math.PI / 2);

  if (out) {
    out.front = front;
    out.left = left;
    out.back = back;
    out.right = right;
    return out;
  }
  return { front, left, back, right };
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
export const CAMERA_FPS = 30;
export const CAMERA_FOV = 2 * Math.PI;
export const CAMERA_BEARING_NOISE = 0.02;
/** Range from a monocular camera is an estimate off apparent size, and poor. */
export const CAMERA_RANGE_ERROR = 0.09;

const TAU = 2 * Math.PI;

// ------------------------------------------------------- arcs of the horizon

/**
 * A stretch of the horizon, stored unwrapped so `to - from` is its width.
 *
 * Keeping it unwrapped rather than folding both ends into −π..π is what makes
 * the arithmetic below readable: an arc that straddles the seam behind the
 * robot is still one interval here, not two special cases.
 */
export interface Arc {
  from: number;
  to: number;
}

/** The SHORT way round between two bearings, ordered so width is `to - from`. */
function arcBetween(a: number, b: number): Arc {
  const d = wrapAngle(b - a);
  return d >= 0 ? { from: a, to: a + d } : { from: b, to: b - d };
}

/**
 * The arc a goal mouth covers, taken from its posts.
 *
 * Not from the centre of the mouth, which is the whole difference: a goal has
 * a width, and the width is the thing a robot wants. It shrinks as the robot
 * backs off and foreshortens as the robot moves round to the side, both of
 * which fall straight out of the two bearings.
 *
 * The posts sit on the goal plane at `GOAL_MOUTH_X`, which is where
 * `physics.ts`, `world.ts` and the renderer all agree the goal is - and, now
 * that the mouth is on the goal line, the same plane `goalMouth()` returns, so
 * the arc and the `Sighting` below finally range to the same place.
 */
export function goalArc(pose: Pose, side: 'cyan' | 'yellow'): Arc | null {
  const gx = side === 'cyan' ? -GOAL_MOUTH_X : GOAL_MOUTH_X;
  // Standing on or past the goal plane, the posts are no longer in front and
  // the short arc between them stops meaning the mouth. A 220 mm robot cannot
  // fit inside a 74 mm goal, so this is a guard rather than a case.
  if (Math.abs(pose.x) >= Math.abs(gx)) return null;
  return arcBetween(
    bearingTo(pose, gx, -HALF_GOAL_WIDTH),
    bearingTo(pose, gx, HALF_GOAL_WIDTH),
  );
}

/** A robot's shadow on the horizon: where it is, and how much it hides. */
export interface Shadow {
  centre: number;
  half: number;
}

/**
 * How much of the horizon a robot blots out, from here.
 *
 * Falls off with distance, which is the part that matters in play: a defender
 * that closes on the striker hides far more of the goal than the same robot
 * sitting back on its own line, so rushing the shot works for a reason the
 * geometry supplies rather than one the simulator asserts.
 */
function shadowOf(pose: Pose, b: { x: number; z: number }): Shadow | null {
  const r = rangeTo(pose, b.x, b.z);
  if (r <= 1) return null;
  return {
    centre: bearingTo(pose, b.x, b.z),
    half: Math.asin(Math.min(1, ROBOT_RADIUS / r)),
  };
}

/**
 * What is left of an arc once the shadows are taken out of it.
 *
 * One robot in the middle of the mouth leaves two pieces, two robots leave
 * three, and three robots across the face of the goal leave four — the count
 * is however many shadows actually landed on it, plus one, and there is no cap
 * here because there is no cap on the field either.
 *
 * Overlapping shadows collapse into one on their own: the running `open` mark
 * only ever moves forwards, so two robots standing shoulder to shoulder hide
 * one stretch of goal rather than leaving a phantom sliver between them.
 */
export function visibleArcs(goal: Arc, shadows: readonly Shadow[]): Arc[] {
  const width = goal.to - goal.from;
  if (width <= 0) return [];

  const cuts: { lo: number; hi: number }[] = [];
  for (const s of shadows) {
    const rc = wrapAngle(s.centre - goal.from);
    // A shadow sitting across the seam from the goal arrives here a full turn
    // away from it, so try it shifted either way. At most one shift can land.
    for (const turn of [-TAU, 0, TAU]) {
      const lo = Math.max(0, rc + turn - s.half);
      const hi = Math.min(width, rc + turn + s.half);
      if (hi > lo) cuts.push({ lo, hi });
    }
  }

  cuts.sort((a, b) => a.lo - b.lo);
  const out: Arc[] = [];
  let open = 0;
  for (const c of cuts) {
    if (c.lo > open) out.push({ from: goal.from + open, to: goal.from + c.lo });
    open = Math.max(open, c.hi);
  }
  if (open < width) out.push({ from: goal.from + open, to: goal.to });
  return out;
}

/**
 * Blobs draw from their own stream, never from the camera's.
 *
 * `perception.ts` gives the reason and this is the case it was written for: if
 * a new reading draws from a stream an existing reading already uses, every
 * number after it shifts, and ADDING a sensor silently changes what every
 * other sensor said. That is not a theory here — wiring the blobs into the
 * camera's own stream moved the ball sighting enough to change match results,
 * which is exactly the kind of change a season's replays cannot survive.
 */
const BLOB_STREAM = 0x7c;

export class CameraState {
  private readonly blobNoise: Noise;
  private sinceFrame = Infinity;

  /** @param seed Match seed mixed with the robot's identity, as `Senses` does. */
  constructor(seed: SeedInput = 0) {
    this.blobNoise = new Noise(streamSeed(toSeed(seed), BLOB_STREAM));
  }

  private last: CameraReading = {
    goals: { cyan: null, yellow: null },
    goalBlobs: { cyan: [], yellow: [] },
    ball: null,
    fresh: false,
  };

  step(dt: number, ideal = false): boolean {
    if (ideal) {
      this.sinceFrame = 0;
      return true;
    }
    this.sinceFrame += dt;
    if (this.sinceFrame >= 1 / CAMERA_FPS) {
      this.sinceFrame = 0;
      return true;
    }
    return false;
  }

  read(
    pose: Pose,
    ball: { x: number; z: number } | null,
    blockers: readonly { x: number; z: number }[],
    noise: Noise,
    fresh: boolean,
    ideal = false,
  ): CameraReading {
    if (!fresh) return { ...this.last, fresh: false };

    const see = (tx: number, tz: number, occludable: boolean): Sighting | null => {
      const bearing = bearingTo(pose, tx, tz);
      if (CAMERA_FOV < 2 * Math.PI && Math.abs(bearing) > CAMERA_FOV / 2) return null;
      if (occludable) {
        for (const b of blockers) {
          if (blocks(pose, { x: tx, z: tz }, b, ROBOT_RADIUS * 0.85)) return null;
        }
      }
      const range = rangeTo(pose, tx, tz);
      return {
        bearing: wrapAngle(bearing + (ideal ? 0 : noise.gaussian(CAMERA_BEARING_NOISE))),
        range: Math.max(0, range * (1 + (ideal ? 0 : noise.gaussian(CAMERA_RANGE_ERROR)))),
      };
    };

    /**
     * The whole mouth as a single point. The easy reading, and the one that
     * cannot answer "is there a gap in it" — see `seeGoalBlobs` for that.
     *
     * The camera sees all the way round, so there is no field of view to clip
     * against and nothing occludes this: it is a wide target high on the wall.
     */
    const seeGoal = (side: 'cyan' | 'yellow'): Sighting | null => {
      const mouth = goalMouth(side);
      const bCenter = bearingTo(pose, mouth.x, mouth.z);
      const trueRange = rangeTo(pose, mouth.x, mouth.z);
      if (ideal) {
        return { bearing: wrapAngle(bCenter), range: Math.max(0, trueRange) };
      }
      return {
        bearing: wrapAngle(bCenter + noise.gaussian(CAMERA_BEARING_NOISE)),
        range: Math.max(0, trueRange * (1 + noise.gaussian(CAMERA_RANGE_ERROR))),
      };
    };

    /**
     * The same goal as the colour blobs a vision pipeline would actually emit.
     *
     * Every robot on the field cuts into this, the team mate included — the
     * same list that blocks the infrared ring. A mate parked on the goal line
     * genuinely blinds its own striker, which is the coordination problem
     * arriving through a second sensor.
     */
    const seeGoalBlobs = (side: 'cyan' | 'yellow'): Blob[] => {
      const arc = goalArc(pose, side);
      if (!arc) return [];

      const gx = side === 'cyan' ? -GOAL_MOUTH_X : GOAL_MOUTH_X;
      const shadows: Shadow[] = [];
      for (const b of blockers) {
        // Only something between the robot and the goal plane can hide it.
        // Depth here is simply x, because the goal IS a plane of constant x.
        if (Math.abs(gx - b.x) >= Math.abs(gx - pose.x)) continue;
        if (Math.sign(gx - b.x) !== Math.sign(gx - pose.x)) continue;
        const s = shadowOf(pose, b);
        if (s) shadows.push(s);
      }

      // Most of the time nothing is in front of the goal at all, and the
      // interval arithmetic has nothing to do. Worth skipping: this runs for
      // both goals on every camera frame of every robot.
      const pieces = shadows.length === 0 ? [arc] : visibleArcs(arc, shadows);

      const out: Blob[] = [];
      for (const seen of pieces) {
        const from = seen.from + (ideal ? 0 : this.blobNoise.gaussian(CAMERA_BEARING_NOISE));
        const to = seen.to + (ideal ? 0 : this.blobNoise.gaussian(CAMERA_BEARING_NOISE));
        // A patch thinner than the noise on its own edges is not something a
        // blob detector resolves; it is one bright pixel that may not be there.
        if (to - from < CAMERA_BEARING_NOISE) continue;

        // Height comes off the goal plane along the blob's own bearing, so a
        // blob near the edge of a goal seen from the side is correctly further
        // away than one near the middle.
        const centre = wrapAngle(pose.heading + (seen.from + seen.to) / 2);
        const cos = Math.cos(centre);
        const dist =
          Math.abs(cos) > 1e-3 ? Math.abs((gx - pose.x) / cos) : rangeTo(pose, gx, 0);
        const height = CROSSBAR_HEIGHT / Math.max(dist, 1);

        out.push({
          start: wrapAngle(from),
          end: wrapAngle(from) + (to - from),
          height: Math.max(
            0,
            height * (1 + (ideal ? 0 : this.blobNoise.gaussian(CAMERA_RANGE_ERROR))),
          ),
        });
      }
      return out;
    };

    this.last = {
      goals: { cyan: seeGoal('cyan'), yellow: seeGoal('yellow') },
      goalBlobs: { cyan: seeGoalBlobs('cyan'), yellow: seeGoalBlobs('yellow') },
      // No ball on the field, nothing to see: the same as a ball out of sight.
      ball: ball ? see(ball.x, ball.z, true) : null,
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

  read(ideal = false): number[] {
    if (ideal) {
      return [...this.counts];
    }
    return this.counts.map((c) => Math.round(c / ENCODER_STEP) * ENCODER_STEP);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
