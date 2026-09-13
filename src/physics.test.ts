/**
 * Rolling resistance is the one physics change this repository makes to the
 * lab's solver, and it changes the game more than anything else in it. These
 * pin both ends: the kick rule it has to satisfy, and the gentle touch it was
 * changed for.
 */

import { describe, expect, it } from 'vitest';
import { rollingIntegrate, type Body } from './physics';
import { GOAL_BACK_X, HALF_WIDTH } from './field';

function ball(vx: number, vz = 0): Body {
  return { x: 0, z: 0, vx, vz, radius: 21, mass: 46 };
}

/** How far a ball rolls from a given speed before coming to rest. */
function rolls(v: number): number {
  const b = ball(v);
  const dt = 1 / 1000;
  for (let i = 0; i < 60_000 && (b.vx !== 0 || b.vz !== 0); i++) {
    rollingIntegrate(b, dt, 1200);
  }
  return Math.hypot(b.x, b.z);
}

describe('the ball rolls like a ball on carpet', () => {
  it('carries a full kick goal to goal, as rule 4.7.1 requires', () => {
    // 4.7.1 asks for a kick that crosses the field from goal to goal and
    // rebounds. Goal backs sit at +/-989 mm, so that is 1978 mm of travel.
    const goalToGoal = 2 * GOAL_BACK_X;
    expect(rolls(2400)).toBeGreaterThan(goalToGoal);
  });

  it('lets a gentle knock die well inside the touchline', () => {
    // The change that halved the restart count. It is 610 mm from the centre
    // of the field to the touchline; a 700 mm/s nudge used to travel 574 mm of
    // that and now travels a third as far.
    expect(rolls(700)).toBeLessThan(HALF_WIDTH / 2);
  });

  it('makes distance grow with the square of speed, not in proportion to it', () => {
    // The whole point. Under the exponential damping it replaced, doubling the
    // speed doubled the distance, so a tap and a kick were the same shot at
    // different scales.
    const slow = rolls(600);
    const fast = rolls(1200);
    expect(fast / slow).toBeGreaterThan(3.2);
    expect(fast / slow).toBeLessThan(4.8);
  });

  it('brings the ball to a complete stop', () => {
    const b = ball(400, -300);
    for (let i = 0; i < 5000; i++) rollingIntegrate(b, 1 / 1000, 1200);
    expect(b.vx).toBe(0);
    expect(b.vz).toBe(0);
  });

  it('never pushes the ball backwards, however coarse the step', () => {
    // Friction can only bring a body to rest. A step long enough to overshoot
    // has to clamp, or a slow ball would reverse every frame.
    const b = ball(50);
    rollingIntegrate(b, 0.5, 1200);
    expect(b.vx).toBe(0);
    expect(b.x).toBeGreaterThanOrEqual(0);
  });

  it('slows a ball along its own direction of travel', () => {
    const b = ball(300, 400);
    const before = Math.atan2(b.vz, b.vx);
    rollingIntegrate(b, 1 / 100, 1200);
    expect(Math.atan2(b.vz, b.vx)).toBeCloseTo(before, 6);
  });
});
