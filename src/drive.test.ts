/**
 * The comments in drive.ts make specific numerical claims about what this
 * drivetrain does. These tests are those claims, so that a later change to the
 * motor sizing cannot quietly move the game out from under teams who tuned
 * against it.
 */

import { describe, expect, it } from 'vitest';
import {
  driveForces,
  inertiaFor,
  mixOmni,
  openDrive,
  stepDrive,
  type DriveSpec,
  type DrivenBody,
} from './drive';

const OPEN_MASS = 2500;
const DT = 1 / 120;

function body(over: Partial<DrivenBody> = {}): DrivenBody {
  return { x: 0, z: 0, vx: 0, vz: 0, heading: 0, omega: 0, mass: OPEN_MASS, ...over };
}

/** Run a drive to steady state and report where it ended up. */
function settle(spec: DriveSpec, powers: number[], seconds = 8, b = body()) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepDrive(b, spec, powers, DT);
  return b;
}

describe('sizing matches what the comments claim', () => {
  it('tops out near 1150 mm/s driving forward at full power', () => {
    const spec = openDrive();
    const b = settle(spec, mixOmni(spec, 0, 1, 0));
    expect(Math.hypot(b.vx, b.vz)).toBeCloseTo(1150, -2);
  });

  it('accelerates from rest at about 9200 mm/s^2', () => {
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, 0, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
    });
    const accel = Math.hypot(r.fx, r.fz) / OPEN_MASS;
    expect(accel).toBeGreaterThan(8800);
    expect(accel).toBeLessThan(9600);
  });

  it('damps at 8 per second on back-EMF alone, in every direction', () => {
    const spec = openDrive();
    // 400 mm/s keeps every wheel well inside its free speed, so this measures
    // the linear part of the motor curve rather than the clamp.
    const speed = 400;
    for (const bearing of [0, 0.3, Math.PI / 4, 1.1, Math.PI / 2, 2.7]) {
      const r = driveForces(spec, [0, 0, 0, 0], {
        heading: 0,
        vx: Math.cos(bearing) * speed,
        vz: Math.sin(bearing) * speed,
        omega: 0,
      });
      const rate = Math.hypot(r.fx, r.fz) / OPEN_MASS / speed;
      expect(rate).toBeCloseTo(8, 1);
    }
  });

  it('cannot brake harder than the motors can pull, once a wheel saturates', () => {
    const spec = openDrive();
    // Travelling straight down a wheel axis at 1000 mm/s, that wheel is past
    // its free speed of 813 and its force is pinned at stall. Braking is
    // weaker than the linear 8 per second as a result, which is what a real
    // drivetrain does and what stops this being an infinitely strong brake.
    const bearing = Math.PI / 4;
    const r = driveForces(spec, [0, 0, 0, 0], {
      heading: 0,
      vx: Math.cos(bearing) * 1000,
      vz: Math.sin(bearing) * 1000,
      omega: 0,
    });
    const rate = Math.hypot(r.fx, r.fz) / OPEN_MASS / 1000;
    expect(rate).toBeLessThan(8);
    expect(rate).toBeGreaterThan(6);
  });

  it('opposes motion when idle rather than assisting it', () => {
    const spec = openDrive();
    const r = driveForces(spec, [0, 0, 0, 0], {
      heading: 0,
      vx: 800,
      vz: 0,
      omega: 0,
    });
    expect(r.fx).toBeLessThan(0);
  });
});

describe('a symmetric drive behaves symmetrically', () => {
  it('drives straight forward with no sideways force and no torque', () => {
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, 0, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
    });
    expect(r.fx).toBeGreaterThan(0);
    expect(Math.abs(r.fz)).toBeLessThan(1);
    expect(Math.abs(r.torque)).toBeLessThan(1);
  });

  it('spins on the spot with no net force', () => {
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, 0, 0, 1), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
    });
    expect(r.torque).toBeGreaterThan(0);
    expect(Math.hypot(r.fx, r.fz)).toBeLessThan(1);
  });

  it('is faster between two wheel axes than along one, by root two', () => {
    // Not a defect to be tuned away: a wheel saturates at its own free speed,
    // so the drive is quickest in the directions where the load is shared
    // evenly. Forward — between two axes — is the fast one, which is the
    // direction a robot chasing the ball spends most of its time pointing.
    const spec = openDrive();
    const between = settle(spec, mixOmni(spec, 0, 1, 0));
    const along = settle(spec, mixOmni(spec, Math.PI / 4, 1, 0));
    const fast = Math.hypot(between.vx, between.vz);
    const slow = Math.hypot(along.vx, along.vz);
    expect(fast / slow).toBeCloseTo(Math.SQRT2, 1);
  });

  it('reaches the same top speed forwards whichever way the field is facing', () => {
    const spec = openDrive();
    const speeds = [0, 0.7, Math.PI / 2, -2.2].map((heading) => {
      const b = settle(spec, mixOmni(spec, 0, 1, 0), 8, body({ heading }));
      return Math.hypot(b.vx, b.vz);
    });
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeLessThan(1);
  });

  it('drives in the field direction it was asked for, once turned', () => {
    const spec = openDrive();
    const heading = Math.PI / 2;
    // Bearing is in the ROBOT frame, so bearing 0 at heading 90 means +z.
    const b = settle(spec, mixOmni(spec, 0, 1, 0), 8, body({ heading }));
    expect(b.vz).toBeGreaterThan(1000);
    expect(Math.abs(b.vx)).toBeLessThan(60);
  });
});

