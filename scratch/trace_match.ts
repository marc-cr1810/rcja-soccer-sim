/**
 * Trace a python-vs-python match: record robot+ball state every control tick,
 * tagged by half, so the two halves (which are mirror images) can be diffed.
 * Writes a JSONL file: one line per tick.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Match } from '../src/match';
import { MatchServer } from '../src/server';

const SEEDS = Number.parseInt(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '1', 10);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '90', 10);
const OUT = resolve(process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'trace.jsonl');

const rows: unknown[] = [];

async function playSeed(seed: number): Promise<void> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;
  const child = spawn(`python3 python/examples/play.py --url ${url}`, {
    shell: true,
    stdio: 'ignore',
    detached: true,
  });
  try {
    await server.agents.whenReady();
    await server.play({
      agents: {},
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed,
      idealSensors: true,
      observe: (m: Match) => {
        const w = m.world;
        if (!w.running) return;
        rows.push({
          seed,
          half: w.half,
          clock: Math.round(w.clock * 50),
          ball: { ...w.ball },
          robots: w.robots.map((r) => ({ id: r.id, x: r.x, z: r.z, h: r.heading })),
          score: { ...w.score },
        });
      },
    });
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch { /* gone */ }
    await server.close();
  }
}

async function main(): Promise<void> {
  for (let seed = 1; seed <= SEEDS; seed++) {
    process.stdout.write(`seed ${seed}... `);
    await playSeed(seed);
    console.log('done');
  }
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n'));
  console.log(`wrote ${rows.length} rows -> ${OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});