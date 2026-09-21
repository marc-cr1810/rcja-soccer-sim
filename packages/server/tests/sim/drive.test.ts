/**
 * The comments in drive.ts make specific numerical claims about what this
 * drivetrain does. These tests are those claims, so that a later change to the
 * motor sizing cannot quietly move the game out from under teams who tuned
 * against it.
 */

import {
  CARPET_GRIP,
  driveForces,
  inertiaFor,
  mixOmni,
  openDrive,
  stepDrive,
  type DriveSpec,
  type DrivenBody,
} from '../../src/sim/drive';

const OPEN_MASS = 2500;
const DT = 1 / 120;

function body(over: Partial<DrivenBody> = {}): DrivenBody {
  return { x: 0, z: 0, vx: 0, vz: 0, heading: 0, omega: 0, mass: OPEN_MASS, ...over };
}

/** The same drive with no gearbox friction and a carpet that never lets go. */
function motorOnly(spec: DriveSpec): DriveSpec {
  return {
    ...spec,
    grip: Infinity,
    motors: spec.motors.map((m) => ({ ...m, gearFriction: 0 })),
  };
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

  it('launches at about 4860 mm/s^2, which is the carpet and not the motors', () => {
    // The motors could pull 9200 mm/s^2; grip 0.7 on a quarter of the weight
    // per wheel allows 4 × 0.7 × g/4 × cos45° of it.
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, 0, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
      mass: OPEN_MASS,
    });
    const accel = Math.hypot(r.fx, r.fz) / OPEN_MASS;
    expect(accel).toBeGreaterThan(4700);
    expect(accel).toBeLessThan(5000);
  });

  it('launches a Lightweight robot no harder than an Open one', () => {
    // Same motors, 1.4 kg instead of 2.5. Without a grip limit this was 16 m/s^2.
    const spec = openDrive();
    const launch = (mass: number) => {
      const r = driveForces(spec, mixOmni(spec, 0, 1, 0), { heading: 0, vx: 0, vz: 0, omega: 0, mass });
      return Math.hypot(r.fx, r.fz) / mass;
    };
    expect(launch(1400)).toBeCloseTo(launch(OPEN_MASS), 0);
  });

  it('would launch at about 9200 mm/s^2 on a carpet that never let go', () => {
    const spec = { ...openDrive(), grip: Infinity };
    const r = driveForces(spec, mixOmni(spec, 0, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
      mass: OPEN_MASS,
    });
    const accel = Math.hypot(r.fx, r.fz) / OPEN_MASS;
    expect(accel).toBeGreaterThan(8800);
    expect(accel).toBeLessThan(10300);
  });

  it('damps at 8 per second on back-EMF alone, in every direction', () => {
    // Back-EMF with the gearbox and the carpet taken out, which is the figure
    // the motor sizing is built on.
    const spec = motorOnly(openDrive());
    // 400 mm/s keeps every wheel well inside its free speed, so this measures
    // the linear part of the motor curve rather than the clamp.
    const speed = 400;
    for (const bearing of [0, 0.3, Math.PI / 4, 1.1, Math.PI / 2, 2.7]) {
      const r = driveForces(spec, [0, 0, 0, 0], {
        heading: 0,
        vx: Math.cos(bearing) * speed,
        vz: Math.sin(bearing) * speed,
        omega: 0,
        mass: OPEN_MASS,
      });
      const rate = Math.hypot(r.fx, r.fz) / OPEN_MASS / speed;
      expect(rate).toBeCloseTo(8, 1);
    }
  });

  it('cannot brake harder than the motors can pull, once a wheel saturates', () => {
    const spec = motorOnly(openDrive());
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
      mass: OPEN_MASS,
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
      mass: OPEN_MASS,
    });
    expect(r.fx).toBeLessThan(0);
  });
});

