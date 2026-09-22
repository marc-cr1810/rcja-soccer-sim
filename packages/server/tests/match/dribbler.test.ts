/**
 * Rule 4.6.6: the dribbler holds the ball, and a robot turning with it carries
 * it round rather than leaving it behind.
 */
import { describe, expect, it } from 'bun:test';

import { Match } from '../../src/match/match';
import type { Agent } from '../../src/match/agent';
import { mixOmni, openDrive, wrapAngle } from '../../src/sim/drive';

const drive = openDrive();

/** Turns on the spot, with the roller on or off. */
function turner(dribbler: number): Agent {
  return { name: 'turner', tick: () => ({ motors: mixOmni(drive, 0, 0, 0.6), dribbler }) };
}

function turnWithBall(dribbler: number): { turned: number; off: number; gap: number } {
  const m = new Match({
    agents: { 'violet-1': turner(dribbler) },
    arrangement: {
      robots: [{ id: 'violet-1', x: 0, z: 0, heading: 0, isGoalie: false }],
      ball: { x: 110 + 21 - 4, z: 0 },
    },
    halfSeconds: 60,
    seed: 1,
  });
  m.world.running = true;
  const r = m.world.robots[0]!;
  let turned = 0;
  let last = r.heading;
  for (let i = 0; i < 400 && turned < Math.PI; i++) {
    m.step(1 / 100);
    turned += Math.abs(wrapAngle(r.heading - last));
    last = r.heading;
  }
  const b = m.world.ball;
  return {
    turned,
    off: Math.abs(wrapAngle(Math.atan2(b.z - r.z, b.x - r.x) - r.heading)),
    gap: Math.hypot(b.x - r.x, b.z - r.z) - r.radius - b.radius,
  };
}

describe('the dribbler (4.6.6)', () => {
  it('carries the ball round a half turn on the spot', () => {
    const held = turnWithBall(1);
    expect(held.turned).toBeGreaterThanOrEqual(Math.PI);
    // Still in the mouth: within the gate's arc and against the roller.
    expect(held.off).toBeLessThan(0.6);
    expect(held.gap).toBeLessThan(12);
  });

  it('leaves it behind with the roller off', () => {
    const loose = turnWithBall(0);
    expect(loose.turned).toBeGreaterThanOrEqual(Math.PI);
    expect(loose.off).toBeGreaterThan(0.6);
  });
});
