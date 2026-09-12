import { Match } from '../src/match';
import { referenceTeam } from '../src/reference';
const teams = () => ({ ...referenceTeam('cyan'), ...referenceTeam('yellow') }) as never;
for (const seed of [1, 2, 3]) {
  const m = new Match({ agents: teams(), halfSeconds: 60, seed, idealSensors: true });
  m.world.kickOff('cyan');
  console.log(`seed ${seed}: ` + m.world.robots.map((r) => `${r.id}(${r.x.toFixed(0)},${r.z.toFixed(0)})`).join(' '));
}
