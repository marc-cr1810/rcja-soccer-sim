import { Match } from '../src/match';
import { referenceTeam } from '../src/reference';
const teams = () => ({ ...referenceTeam('cyan'), ...referenceTeam('yellow') }) as never;
for (const ideal of [true, false]) {
  const out: string[] = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = new Match({ agents: teams(), halfSeconds: 90, seed, idealSensors: ideal }).run();
    out.push(`${r.score.cyan}-${r.score.yellow}`);
  }
  const distinct = new Set(out).size;
  console.log(`idealSensors=${String(ideal).padEnd(5)} scores ${out.join(' ')}   ${distinct > 1 ? 'seeds bite' : '>>> ALL IDENTICAL'}`);
}
