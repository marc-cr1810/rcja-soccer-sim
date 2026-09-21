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

  // Test Gemini as Violet taking kickoff
  const resolved = await resolveLineup(SUBMISSIONS_DIR, { violet: 'Gemini', lime: '__none__' });

  const lineup = await spawnLineup(
    server,
    resolved,
    { pythonLibDir: PYTHON_LIB_DIR, connectTimeoutSeconds: 5 },
    (line) => {
      if (line.includes('STRIKER_KO') || line.includes('Illegal') || line.includes('kickoff')) {
        console.log('[AGENT LOG]', line);
      }
    },
  );

  try {
    const agents = {
      ...referenceTeam('violet'),
      ...referenceTeam('lime'),
    } as unknown as MatchAgents;

    // Run just 3 seconds of kickoff
    const result = await server.play({
      agents,
      transports: lineup.transports,
      halfSeconds: 5,
      seed: 1,
      observe: (match) => {
        if (match.world.clock <= 1.0) {
          const striker = match.world.robots.find((r) => r.id === 'violet-1')!;
          const ball = match.world.ball;
          const gap = Math.hypot(striker.x - ball.x, striker.z - ball.z) - (striker.radius + ball.radius);
          const ballDistFromCenter = Math.hypot(ball.x, ball.z);
          const crossedHalf = match.world.attackingGoal(striker.team) === 'yellow' ? striker.x > 0 : striker.x < 0;
          console.log(
            `[SIM t=${match.world.clock.toFixed(3)}] pending=${match.world.kickOffPending} ` +
            `striker=(${striker.x.toFixed(1)}, ${striker.z.toFixed(1)}) ` +
            `ball=(${ball.x.toFixed(1)}, ${ball.z.toFixed(1)}) vx=${ball.vx.toFixed(1)} gap=${gap.toFixed(1)} ` +
            `distCenter=${ballDistFromCenter.toFixed(1)} crossedHalf=${crossedHalf} ` +
            `actuators=${JSON.stringify(match.actuators['violet-1'])}`
          );
        }
      },
    });

    console.log('\nCalls:', result.calls);
    console.log('Events:', result.events.filter((e) => e.kind.includes('kickoff')));
  } finally {
    lineup.stop();
    await server.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
