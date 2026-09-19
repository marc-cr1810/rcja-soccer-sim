/**
 * Sensor Fusion & World Model.
 *
 * Implements:
 * 1. Weighted Least Squares Locator with Sonar Wall Gating & Obstacle Rejection.
 * 2. Ball Estimator with Exponential Carpet Drag & Velocity Filter.
 * 3. Visual Compass Bias Compensation.
 * 4. Yaw Rate Estimator & Wheel Effort Stall Detector.
 * 5. Teleportation / Penalty Reset Detector.
 */

import { wrapAngle } from '../sim/drive';
import {
  WALL_X,
  WALL_Z,
  goalMouth,
  type GoalSide,
} from '@rcja/shared/field';

import type { SensorFrame } from '../match/protocol';
import {
  CONTACT_RANGE,
  MOUNT_RADIUS,
  ROBOT_RADIUS,
  WHEEL_RADIUS,
  type BallEstimate,
  type Obstacle,
  type PoseEstimate,
} from './types';

export const IR_REFERENCE_RANGE = 131.0;
export const SONAR_SD = 8.0;
export const CAMERA_RANGE_SD_FRACTION = 0.09;
export const CAMERA_BEARING_SD = 0.02;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Yaw rate from wheel encoders, damped with the gyro rate.
 */
export class YawEstimator {
  rate = 0;
  private lastEncoders: number[] | null = null;
  private lastClock: number | null = null;

  update(frame: SensorFrame): number {
    const clock = frame.clock;
    const dt = this.lastClock === null ? 0.02 : Math.max(1e-3, clock - this.lastClock);
    this.lastClock = clock;

    const encoders = frame.encoders ?? [];
    if (this.lastEncoders && this.lastEncoders.length === encoders.length && encoders.length > 0) {
      let turns = 0;
      for (let i = 0; i < encoders.length; i++) {
        turns += (encoders[i]! - this.lastEncoders[i]!) / dt;
      }
      const mean = turns / encoders.length;
      const omega = (mean * WHEEL_RADIUS) / MOUNT_RADIUS;
      const blend = Math.min(1.0, dt / 0.05);
      this.rate += (omega - this.rate) * blend;
    } else if (frame.gyro) {
      const blend = Math.min(1.0, dt / 0.05);
      this.rate += (frame.gyro.rate - this.rate) * blend;
    }

    this.lastEncoders = [...encoders];
    return this.rate;
  }

  reset(): void {
    this.rate = 0;
    this.lastEncoders = null;
    this.lastClock = null;
  }
}

/**
 * Wheel effort tracker: measures total wheel speed magnitude to detect stalls.
 */
export class WheelEffort {
  value = 0;
  private lastEncoders: number[] | null = null;
  private lastClock: number | null = null;

  update(frame: SensorFrame): number {
    const clock = frame.clock;
    const dt = this.lastClock === null ? 0.02 : Math.max(1e-3, clock - this.lastClock);
    this.lastClock = clock;

    const encoders = frame.encoders ?? [];
    if (this.lastEncoders && this.lastEncoders.length === encoders.length && encoders.length > 0) {
      let sum = 0;
      for (let i = 0; i < encoders.length; i++) {
        sum += Math.abs(encoders[i]! - this.lastEncoders[i]!);
      }
      this.value = (sum / encoders.length / dt) * WHEEL_RADIUS;
    }

    this.lastEncoders = [...encoders];
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.lastEncoders = null;
    this.lastClock = null;
  }
}

/**
 * Compass Drift Calibration from Goal Sightings.
 * The compass needle drifts slightly over match time; the goals stay anchored.
 */
export class CompassBias {
  bias = 0;
  private readonly alpha: number;

  constructor(alpha = 0.03) {
    this.alpha = alpha;
  }

  update(meX: number, meZ: number, heading: number, frame: SensorFrame): void {
    const camera = frame.camera;
    if (!camera || !camera.goals) return;

    let errors = 0;
    let count = 0;
    for (const side of ['cyan', 'yellow'] as const) {
      const sighting = camera.goals[side];
      if (!sighting) continue;
      const g = goalMouth(side);
      const trueAngle = Math.atan2(g.z - meZ, g.x - meX);
      const observed = wrapAngle(heading + sighting.bearing);
      errors += wrapAngle(observed - trueAngle);
      count++;
    }

    if (count > 0) {
      this.bias = wrapAngle(this.bias + this.alpha * (errors / count - this.bias));
    }
  }

