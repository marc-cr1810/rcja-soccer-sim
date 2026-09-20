/**
 * How often does a ball enter the goal and fail to score?
 *
 * 5.5.1 is implemented as "strikes the back wall". The goal is 74 mm deep and
 * the open-league ball is 42 mm across, so a ball that crosses the line has
 * only ~53 mm left to travel - and rolling resistance can eat that. A ball
 * that runs out of speed in there is not a goal, and three seconds later
 * 5.6.1.1 frees it.
 */
import { Match } from '../packages/server/src/match/match';
import { botRoster } from '../packages/server/src/match/bots';
import type { MatchAgents } from '../packages/server/src/match/match';
import { HALF_LENGTH } from '../packages/server/src/sim/field';
import { withinGoalMouth } from '../packages/server/src/sim/field';

const roster = botRoster();
let entries = 0, scored = 0, bouncedOut = 0, cameToRest = 0;
const entrySpeeds: { v: number; scored: boolean }[] = [];

for (let round = 0; round < 2; round++) {
  for (const home of roster) {
    for (const away of roster) {
      if (home === away) continue;
      const [c1, c2] = home.make('violet');
      const [y1, y2] = away.make('lime');
      const agents = { 'violet-1': c1!, 'violet-2': c2!, 'lime-1': y1!, 'lime-2': y2! } satisfies MatchAgents;
      let inside = false;
      let entryV = 0;
      let goalsBefore = 0;
      const m: Match = new Match({
        agents, halfSeconds: 120, seed: 4100 + round,
        observe: () => {
          const w = m.world;
          const within = Math.abs(w.ball.x) > HALF_LENGTH && withinGoalMouth(w.ball.z);
          if (within && !inside) {
            inside = true; entries++;
            entryV = Math.hypot(w.ball.vx, w.ball.vz);
            goalsBefore = w.score.violet + w.score.lime;
          } else if (!within && inside) {
            inside = false;
            const did = (w.score.violet + w.score.lime) > goalsBefore;
            if (did) scored++; else bouncedOut++;
            entrySpeeds.push({ v: entryV, scored: did });
          }
        },
      });
      const r = m.run();
      // The unambiguous case: 5.6.1.1's in-goal wording. The ball stopped
      // inside the goal, the crossbar means no robot can ever reach it, and
      // the referee had to free it.
      cameToRest += r.events.filter((e) => e.kind === 'lack-of-progress' && (e.message ?? '').includes('crossbar')).length;
    }
  }
}

const sc = entrySpeeds.filter((e) => e.scored).map((e) => e.v).sort((a, b) => a - b);
const st = entrySpeeds.filter((e) => !e.scored).map((e) => e.v).sort((a, b) => a - b);
const q = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!.toFixed(0) : '-';
console.log(JSON.stringify({
  ballsThatCrossedTheGoalLine: entries,
  scored,
  bouncedBackOut: bouncedOut,
  cameToRestInsideTheGoal: cameToRest,
  restVsGoals: (cameToRest / Math.max(1, scored + cameToRest) * 100).toFixed(0) + '% of balls that ended in the goal were not given',
  entrySpeedScored: { p10: q(sc, 0.1), p50: q(sc, 0.5) },
  entrySpeedStranded: { p50: q(st, 0.5), p90: q(st, 0.9), max: q(st, 1) },
}, null, 2));
