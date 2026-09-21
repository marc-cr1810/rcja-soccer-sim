/** Same forensics, but with robots that actually attack a goal. */
import { Match } from '../packages/server/src/match/match';
import { championTeam } from '../packages/server/src/champion/index';
import { referenceTeam } from '../packages/server/src/infra/reference';
import type { MatchAgents } from '../packages/server/src/match/match';

const makers: Record<string, (t: 'violet' | 'lime') => MatchAgents> = {
  champion: (t) => championTeam(t) as never,
  reference: (t) => referenceTeam(t) as never,
};

for (const [hn, home] of Object.entries(makers)) {
  for (const [an, away] of Object.entries(makers)) {
    for (let seed = 0; seed < 12; seed++) {
      const agents = { ...home('violet'), ...away('lime') } as MatchAgents;
      (globalThis as any).__hist = [];
      new Match({ agents, halfSeconds: 300, seed: 9000 + seed }).run();
    }
    const ev = ((globalThis as any).__ev ?? []) as any[];
    (globalThis as any).__byPair ??= {};
    (globalThis as any).__byPair[`${hn} v ${an}`] = ev.length;
  }
}

type Ev = { rule: string; minV: number; maxV: number; meanV: number; fracStill: number; spanX: number; spanZ: number; ballX: number; ballZ: number; everPastLine: boolean; maxAbsX: number };
const ev = ((globalThis as any).__ev ?? []) as Ev[];
const nearGoal = ev.filter((e) => e.maxAbsX > 915 - 300);
const moving = ev.filter((e) => e.fracStill < 0.25);
const movingNearGoal = nearGoal.filter((e) => e.fracStill < 0.25);
const show = (e: Ev) => `${e.rule} still=${(e.fracStill * 100).toFixed(0)}% meanV=${e.meanV.toFixed(0)} maxV=${e.maxV.toFixed(0)} span=${e.spanX.toFixed(0)}x${e.spanZ.toFixed(0)} maxAbsX=${e.maxAbsX.toFixed(0)} pastLine=${e.everPastLine}`;
console.log(JSON.stringify({
  calls: ev.length,
  byRule: ev.reduce((a: Record<string, number>, e) => { a[e.rule] = (a[e.rule] ?? 0) + 1; return a; }, {}),
  nearGoal: nearGoal.length,
  nearGoalPastLine: nearGoal.filter((e) => e.everPastLine).length,
  ballMovingThroughout: moving.length,
  movingAndNearGoal: movingNearGoal.length,
}, null, 2));
console.log('--- worst offenders: moving ball, near a goal ---');
for (const e of movingNearGoal.slice(0, 12)) console.log('  ' + show(e));
console.log('--- any call where the ball was past the goal line ---');
for (const e of ev.filter((x) => x.everPastLine).slice(0, 12)) console.log('  ' + show(e));
