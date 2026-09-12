import { Match } from '../src/match';
import { referenceTeam } from '../src/reference';

const seeds = 120;
const ideal = process.argv.includes('--ideal');
const halfSeconds = 90;

let cFor = 0;
let cAgainst = 0;
let cyanWins = 0;
let yellowWins = 0;
let draws = 0;

for (let seed = 1; seed <= seeds; seed++) {
  const match = new Match({
    agents: { ...referenceTeam('cyan'), ...referenceTeam('yellow') } as never,
    halfSeconds,
    seed,
    idealSensors: ideal,
  });
  const result = match.run();
  cFor += result.score.cyan;
  cAgainst += result.score.yellow;
  if (result.score.cyan > result.score.yellow) cyanWins++;
  else if (result.score.yellow > result.score.cyan) yellowWins++;
  else draws++;
}

console.log(`reference-vs-reference over ${seeds} seeds (ideal=${ideal}):`);
console.log(`  cyan ${cFor} - ${cAgainst} yellow  (avg cyan ${(cFor / seeds).toFixed(2)} vs ${(cAgainst / seeds).toFixed(2)})`);
console.log(`  wins: cyan ${cyanWins}, yellow ${yellowWins}, draws ${draws}`);