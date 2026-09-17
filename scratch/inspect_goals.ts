import { Match } from '../src/match';
import { championTeam } from '../src/champion';
import { spawnLineup } from '../src/lineup';

async function main() {
  const match = new Match({
    halfSeconds: 45,
    seed: 1,
    idealSensors: false,
  });

  // Champion as Lime, Python as Violet
  const limeTeam = championTeam('lime');
  
  // We can connect Python via subprocess or run Match with observe
  console.log('Seed 1 inspection ready');
}

main().catch(console.error);