describe('the gearbox and the carpet hold the robot', () => {
  /** Distance an idle robot slides after being knocked to `speed`, mm. */
  function slide(speed: number, bearing = Math.PI / 2): number {
    const b = body({ vx: Math.cos(bearing) * speed, vz: Math.sin(bearing) * speed });
    settle(openDrive(), [0, 0, 0, 0], 2, b);
    return Math.hypot(b.x, b.z);
  }

  it('stops a robot knocked to 400 mm/s inside a hand width', () => {
    // 49 mm on back-EMF alone; a geared robot barely gives.
    for (const bearing of [0, Math.PI / 4, Math.PI / 2, 2.2]) {
      expect(slide(400, bearing)).toBeLessThan(35);
    }
  });

  it('barely moves for a nudge', () => {
    expect(slide(50)).toBeLessThan(2);
  });

  it('will not move from rest below the deadband', () => {
    const spec = openDrive();
    const b = settle(spec, mixOmni(spec, 0, 0.08, 0), 1);
    expect(b.x).toBe(0);
    expect(b.vx).toBe(0);
  });

  it('moves from rest just above it', () => {
    // Nor may the rest snap eat a gentle start: power 0.15 cannot reach
    // 12 mm/s in one tick, and used to be thrown away every tick.
    const spec = openDrive();
    const b = settle(spec, mixOmni(spec, 0, 0.15, 0), 1);
    expect(b.x).toBeGreaterThan(20);
  });

  it('still tops out at full speed, so the friction is not a speed limit', () => {
    const spec = openDrive();
    const withFriction = settle(spec, mixOmni(spec, 0, 1, 0));
    const without = settle(motorOnly(spec), mixOmni(spec, 0, 1, 0));
    expect(Math.hypot(withFriction.vx, withFriction.vz)).toBeCloseTo(Math.hypot(without.vx, without.vz), 0);
  });

  it('spins its wheels on a full-power launch, and the encoders see it', () => {
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, 0, 1, 0), { heading: 0, vx: 0, vz: 0, omega: 0, mass: OPEN_MASS });
    // The robot is standing still; every wheel is turning.
    for (const w of r.wheelSpeeds) expect(Math.abs(w)).toBeGreaterThan(100);
  });

  it('reads the ground, not a spinning wheel, when the wheels grip', () => {
    const spec = openDrive();
    const r = driveForces(spec, mixOmni(spec, 0, 0.3, 0), { heading: 0, vx: 500, vz: 0, omega: 0, mass: OPEN_MASS });
    for (const w of r.wheelSpeeds) expect(Math.abs(w)).toBeCloseTo(500 * Math.SQRT1_2, 3);
  });

  it('skids when shoved harder than its wheels can hold, at exactly the grip limit', () => {
    // Knocked down a wheel axis at 900 mm/s: that wheel's motor would brake at
    // full stall, far past what 0.7 of its quarter-weight allows.
    const spec = openDrive();
    const bearing = Math.PI / 4;
    const r = driveForces(spec, [0, 0, 0, 0], {
      heading: 0,
      vx: Math.cos(bearing) * 900,
      vz: Math.sin(bearing) * 900,
      omega: 0,
      mass: OPEN_MASS,
    });
    const limit = (CARPET_GRIP * OPEN_MASS * 9810) / 4;
    // Two wheels run along the shove and both skid; the other two roll free.
    expect(Math.hypot(r.fx, r.fz)).toBeCloseTo(2 * limit, -3);
    // A skidding wheel is dragged round slower than the ground goes past.
    const along = r.wheelSpeeds.filter((w) => Math.abs(w) > 1);
    expect(along).toHaveLength(2);
    for (const w of along) expect(Math.abs(w)).toBeLessThan(900);
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
      mass: OPEN_MASS,
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
      mass: OPEN_MASS,
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
   * Two wheels, left and right, both driving forward: a plain two-wheel
   * differential drive. Not a division this league runs, but the case that
   * proves the motor model is doing real work — a drive like this physically
   * cannot strafe, and under the lab's force-in-any-direction model it could.
   */
  function differential(): DriveSpec {
    return {
      motors: [
        { mountX: 0, mountZ: 90, axis: 0, stallForce: 8.13e6, freeSpeed: 813, gearFriction: 0 },
        { mountX: 0, mountZ: -90, axis: 0, stallForce: 8.13e6, freeSpeed: 813, gearFriction: 0 },
      ],
      inertia: inertiaFor(1000),
      grip: CARPET_GRIP,
    };
  }

  it('cannot move a differential drive sideways, at any power', () => {
    const spec = differential();
    const b = body({ mass: 1000 });
    // Ask both motors for everything, in every combination. None of it
    // produces lateral motion, because no wheel points that way.
    for (const powers of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0.5, -0.5]]) {
      const r = driveForces(spec, powers, { heading: 0, vx: 0, vz: 0, omega: 0, mass: OPEN_MASS });
      expect(Math.abs(r.fz)).toBeLessThan(1e-6);
    }
    expect(b.vz).toBe(0);
  });

  it('turns a differential drive by driving its wheels apart', () => {
    const spec = differential();
    const r = driveForces(spec, [1, -1], { heading: 0, vx: 0, vz: 0, omega: 0, mass: OPEN_MASS });
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
      mass: OPEN_MASS,
    });
    expect(r.fz).toBeGreaterThan(0);
    expect(Math.abs(r.fx)).toBeLessThan(1);
  });

  it('clamps a program that asks for more power than exists', () => {
    const spec = openDrive();
    const honest = driveForces(spec, [1, -1, -1, 1], { heading: 0, vx: 0, vz: 0, omega: 0, mass: OPEN_MASS });
    const greedy = driveForces(spec, [9, -9, -9, 9], { heading: 0, vx: 0, vz: 0, omega: 0, mass: OPEN_MASS });
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
      mass: OPEN_MASS,
    });
    // The robot's centre is going nowhere, but every wheel is turning.
    for (const u of r.wheelSpeeds) expect(Math.abs(u)).toBeGreaterThan(100);
  });

  it('reports nothing when a robot is pushed across its own wheel axes', () => {
    // A single wheel driving along +x, shoved sideways: the roller takes it and
    // the encoder never sees it. This is why odometry drifts when robots touch.
    const spec: DriveSpec = {
      motors: [{ mountX: 0, mountZ: 0, axis: 0, stallForce: 8.13e6, freeSpeed: 813, gearFriction: 0 }],
      inertia: inertiaFor(2500),
      grip: CARPET_GRIP,
    };
    const r = driveForces(spec, [0], { heading: 0, vx: 0, vz: 600, omega: 0, mass: OPEN_MASS });
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
    // The mixer's promise, so measured on motors alone. On carpet the wheels
    // doing most of the spinning hit their grip first and the launch does
    // bend: that is wheelspin, and compensating for it is the team's job.
    const spec = motorOnly(openDrive());
    const straight = driveForces(spec, mixOmni(spec, 0.6, 1, 0), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
      mass: OPEN_MASS,
    });
    const spinning = driveForces(spec, mixOmni(spec, 0.6, 1, 0.8), {
      heading: 0,
      vx: 0,
      vz: 0,
      omega: 0,
      mass: OPEN_MASS,
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

describe('stepDrive moves the robot', () => {
  it('carries the robot across the carpet, not just its velocity', () => {
    // The regression that mattered: an earlier version updated velocity and
    // left position alone, so robots accelerated on the spot forever.
    const spec = openDrive();
    const b = body();
    for (let i = 0; i < 120; i++) stepDrive(b, spec, mixOmni(spec, 0, 1, 0), DT);
    expect(b.x).toBeGreaterThan(500);
    expect(Math.abs(b.z)).toBeLessThan(20);
  });

  it('goes backwards when asked to', () => {
    const spec = openDrive();
    const b = body();
    for (let i = 0; i < 120; i++) stepDrive(b, spec, mixOmni(spec, Math.PI, 1, 0), DT);
    expect(b.x).toBeLessThan(-500);
  });

  it('travels about as far as its speed says it should', () => {
    const spec = openDrive();
    const b = body();
    const seconds = 2;
    for (let i = 0; i < seconds / DT; i++) stepDrive(b, spec, mixOmni(spec, 0, 1, 0), DT);
    // Two seconds at ~1150 mm/s, less the ramp up from rest.
    expect(b.x).toBeGreaterThan(1800);
    expect(b.x).toBeLessThan(2300);
  });
});
