/** Goals given vs goals disallowed for forcing (5.6.1.3). */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import { championTeam } from '../packages/server/src/champion/index';
import { referenceTeam } from '../packages/server/src/infra/reference';
import type { MatchAgents } from '../packages/server/src/match/match';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
console.log('world.ts md5:', createHash('md5').update(readFileSync('packages/server/src/sim/world.ts')).digest('hex'));

let given = 0, disallowed = 0, crossbar = 0;
const roster = botRoster();
for (const home of roster) for (const away of roster) {
  if (home === away) continue;
  const [c1, c2] = home.make('violet'); const [y1, y2] = away.make('lime');
  const r = new Match({ agents: { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } as MatchAgents, halfSeconds: 120, seed: 8100 }).run();
  given += r.score.violet + r.score.lime;
  disallowed += r.events.filter((e) => (e.message ?? '').includes('Goal disallowed')).length;
  crossbar += r.events.filter((e) => (e.message ?? '').includes('crossbar')).length;
}
let cGiven = 0, cDis = 0, cCross = 0;
for (const h of [championTeam, referenceTeam]) for (const a of [championTeam, referenceTeam]) {
  for (let seed = 0; seed < 12; seed++) {
    const r = new Match({ agents: { ...h('violet'), ...a('lime') } as never, halfSeconds: 300, seed: 9000 + seed }).run();
    cGiven += r.score.violet + r.score.lime;
    cDis += r.events.filter((e) => (e.message ?? '').includes('Goal disallowed')).length;
    cCross += r.events.filter((e) => (e.message ?? '').includes('crossbar')).length;
  }
}
console.log(JSON.stringify({
  bots: { given, disallowed, strandedInGoal: crossbar, disallowedShare: (disallowed / Math.max(1, given + disallowed) * 100).toFixed(0) + '%' },
  championAndReference: { given: cGiven, disallowed: cDis, strandedInGoal: cCross, disallowedShare: (cDis / Math.max(1, cGiven + cDis) * 100).toFixed(0) + '%' },
}, null, 2));
