/**
 * Is world.step() itself rotation-symmetric?
 *
 * Perception is (scratch/rot_sym.ts) and the strategy code now is, so if a
 * match still leans one way the remaining candidate is the physics: walls,
 * goal mouths, collisions, the dribbler, the out-of-play and lack-of-progress
 * detectors. Same construction: run a world, and run its 180-degree rotation,
 * with rotated motor commands, and see whether the two stay each other's image.
 */
import { World } from '../src/world';
import { getLeague } from '../src/leagues';

const wrap = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));

function build(rotated: boolean) {
  const w = new World({ league: getLeague('open'), halfLengthSeconds: 600, commsEnabled: true });
  w.resetRobots('cyan');
  w.running = true;
  const s = rotated ? -1 : 1;
  // A deliberately busy state: robots off-axis, ball moving across the field.
  const poses: [string, number, number, number][] = [
    ['cyan-1', 120, -80, 0.3],
    ['cyan-2', -700, 40, 0.1],
    ['yellow-1', -60, 150, 2.6],
    ['yellow-2', 690, -30, 3.0],
  ];
  for (const [id, x, z, h] of poses) {
    const r = w.robots.find((q) => q.id === id)!;
    r.x = s * x; r.z = s * z; r.heading = h + (rotated ? Math.PI : 0);
    r.vx = 0; r.vz = 0; r.omega = 0;
  }
  w.ball.x = s * 40; w.ball.z = s * -20; w.ball.vx = s * 900; w.ball.vz = s * 420;
  return w;
}

const a = build(false);
const b = build(true);

// A fixed, non-symmetric motor pattern per robot, identical in both worlds:
// under a rotation the robot frame is carried along, so the SAME powers are
// the rotated command.
const powers: Record<string, number[]> = {
  'cyan-1': [0.8, -0.2, 0.5, 0.9],
  'cyan-2': [-0.4, 0.7, 0.3, -0.6],
  'yellow-1': [0.6, 0.6, -0.9, 0.1],
  'yellow-2': [0.2, -0.8, 0.4, 0.5],
};

let worst = 0;
let worstAt = '';
const note = (what: string, d: number, i: number): void => {
  if (Math.abs(d) > worst) { worst = Math.abs(d); worstAt = `${what} @step ${i}`; }
};

for (let i = 0; i < 1200; i++) {
  for (const w of [a, b]) for (const r of w.robots) r.motors = powers[r.id]!;
  a.step(0.01);
  b.step(0.01);
  note('ball.x', b.ball.x - -a.ball.x, i);
  note('ball.z', b.ball.z - -a.ball.z, i);
  note('ball.vx', b.ball.vx - -a.ball.vx, i);
  note('ball.vz', b.ball.vz - -a.ball.vz, i);
  for (const ra of a.robots) {
    const rb = b.robots.find((q) => q.id === ra.id)!;
    note(`${ra.id}.x`, rb.x - -ra.x, i);
    note(`${ra.id}.z`, rb.z - -ra.z, i);
    note(`${ra.id}.heading`, wrap(rb.heading - (ra.heading + Math.PI)), i);
    note(`${ra.id}.removed`, (rb.removed ? 1 : 0) - (ra.removed ? 1 : 0), i);
  }
  note('score.cyan', b.score.cyan - a.score.cyan, i);
  note('score.yellow', b.score.yellow - a.score.yellow, i);
}

console.log(`after 1200 steps (12 s):`);
console.log(`  score A  cyan ${a.score.cyan} yellow ${a.score.yellow}   |  score B  cyan ${b.score.cyan} yellow ${b.score.yellow}`);
console.log(`  ball A (${a.ball.x.toFixed(1)}, ${a.ball.z.toFixed(1)})  |  ball B negated (${(-b.ball.x).toFixed(1)}, ${(-b.ball.z).toFixed(1)})`);
console.log(`\nworst |difference|: ${worst.toExponential(3)}  at ${worstAt}`);
console.log(worst < 1e-6 ? '>>> the physics is rotation-symmetric' : '>>> PHYSICS ASYMMETRY');
