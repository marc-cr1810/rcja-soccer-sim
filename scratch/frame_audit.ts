/** One python-vs-python match with RCJA_FRAME_AUDIT on, stderr captured. */
import { spawn, type ChildProcess } from 'node:child_process';
import { MatchServer } from '../src/server';

async function main(): Promise<void> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const kid: ChildProcess = spawn(`python3 python/examples/play.py --url ws://localhost:${port}/agent`, {
    shell: true, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
    env: { ...process.env, RCJA_FRAME_AUDIT: '1' },
  });
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      const t = server.agents.transports();
      if (['cyan-1', 'cyan-2', 'yellow-1', 'yellow-2'].every((id) => t[id as never])) break;
      if (Date.now() > deadline) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
    await server.play({
      agents: {} as never,
      transports: server.agents.transports(),
      halfSeconds: 90,
      seed: 4,
      idealSensors: true,
    });
  } finally {
    try { if (kid.pid) process.kill(-kid.pid, 'SIGKILL'); } catch { /* gone */ }
    await server.close();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
