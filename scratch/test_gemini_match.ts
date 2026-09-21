import { resolve } from 'node:path';
import { MatchServer } from '../packages/server/src/infra/server';
import { resolveLineup, spawnLineup } from '../packages/server/src/accounts/lineup';
import { referenceTeam } from '../packages/server/src/infra/reference';
import type { MatchAgents } from '../packages/server/src/match/match';

const REPO_ROOT = process.cwd();
const PYTHON_LIB_DIR = resolve(REPO_ROOT, 'python');
const SUBMISSIONS_DIR = resolve(REPO_ROOT, 'data/submissions');

async function main() {
  const server = new MatchServer({ port: 0, realtime: false, pythonLibDir: PYTHON_LIB_DIR });
  await server.listen();

  console.log('Resolving lineup for Reference vs Gemini (Lime)...');
  const resolved = await resolveLineup(SUBMISSIONS_DIR, { violet: '__none__', lime: 'Gemini' });
  console.log('Resolved slots:', Object.keys(resolved));

  const logs: string[] = [];
  const lineup = await spawnLineup(
    server,
    resolved,
    { pythonLibDir: PYTHON_LIB_DIR, connectTimeoutSeconds: 5 },
    (line) => {
      logs.push(line);
      console.log('[AGENT LOG]', line);
    },
  );

  try {
    console.log('Starting match...');
    const agents = {
      ...referenceTeam('violet'),
      ...referenceTeam('lime'),
    } as unknown as MatchAgents;

    const result = await server.play({
      agents,
      transports: lineup.transports,
      halfSeconds: 30,
      seed: 1,
      observe: (match) => {
        if (match.world.clock >= 29.95 && match.world.clock <= 30.35) {
          const striker = match.world.robots.find((r) => r.id === 'lime-1')!;
          const ball = match.world.ball;
          const gap = Math.hypot(striker.x - ball.x, striker.z - ball.z) - (striker.radius + ball.radius);
          const ballDistFromCenter = Math.hypot(ball.x, ball.z);
          const crossedHalf = match.world.attackingGoal(striker.team) === 'yellow' ? striker.x > 0 : striker.x < 0;
          console.log(
            `[SIM t=${match.world.clock.toFixed(3)}] kickOffPending=${match.world.kickOffPending} ` +
            `sinceKickOff=${match.world.sinceKickOff.toFixed(2)} ` +
            `kickingOffTeam=${match.world.kickingOffTeam} ` +
            `striker=(${striker.x.toFixed(1)}, ${striker.z.toFixed(1)}) ` +
            `heading=${striker.heading.toFixed(2)} motors=[${striker.motors.map((m) => m.toFixed(2)).join(',')}] ` +
            `ball=(${ball.x.toFixed(1)}, ${ball.z.toFixed(1)}) vx=${ball.vx.toFixed(1)} gap=${gap.toFixed(1)} ` +
            `ballDistCenter=${ballDistFromCenter.toFixed(1)} crossedHalf=${crossedHalf} ` +
            `actuators=${JSON.stringify(match.actuators['lime-1'])}`
          );
        }
      },
    });

    console.log('\n--- MATCH FINISHED ---');
    console.log('Score:', result.score);
    console.log('Calls:', result.calls);
    console.log('Events:', result.events.filter((e) => e.kind.includes('kickoff')));
    console.log('Slots:', result.slots);
  } finally {
    lineup.stop();
    await server.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
