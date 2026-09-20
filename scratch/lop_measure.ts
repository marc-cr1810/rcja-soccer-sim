/**
 * How often does the referee call lack of progress, and how long does a dead
 * ball sit before anyone says anything?
 *
 * Run on both sides of a change to the 5.6 detectors. The interesting numbers
 * are the call counts by rule and, more importantly, the longest the ball went
 * without moving anywhere while nobody was punished for it.
 */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import type { MatchAgents } from '../packages/server/src/match/match';
import { distance } from '../packages/server/src/sim/physics';

const roster = botRoster();
const calls: Record<string, number> = {};
let matches = 0;
let worstDeadSpell = 0;
const spells: number[] = [];

for (let round = 0; round < 2; round++) {
  for (const home of roster) {
    for (const away of roster) {
      if (home === away) continue;
      const [c1, c2] = home.make('violet');
      const [y1, y2] = away.make('lime');
      const agents = { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } satisfies MatchAgents;
      let observer: () => void = () => {};
      const m = new Match({ agents, halfSeconds: 120, seed: 1000 + round, observe: () => observer() });

      // Watch the ball: how long can it stay inside a 320 mm circle?
      let mark = { x: m.world.ball.x, z: m.world.ball.z };
      let since = 0;
      let lastClock = 0;
      let seenEvents = 0;
      observer = () => {
        const dt = m.world.clock - lastClock;
        lastClock = m.world.clock;
        if (dt <= 0 || !m.world.running) { mark = { x: m.world.ball.x, z: m.world.ball.z }; since = 0; return; }
        // A referee call ends the spell whatever the ball did.
        if (m.world.events.length !== seenEvents) {
          // Every new event, not just the last: several land in one tick, and
          // checking only the newest silently misses the referee's call.
          const fresh = m.world.events.slice(seenEvents);
          seenEvents = m.world.events.length;
          if (fresh.some((e) => e.kind === 'lack-of-progress' || e.kind === 'ball-out-of-play' || e.kind === 'goal')) {
            mark = { x: m.world.ball.x, z: m.world.ball.z }; since = 0; return;
          }
        }
        if (distance(m.world.ball, mark) > 320) {
          mark = { x: m.world.ball.x, z: m.world.ball.z };
          if (since > 3) spells.push(since);
          worstDeadSpell = Math.max(worstDeadSpell, since);
          since = 0;
        } else {
          since += dt;
        }
      };
      const result = m.run();
      if (since > 3) spells.push(since);
      worstDeadSpell = Math.max(worstDeadSpell, since);
      matches++;
      for (const [kind, n] of Object.entries(result.calls)) calls[kind] = (calls[kind] ?? 0) + n;
      for (const e of result.events) {
        if (e.kind === 'lack-of-progress') {
          const k = `lop:${e.rule ?? '?'}`;
          calls[k] = (calls[k] ?? 0) + 1;
        }
      }
    }
  }
}

spells.sort((a, b) => a - b);
const pct = (p: number) => spells.length ? spells[Math.min(spells.length - 1, Math.floor(spells.length * p))]!.toFixed(1) : '-';
console.log(JSON.stringify({
  matches,
  lopCalls: Object.fromEntries(Object.entries(calls).filter(([k]) => k.startsWith('lop:') || k === 'lack-of-progress')),
  stuckSpellsOver3s: spells.length,
  medianSpell: pct(0.5),
  p95Spell: pct(0.95),
  worstSpell: worstDeadSpell.toFixed(1),
}, null, 2));
