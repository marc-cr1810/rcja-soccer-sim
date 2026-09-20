/** What does the longest remaining dead spell actually look like? */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import type { MatchAgents } from '../packages/server/src/match/match';
import { distance } from '../packages/server/src/sim/physics';

const roster = botRoster();
let worst = { secs: 0, gap: 0, contested: false, who: '' };
const longSpells: { gap: number; contested: boolean }[] = [];

for (const home of roster) {
  for (const away of roster) {
    if (home === away) continue;
    const [c1, c2] = home.make('violet');
    const [y1, y2] = away.make('lime');
    const agents = { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } satisfies MatchAgents;
    let mark = { x: 0, z: 0 };
    let since = 0, lastClock = 0, seen = 0;
    const m = new Match({
      agents, halfSeconds: 120, seed: 4242,
      observe: () => {
        const w = m.world;
        const dt = w.clock - lastClock;
        lastClock = w.clock;
        if (dt <= 0 || !w.running) { mark = { x: w.ball.x, z: w.ball.z }; since = 0; return; }
        if (w.events.length !== seen) {
          // Every new event, not just the last: several land in one tick, and
          // checking only the newest silently misses the referee's call.
          const fresh = w.events.slice(seen);
          seen = w.events.length;
          if (fresh.some((e) => e.kind === 'lack-of-progress' || e.kind === 'ball-out-of-play' || e.kind === 'goal')) {
            mark = { x: w.ball.x, z: w.ball.z }; since = 0; return;
          }
        }
        if (distance(w.ball, mark) > 320) { mark = { x: w.ball.x, z: w.ball.z }; since = 0; return; }
        since += dt;
        if (since > 8) {
          // Who is near, and is it a contest?
          let gap = Infinity; let v = false, l = false;
          for (const r of w.robots) {
            if (r.removed) continue;
            const g = distance(r, w.ball) - r.radius - w.ball.radius;
            gap = Math.min(gap, g);
            if (distance(r, w.ball) < 320) { if (r.team === 'violet') v = true; else l = true; }
          }
          if (since > worst.secs) worst = { secs: since, gap, contested: v && l, who: `${home.name} v ${away.name}` };
          if (Math.abs(since - 8.5) < 0.1) longSpells.push({ gap, contested: v && l });
        }
      },
    });
    m.run();
  }
}
const held = longSpells.filter((s) => s.gap <= 30).length;
console.log(JSON.stringify({
  longestSpell: worst.secs.toFixed(1),
  longestSpellNearestGapMm: worst.gap.toFixed(0),
  longestSpellContested: worst.contested,
  longestSpellMatch: worst.who,
  spellsPast8s: longSpells.length,
  ofThoseWithBallAtARobotsFeet: held,
}, null, 2));
