import { Match } from '../src/match';
import { referenceTeam } from '../src/reference';
const teams = () => ({ ...referenceTeam('cyan'), ...referenceTeam('yellow') }) as never;
for (const [half, ideal] of [[90, undefined], [90, true], [45, true], [45, undefined]] as const) {
  let c = 0, y = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = new Match({ agents: teams(), halfSeconds: half, seed, idealSensors: ideal }).run();
    c += r.score.cyan; y += r.score.yellow;
  }
  console.log(`half=${half} ideal=${ideal}  -> cyan ${c} yellow ${y} over 6 seeds`);
}
