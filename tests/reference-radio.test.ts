import { describe, expect, it } from 'bun:test';
import { Senses, type SensedRobot } from '../src/perception';
import { ReferenceAgent } from '../src/reference';
import { IR_REFERENCE_RANGE } from '../src/sensors';
import { driveForces, openDrive, wrapAngle } from '../src/drive';
import type { SensorFrame, TeamMessage } from '../src/protocol';

/**
 * A single Senses frame, ideal sensors everywhere, so the tests exercise the
 * agent's decisions rather than the sensing noise. `self` is who is looking,
 * `robots` is everyone else on the pitch, `ball` is the true ball position.
 */
function frameOf(
  seed: number,
  self: SensedRobot,
  robots: SensedRobot[],
  ball: { x: number; z: number },
  opts: { held?: boolean; messages?: TeamMessage[]; attackDirection?: 1 | -1 } = {},
): SensorFrame {
  const S = new Senses(seed, 4, true);
  return S.read({
    view: {
      clock: 0.02,
      playing: true,
      ball,
      robots: [self, ...robots],
      kickoff: { pending: false, team: null, countdown: 0 },
    },
    self,
    wheelSpeeds: [0, 0, 0, 0],
    omega: 0,
    held: opts.held ?? false,
    messages: opts.messages ?? [],
    attackDirection: opts.attackDirection ?? 1,
    dt: 0.02,
  });
}

/** The commanded drive direction, as a bearing in the robot's own frame. */
function commandedBearing(motors: number[]): number {
  const force = driveForces(openDrive(), motors, { heading: 0, vx: 0, vz: 0, omega: 0 });
  return Math.atan2(force.fz, force.fx);
}

const strikerSeat = (x: number, z: number, heading = 0): SensedRobot => ({
  id: 'violet-1',
  team: 'violet',
  number: 1,
  x,
  z,
  heading,
});

const goalieSeat = (x: number, z: number, heading = 0): SensedRobot => ({
  id: 'violet-2',
  team: 'violet',
  number: 2,
  x,
  z,
  heading,
});

const broadcast = (bearing: number, age: number): TeamMessage => ({
  from: 1,
  age,
  body: {
    role: 'striker',
    x: -800,
    z: 0,
    ball: { bearing, range: 400 },
  },
});

describe('team radio', () => {
  it('the striker advertises its own position and a ball sighting in its own frame', () => {
    const agent = new ReferenceAgent({ team: 'violet', number: 1, role: 'striker' });
    const frame = frameOf(5, strikerSeat(-300, 120), [], { x: -250, z: 120 });
    const say = agent.tick(frame).say as {
      role: string;
      x: number;
      z: number;
      ball: { bearing: number; range: number };
    };

    expect(say).toBeDefined();
    expect(say.role).toBe('striker');
    expect(say.x).toBe(-300);
    expect(say.z).toBe(120);
    // The ball is 50 mm dead ahead; the ring quantises its bearing to a sector
    // and the IR saturates inside the reference range, so the sighting is the
    // clamped range rather than the true 50 mm.
    expect(Math.abs(wrapAngle(say.ball.bearing))).toBeLessThan(Math.PI / 12);
    expect(say.ball.range).toBeCloseTo(IR_REFERENCE_RANGE, 0);
  });

  it('a goalkeeper that cannot see the ball drives towards a fresh relayed sighting', () => {
    const agent = new ReferenceAgent({ team: 'violet', number: 2, role: 'goalie' });
    const away = frameOf(3, goalieSeat(0, 0), [], { x: 9999, z: 0 }, {
      messages: [broadcast(0, 0.02)],
    });
    const forward = agent.tick(away).motors;
    expect(Math.cos(commandedBearing(forward))).toBeGreaterThan(0.9);

    const again = new ReferenceAgent({ team: 'violet', number: 2, role: 'goalie' });
    const otherWay = frameOf(3, goalieSeat(0, 0), [], { x: 9999, z: 0 }, {
      messages: [broadcast(Math.PI, 0.02)],
    });
    const backward = again.tick(otherWay).motors;
    expect(Math.cos(commandedBearing(backward))).toBeLessThan(-0.9);
    // The mirrored sighting is mirrored command, not noise: swapping the
    // broadcast flips exactly the translation, spin and all.
    const spinOf = (m: number[]) => driveForces(openDrive(), m, { heading: 0, vx: 0, vz: 0, omega: 0 }).torque;
    expect(spinOf(forward)).toBeCloseTo(spinOf(backward), 6);
  });

  it('a goalkeeper ignores a relay older than the packet lifetime', () => {
    const stale = new ReferenceAgent({ team: 'violet', number: 2, role: 'goalie' });
    const frame = frameOf(3, goalieSeat(0, 0), [], { x: 9999, z: 0 }, {
      messages: [broadcast(0, 0.5)],
    });
    const withStale = stale.tick(frame).motors;

    const none = new ReferenceAgent({ team: 'violet', number: 2, role: 'goalie' });
    const bare = frameOf(3, goalieSeat(0, 0), [], { x: 9999, z: 0 });
    const without = none.tick(bare).motors;

    expect(withStale).toEqual(without);
    // With no usable relay the keeper circles back towards its own goal, which
    // is the opposite way to where a fresh right-ahead sighting points.
    expect(Math.cos(commandedBearing(withStale))).toBeLessThan(-0.9);
  });

  it('the goalkeeper clears only into a genuinely open far mouth', () => {
    const kick = (frame: SensorFrame): boolean => {
      const agent = new ReferenceAgent({ team: 'violet', number: 2, role: 'goalie' });
      return agent.tick(frame).kicker === true;
    };

    const clear = frameOf(6, goalieSeat(-735, 0), [], { x: -600, z: 0 }, { held: true });
    expect(kick(clear)).toBe(true);

    const keeperSits = goalieSeat(830, 0, Math.PI);
    keeperSits.id = 'lime-2';
    keeperSits.team = 'lime';
    keeperSits.number = 2;
    const hidden = frameOf(6, goalieSeat(-735, 0), [keeperSits], { x: -600, z: 0 }, { held: true });
    expect(kick(hidden)).toBe(false);
  });
});