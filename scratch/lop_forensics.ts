/** For every 5.6 call: was the ball actually still? And where was it? */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import type { MatchAgents } from '../packages/server/src/match/match';

const roster = botRoster();
for (let round = 0; round < 2; round++) {
  for (const home of roster) {
    for (const away of roster) {
      if (home === away) continue;
      const [c1, c2] = home.make('violet');
      const [y1, y2] = away.make('lime');
      const agents = { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } satisfies MatchAgents;
      (globalThis as any).__hist = [];
      new Match({ agents, halfSeconds: 120, seed: 8100 + round }).run();
    }
  }
}
type Ev = { rule: string; minV: number; maxV: number; meanV: number; fracStill: number; spanX: number; spanZ: number; ballX: number; ballZ: number; everPastLine: boolean; maxAbsX: number };
const ev = ((globalThis as any).__ev ?? []) as Ev[];
const q = (xs: number[], p: number) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : NaN;
const f = (n: number) => Number.isFinite(n) ? n.toFixed(0) : '-';
// "The ball was moving the whole time" = never sat still for long.
const moving = ev.filter((e) => e.fracStill < 0.25);
const nearGoal = ev.filter((e) => e.maxAbsX > 915 - 300);
console.log(JSON.stringify({
  calls: ev.length,
  byRule: ev.reduce((a: Record<string, number>, e) => { a[e.rule] = (a[e.rule] ?? 0) + 1; return a; }, {}),
  ballWasMovingThroughout: moving.length,
  movingShare: (moving.length / Math.max(1, ev.length) * 100).toFixed(0) + '%',
  ofThoseNearAGoal: moving.filter((e) => e.maxAbsX > 915 - 300).length,
  ofThoseEverPastTheGoalLine: moving.filter((e) => e.everPastLine).length,
  movingCallProfile: {
    meanSpeed_p50: f(q(moving.map((e) => e.meanV), 0.5)),
    maxSpeed_p50: f(q(moving.map((e) => e.maxV), 0.5)),
    spanX_p50: f(q(moving.map((e) => e.spanX), 0.5)),
    spanZ_p50: f(q(moving.map((e) => e.spanZ), 0.5)),
  },
  nearGoalCalls: nearGoal.length,
  nearGoalEverPastLine: nearGoal.filter((e) => e.everPastLine).length,
}, null, 2));
