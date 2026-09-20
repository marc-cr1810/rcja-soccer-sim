import { describe, expect, test } from 'bun:test';
import { runSimBenchmark, formatSimBenchTable } from '../../src/league/sim-bench';

describe('Headless Concurrency Benchmark (sim-bench)', () => {
  test('runSimBenchmark executes parallel matches and measures throughput', async () => {
    const rows = await runSimBenchmark({
      matches: [1, 2],
      seconds: 1,
      league: 'open',
      idealSensors: true,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.concurrentMatches).toBe(1);
    expect(rows[0]!.simulatedSeconds).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.speedup).toBeGreaterThan(0);
    expect(rows[0]!.ticksPerSec).toBeGreaterThan(0);

    expect(rows[1]!.concurrentMatches).toBe(2);
    expect(rows[1]!.simulatedSeconds).toBeGreaterThanOrEqual(2);
    expect(rows[1]!.speedup).toBeGreaterThan(0);

    const table = formatSimBenchTable(rows);
    expect(table).toContain('Headless Concurrency Benchmark');
    expect(table).toContain('Ticks/sec');
    expect(table).toContain('Speedup');
  });
});
