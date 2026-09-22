/**
 * Rolling resistance is the one physics change this repository makes to the
 * lab's solver, and it changes the game more than anything else in it. These
 * pin both ends: the kick rule it has to satisfy, and the gentle touch it was
 * changed for.
 */

import {
  ballContact,
  collideBallRobot,
  KICK_CARRY,
  kickBall,
  kickSpeed,
  rollingIntegrate,
  stepBall,
  sweptBallCollision,
  type Ball,
  type Body,
} from '../../src/sim/physics';
import { GOAL_BACK_X, GOAL_MOUTH_X, HALF_GOAL_WIDTH, HALF_WIDTH } from '../../src/sim/field';
import { World } from '../../src/sim/world';
import { getLeague } from '@rcja/shared/leagues';

/** The Open league's golf ball, rolling cleanly at the given velocity. */
function ball(vx: number, vz = 0): Ball {
  return { x: 0, z: 0, vx, vz, radius: 21, mass: 46, slipVx: 0, slipVz: 0, inertia: 0.4, restitution: 0.6 };
}

/** The Lightweight league's IR ball. */
function irBall(vx = 0, vz = 0): Ball {
  return { x: 0, z: 0, vx, vz, radius: 37, mass: 140, slipVx: 0, slipVz: 0, inertia: 0.5, restitution: 0.5 };
}

type TestRobot = Body & { heading: number; omega: number; id?: string };

function robot(mass: number, over: Partial<TestRobot> = {}): TestRobot {
  return { x: 0, z: 0, vx: 0, vz: 0, radius: 110, mass, heading: 0, omega: 0, ...over };
}

/** Step the ball on the carpet until it stops; how far it went. */
function travel(b: Ball, dt = 1 / 100): number {
  const x0 = b.x;
  const z0 = b.z;
  for (let i = 0; i < 100_000 && (b.vx !== 0 || b.vz !== 0 || b.slipVx !== 0); i++) stepBall(b, dt);
  return Math.hypot(b.x - x0, b.z - z0);
}

/** A ball struck through its middle: moving, with no spin at all. */
function spinless(b: Ball): Ball {
  b.slipVx = b.vx;
  b.slipVz = b.vz;
  return b;
}

