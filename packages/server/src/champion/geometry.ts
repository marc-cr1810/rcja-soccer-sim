/**
 * Geometric Algorithms, Edge Safety Force Fields, Raycasting & Trajectory Generation.
 */

import { wrapAngle } from '../sim/drive';
import {
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  WALL_X,
  WALL_Z,
} from '@rcja/shared/field';
import type { Blob, SensorFrame } from '../match/protocol';
import { BALL_RADIUS, ROBOT_RADIUS } from './types';
import type { FramedBall } from './types';

export const EDGE_STOP_Z = HALF_WIDTH - 25.0;
export const EDGE_STOP_X = HALF_LENGTH + 15.0;
export const BALL_STOP_Z = HALF_WIDTH - BALL_RADIUS;
export const BALL_STOP_X = HALF_LENGTH - BALL_RADIUS;
export const CROSSBAR_HEIGHT = 140.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Steer clear of the playing area boundary.
 * Blends a proportional inward bend near the edge with an absolute inward brake at the boundary.
 * If carrying the ball, tests against the ball position in the dribbler rather than the chassis center.
 */
export function steerClearOfEdges(
  travel: number,
  x: number,
  z: number,
  margin = 160.0,
  stopX = EDGE_STOP_X,
  stopZ = EDGE_STOP_Z,
  carry = 0.0,
  heading = 0.0,
  goalLine?: number,
): number {
  if (carry > 0.0) {
    const ballX = x + Math.cos(heading) * carry;
    const ballZ = z + Math.sin(heading) * carry;
    z = ballZ;
    stopZ = Math.min(stopZ, BALL_STOP_Z);

    let inMouth = Math.abs(ballZ) <= HALF_GOAL_WIDTH - BALL_RADIUS;
    if (goalLine !== undefined && ballX * goalLine <= 0) {
      inMouth = false; // Defending end: never allow carrying into own net!
    }
    if (!inMouth) {
      x = ballX;
      stopX = Math.min(stopX, BALL_STOP_X);
    }
  }

  let wx = Math.cos(travel);
  let wz = Math.sin(travel);

  // Progressive proportional fade of outward velocity component
  const fadeX = clamp((Math.abs(x) - (HALF_LENGTH - margin)) / margin, 0.0, 1.0);
  if (fadeX > 0 && wx * x > 0) {
    wx *= 1.0 - fadeX;
  }
  const fadeZ = clamp((Math.abs(z) - (HALF_WIDTH - margin)) / margin, 0.0, 1.0);
  if (fadeZ > 0 && wz * z > 0) {
    wz *= 1.0 - fadeZ;
  }

  // Hard stop / brake inward
  if (Math.abs(z) > stopZ) {
    wz = -Math.sign(z);
  }
  if (Math.abs(x) > stopX) {
    wx = -Math.sign(x);
  }

  if (Math.abs(wx) < 1e-6 && Math.abs(wz) < 1e-6) {
    return Math.atan2(-z, -x);
  }
  return Math.atan2(wz, wx);
}

/**
 * Return the nearest point safely inside the playing area.
 */
export function backInside(x: number, z: number, margin = 150.0): [number, number] {
  return [
    clamp(x, -(HALF_LENGTH - margin), HALF_LENGTH - margin),
    clamp(z, -(HALF_WIDTH - margin), HALF_WIDTH - margin),
  ];
}

/**
 * Whether pushing the ball this way keeps it inside the playing area for the next reach.
 *
 * `goalLine` is the goal line being attacked - always `+HALF_LENGTH` now that
 * the callers work in attack-relative coordinates (`src/frame.ts`), and named
 * for what it is rather than for a direction it no longer carries. Passing it
 * changes the answer for exactly one family of pushes: the ones that score. The playing area ends
 * at |x| = 894, so a shot taken from closer than the reach tests as leaving it
 * — and `steerBallInside` then bends the only push that was going to work into
 * the corner, from the one place on the field where scoring is easiest. A ball
 * that crosses the line between the posts has not gone out under rule 5.9, it
 * has gone in under 5.10.
 *
 * Which goal is which has to be said rather than inferred, because the same
 * geometry at the other end is a push into our own net. `shotRange` is asked
 * about `goalLine` alone and answers null for a push going the other way, so
 * the defending mouth is never exempt - the guard `steerClearOfEdges` spells
 * out for itself is structural here.
 */
export function pushKeepsBallIn(
  ballX: number,
  ballZ: number,
  push: number,
  reach = 320.0,
  goalLine?: number,
): boolean {
  if (goalLine !== undefined && shotRange(ballX, ballZ, push, goalLine) !== null) {
    // Between the posts. The segment from here to there cannot have crossed a
    // touchline on the way: z runs monotonically along a straight push, so the
    // widest it gets is at one end or the other, and both are inside.
    return true;
  }
  return (
    Math.abs(ballX + Math.cos(push) * reach) <= HALF_LENGTH - BALL_RADIUS &&
    Math.abs(ballZ + Math.sin(push) * reach) <= HALF_WIDTH - BALL_RADIUS
  );
}

/**
 * Bend a push away from the nearest edge by as little as will do, keeping the ball in play.
 */
export function steerBallInside(
  ballX: number,
  ballZ: number,
  push: number,
  goalLine?: number,
): number {
  if (pushKeepsBallIn(ballX, ballZ, push, 320.0, goalLine)) return push;
  for (let step = 1; step <= 12; step++) {
    const bend = (step * Math.PI) / 12;
    for (const side of [1.0, -1.0]) {
      const candidate = wrapAngle(push + side * bend);
      if (pushKeepsBallIn(ballX, ballZ, candidate, 320.0, goalLine)) return candidate;
    }
  }
  return Math.atan2(-ballZ, -ballX);
}