describe('the model actually constrains the robot', () => {
  /**
   * Two wheels, left and right, both driving forward: the arrangement every
   * Simple Simon and Standard robot uses. Not a division this league runs, but
   * the case that proves the motor model is doing real work — a drive like this
   * physically cannot strafe, and under the lab's force-in-any-direction model
   * it could.
   */
  function differential(): DriveSpec {
    return {
      motors: [
        { mountX: 0, mountZ: 90, axis: 0, stallForce: 8.13e6, freeSpeed: 813 },
        { mountX: 0, mountZ: -90, axis: 0, stallForce: 8.13e6, freeSpeed: 813 },
      ],
      inertia: inertiaFor(1000),
    };
  }

  it('cannot move a differential drive sideways, at any power', () => {
    const spec = differential();
    const b = body({ mass: 1000 });
    // Ask both motors for everything, in every combination. None of it
    // produces lateral motion, because no wheel points that way.
    for (const powers of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0.5, -0.5]]) {
      const r = driveForces(spec, powers, { heading: 0, vx: 0, vz: 0, omega: 0 });
      expect(Math.abs(r.fz)).toBeLessThan(1e-6);
    }
    expect(b.vz).toBe(0);
  });

  it('turns a differential drive by driving its wheels apart', () => {
    const spec = differential();
    const r = driveForces(spec, [1, -1], { heading: 0, vx: 0, vz: 0, omega: 0 });
    expect(Math.abs(r.torque)).toBeGreaterThan(0);
    expect(Math.abs(r.fx)).toBeLessThan(1e-6);
  });

  it('lets an omni drive strafe, which is the difference between the leagues', () => {
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, Math.PI / 2, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
    });
    expect(r.fz).toBeGreaterThan(0);
    expect(Math.abs(r.fx)).toBeLessThan(1);
  });

  it('clamps a program that asks for more power than exists', () => {
    const spec = openDrive();
    const honest = driveForces(spec, [1, -1, -1, 1], { heading: 0, vx: 0, vz: 0, omega: 0 });
    const greedy = driveForces(spec, [9, -9, -9, 9], { heading: 0, vx: 0, vz: 0, omega: 0 });
    expect(greedy.fx).toBeCloseTo(honest.fx, 6);
  });
});

describe('encoders measure the wheel, not the robot', () => {
  it('reports wheel movement while spinning on the spot', () => {
    const spec = openDrive();
    const r = driveForces(spec, [0, 0, 0, 0], {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 4,
    });
    // The robot's centre is going nowhere, but every wheel is turning.
    for (const u of r.wheelSpeeds) expect(Math.abs(u)).toBeGreaterThan(100);
  });

  it('reports nothing when a robot is pushed across its own wheel axes', () => {
    // A single wheel driving along +x, shoved sideways: the roller takes it and
    // the encoder never sees it. This is why odometry drifts when robots touch.
    const spec: DriveSpec = {
      motors: [{ mountX: 0, mountZ: 0, axis: 0, stallForce: 8.13e6, freeSpeed: 813 }],
      inertia: inertiaFor(2500),
    };
    const r = driveForces(spec, [0], { heading: 0, vx: 0, vz: 600, omega: 0 });
    expect(Math.abs(r.wheelSpeeds[0]!)).toBeLessThan(1e-6);
  });
});

describe('mixOmni', () => {
  it('never asks for more than full power', () => {
    const spec = openDrive();
    for (const bearing of [0, 1, 2, 3, -2]) {
      for (const spin of [-1, 0, 0.5, 1]) {
        for (const p of mixOmni(spec, bearing, 1, spin)) {
          expect(Math.abs(p)).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });

  it('keeps the direction when it has to scale back for spin', () => {
    const spec = openDrive();
    const straight = driveForces(spec, mixOmni(spec, 0.6, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
    });
    const spinning = driveForces(spec, mixOmni(spec, 0.6, 1, 0.8), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
    });
    const a = Math.atan2(straight.fz, straight.fx);
    const b = Math.atan2(spinning.fz, spinning.fx);
    expect(Math.abs(a - b)).toBeLessThan(0.12);
    expect(spinning.torque).toBeGreaterThan(0);
  });

  it('scales speed down proportionally', () => {
    const spec = openDrive();
    const full = settle(spec, mixOmni(spec, 0, 1, 0));
    const half = settle(spec, mixOmni(spec, 0, 0.5, 0));
    const ratio = Math.hypot(half.vx, half.vz) / Math.hypot(full.vx, full.vz);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});

describe('stepDrive', () => {
  it('brings an unpowered robot to a complete stop', () => {
    const spec = openDrive();
    const b = settle(spec, [0, 0, 0, 0], 4, body({ vx: 900, vz: -300, omega: 2 }));
    expect(b.vx).toBe(0);
    expect(b.vz).toBe(0);
    expect(b.omega).toBe(0);
  });

  it('turns the heading when it spins, and keeps it wrapped', () => {
    const spec = openDrive();
    const b = body();
    for (let i = 0; i < 600; i++) stepDrive(b, spec, mixOmni(spec, 0, 0, 1), DT);
    expect(b.omega).toBeGreaterThan(0);
    expect(b.heading).toBeGreaterThanOrEqual(-Math.PI);
    expect(b.heading).toBeLessThanOrEqual(Math.PI);
  });
});
