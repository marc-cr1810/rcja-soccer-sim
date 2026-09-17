import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';
import { HALF_LENGTH, HALF_GOAL_WIDTH } from '../src/field';

let prev: { clock: number; kx: number; kz: number; bx: number; bz: number; bvx: number; bvz: number; bsx: number; bsz: number } | null = null;
let wasOver = false;
const conceded: { seed: number; clock: number; side: number; snap: typeof prev; ballV: number; keeperGuardLine: number }[] = [];

for (let seed = 1; seed <= 30; seed++) {
  const agents = { ...championTeam('violet'), ...championTeam('lime') } as unknown as MatchAgents;
  const m = new Match({
    agents, halfSeconds: 120, seed,
    observe: (match) => {
      const w = match.world;
      const ball = w.ball;
      const k = w.robots.find((r) => r.id === 'violet-2');
      const s = w.robots.find((r) => r.id === 'lime-1');
      const kx = k && !k.removed ? k.x : NaN;
      const kz = k && !k.removed ? k.z : NaN;
      const over = Math.abs(ball.x) > HALF_LENGTH - 10 && Math.abs(ball.z) < HALF_GOAL_WIDTH;
      if (over && !wasOver && prev) {
        // violet concedes if the ball crossed the goal behind the violet keeper
        const keeperSign = Math.sign(kx);
        const ballSign = Math.sign(ball.x);
        if (keeperSign === ballSign && keeperSign !== 0) {
          conceded.push({
            seed, clock: prev.clock, side: ballSign, snap: prev,
            ballV: Math.hypot(prev.bvx, prev.bvz),
            keeperGuardLine: Math.abs(prev.kx) - (HALF_LENGTH - 175),
          });
        }
      }
      wasOver = over;
      prev = { clock: w.clock, kx, kz, bx: ball.x, bz: ball.z, bvx: ball.vx, bvz: ball.vz, bsx: s.x, bsz: s.z };
    },
  });
  m.run();
}

console.log(`violet conceded ${conceded.length} (30 mirror matches)`);
console.log(`\nkeeper x offset from guard line at concede (negative = behind/on line, positive = too far up):`);
const offs = conceded.map((c) => c.keeperGuardLine);
const avg = offs.reduce((a, b) => a + b, 0) / offs.length;
console.log(`  mean ${avg.toFixed(0)}  min ${Math.min(...offs).toFixed(0)}  max ${Math.max(...offs).toFixed(0)}`);

const farUp = conceded.filter((c) => c.keeperGuardLine > 40);
console.log(`concedes with keeper >40mm off the line (smothering/upfield): ${farUp.length}/${conceded.length}`);

const slow = conceded.filter((c) => c.ballV < 350);
console.log(`concedes where ball at crossing <350mm/s (dribble/roll-in): ${slow.length}/${conceded.length}`);

const fast = conceded.filter((c) => c.ballV >= 350);
const zErr = fast.map((c) => Math.abs(c.snap!.kz - c.snap!.bz));
const avgZ = zErr.reduce((a, b) => a + b, 0) / Math.max(1, zErr.length);
console.log(`fast concedes (${fast.length}): avg |keeperZ - ballZ| at concede ${avgZ.toFixed(0)}mm`);

console.log('\nsample fast concedes:');
fast.slice(0, 12).forEach((c) => {
  const s = c.snap!;
  console.log(`seed ${c.seed} t=${c.clock.toFixed(0)} keeper(${s.kx.toFixed(0)},${s.kz.toFixed(0)}) ball(${s.bx.toFixed(0)},${s.bz.toFixed(0)}) v=${c.ballV.toFixed(0)} striker(${s.bsx.toFixed(0)},${s.bsz.toFixed(0)})`);
});