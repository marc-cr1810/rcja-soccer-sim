import { World } from '../src/world';
import { getLeague } from '../src/leagues';
import { championTeam } from '../src/champion';

async function main() {
  const league = getLeague('open');
  const w1 = new World({ league, placementSeed: 1 });
  const w2 = new World({ league, placementSeed: 1 });

  w1.kickOff('violet');
  w2.kickOff('lime'); // Should be 180-deg rotated kickOff

  console.log('w1 kickoff robots:');
  for (const r of w1.robots) {
    console.log(`  ${r.id}: (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) h=${(r.heading * 180 / Math.PI).toFixed(1)}°`);
  }

  console.log('w2 kickoff robots:');
  for (const r of w2.robots) {
    console.log(`  ${r.id}: (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) h=${(r.heading * 180 / Math.PI).toFixed(1)}°`);
  }
}

main().catch(console.error);
