import { spawn } from 'node:child_process';
import { MatchServer } from './src/server';
import { Match } from './src/match';
import { referenceTeam } from './src/reference';

async function main() {
  const server = new MatchServer({
    port: 0,
    realtime: false,
    idealSensors: true,
  });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;

  console.log(`Starting python play.py on ${url}...`);
  const child = spawn(`python3 python/examples/play.py --url ${url}`, { shell: true, stdio: 'inherit' });

  await server.agents.whenReady();
  console.log('All 4 agents connected!');

  const match = new Match({
    agents: { ...referenceTeam('cyan'), ...referenceTeam('yellow') } as any,
    transports: server.agents.transports(),
    halfSeconds: 120,
    idealSensors: true,
    observe: (m) => {
      // observer hook every physics step
    },
  });

  const result = await server.play({
    agents: { ...referenceTeam('cyan'), ...referenceTeam('yellow') } as any,
    transports: server.agents.transports(),
    halfSeconds: 120,
    idealSensors: true,
  });

  console.log(`Match finished! Score: Cyan ${result.score.cyan} - Yellow ${result.score.yellow}`);
  console.log(`Goals:`, result.goals);
  console.log(`Calls:`, result.calls);

  child.kill();
  await server.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
