/**
 * The referee has to make the same call at both ends of the field.
 *
 * `symmetry.test.ts` covers perception, physics and the agents. This covers
 * the surface neither of those reaches: the calls. They matter more than their
 * share of the code suggests - in a python-vs-python match the ball is parked
 * on a referee's placement about 45% of the time, so where the referee puts it
 * is a large fraction of where the ball ever is.
 *
 * And chaos is the reason this has to be exact rather than measured. A one-ulp
 * difference in a sensor reading becomes a completely different match in about
 * half a second, so no amount of playing matches can isolate a bias: any two
 * runs decorrelate long before the score means anything. What chaos CANNOT do
 * is bias the average - it reshuffles trajectories, it does not move their
 * centre. A systematic lean therefore has to come from a systematic asymmetry,
 * which means a discrete one, which means a decision like this one - and those
 * can be checked exactly, here, in milliseconds.
 */
import { World } from '../src/world';
import { getLeague } from '../src/leagues';
import { nearestNeutralPoint, NEUTRAL_POINTS, HALF_LENGTH, HALF_WIDTH } from '../src/field';

const rot = (p: { x: number; z: number }): { x: number; z: number } => ({ x: -p.x, z: -p.z });

/** -0 and +0 are the same place; toEqual disagrees. */
const samePlace = (a: { x: number; z: number }, b: { x: number; z: number }): boolean =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;

const world = (): World => {
  const w = new World({
    league: getLeague('open'),
    halfLengthSeconds: 600,
    inclined: false,
    commsEnabled: true,
  });
  w.resetRobots('violet');
  w.running = true;
  return w;
};

describe('the referee makes the same call at both ends', () => {
  it('sends the ball to the rotation of the neutral point it would have chosen', () => {
    const spots: { x: number; z: number }[] = [];
    for (let x = -1100; x <= 1100; x += 100) {
      for (let z = -700; z <= 700; z += 100) spots.push({ x, z });
    }

    const wrong: string[] = [];
    for (const p of spots) {
      const a = nearestNeutralPoint(p);
      const b = nearestNeutralPoint(rot(p));
      const want = rot(a);
      if (b.x !== want.x || b.z !== want.z) {
        wrong.push(
          `ball (${p.x},${p.z}) -> (${a.x},${a.z}), but rotated ball (${-p.x},${-p.z}) -> ` +
            `(${b.x},${b.z}) instead of (${want.x},${want.z})`,
        );
      }
    }
    expect(wrong.slice(0, 8)).toEqual([]);
  });

  it('has a neutral point set that is symmetric about the centre spot', () => {
    for (const np of NEUTRAL_POINTS) {
      const mirrored = NEUTRAL_POINTS.some((q) => q.x === -np.x && q.z === -np.z);
      expect(mirrored, `(${np.x},${np.z}) has no opposite`).toBe(true);
    }
  });

  it('places the ball for lack of progress at the rotation of where it would have', () => {
    for (const p of [
      { x: 400, z: 0 },
      { x: 400, z: 40 },
      { x: -700, z: 0 },
      { x: 0, z: 500 },
      { x: 850, z: -120 },
    ]) {
      const a = world();
      a.ball.x = p.x;
      a.ball.z = p.z;
      a.callLackOfProgress();

      const b = world();
      b.ball.x = -p.x;
      b.ball.z = -p.z;
      b.callLackOfProgress();

      const want = rot({ x: a.ball.x, z: a.ball.z });
      expect(
        samePlace({ x: b.ball.x, z: b.ball.z }, want),
        `from (${p.x},${p.z}): A -> (${a.ball.x},${a.ball.z}), B -> (${b.ball.x},${b.ball.z}), wanted (${want.x},${want.z})`,
      ).toBe(true);
    }
  });

  it('sends a ball that leaves play to the rotation of where the other one goes', () => {
    for (const p of [
      { x: HALF_LENGTH + 80, z: 0 },
      { x: HALF_LENGTH + 80, z: 30 },
      { x: 300, z: HALF_WIDTH + 60 },
      { x: -HALF_LENGTH - 80, z: 0 },
      { x: 0, z: HALF_WIDTH + 60 },
    ]) {
      const a = world();
      a.ball.x = p.x;
      a.ball.z = p.z;
      a.step(0.01);

      const b = world();
      b.ball.x = -p.x;
      b.ball.z = -p.z;
      b.step(0.01);

      const want = rot({ x: a.ball.x, z: a.ball.z });
      expect(
        samePlace({ x: b.ball.x, z: b.ball.z }, want),
        `out at (${p.x},${p.z}): A -> (${a.ball.x},${a.ball.z}), B -> (${b.ball.x},${b.ball.z}), wanted (${want.x},${want.z})`,
      ).toBe(true);
    }
  });

  it('starts a kick-off with nobody inside anybody else', () => {
    // Two robots of radius r need 2r between centres. Less than that and the
    // separation pass shoves them apart before the whistle, so the restart is
    // not the one the referee set - and it is only ever the non-kicking team,
    // because it is the only one with two robots placed close together.
    for (const half of [1, 2] as const) {
      for (const kicking of ['violet', 'lime'] as const) {
        const w = world();
        w.half = half;
        w.kickOff(kicking);
        for (let i = 0; i < w.robots.length; i++) {
          for (let j = i + 1; j < w.robots.length; j++) {
            const a = w.robots[i]!;
            const b = w.robots[j]!;
            const gap = Math.hypot(a.x - b.x, a.z - b.z);
            expect(
              gap,
              `half ${half}, ${kicking} kicks off: ${a.id} and ${b.id} are ${gap.toFixed(1)}mm apart`,
            ).toBeGreaterThanOrEqual(a.radius + b.radius);
          }
        }
      }
    }
  });
});
