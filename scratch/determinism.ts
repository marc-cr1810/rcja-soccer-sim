/**
 * Does lockstep actually make a python match reproducible?
 *
 * Plays the same seed twice and hashes the whole ball trajectory, not just the
 * score: two matches can end 1-1 by completely different routes. Also runs it
 * polled, for the comparison that matters - if polled already repeated there
 * would be nothing to fix.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MatchServer } from '../src/server';
import { playLockstep } from '../src/lockstep';
import type { Match } from '../src/match';

const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '30', 10);
const SEED = Number.parseInt(process.argv.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? '4', 10);

const groups = new Set<number>();
const reap = (): void => {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  groups.clear();
};
process.on('exit', reap);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => { reap(); process.exit(128); });

async function seats(server: MatchServer): Promise<void> {
  const want = ['cyan-1', 'cyan-2', 'yellow-1', 'yellow-2'];
  const deadline = Date.now() + 30000;
  for (;;) {
    const t = server.agents.transports();
    if (want.every((id) => t[id as never])) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for seats');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function play(mode: 'lockstep' | 'polled'): Promise<{ score: string; trace: string }> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const kid: ChildProcess = spawn(`python3 python/examples/play.py --url ws://localhost:${port}/agent`, {
    shell: true,
    stdio: 'ignore',
    detached: true,
  });
  if (kid.pid) groups.add(kid.pid);
  try {
    await seats(server);
    const hash = createHash('sha256');
    let n = 0;
    const observe = (m: Match): void => {
      // Every tick of the ball, rounded well inside the noise floor, so the
      // hash is about the match and not about the last bit of a double.
      if (n++ % 5 === 0) {
        hash.update(`${m.world.ball.x.toFixed(3)},${m.world.ball.z.toFixed(3)};`);
      }
    };
    const common = {
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed: SEED,
      idealSensors: true,
      observe,
    };
    const result =
      mode === 'lockstep'
        ? await playLockstep({ agents: {} as never, ...common })
        : await server.play({ agents: {} as never, ...common });
    return { score: `${result.score.cyan}-${result.score.yellow}`, trace: hash.digest('hex').slice(0, 16) };
  } finally {
    if (kid.pid) {
      try {
        process.kill(-kid.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      groups.delete(kid.pid);
    }
    await server.close();
  }
}

async function main(): Promise<void> {
  for (const mode of ['polled', 'lockstep'] as const) {
    const a = await play(mode);
    const b = await play(mode);
    const same = a.trace === b.trace;
    console.log(
      `${mode.padEnd(9)} run1 ${a.score} trace ${a.trace}   run2 ${b.score} trace ${b.trace}   ` +
        (same ? '>>> REPRODUCIBLE' : '>>> differs'),
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
