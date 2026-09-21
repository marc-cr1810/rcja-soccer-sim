/**
 * Built-in robots against each other, headless: goals and kick-off calls.
 * Recorded before and after they stopped being told referee state, so later
 * comparisons are not made across that change by accident.
 *
 *   bun scratch/builtin_baseline.ts 20
 */
import { MatchServer } from '../packages/server/src/infra/server';
import { referenceTeam } from '../packages/server/src/infra/reference';
import { championTeam } from '../packages/server/src/champion/index';
import type { MatchAgents } from '../packages/server/src/match/match';

const n = Number(process.argv[2] ?? 20);
const pairings: [string, () => MatchAgents][] = [
  ['reference v reference', () => ({ ...referenceTeam('violet'), ...referenceTeam('lime') }) as unknown as MatchAgents],
  ['champion v reference', () => ({ ...championTeam('violet'), ...referenceTeam('lime') }) as unknown as MatchAgents],
  ['reference v champion', () => ({ ...referenceTeam('violet'), ...championTeam('lime') }) as unknown as MatchAgents],
];
const server = new MatchServer({ port: 0, realtime: false });
await server.listen();
try {
  for (const [name, make] of pairings) {
    const t = { violetGoals: 0, limeGoals: 0, koV: 0, koL: 0, illV: 0, illL: 0 };
    for (let seed = 1; seed <= n; seed++) {
      const r: any = await server.play({ agents: make(), halfSeconds: 60, seed });
      t.violetGoals += r.score.violet;
      t.limeGoals += r.score.lime;
      for (const e of r.events) {
        if (e.kind === 'kickoff') e.team === 'violet' ? t.koV++ : t.koL++;
        if (e.kind === 'illegal-kickoff') e.team === 'violet' ? t.illV++ : t.illL++;
      }
    }
    console.log(`${name.padEnd(22)} goals ${t.violetGoals}-${t.limeGoals}  illegal KO violet ${t.illV}/${t.koV} lime ${t.illL}/${t.koL}`);
  }
} finally {
  await server.close();
}
