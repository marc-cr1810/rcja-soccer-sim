/**
 * Isolate whether the +x/-x scoring asymmetry lives in striker.py (attacking)
 * or goalie.py (defending).
 *
 * Python plays cyan (striker + goalie) against a TS "statue" side (both
 * robots motionless) for a full two-half match, so ends swap at half-time
 * exactly as they would in a real match. Statue never scores and never
 * threatens, so EVERY goal is the python striker scoring on an open net -
 * this isolates striker.py's shooting, uncontaminated by any goalie.py
 * defensive behaviour. If h1 and h2 scoring rates differ, the asymmetry is in
 * the striker; if they match, it must be in the goalie.
 */
import { spawn } from 'node:child_process';
import { MatchServer } from '../src/server';
import { statue } from '../src/bots';

const SEEDS = Number.parseInt(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '20', 10);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '90', 10);

async function playSeed(seed: number): Promise<{ h1: number; h2: number }> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;
  // `detached: true` puts the shell (and everything it spawns) in its own
  // process group, so killing that whole group is the only way to reliably
  // reach the python grandchildren `shell: true` interposes - `child.kill()`
  // alone only ever signalled the shell, leaving striker.py/goalie.py behind
  // as orphans piling up across every seed.
  const child = spawn(`python3 python/examples/play.py --only yellow --url ${url}`, {
    shell: true,
    stdio: 'ignore',
    detached: true,
  });
  try {
    // Only cyan connects (--only yellow), so `whenReady` (all four gateway
    // seats) would never resolve. Poll for just the two remote seats.
    const deadline = Date.now() + 30000;
    for (;;) {
      const t = server.agents.transports();
      if ((t['yellow-1'] ?? false) && (t['yellow-2'] ?? false)) break;
      if (Date.now() > deadline) throw new Error('timeout waiting for cyan seats');
      await new Promise((r) => setTimeout(r, 100));
    }
    let h1 = 0;
    let h2 = 0;
    let prevTotal = 0;
    const observe = (m: { world: { half: 1 | 2; score: { cyan: number; yellow: number } } }): void => {
      const total = m.world.score.cyan + m.world.score.yellow;
      if (total > prevTotal) {
        if (m.world.half === 1) h1++;
        else h2++;
      }
      prevTotal = total;
    };
    await server.play({
      agents: { 'cyan-1': statue, 'cyan-2': statue } as never,
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed,
      idealSensors: true,
      observe: observe as never,
    });
    return { h1, h2 };
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    await server.close();
  }
}

async function main(): Promise<void> {
  let h1Total = 0;
  let h2Total = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { h1, h2 } = await playSeed(seed);
    h1Total += h1;
    h2Total += h2;
    console.log(`seed ${seed}: h1=${h1} h2=${h2}`);
  }
  console.log(`\nTOTAL over ${SEEDS} seeds: h1=${h1Total}  h2=${h2Total}`);
  console.log(
    `PYTHON=YELLOW: h1 attacks -x, h2 attacks +x, after the half-time end swap.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
