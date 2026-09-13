/** When does the score change, relative to the ball leaving the field? */
import { Match, type MatchAgents } from '../src/match';
import { referenceTeam } from '../src/reference';
import { HALF_LENGTH, HALF_WIDTH } from '../src/field';

const match = new Match({
  agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
  halfSeconds: 90,
  seed: 3,
});
match.world.kickOff('violet');
match.world.running = true;

let prev = { v: 0, l: 0 };
let ticks = 0;
let outFirst = 0, together = 0;
let wasOut = false;
let lastOutAt: number | null = null;
let firstOut: number | null = null;

for (let i = 0; i < 90 * 100; i++) {
  match.step(1 / 100);
  ticks++;
  const w = match.world;
  const out = Math.abs(w.ball.x) > HALF_LENGTH || Math.abs(w.ball.z) > HALF_WIDTH;
  const scored = w.score.violet !== prev.v || w.score.lime !== prev.l;
  if (out && lastOutAt === null) lastOutAt = ticks;
  if (!out) lastOutAt = null;
  if (scored) {
    if (wasOut) outFirst++; else together++;
    console.log(
      `goal at tick ${ticks}: ball first left play at tick ${firstOut}` +
      `  -> lag ${ticks - (firstOut ?? ticks)} ticks (${((ticks - (firstOut ?? ticks)) / 100).toFixed(2)}s)`,
    );
    prev = { v: w.score.violet, l: w.score.lime };
    firstOut = null;
  }
  if (out && firstOut === null) firstOut = ticks;
  if (!out) firstOut = null;
  wasOut = out;
}
console.log(`\nscore changed AFTER the ball had already left play: ${outFirst}`);
console.log(`score changed on the same tick the ball was still in play: ${together}`);