  corrected(heading: number): number {
    return wrapAngle(heading - this.bias);
  }

  reset(): void {
    this.bias = 0;
  }
}

/**
 * Weighted Least-Squares Robot Locator with Sonar Wall Gating.
 */
export class LeastSquaresLocator {
  x = 0;
  z = 0;
  confidence = 0;
  obstacles: Obstacle[] = [];
  private started = false;

  reset(): void {
    this.x = 0;
    this.z = 0;
    this.confidence = 0;
    this.obstacles = [];
    this.started = false;
  }

  update(frame: SensorFrame, heading: number): PoseEstimate {
    let axx = 0;
    let ayy = 0;
    let axy = 0;
    let bx = 0;
    let bz = 0;

    const constrain = (nx: number, nz: number, c: number, sd: number) => {
      const w = 1.0 / (sd * sd);
      axx += w * nx * nx;
      ayy += w * nz * nz;
      axy += w * nx * nz;
      bx += w * nx * c;
      bz += w * nz * c;
    };

    // 1. Camera Goal Sightings
    const seen: { x: number; z: number; range: number }[] = [];
    const camera = frame.camera;
    if (camera && camera.goals) {
      for (const side of ['cyan', 'yellow'] as GoalSide[]) {
        const sighting = camera.goals[side];
        if (!sighting) continue;
        const g = goalMouth(side);
        const angle = wrapAngle(heading + sighting.bearing);
        const ux = Math.cos(angle);
        const uz = Math.sin(angle);
        const px = g.x - ux * sighting.range;
        const pz = g.z - uz * sighting.range;
        seen.push({ x: px, z: pz, range: sighting.range });

        // Range constraint along line of sight
        const sdRange = Math.max(30.0, CAMERA_RANGE_SD_FRACTION * sighting.range);
        constrain(ux, uz, px * ux + pz * uz, sdRange);

        // Bearing constraint perpendicular to line of sight (much higher accuracy)
        const sdBearing = Math.max(8.0, CAMERA_BEARING_SD * sighting.range);
        constrain(-uz, ux, px * -uz + pz * ux, sdBearing);
      }
    }

    let priorX = 0;
    let priorZ = 0;
    let gate = 1e9;

    if (seen.length > 0) {
      priorX = seen.reduce((s, p) => s + p.x, 0) / seen.length;
      priorZ = seen.reduce((s, p) => s + p.z, 0) / seen.length;
      const minRange = Math.min(...seen.map((p) => p.range));
      gate = Math.max(140.0, 0.22 * minRange);
    } else if (this.started) {
      priorX = this.x;
      priorZ = this.z;
      gate = 260.0;
    }

    // 2. Gated Sonar Rays
    this.obstacles = [];
    const sonarOffsets: [number, number | null][] = [
      [0.0, frame.range.front],
      [Math.PI / 2, frame.range.left],
      [Math.PI, frame.range.back],
      [-Math.PI / 2, frame.range.right],
    ];

    for (const [offset, reading] of sonarOffsets) {
      if (reading === null) continue;
      const angle = wrapAngle(heading + offset);
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const reach = reading + ROBOT_RADIUS;

      // Predict wall distance from prior position
      const tx = Math.abs(dx) > 1e-6 ? (Math.sign(dx) * WALL_X - priorX) / dx : Infinity;
      const tz = Math.abs(dz) > 1e-6 ? (Math.sign(dz) * WALL_Z - priorZ) / dz : Infinity;
      const expected = Math.min(tx, tz);

      // If sonar echo arrives earlier than wall, it's an obstacle (opponent or teammate)
      if (reach < expected - gate) {
        this.obstacles.push({
          x: priorX + dx * reach,
          z: priorZ + dz * reach,
          range: reading,
          bearing: offset,
        });
        continue;
      }

      // Add wall constraint
      if (tx <= tz) {
        if (Math.abs(dx) >= 0.25) {
          const c = Math.sign(dx) * WALL_X - reach * dx;
          constrain(1.0, 0.0, c, SONAR_SD / Math.abs(dx));
        }
      } else {
        if (Math.abs(dz) >= 0.25) {
          const c = Math.sign(dz) * WALL_Z - reach * dz;
          constrain(0.0, 1.0, c, SONAR_SD / Math.abs(dz));
        }
      }
    }

    // 3. Normal Equations Solve
    const det = axx * ayy - axy * axy;
    const scale = Math.max(axx, ayy, 1e-9);

    if (det > 1e-6 * scale * scale) {
      this.x = (bx * ayy - bz * axy) / det;
      this.z = (bz * axx - bx * axy) / det;
      this.confidence = 1.0;
      this.started = true;
    } else {
      this.confidence = Math.max(0.0, this.confidence - 0.05);
    }

    this.x = clamp(this.x, -WALL_X, WALL_X);
    this.z = clamp(this.z, -WALL_Z, WALL_Z);

    return {
      x: this.x,
      z: this.z,
      confidence: this.confidence,
    };
  }
}

