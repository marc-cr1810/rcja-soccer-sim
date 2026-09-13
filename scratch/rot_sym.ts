/**
 * 180-degree ROTATION symmetry, which is the symmetry that actually separates
 * "attacking +x" from "attacking -x".
 *
 * A mirror (x -> -x, heading -> PI - heading) is the wrong test: the open
 * drivetrain is chiral (four tangential wheels all driving the same way round),
 * so its mirror image is a different machine and a mirror test reports
 * asymmetries that are not bugs.
 *
 * Rotation by PI is the right one. Under
 *
 *     x -> -x,  z -> -z,  heading -> heading + PI
 *
 * the field maps onto itself (goals, walls, boxes and neutral points are all
 * symmetric about the origin) and the ROBOT FRAME IS CARRIED ALONG. So every
 * robot-frame reading - IR bearing, sonar, line ring, encoders, camera ball -
 * must come back byte-identical. Only two things may differ:
 *
 *   - compass.heading, by exactly PI
 *   - camera.goals.cyan and .yellow, which swap places
 *
 * Anything else that differs is an asymmetry in the simulator itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Senses, type MatchView, type SenseInput } from '../src/perception';
import type { SensorFrame } from '../src/protocol';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rotframes');
fs.mkdirSync(OUT, { recursive: true });
const IDEAL = process.argv.includes('--ideal');
// The keeper's clearance branch only runs while the dribbler has the ball, so
// a sweep with held=false never reaches clearance_heading at all.
const HELD = process.argv.includes('--held');

type Pose = { x: number; z: number; heading: number; bx: number; bz: number; kick?: boolean; rotated?: boolean };

/**
 * A short scripted run, so the stateful trackers actually warm up.
 *
 * It opens with three kick-off ticks from a legal kick-off spot in the robot's
 * OWN half, because that is the only moment GoalFrame looks at the goals; a
 * trajectory that never shows it a kick-off leaves it on its constructor
 * default and tests nothing.
 */
function trajectory(p: Pose, ticks = 40): Pose[] {
  const out: Pose[] = [];
  for (let i = 0; i < 3; i++) {
    out.push({ x: -400, z: 0, heading: 0, bx: 0, bz: 0, kick: true });
  }
  for (let i = 0; i < ticks; i++) {
    out.push({
      x: p.x + Math.cos(p.heading) * 4 * i,
      z: p.z + Math.sin(p.heading) * 4 * i,
      heading: p.heading + 0.01 * i,
      bx: p.bx + 3 * i,
      bz: p.bz - 1.5 * i,
    });
  }
  return out;
}

const rotate = (p: Pose): Pose => ({
  x: -p.x,
  z: -p.z,
  heading: p.heading + Math.PI,
  bx: -p.bx,
  bz: -p.bz,
  kick: p.kick,
  rotated: !p.rotated,
});

/**
 * The other three robots, placed relative to the ball so they actually get in
 * the way. Without them the sweep never exercises obstacle_range (every sonar
 * sees a wall), never occludes the IR or the camera ball, and never delivers a
 * keeper's message - so cover(), leave_room_for_the_keeper() and the whole
 * blocked-shot branch go untested.
 */
function others(p: Pose, team: 'cyan' | 'yellow') {
  const mate = team === 'cyan' ? 'cyan-2' : 'yellow-2';
  const foeA = team === 'cyan' ? 'yellow-1' : 'cyan-1';
  const foeB = team === 'cyan' ? 'yellow-2' : 'cyan-2';
  const foeTeam = team === 'cyan' ? 'yellow' : 'cyan';
  return [
    { id: mate, team, number: 2, x: p.x * 0.2 - 300, z: p.z * 0.3 + 40, heading: p.heading + 0.5 },
    { id: foeA, team: foeTeam, number: 1, x: (p.x + p.bx) / 2 + 90, z: (p.z + p.bz) / 2 - 30, heading: p.heading - 1.1 },
    { id: foeB, team: foeTeam, number: 2, x: p.bx * 0.6 + 250, z: p.bz * 0.4 + 70, heading: p.heading + 2.2 },
  ];
}

function run(seq: Pose[], team: 'cyan' | 'yellow', attackDirection: 1 | -1): SensorFrame[] {
  // Same seed for both members of a pair: identical noise draws, so any
  // difference that survives is structural, not luck.
  const senses = new Senses(0xbeef, 4, IDEAL);
  const out: SensorFrame[] = [];
  let clock = 0;
  for (const p of seq) {
    clock += 0.02;
    const self = { id: `${team}-1`, team, number: 1, x: p.x, z: p.z, heading: p.heading };
    // The mates/opponents are placed from the UNROTATED pose and then rotated
    // with everything else, so the two worlds really are each other's image.
    const base = p.rotated ? rotate(p) : p;
    const rest = others(base, team).map((r) =>
      p.rotated ? { ...r, x: -r.x, z: -r.z, heading: r.heading + Math.PI } : r,
    );
    const view: MatchView = {
      clock,
      playing: true,
      ball: { x: p.bx, z: p.bz },
      robots: [self, ...rest],
      kickoff: { pending: p.kick === true, team: p.kick ? team : null },
    };
    const input: SenseInput = {
      view,
      self,
      wheelSpeeds: [100, -100, 100, -100],
      omega: 0,
      held: HELD,
      messages: [{ from: 2, body: { role: 'goalie', ball: [p.bx, p.bz], held: false }, at: clock } as never],
      attackDirection,
      dt: 0.02,
    };
    out.push(senses.read(input));
  }
  return out;
}

