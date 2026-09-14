/**
 * Why does a keeper that is holding the ball, lined up on a striker that is
 * standing still facing it, never actually fire?
 *
 * Watches every tick the keeper spends in PASS/TURN_TO_PASS with the ball
 * held, and records each gate the kick has to clear, measured from the world
 * rather than from inside the program: the heading error onto the team mate,
 * how far the ray misses by, the range it would travel, and whether the
 * striker was saying `ready` at the time. A stand-off shows up as a long run
 * of ticks where one and only one of those is false.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Match } from '../src/match';
import { MatchServer } from '../src/server';
import { referenceTeam } from '../src/reference';
import { waitForSeats } from '../src/bench';

const RANGE = (process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '1-3')
  .split('-')
  .map(Number);
const FIRST = RANGE[0]!;
const LAST = RANGE[1] ?? FIRST;

interface Tick {
  seed: number;
  clock: number;
  intent: string;
  ready: boolean;
  relayed: boolean;      // striker's position was on the wire
  err: number;           // heading error onto the true striker, rad
  relErr: number;        // heading error onto the relayed striker, rad
  miss: number;          // how far the ray passes from the true striker, mm
  relMiss: number;       // ... from the relayed striker
  reach: number;         // range along the ray to closest approach, mm
  gap: number;           // true keeper-striker distance
  kicked: boolean;
  advance: number;       // striker depth - keeper depth, the >250 gate
}
const ticks: Tick[] = [];

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

const server = new MatchServer({ port: 0, realtime: false, idealSensors: false });
const port = await server.listen();
const url = `ws://localhost:${port}/agent`;
const child = spawn(`python3 ${resolve('python/examples/play.py')} --only violet --url ${url}`, {
  shell: true,
  stdio: ['ignore', 'ignore', openSync('/tmp/claude-1000/-home-marc-programming-typescript-rcja-soccer-sim/618e7f65-14ba-45ff-bc82-d88b7cde92ae/scratchpad/trace.log', 'w')],
  detached: true,
  env: { ...process.env, PASS_TRACE: '1' },
});

try {
  await waitForSeats(server, ['violet-1', 'violet-2'], 30);
  for (let seed = FIRST; seed <= LAST; seed++) {
    await server.play({
      agents: referenceTeam('lime') as never,
      transports: server.agents.transports(),
      halfSeconds: 90,
      seed,
      observe: (m: Match) => {
        const w = m.world;
        if (!w.running) return;
        const keeper = w.robots.find((r) => r.id === 'violet-2');
        const striker = w.robots.find((r) => r.id === 'violet-1');
        if (!keeper || !striker) return;
        const kSay = m.actuators['violet-2']?.say as
          | { intent?: string; held?: boolean; pos?: number[] | null }
          | undefined;
        const sSay = m.actuators['violet-1']?.say as
          | { ready?: boolean; pos?: number[] | null }
          | undefined;
        if (!kSay?.held) return;
        const intent = kSay.intent ?? '';
        if (intent !== 'PASS' && intent !== 'TURN_TO_PASS') return;

        const dx = Math.cos(keeper.heading);
        const dz = Math.sin(keeper.heading);
        const ray = (tx: number, tz: number) => {
          const t = (tx - keeper.x) * dx + (tz - keeper.z) * dz;
          const miss = Math.hypot(keeper.x + dx * t - tx, keeper.z + dz * t - tz);
          return { t, miss };
        };
        const truth = ray(striker.x, striker.z);
        const relayed = Array.isArray(sSay?.pos) ? (sSay!.pos as number[]) : null;
        const rel = relayed ? ray(relayed[0]!, relayed[1]!) : { t: NaN, miss: NaN };

        // Violet attacks +x in this rig unless the ends swapped; depth from own
        // goal is measured the same way for both robots, so the difference is
        // what the keeper's `> 250` advance gate sees.
        const up = w.robots.find((r) => r.id === 'violet-1') ? 1 : 1;
        const depth = (x: number) => (up > 0 ? x + 915 : 915 - x);

        ticks.push({
          seed,
          clock: w.clock,
          intent,
          ready: sSay?.ready === true,
          relayed: relayed !== null,
          err: Math.abs(wrap(Math.atan2(striker.z - keeper.z, striker.x - keeper.x) - keeper.heading)),
          relErr: relayed
            ? Math.abs(wrap(Math.atan2(relayed[1]! - keeper.z, relayed[0]! - keeper.x) - keeper.heading))
            : NaN,
          miss: truth.miss,
          relMiss: rel.miss,
          reach: truth.t,
          gap: Math.hypot(striker.x - keeper.x, striker.z - keeper.z),
          kicked: m.actuators['violet-2']?.kicker === true,
          advance: depth(striker.x) - depth(keeper.x),
        });
      },
    });
    console.error(`  seed ${seed} done (${ticks.filter((t) => t.seed === seed).length} pass ticks)`);
  }
} finally {
  if (child.pid) process.kill(-child.pid, 'SIGTERM');
  await server.close();
}

const n = ticks.length;
console.log(`\n  ${n} ticks with the keeper holding and trying to pass\n`);
if (n === 0) process.exit(0);

const pct = (f: (t: Tick) => boolean) =>
  `${((100 * ticks.filter(f).length) / n).toFixed(1)}%`.padStart(7);
console.log(`  intent PASS            ${pct((t) => t.intent === 'PASS')}`);
console.log(`  striker said ready     ${pct((t) => t.ready)}`);
console.log(`  striker pos relayed    ${pct((t) => t.relayed)}`);
console.log(`  heading within 140mm   ${pct((t) => t.miss <= 140)}   (on the true striker)`);
console.log(`  relayed within 140mm   ${pct((t) => t.relMiss <= 140)}`);
console.log(`  range in [250,1100]    ${pct((t) => t.reach >= 250 && t.reach <= 1100)}`);
console.log(`  kicker fired           ${pct((t) => t.kicked)}`);

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? NaN;
};
const col = (label: string, xs: number[], f = 0) =>
  console.log(
    `  ${label.padEnd(22)} ${q(xs, 0.1).toFixed(f).padStart(8)} ${q(xs, 0.5).toFixed(f).padStart(8)} ${q(xs, 0.9).toFixed(f).padStart(8)}`,
  );
console.log(`\n  ${''.padEnd(22)} ${'p10'.padStart(8)} ${'p50'.padStart(8)} ${'p90'.padStart(8)}`);
col('heading error, deg', ticks.map((t) => (t.err * 180) / Math.PI), 1);
col('relayed err, deg', ticks.filter((t) => t.relayed).map((t) => (t.relErr * 180) / Math.PI), 1);
col('miss, mm', ticks.map((t) => t.miss));
col('relayed miss, mm', ticks.filter((t) => t.relayed).map((t) => t.relMiss));
col('reach, mm', ticks.map((t) => t.reach));
col('true gap, mm', ticks.map((t) => t.gap));
col('advance, mm', ticks.map((t) => t.advance));

// Stand-offs: runs of consecutive ticks, and what was false throughout.
let runs: Tick[][] = [];
let run: Tick[] = [];
for (const t of ticks) {
  const last = run[run.length - 1];
  if (last && t.seed === last.seed && t.clock - last.clock < 0.05) run.push(t);
  else {
    if (run.length) runs.push(run);
    run = [t];
  }
}
if (run.length) runs.push(run);
runs.sort((a, b) => b.length - a.length);
console.log(`\n  ${runs.length} stand-offs; longest:`);
for (const r of runs.slice(0, 6)) {
  const secs = r[r.length - 1]!.clock - r[0]!.clock;
  const fired = r.some((t) => t.kicked);
  console.log(
    `   seed ${r[0]!.seed} at ${r[0]!.clock.toFixed(1)}s for ${secs.toFixed(1)}s` +
      `  ready ${((100 * r.filter((t) => t.ready).length) / r.length).toFixed(0)}%` +
      `  aimed ${((100 * r.filter((t) => t.relMiss <= 140).length) / r.length).toFixed(0)}%` +
      `  in range ${((100 * r.filter((t) => t.reach >= 250 && t.reach <= 1100).length) / r.length).toFixed(0)}%` +
      `  ${fired ? 'FIRED' : 'never fired'}`,
  );
}
