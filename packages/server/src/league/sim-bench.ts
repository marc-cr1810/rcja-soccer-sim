/**
 * Headless Concurrency Benchmark for RCJA Soccer Simulator.
 *
 * Measures raw simulation throughput, ticks/second, and multi-core scaling
 * across 1, 2, 4, 8, ... concurrent matches running in parallel worker threads.
 */

import { resolve } from 'node:path';
import type { LeagueId } from '@rcja/shared/leagues';

export interface SimBenchOptions {
  /** Concurrent match counts to benchmark, e.g. [1, 2, 4, 8]. Default [1, 2, 4, 8]. */
  matches?: number[];
  /** Simulated seconds to run each match. Default 10. */
  seconds?: number;
  /** League ID. Default 'open'. */
  league?: LeagueId;
  /** Ideal sensors (no noise). Default true for raw engine throughput. */
  idealSensors?: boolean;
}

export interface SimBenchRow {
  concurrentMatches: number;
  simulatedSeconds: number;
  elapsedSeconds: number;
  speedup: number;
  ticksPerSec: number;
  rssMb: number;
}

/** Runs a single match in a Bun.Worker thread and waits for completion. */
function runWorkerMatch(
  workerPath: string,
  options: { seconds: number; league: string; seed: number; idealSensors: boolean },
): Promise<{ clock: number; elapsedMs: number }> {
  return new Promise((done, reject) => {
    const worker = new Worker(workerPath);
    worker.onmessage = (event) => {
      const msg = event.data;
      worker.terminate();
      if (msg.ok) {
        done({ clock: msg.clock, elapsedMs: msg.elapsedMs });
      } else {
        reject(new Error(msg.error ?? 'worker match failed'));
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage({ type: 'run', ...options });
  });
}

/** Runs the full concurrency benchmark across the specified match counts. */
export async function runSimBenchmark(opts: SimBenchOptions = {}): Promise<SimBenchRow[]> {
  const counts = opts.matches ?? [1, 2, 4, 8];
  const seconds = opts.seconds ?? 10;
  const league = opts.league ?? 'open';
  const idealSensors = opts.idealSensors ?? true;
  const workerPath = resolve(import.meta.dirname, 'sim-bench-worker.ts');

  const rows: SimBenchRow[] = [];

  for (const count of counts) {
    const t0 = performance.now();
    const tasks: Promise<{ clock: number; elapsedMs: number }>[] = [];

    for (let i = 0; i < count; i++) {
      tasks.push(
        runWorkerMatch(workerPath, {
          seconds,
          league,
          seed: i + 1,
          idealSensors,
        }),
      );
    }

    const results = await Promise.all(tasks);
    const wallElapsedMs = performance.now() - t0;
    const elapsedSeconds = wallElapsedMs / 1000;
    const totalSimulatedSeconds = results.reduce((acc, r) => acc + r.clock, 0);
    const speedup = totalSimulatedSeconds / elapsedSeconds;
    const ticksPerSec = (totalSimulatedSeconds * 100) / elapsedSeconds;
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    rows.push({
      concurrentMatches: count,
      simulatedSeconds: Math.round(totalSimulatedSeconds),
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      speedup: Number(speedup.toFixed(1)),
      ticksPerSec: Math.round(ticksPerSec),
      rssMb,
    });
  }

  return rows;
}

/** Formats the benchmark results as a clean ASCII table. */
export function formatSimBenchTable(rows: SimBenchRow[]): string {
  const lines: string[] = [
    '  RCJA Soccer Simulator — Headless Concurrency Benchmark',
    '  ' + '='.repeat(68),
    '  Matches   Simulated   Elapsed   Speedup   Ticks/sec      RSS Mem',
    '  ' + '-'.repeat(68),
  ];

  for (const row of rows) {
    const m = String(row.concurrentMatches).padStart(7);
    const sim = (row.simulatedSeconds + 's').padStart(11);
    const el = (row.elapsedSeconds.toFixed(2) + 's').padStart(9);
    const sp = (row.speedup.toFixed(1) + 'x').padStart(9);
    const tps = (row.ticksPerSec.toLocaleString() + '/s').padStart(11);
    const rss = (row.rssMb + ' MB').padStart(10);
    lines.push(`  ${m} ${sim} ${el} ${sp} ${tps}   ${rss}`);
  }

  lines.push('  ' + '='.repeat(68));
  return lines.join('\n');
}