/** Skid until rolling; the speed it then rolls at. */
function settle(b: Ball): number {
  for (let i = 0; i < 1000 && (b.slipVx !== 0 || b.slipVz !== 0); i++) stepBall(b, 1 / 1000);
  return Math.hypot(b.vx, b.vz);
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
  it('carries a 2400 mm/s rolling ball the length of the field', () => {
    // Goal backs sit at +/-989 mm, so that is 1978 mm of travel.
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

  it('prevents a 3500 mm/s kicked ball from tunneling through goal posts', () => {
    // A 3500 mm/s ball aimed directly at the goal post corner at (915, 225)
    // In one 60Hz tick (dt = 1/60), it travels ~58.3mm.
    const { sweptBallCollision } = require('../../src/sim/physics');
    const { GOAL_MOUTH_X, HALF_GOAL_WIDTH } = require('../../src/sim/field');
    const b = ball(3500, 0);
    b.x = 880;
    b.z = HALF_GOAL_WIDTH;
    const x0 = b.x;
    const z0 = b.z;
    const x1 = b.x + b.vx * (1 / 60);
    const z1 = b.z;

    const hit = sweptBallCollision(b, x0, z0, x1, z1, [], false);
    expect(hit).not.toBeNull();
    // Ball should stop before or at post contact, not jump to 938mm inside the post
    expect(b.x).toBeLessThanOrEqual(GOAL_MOUTH_X);
    // Velocity should be reflected backward
    expect(b.vx).toBeLessThan(0);
  });
});

describe('a struck ball skids before it rolls', () => {
  it('settles at 5/7 of its speed if it is a solid golf ball, 2/3 if the IR ball', () => {
    // v + k w is conserved through the skid, so a ball with no spin ends up
    // rolling at v / (1 + k).
    // To within the few mm/s of slip the skid stops at.
    expect(settle(spinless(ball(2000)))).toBeCloseTo((2000 * 5) / 7, -1);
    expect(settle(spinless(irBall(2000)))).toBeCloseTo((2000 * 2) / 3, -1);
  });

  it('does not skid a ball that was only given a velocity', () => {
    // A staged ball, a test's ball, a practice drag: rolling, not skidding.
    const b = ball(1000);
    stepBall(b, 1 / 100);
    expect(b.vx).toBeCloseTo(1000 - 12, 6);
    expect(b.slipVx).toBe(0);
  });

  it('lands exactly on rolling, however coarse the step', () => {
    const b = spinless(ball(300));
    stepBall(b, 0.5);
    expect(b.slipVx).toBe(0);
    expect(b.vx).toBeCloseTo((300 * 5) / 7, 6);
  });

  it('comes back to the robot when it has backspin and no speed', () => {
    // What a dribbler's roller gives it: spin with nowhere to go. The carpet
    // turns it into motion, the other way.
    const b = ball(0);
    b.slipVx = 300; // spinning as if rolling at -300 mm/s
    stepBall(b, 1 / 100);
    expect(b.vx).toBeLessThan(0);
  });
});

describe('the kicker is a plunger with a mass, built for its league', () => {
  /** Kick a ball resting against the front of a still robot. */
  function kicked(b: Ball, mass: number): { b: Ball; r: TestRobot } {
    const r = robot(mass);
    b.x = r.radius + b.radius;
    kickBall(b, r);
    return { b, r };
  }

  it("passes rule 4.7.1's kicker test in both leagues, with the carry it always had", () => {
    // 4.7.1 asks for a kick that crosses the field from goal to goal, 1930 mm
    // between the goal lines.
    for (const [b, mass] of [
      [ball(0), 2500],
      [irBall(), 1400],
    ] as const) {
      const carry = travel(kicked(b, mass).b);
      expect(carry).toBeGreaterThan(1930);
      // Within 50 mm: the formula is exact, the 10 ms step is not.
      expect(carry).toBeCloseTo(KICK_CARRY, -2);
    }
  });

  it('leaves at a believable speed, not the 4900 mm/s one kicker for both gave the golf ball', () => {
    expect(kicked(ball(0), 2500).b.vx).toBeCloseTo(kickSpeed(ball(0)), 6);
    expect(kickSpeed(ball(0))).toBeGreaterThan(2800);
    expect(kickSpeed(ball(0))).toBeLessThan(3000);
    expect(kickSpeed(irBall())).toBeGreaterThan(2900);
    expect(kickSpeed(irBall())).toBeLessThan(3100);
  });

  it('leaves spinless, so the kick skids first', () => {
    const { b } = kicked(ball(0), 2500);
    expect(b.slipVx).toBeCloseTo(b.vx, 6);
  });

  it('kicks harder on the run', () => {
    const still = kicked(ball(0), 2500).b.vx;
    const r = robot(2500, { vx: 1000 });
    const b = ball(1000); // carried at the robot's speed
    b.x = r.radius + b.radius;
    kickBall(b, r);
    expect(b.vx - still).toBeCloseTo(1000, 0);
  });

  it('kicks at an angle when the robot is sliding sideways', () => {
    const r = robot(2500, { vz: 600 });
    const b = ball(0, 600);
    b.x = r.radius + b.radius;
    kickBall(b, r);
    expect(b.vz).toBeCloseTo(600, 6);
    expect(b.vx).toBeCloseTo(kickSpeed(b), 6);
  });

  it('recoils the robot by the momentum it gives the ball', () => {
    const { b, r } = kicked(ball(0), 2500);
    expect(b.mass * b.vx + r.mass * r.vx).toBeCloseTo(0, 6);
    expect(r.vx).toBeLessThan(0);
  });
});

describe('the ball against walls and bumpers', () => {
  it('comes back off a wall slower than its bounce alone, once its spin has had its say', () => {
    // Rolling head-on into a wall. The bounce reverses the ball at 0.6 v, but
    // it is still spinning forwards; wall friction takes that spin off (all of
    // it, for the golf ball) and the carpet skid does the rest.
    const b = ball(1000);
    ballContact(b, -1, 0);
    expect(b.vx).toBeCloseTo(-600, 6);
    expect(settle(b)).toBeCloseTo(600 / 1.4, -1);
    expect(b.vx).toBeLessThan(0);
  });

  it('brings the deader IR ball back slower still', () => {
    const b = irBall(1000);
    ballContact(b, -1, 0);
    // Wall friction strips 0.9 of the spin: (-0.5 + 0.5 * 0.1) / 1.5.
    expect(settle(b)).toBeCloseTo(300, -1);
    expect(b.vx).toBeLessThan(0);
  });

  it('loses sideways speed on a graze', () => {
    const b = ball(700, 700);
    ballContact(b, 0, -1);
    expect(b.vz).toBeCloseTo(-0.6 * 700, 6);
    expect(b.vx).toBeLessThan(700);
    expect(b.vx).toBeGreaterThan(0);
  });

  it('is flicked sideways by a spinning robot', () => {
    // Pressing into it as well: friction needs a normal impulse to act through.
    const r = robot(2500, { omega: 6, vx: 200 });
    const b = ball(0);
    b.x = r.radius + b.radius - 1; // just touching the front
    expect(collideBallRobot(r, b)).toBe(true);
    // The front of a robot turning anticlockwise (+omega) moves towards +z.
    expect(b.vz).toBeGreaterThan(0);
  });

  it('pushes the robot back by what it gives the ball', () => {
    const r = robot(2500);
    const b = ball(-2000);
    b.x = r.radius + b.radius - 1;
    const before = b.mass * b.vx + r.mass * r.vx;
    collideBallRobot(r, b);
    expect(b.mass * b.vx + r.mass * r.vx).toBeCloseTo(before, 6);
    expect(r.vx).toBeLessThan(0);
  });
});

describe('a shot reaching the goal, with masses', () => {
  const SHOT = 4900;

  /** A golf-ball shot down +x into a keeper standing in the goal mouth. */
  function shotAtKeeper(keeperVx: number): { b: Ball; k: TestRobot } {
    const k = robot(2500, { x: GOAL_MOUTH_X - 120, vx: keeperVx, id: 'lime-2' });
    const b = spinless(ball(SHOT));
    b.x = k.x - 150;
    const x0 = b.x;
    const x1 = b.x + b.vx / 100;
    sweptBallCollision(b, x0, 0, x1, 0, [k], true);
    return { b, k };
  }

  it('knocks the keeper back, and the ball off it, conserving momentum', () => {
    const { b, k } = shotAtKeeper(0);
    expect(b.mass * b.vx + k.mass * k.vx).toBeCloseTo(b.mass * SHOT, 3);
    // m_b (1 + e) v / (m_b + m_r): about 140 mm/s for a 2.5 kg keeper.
    expect(k.vx).toBeCloseTo((46 * 1.6 * SHOT) / (46 + 2500), 3);
    expect(b.vx).toBeLessThan(0);
  });

  it('comes back harder off a keeper stepping into it than off one standing still', () => {
    const still = shotAtKeeper(0).b.vx;
    const stepping = shotAtKeeper(-500).b.vx;
    expect(stepping).toBeLessThan(still);
  });

  function emptyGoal(autoResolve = true): World {
    const w = new World({ league: getLeague('open'), halfLengthSeconds: 300, inclined: false, kickoffCountdown: 0, autoResolve });
    w.robots.forEach((r) => (r.removed = true));
    return w;
  }

  it('scores every shot on target, however hard and from whatever angle', () => {
    // Up to 6000 mm/s crosses the 74 mm goal and more inside one tick; the
    // swept test is what sees it go in.
    for (const speed of [3000, 4500, 6000]) {
      for (const aim of [-170, -90, 0, 90, 170]) {
        for (const fromZ of [-300, 0, 300]) {
          const w = emptyGoal();
          w.ball.x = 300;
          w.ball.z = fromZ;
          const dx = GOAL_MOUTH_X - w.ball.x;
          const dz = aim - fromZ;
          const d = Math.hypot(dx, dz);
          w.ball.vx = (speed * dx) / d;
          w.ball.vz = (speed * dz) / d;
          w.ball.slipVx = w.ball.vx;
          w.ball.slipVz = w.ball.vz;
          for (let t = 0; t < 1.5 && w.score.violet === 0; t += 1 / 100) w.step(1 / 100);
          expect({ speed, aim, fromZ, goals: w.score.violet }).toEqual({ speed, aim, fromZ, goals: 1 });
        }
      }
    }
  });

  it('never lets a hard shot through the post', () => {
    for (const speed of [3000, 6000]) {
      const w = emptyGoal();
      w.ball.x = 500;
      w.ball.z = HALF_GOAL_WIDTH + 30; // at the post, not the mouth
      w.ball.vx = speed;
      for (let t = 0; t < 1; t += 1 / 100) w.step(1 / 100);
      expect(w.score.violet).toBe(0);
      expect(w.ball.x).toBeLessThan(GOAL_MOUTH_X);
    }
  });

  it('gives a goal once for a shot that comes straight back out off the goal back', () => {
    const w = emptyGoal(false);
    w.ball.x = 500;
    w.ball.vx = 6000;
    for (let t = 0; t < 1.5; t += 1 / 100) w.step(1 / 100);
    expect(w.score.violet).toBe(1);
  });
});
