/**
 * Full python-vs-python match, but prints the +x/-x goal split PER SEED, so
 * we can see whether the aggregate bias is a smooth ~4:1 or a handful of
 * clumped seeds (near-deterministic trajectories break per-goal independence).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { MatchServer } from '../src/server';

const SEEDS = Number.parseInt(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '25', 10);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '45', 10);

type End = 'plus' | 'minus';

async function waitForSeats(server: MatchServer, ids: string[]): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const t = server.agents.transports();
    if (ids.every((id) => t[id as never])) break;
    if (Date.now() > deadline) throw new Error(`timeout waiting for seats ${ids}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function playSeed(seed: number): Promise<{ plus: number; minus: number; goals: End[] }> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;
  const kids: ChildProcess[] = [
    spawn(`python3 python/examples/play.py --url ${url}`, { shell: true, stdio: 'ignore', detached: true }),
  ];
  try {
    await waitForSeats(server, ['cyan-1', 'cyan-2', 'yellow-1', 'yellow-2']);
    let prevTotal = 0;
    const ends: End[] = [];
    const observe = (m: { world: { half: 1 | 2; score: Record<string, number>; ball: { x: number } } }): void => {
      const total = m.world.score.cyan + m.world.score.yellow;
      if (total > prevTotal) {
        ends.push(m.world.ball.x > 0 ? 'plus' : 'minus');
        prevTotal = total;
      }
    };
    await server.play({
      agents: {} as never,
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed,
      idealSensors: true,
      observe: observe as never,
    });
    return { plus: ends.filter((e) => e === 'plus').length, minus: ends.filter((e) => e === 'minus').length, goals: ends };
  } finally {
    for (const k of kids) {
      try { if (k.pid) process.kill(-k.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
    await server.close();
  }
}

async function main(): Promise<void> {
  let plus = 0;
  let minus = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = await playSeed(seed);
    plus += r.plus;
    minus += r.minus;
    console.log(`seed ${seed}: +x ${r.plus}  -x ${r.minus}   ${r.goals.join(',')}`);
  }
  console.log(`\nTOTAL: +x ${plus} / -x ${minus}   (ratio ${(plus / Math.max(1, minus)).toFixed(2)})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});