// A spread of generic poses. Nothing sits exactly on z = 0 or on any other
// knife edge: a tie-break that is decided by the sign of an exact zero is a
// degenerate case, not the directional bias we are hunting.
let rngState = 12345;
const rnd = (): number => {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
};
const span = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
const POSES: [string, Pose][] = [];
for (let i = 0; i < 60; i++) {
  POSES.push([
    `p${String(i).padStart(2, '0')}`,
    {
      x: span(-850, 850),
      z: span(-560, 560),
      heading: span(-Math.PI, Math.PI),
      bx: span(-880, 880),
      bz: span(-580, 580),
    },
  ]);
}

let worst = 0;
let worstWhat = '';
const report: string[] = [];

for (const [tag, pose] of POSES) {
  const a = run(trajectory(pose), 'cyan', 1);
  const b = run(trajectory(pose).map(rotate), 'cyan', -1);
  fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify(a));
  fs.writeFileSync(path.join(OUT, `r_${tag}.json`), JSON.stringify(b));

  const note = (what: string, d: number): void => {
    if (!Number.isFinite(d)) d = 9e9;
    if (Math.abs(d) > worst) { worst = Math.abs(d); worstWhat = `${tag}/${what}`; }
  };
  // NB: JS % is remainder, not modulo, so the (v+PI)%(2PI)-PI idiom is wrong
  // for negative v. atan2 is exact and has no sign trap.
  const wrap = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));
  let maxHere = 0;
  const bump = (what: string, d: number): void => {
    note(what, d);
    if (Math.abs(d) > maxHere) maxHere = Math.abs(d);
  };

  for (let i = 0; i < a.length; i++) {
    const A = a[i]!, B = b[i]!;
    bump('compass', wrap(B.compass.heading - (A.compass.heading + Math.PI)));
    bump('ir.bearing', (A.ball ? wrap((B.ball?.bearing ?? 0) - A.ball.bearing) : 0));
    bump('ir.strength', (A.ball ? (B.ball?.strength ?? 0) - A.ball.strength : 0));
    for (const k of ['front', 'left', 'back', 'right'] as const) {
      const av = A.range[k], bv = B.range[k];
      if (av === null && bv === null) continue;
      if (av === null || bv === null) { bump(`range.${k}(null)`, 9e9); continue; }
      bump(`range.${k}`, bv - av);
    }
    for (let j = 0; j < A.lines.length; j++) {
      bump('line.bearing', wrap(B.lines[j]!.bearing - A.lines[j]!.bearing));
      bump('line.value', B.lines[j]!.value - A.lines[j]!.value);
    }
    for (let j = 0; j < A.encoders.length; j++) bump('encoder', B.encoders[j]! - A.encoders[j]!);
    // The goals swap labels under the rotation.
    for (const [ka, kb] of [['cyan', 'yellow'], ['yellow', 'cyan']] as const) {
      const av = A.camera.goals[ka], bv = B.camera.goals[kb];
      if (av === null && bv === null) continue;
      if (av === null || bv === null) { bump(`goal.${ka}(null)`, 9e9); continue; }
      bump(`goal.${ka}.bearing`, wrap(bv.bearing - av.bearing));
      bump(`goal.${ka}.range`, bv.range - av.range);
    }
    if (A.camera.ball && B.camera.ball) {
      bump('cam.ball.bearing', wrap(B.camera.ball.bearing - A.camera.ball.bearing));
      bump('cam.ball.range', B.camera.ball.range - A.camera.ball.range);
    } else if (!!A.camera.ball !== !!B.camera.ball) bump('cam.ball(null)', 9e9);
  }
  report.push(`  ${tag.padEnd(8)} max |difference| ${maxHere.toExponential(2)}`);
}

console.log(`sensor frames, ${IDEAL ? 'ideal' : 'noisy'}, rotated pairs (same noise seed):`);
console.log(report.join('\n'));
console.log(`\nworst overall: ${worst.toExponential(3)}  at ${worstWhat}`);
console.log(worst < 1e-6 ? '>>> the simulator is rotation-symmetric' : '>>> SIMULATOR ASYMMETRY');