/**
 * Detects if a robot has been teleported / repositioned by the referee (Rule 5.7.1.6 or 5.11).
 */
export function teleported(
  prevX: number,
  prevZ: number,
  prevConf: number,
  newX: number,
  newZ: number,
  threshold = 300.0,
): boolean {
  if (prevConf <= 0.0) return false;
  return Math.hypot(newX - prevX, newZ - prevZ) > threshold;
}

/**
 * Ball Estimator with exponential carpet deceleration and continuous velocity filter.
 */
export class BallEstimator {
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  age = 99.0;
  private lastClock: number | null = null;
  private have = false;

  readonly MEMORY = 1.2;

  get seen(): boolean {
    return this.have && this.age <= this.MEMORY;
  }

  get fresh(): boolean {
    return this.have && this.age < 0.12;
  }

  reset(): void {
    this.x = 0;
    this.z = 0;
    this.vx = 0;
    this.vz = 0;
    this.age = 99.0;
    this.lastClock = null;
    this.have = false;
  }

  update(frame: SensorFrame, heading: number, meX: number, meZ: number): BallEstimate {
    const clock = frame.clock;
    const dt = this.lastClock === null ? 0.02 : clamp(clock - this.lastClock, 1e-3, 0.5);
    this.lastClock = clock;

    // Carpet friction slows ball down
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const decay = Math.exp(-dt * 1.5);
    this.vx *= decay;
    this.vz *= decay;
    this.age += dt;

    let bearing: number | null = null;
    let distance: number | null = null;

    if (frame.ball) {
      bearing = wrapAngle(heading + frame.ball.bearing);
      if (frame.ball.strength < 0.98) {
        distance = IR_REFERENCE_RANGE / Math.sqrt(Math.max(frame.ball.strength, 1e-4));
      } else {
        distance = CONTACT_RANGE;
      }
    }

    const camera = frame.camera;
    if (camera && camera.ball && camera.fresh) {
      distance = camera.ball.range;
      if (bearing === null) {
        bearing = wrapAngle(heading + camera.ball.bearing);
      }
    }

    if (bearing !== null && distance !== null) {
      const mx = meX + Math.cos(bearing) * distance;
      const mz = meZ + Math.sin(bearing) * distance;

      if (!this.have) {
        this.x = mx;
        this.z = mz;
        this.vx = 0;
        this.vz = 0;
        this.have = true;
        this.age = 0;
      } else {
        const gain = 0.45;
        const px = this.x;
        const pz = this.z;
        this.x += (mx - this.x) * gain;
        this.z += (mz - this.z) * gain;
        const vgain = clamp(dt / 0.18, 0.0, 1.0);
        this.vx += ((this.x - px) / dt - this.vx) * vgain;
        this.vz += ((this.z - pz) / dt - this.vz) * vgain;
        this.age = 0;
      }
    }

    return {
      x: this.x,
      z: this.z,
      vx: this.vx,
      vz: this.vz,
      age: this.age,
      seen: this.seen,
      fresh: this.fresh,
    };
  }

  /**
   * Predict ball coordinates after `seconds` under carpet friction.
   */
  predict(seconds: number): [number, number] {
    if (seconds <= 0) return [this.x, this.z];
    const k = 1.5;
    const travel = (1.0 - Math.exp(-k * seconds)) / k;
    return [this.x + this.vx * travel, this.z + this.vz * travel];
  }

  speed(): number {
    return Math.hypot(this.vx, this.vz);
  }
}
