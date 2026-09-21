/** When a goal is disallowed for forcing, how long had the forcing lasted? */
import { Match } from '../packages/server/src/match/match';
import { championTeam } from '../packages/server/src/champion/index';
import { referenceTeam } from '../packages/server/src/infra/reference';

let given = 0;
for (const h of [championTeam, referenceTeam]) for (const a of [championTeam, referenceTeam]) {
  for (let seed = 0; seed < 12; seed++) {
    const r = new Match({ agents: { ...h('violet'), ...a('lime') } as never, halfSeconds: 300, seed: 9000 + seed }).run();
    given += r.score.violet + r.score.lime;
  }
}
const d = ((globalThis as any).__dis ?? []) as { dur: number; since: number }[];
const durs = d.map((x) => x.dur).sort((a, b) => a - b);
const q = (p: number) => durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * p))]!.toFixed(3) : '-';
console.log(JSON.stringify({
  goalsGiven: given, goalsDisallowed: d.length,
  disallowedShare: (d.length / Math.max(1, given + d.length) * 100).toFixed(0) + '%',
  forcingDurationAtDisallow: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1) },
  underOneTick: d.filter((x) => x.dur <= 0.02).length,
  under_0_25s: d.filter((x) => x.dur < 0.25).length,
  under_0_5s: d.filter((x) => x.dur < 0.5).length,
  atLeast_1_2s: d.filter((x) => x.dur >= 1.2).length,
}, null, 2));
