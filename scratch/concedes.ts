import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';

type Snap = { clock: number; kx: number; kz: number; sx: number; sz: number; bx: number; bz: number; bvx: number; bvz: number };
let prev: Snap | null = null;
let lastV = 0, lastL = 0;
const concedes: { seed: number; snap: Snap; vGoal: boolean }[] = [];

for (let seed = 1; seed <= 30; seed++) {
  const agents = { ...championTeam('violet'), ...championTeam('lime') } as unknown as MatchAgents;
  const m = new Match({
    agents, halfSeconds: 120, seed,
    observe: (match) => {
      const w = match.world;
      const ball = w.ball;
      const vel = Math.hypot(ball.vx, ball.vz);
      const k = w.robots.find((r) => r.id === 'violet-2');
      const s = w.robots.find((r) => r.id === 'lime-1');
      prev = { clock: w.clock, kx: k.x, kz: k.z, sx: s.x, sz: s.z, bx: ball.x, bz: ball.z, bvx: ball.vx, bvz: ball.vz };
      if (match.world.score.violet > lastV || match.world.score.lime > lastL) {
        const vScored = match.world.score.violet > lastV;
        if (vScored && prev) concedes.push({ seed, snap: prev, vGoal: true });
        if (!vScored && prev) concedes.push({ seed, snap: prev, vGoal: false });
        lastV = match.world.score.violet; lastL = match.world.score.lime;
      }
    },
  });
  m.run();
  lastV = 0; lastL = 0;
}

const myCons = concedes.filter((c) => c.vGoal);
const theirCons = concedes.filter((c) => !c.vGoal);
console.log(`violet conceded ${myCons.length}; lime conceded ${theirCons.length}`);
console.log('\nsample violet-concedes (keeper pose, striker pose, ball at concede):');
myCons.slice(0, 12).forEach((c) => {
  const s = c.snap;
  console.log(`t=${s.clock.toFixed(0)}  keeper(${s.kx.toFixed(0)},${s.kz.toFixed(0)})  striker(${s.sx.toFixed(0)},${s.sz.toFixed(0)})  ball(${s.bx.toFixed(0)},${s.bz.toFixed(0)}) v=${Math.hypot(s.bvx, s.bvz).toFixed(0)}`);
});

const offLine = myCons.filter((c) => Math.abs(c.snap.kx) < 915 - 175 - 40);
console.log(`\nviolet concedes while keeper >40mm off the guard line (i.e. smothering/caught upfield): ${offLine.length}/${myCons.length}`);
const keeperOffSide = myCons.filter((c) => {
  const kz = c.snap.kz, bz = c.snap.bz;
  return Math.abs(kz - bz) > 120;
});
console.log(`violet concedes where keeper z was >120mm from ball z: ${keeperOffSide.length}/${myCons.length}`);
