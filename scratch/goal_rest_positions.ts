/** Where exactly do balls stop when they die inside the goal? */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import type { MatchAgents } from '../packages/server/src/match/match';
import { HALF_LENGTH, GOAL_BACK_X, withinGoalMouth } from '../packages/server/src/sim/field';

const roster = botRoster();
const rest: number[] = [];   // how far the ball's CENTRE got past the goal line

for (let round = 0; round < 2; round++) {
  for (const home of roster) {
    for (const away of roster) {
      if (home === away) continue;
      const [c1, c2] = home.make('violet');
      const [y1, y2] = away.make('lime');
      const agents = { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } satisfies MatchAgents;
      let seen = 0;
      let lastDepth: number | null = null;
      const m: Match = new Match({
        agents, halfSeconds: 120, seed: 4100 + round,
        observe: () => {
          const w = m.world;
          // Remember where the ball was while it was still in there - the
          // referee moves it in the same tick it emits.
          if (Math.abs(w.ball.x) > HALF_LENGTH && withinGoalMouth(w.ball.z)) {
            lastDepth = Math.abs(w.ball.x) - HALF_LENGTH;
          }
          if (w.events.length === seen) return;
          const fresh = w.events.slice(seen); seen = w.events.length;
          for (const e of fresh) {
            if (e.kind === 'lack-of-progress' && (e.message ?? '').includes('crossbar')) {
              // The referee has not moved it yet at emit time for the non-auto
              // path, but it has for auto; record the ball's depth as seen now.
              if (lastDepth !== null) rest.push(lastDepth);
              lastDepth = null;
            }
          }
        },
      });
      m.run();
    }
  }
}
const r = w => rest.filter(w).length;
const radius = 21;
console.log(JSON.stringify({
  strandedBalls: rest.length,
  note: 'depth = ball CENTRE past the goal line, mm. Fully across needs ' + radius + ', back wall needs ' + (GOAL_BACK_X - HALF_LENGTH - radius),
  centreNotEvenOnTheLine: r(d => d < 0),
  onTheLineNotFullyAcross: r(d => d >= 0 && d < radius),
  fullyAcrossButShortOfTheBackWall: r(d => d >= radius),
}, null, 2));
