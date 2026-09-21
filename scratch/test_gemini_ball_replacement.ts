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

  // Test Gemini as Violet
  const resolved = await resolveLineup(SUBMISSIONS_DIR, { violet: 'Gemini', lime: '__none__' });

  const agentLogs: string[] = [];
  const lineup = await spawnLineup(
    server,
    resolved,
    { pythonLibDir: PYTHON_LIB_DIR, connectTimeoutSeconds: 5 },
    (line) => {
      agentLogs.push(line);
      if (line.includes('WAIT_FOR_BALL') || line.includes('HOLD_CENTRE') || line.includes('striker') || line.includes('goalie')) {
        console.log('[AGENT LOG]', line);
      }
    },
  );

  try {
    const agents = {
      ...referenceTeam('violet'),
      ...referenceTeam('lime'),
    } as unknown as MatchAgents;

    let ballRemovedAt = -1;
    let ballRestoredAt = -1;
    let strikerSampledInWait = false;
    let strikerMinDistToNeutralPoint = Infinity;

    const result = await server.play({
      agents,
      transports: lineup.transports,
      halfSeconds: 15,
      seed: 1,
      ballPlacementSeconds: { min: 1.5, max: 1.5 },
      observe: (match) => {
        const t = match.world.clock;

        // Force a lack of progress at t = 6.0 after kickoff play to test ball removal & neutral point waiting
        if (t >= 6.0 && ballRemovedAt < 0 && match.world.ballInPlay) {
          console.log(`\n[TEST TRIGGER] Triggering callLackOfProgress at t=${t.toFixed(2)} when ball was at (${match.world.ball.x.toFixed(1)}, ${match.world.ball.z.toFixed(1)})`);
          match.world.callLackOfProgress();
          ballRemovedAt = t;
        }

        // Check state during ball removal (between t=3.0 and t=4.5)
        if (!match.world.ballInPlay && ballRemovedAt > 0) {
          const dtAway = t - ballRemovedAt;
          const striker = match.world.robots.find((r) => r.id === 'violet-1')!;
          const goalie = match.world.robots.find((r) => r.id === 'violet-2')!;

          // Check at the end of the wait period (when striker has had time to drive and settle)
          if (dtAway >= 1.0 && dtAway <= 1.48) {
            strikerSampledInWait = true;
            const distToNPs = [
              Math.hypot(striker.x - 0, striker.z - -300),
              Math.hypot(striker.x - 0, striker.z - 0),
              Math.hypot(striker.x - 0, striker.z - 300),
            ];
            const closestNP = Math.min(...distToNPs);
            if (closestNP < strikerMinDistToNeutralPoint) {
              strikerMinDistToNeutralPoint = closestNP;
            }
            if (Math.round(dtAway * 100) % 20 === 0) {
              console.log(
                `[BALL AWAY t=${t.toFixed(3)} dt=${dtAway.toFixed(2)}] ` +
                `striker=(${striker.x.toFixed(1)}, ${striker.z.toFixed(1)}) heading=${striker.heading.toFixed(2)} closestNP=${closestNP.toFixed(1)} ` +
                `goalie=(${goalie.x.toFixed(1)}, ${goalie.z.toFixed(1)}) ` +
                `violet-1 say=${JSON.stringify(match.actuators['violet-1']?.say)}`
              );
            }
          }
        }

        if (ballRemovedAt > 0 && ballRestoredAt < 0 && match.world.ballInPlay) {
          ballRestoredAt = t;
          const striker = match.world.robots.find((r) => r.id === 'violet-1')!;
          const distToRestored = Math.hypot(striker.x - match.world.ball.x, striker.z - match.world.ball.z);
          console.log(`\n[BALL RESTORED] Ball returned at t=${t.toFixed(2)} at (${match.world.ball.x.toFixed(1)}, ${match.world.ball.z.toFixed(1)})`);
          console.log(`[AT RESTORATION] striker=(${striker.x.toFixed(1)}, ${striker.z.toFixed(1)}) distToBall=${distToRestored.toFixed(1)} mm (must be >= 110 mm)`);
          if (distToRestored >= 110) {
            console.log('SUCCESS: Neutral point was completely clear when ball was placed!');
          } else {
            console.log('FAILURE: Robot encroached neutral point at placement!');
          }
        }

        if (ballRestoredAt > 0 && t > ballRestoredAt && t <= ballRestoredAt + 1.5) {
          if (Math.round(t * 100) % 20 === 0) {
            const striker = match.world.robots.find((r) => r.id === 'violet-1')!;
            const ball = match.world.ball;
            const dist = Math.hypot(striker.x - ball.x, striker.z - ball.z);
            console.log(`[AFTER RESTORE t=${t.toFixed(2)}] striker=(${striker.x.toFixed(1)}, ${striker.z.toFixed(1)}) distToBall=${dist.toFixed(1)} say=${JSON.stringify(match.actuators['violet-1']?.say)}`);
          }
        }
      },
    });

    console.log('\n--- VERIFICATION SUMMARY ---');
    console.log(`Ball removed at: ${ballRemovedAt.toFixed(2)}s`);
    console.log(`Ball restored at: ${ballRestoredAt.toFixed(2)}s`);
    console.log(`Striker sampled during wait: ${strikerSampledInWait}`);
    console.log(`Striker min distance to any neutral point: ${strikerMinDistToNeutralPoint.toFixed(1)} mm (must be >= 110 mm)`);
    
    if (strikerMinDistToNeutralPoint >= 110 && strikerMinDistToNeutralPoint <= 250) {
      console.log('SUCCESS: Striker respected standoff distance from neutral point!');
    } else {
      console.log('WARNING: Striker distance outside expected standoff range [110, 250]');
    }

  } finally {
    await lineup.stop();
    await server.close();
  }
}

main().catch(console.error);