/**
 * Logarithmic spiral / tangent approach to arrive behind the ball along the target line.
 */
export function tangentApproach(
  meX: number,
  meZ: number,
  ballX: number,
  ballZ: number,
  pushAngle: number,
): { travel: number; swing: number; range: number; aligned: boolean } {
  const dx = ballX - meX;
  const dz = ballZ - meZ;
  const range = Math.hypot(dx, dz);
  const toBall = Math.atan2(dz, dx);

  const swing = wrapAngle(toBall - pushAngle);
  const gain = clamp(0.6 + 120.0 / Math.max(range, 100.0), 0.6, 1.4);
  const travel = wrapAngle(toBall + clamp(swing * gain, -1.9, 1.9));

  return {
    travel,
    swing,
    range,
    aligned: Math.abs(swing) < 0.35,
  };
}

/**
 * Minimum-time intercept point solver.
 */
export function calculateIntercept(
  meX: number,
  meZ: number,
  ballEst: FramedBall,
  maxSpeed = 1200.0,
): { x: number; z: number; time: number } {
  if (!ballEst.seen || ballEst.speed() < 200) {
    return { x: ballEst.x, z: ballEst.z, time: 0 };
  }

  for (let t = 0.04; t <= 1.2; t += 0.04) {
    const [px, pz] = ballEst.predict(t);
    const dist = Math.hypot(px - meX, pz - meZ);
    if (dist <= maxSpeed * t + 80.0) {
      return { x: px, z: pz, time: t };
    }
  }

  const [fx, fz] = ballEst.predict(0.5);
  return { x: fx, z: fz, time: 0.5 };
}

/**
 * Widest unoccluded opening of a goal from camera blobs.
 */
export function widestOpening(
  blobs: Blob[],
): { bearing: number; width: number; range: number } | null {
  let best: Blob | null = null;
  for (const b of blobs) {
    const width = b.end - b.start;
    if (width < 0.03) continue;
    if (!best || width > best.end - best.start) {
      best = b;
    }
  }
  if (!best) return null;

  const arc = best.end - best.start;
  const bearing = wrapAngle((best.start + best.end) / 2.0);
  const height = best.height || 1e-6;
  const range = CROSSBAR_HEIGHT / height;
  const widthMm = 2.0 * range * Math.tan(arc / 2.0);

  return { bearing, width: widthMm, range };
}

/**
 * Check if the kicker heading currently points through an open goal mouth with clearance.
 */
export function shotIsOpen(blobs: Blob[], clearance = 2.5): boolean {
  if (!blobs || blobs.length === 0) return false;
  for (const b of blobs) {
    const height = b.height || 1e-6;
    const distance = CROSSBAR_HEIGHT / height;
    const margin = Math.atan2(BALL_RADIUS * clearance, Math.max(distance, 1.0));
    if (b.start + margin <= 0.0 && 0.0 <= b.end - margin) {
      return true;
    }
  }
  return false;
}

/**
 * How far away an obstacle is along a given robot offset, or null if the way is clear to the wall.
 */
export function obstacleRange(
  frame: SensorFrame,
  heading: number,
  x: number,
  z: number,
  offset = 0.0,
): number | null {
  const norm = roundAngleOffset(offset);
  let beam: number | null = null;
  if (norm === 0) beam = frame.range.front;
  else if (norm === 1) beam = frame.range.left;
  else if (norm === 2) beam = frame.range.back;
  else beam = frame.range.right;

  if (beam === null) return null;

  const angle = wrapAngle(heading + offset);
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const tx = Math.abs(dx) > 1e-6 ? (Math.sign(dx) * WALL_X - x) / dx : Infinity;
  const tz = Math.abs(dz) > 1e-6 ? (Math.sign(dz) * WALL_Z - z) / dz : Infinity;
  const wall = Math.min(tx, tz);

  const reach = beam + ROBOT_RADIUS;
  if (reach < wall - 220.0) {
    return beam;
  }
  return null;
}

function roundAngleOffset(offset: number): number {
  const step = Math.round(wrapAngle(offset) / (Math.PI / 2));
  return ((step % 4) + 4) % 4;
}

/**
 * Raycast along heading from (bx, bz) to opponent goal line at `targetX`.
 * Returns travel distance if within goal mouth width, else null.
 */
export function shotRange(bx: number, bz: number, heading: number, targetX: number): number | null {
  const dx = Math.cos(heading);
  const dz = Math.sin(heading);
  if ((targetX - bx) * dx <= 0) return null; // pointing wrong way

  const dist = (targetX - bx) / dx;
  const hitZ = bz + dz * dist;
  if (Math.abs(hitZ) <= HALF_GOAL_WIDTH - BALL_RADIUS) {
    return dist;
  }
  return null;
}

/**
 * Check if passing along heading lands near target point (targetX, targetZ).
 */
export function passIsOpen(
  heading: number,
  meX: number,
  meZ: number,
  targetX: number,
  targetZ: number,
  obstacleDist: number | null,
  minRange = 250.0,
  maxRange = 1100.0,
): boolean {
  const dx = Math.cos(heading);
  const dz = Math.sin(heading);
  const toX = targetX - meX;
  const toZ = targetZ - meZ;
  const reach = toX * dx + toZ * dz;

  if (reach < minRange || reach > maxRange) return false;
  // Perpendicular offset from kicker line to target
  const lateral = Math.abs(toX * -dz + toZ * dx);
  if (lateral > 140.0) return false;

  if (obstacleDist !== null && obstacleDist < reach - 150.0) {
    return false;
  }
  return true;
}

/**
 * PD Spin Controller clamped to [-1, 1].
 */
export function spinTowards(error: number, yawRate: number, kp = 1.3, kd = 0.35): number {
  return clamp(error * kp - yawRate * kd, -1.0, 1.0);
}
