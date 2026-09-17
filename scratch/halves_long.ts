/** The +x/-x split over more seeds than test_halves runs, for a tighter answer. */
import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';

const SEEDS = Number(process.argv[2] ?? 60);
let plusX = 0, minusX = 0;
const perSeed: number[] = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const agents = { ...championTeam('violet'), ...championTeam('lime') } as unknown as MatchAgents;
  const res = new Match({ agents, halfSeconds: 45, seed }).run();
  // H1: violet attacks +x. H2: lime attacks +x.
  let p = 0, m = 0;
  for (const g of res.goals) {
    const attackingPlusX = g.half === 1 ? g.team === 'violet' : g.team === 'lime';
    if (attackingPlusX) p++; else m++;
  }
  plusX += p; minusX += m;
  perSeed.push(p - m);
  if (seed % 10 === 0) console.log(`  ...${seed} seeds: ${plusX} : ${minusX}`);
}

const n = plusX + minusX;
const gap = plusX - minusX;
const sd = Math.sqrt(n) / 2;           // binomial sd of the count, naive
console.log(`\nattacking +x (yellow): ${plusX}`);
console.log(`attacking -x (cyan):   ${minusX}`);
console.log(`total goals: ${n} over ${SEEDS} matches`);
console.log(`gap ${gap >= 0 ? '+' : ''}${gap}; naive binomial sd of the gap = ${(2 * sd).toFixed(1)}, so ${Math.abs(gap / (2 * sd)).toFixed(2)} sigma`);
console.log(`(naive: goals inside a match are correlated, so the true sigma is LARGER and this overstates significance)`);
const wins = perSeed.filter((d) => d > 0).length, losses = perSeed.filter((d) => d < 0).length;
console.log(`per-match sign: ${wins} matches favoured +x, ${losses} favoured -x, ${SEEDS - wins - losses} level`);
