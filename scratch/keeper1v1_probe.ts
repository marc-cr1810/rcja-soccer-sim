/**
 * Full-stack striker vs keeper: one real python STRIKER attacks, while BOTH
 * goals are defended by real python keepers. Only the opponents' striker is a
 * statue (a harmless lump on its own half). Ends swap at half-time as usual.
 *
 * Pure TS/physics probes (scripted_symmetry_probe, keeper_symmetry_probe)
 * proved the world itself is mirror-symmetric and the scripted keeper is
 * airtight. This keeps the REAL python sensing + full state machines for one
 * striker and both keepers, removing the whole class of striker-vs-striker
 * interplay. If the +x advantage survives here, it lives in the python full
 * stack (or its coupling to the server's sensor/digest pipe) - if not, it
 * needs the defender/pressuring-striker interplay of the full game.
 *
 * End aggregation (ends swap at half):
 *   P: cyan-1 striker, cyan-2 + yellow-2 keepers  -> cyan attacks +x h1, -x h2
 *   Q: yellow-1 striker, cyan-2 + yellow-2 keepers -> yellow attacks -x h1, +x h2
 *   goals at +x = P.h1 + Q.h2 ; goals at -x = P.h2 + Q.h1
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { MatchServer } from '../src/server';
import { statue } from '../src/bots';

const SEEDS = Number.parseInt(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '10', 10);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '45', 10);
// --keep statue: both strikers python, both keepers statue (isolates the
// striker-vs-striker / restart interplay from any keeper behaviour).
const KEEP = process.argv.includes('--keep-statue') ? 'statue' : 'python';

type HalfCounts = { h1: number; h2: number };

async function waitForSeats(server: MatchServer, ids: string[]): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const t = server.agents.transports();
    if (ids.every((id) => t[id as never])) break;
    if (Date.now() > deadline) throw new Error(`timeout waiting for seats ${ids}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const spawnBot = (url: string, script: string, team: string, number: number): ChildProcess =>
  spawn(
    `python3 python/examples/${script} --team ${team} --number ${number} --name bench --url ${url}`,
    { shell: true, stdio: 'ignore', detached: true },
  );

async function playSeed(kind: 'P' | 'Q', seed: number): Promise<HalfCounts> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;

  // Both keepers are real unless --keep-statue.
  const kids: ChildProcess[] =
    KEEP === 'python'
      ? kind === 'P'
        ? [
            spawnBot(url, 'striker.py', 'cyan', 1),
            spawnBot(url, 'goalie.py', 'cyan', 2),
            spawnBot(url, 'goalie.py', 'yellow', 2),
          ]
        : [
            spawnBot(url, 'striker.py', 'yellow', 1),
            spawnBot(url, 'goalie.py', 'cyan', 2),
            spawnBot(url, 'goalie.py', 'yellow', 2),
          ]
      : kind === 'P'
        ? [spawnBot(url, 'striker.py', 'cyan', 1), spawnBot(url, 'striker.py', 'yellow', 1)]
        : [spawnBot(url, 'striker.py', 'yellow', 1), spawnBot(url, 'striker.py', 'cyan', 1)];

  const seats =
    KEEP === 'python'
      ? kind === 'P'
        ? ['cyan-1', 'cyan-2', 'yellow-2']
        : ['yellow-1', 'cyan-2', 'yellow-2']
      : ['cyan-1', 'yellow-1'];
  try {
    await waitForSeats(server, seats);
    let prevTotal = 0;
    const counts: HalfCounts = { h1: 0, h2: 0 };
    const observe = (m: { world: { half: 1 | 2; score: { cyan: number; yellow: number } } }): void => {
      const total = m.world.score.cyan + m.world.score.yellow;
      if (total > prevTotal) {
        if (m.world.half === 1) counts.h1++;
        else counts.h2++;
      }
      prevTotal = total;
    };
    await server.play({
      agents:
        KEEP === 'statue'
          ? ({ 'cyan-2': statue, 'yellow-2': statue } as never)
          : kind === 'P'
            ? ({ 'yellow-1': statue } as never)
            : ({ 'cyan-1': statue } as never),
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed,
      idealSensors: true,
      observe: observe as never,
    });
    return counts;
  } finally {
    for (const k of kids) {
      try {
        if (k.pid) process.kill(-k.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await server.close();
  }
}

async function main(): Promise<void> {
  let Ph1 = 0, Ph2 = 0, Qh1 = 0, Qh2 = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const [P, Q] = await Promise.all([playSeed('P', seed), playSeed('Q', seed)]);
    Ph1 += P.h1; Ph2 += P.h2; Qh1 += Q.h1; Qh2 += Q.h2;
  }
  const atPlus = Ph1 + Qh2;
  const atMinus = Ph2 + Qh1;
  console.log(`\npython striker vs python keepers, one side attacks (statue opp. striker), ${SEEDS} seeds x ${HALF}s`);
  console.log(`  P (cyan attacks):   h1(+x)=${Ph1}  h2(-x)=${Ph2}`);
  console.log(`  Q (yellow attacks): h1(-x)=${Qh1}  h2(+x)=${Qh2}`);
  console.log(`\n  goals at +x end: ${atPlus}   goals at -x end: ${atMinus}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});