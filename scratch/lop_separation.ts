/**
 * Can "stuck" be told from "being played" by how hard the ball is struck?
 *
 * A stuck ball is SHOVED: low, steady speed, no impulses. A ball in a goalmouth
 * scramble is KICKED: sharp peaks. If the two populations separate, peak speed
 * is a usable let-off; if they overlap, it is not.
 */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import { championTeam } from '../packages/server/src/champion/index';
import { referenceTeam } from '../packages/server/src/infra/reference';
import type { MatchAgents } from '../packages/server/src/match/match';

const roster = botRoster();
for (const home of roster) for (const away of roster) {
  if (home === away) continue;
  const [c1, c2] = home.make('violet'); const [y1, y2] = away.make('lime');
  (globalThis as any).__hist = [];
  new Match({ agents: { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } as MatchAgents, halfSeconds: 120, seed: 8100 }).run();
}
for (const h of [championTeam, referenceTeam]) for (const a of [championTeam, referenceTeam]) {
  for (let seed = 0; seed < 12; seed++) {
    (globalThis as any).__hist = [];
    new Match({ agents: { ...h('violet'), ...a('lime') } as never, halfSeconds: 300, seed: 9000 + seed }).run();
  }
}

type Ev = { rule: string; maxV: number; meanV: number; fracStill: number; spanX: number; spanZ: number; maxAbsX: number };
const ev = ((globalThis as any).__ev ?? []) as Ev[];
// Ground truth by how much of the window the ball spent essentially stopped.
const stuck = ev.filter((e) => e.fracStill >= 0.6);
const played = ev.filter((e) => e.fracStill < 0.25);
const q = (xs: number[], p: number) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!.toFixed(0) : '-';
const span = (e: Ev) => Math.hypot(e.spanX, e.spanZ);
const diag = ev.map(span).sort((a, b) => a - b);
console.log('--- span diagonal of every call window ---');
for (const t of [250, 300, 350, 400, 450, 500]) {
  const over = ev.filter((e) => span(e) > t);
  const overStuck = over.filter((e) => e.fracStill >= 0.6).length;
  const overPlayed = over.filter((e) => e.fracStill < 0.25).length;
  console.log(`  threshold ${t}: would drop ${over.length}/${ev.length} calls  (of which genuinely-still ${overStuck}, being-played ${overPlayed})`);
}
console.log('  span p50 all =', diag[Math.floor(diag.length / 2)]?.toFixed(0), ' max =', diag[diag.length - 1]?.toFixed(0));
console.log(JSON.stringify({
  calls: ev.length, stuckWindows: stuck.length, playedWindows: played.length,
  maxSpeed: {
    stuck: { p50: q(stuck.map((e) => e.maxV), 0.5), p90: q(stuck.map((e) => e.maxV), 0.9), p99: q(stuck.map((e) => e.maxV), 0.99) },
    played: { p10: q(played.map((e) => e.maxV), 0.1), p50: q(played.map((e) => e.maxV), 0.5) },
  },
  meanSpeed: {
    stuck: { p50: q(stuck.map((e) => e.meanV), 0.5), p90: q(stuck.map((e) => e.meanV), 0.9) },
    played: { p10: q(played.map((e) => e.meanV), 0.1), p50: q(played.map((e) => e.meanV), 0.5) },
  },
  spanDiagonal: {
    stuck: { p50: q(stuck.map(span), 0.5), p90: q(stuck.map(span), 0.9) },
    played: { p10: q(played.map(span), 0.1), p50: q(played.map(span), 0.5) },
  },
}, null, 2));
