/**
 * What is a keeper's possession actually worth?
 *
 * The keeper's outlet - pass it, clear it, or carry it - is only worth arguing
 * about if the keeper wins the ball often enough for the answer to matter, and
 * only worth changing if the present answer is losing it. This counts both:
 * how often the keeper takes control, and who has the ball two seconds after
 * it lets go.
 *
 * Ownership is the nearest robot inside a contact gap of the ball, which is
 * the same thing the dribbler is doing; it is not the bench's "possession"
 * percentage, which is a sampled proportion rather than an event.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Match } from '../src/match';
import { MatchServer } from '../src/server';
import { referenceTeam } from '../src/reference';
import { waitForSeats } from '../src/bench';

const RANGE = (process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '1-6')
  .split('-')
  .map(Number);
const FIRST = RANGE[0]!;
const LAST = RANGE[1] ?? FIRST;
const CONTACT = 40;     // mm of clear air between shells and ball
const SETTLE = 2.0;     // seconds after the keeper lets go

interface Episode {
  seed: number;
  start: number;
  end: number;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  after: string;        // who had it SETTLE seconds later
  restart: boolean;     // play stopped in between (goal, out, restart)
}
const episodes: Episode[] = [];
let holds = 0;

const server = new MatchServer({ port: 0, realtime: false, idealSensors: false });
const port = await server.listen();
const url = `ws://localhost:${port}/agent`;
// `--src` points at another `python/` tree, so the same measurement can be
// taken of a variant without editing the working tree out from under it.
const SRC = process.argv.find((a) => a.startsWith('--src='))?.split('=')[1] ?? 'python';
const child = spawn(`python3 ${resolve(SRC, 'examples/play.py')} --only violet --url ${url}`, {
  shell: true,
  stdio: 'ignore',
  detached: true,
});

try {
  await waitForSeats(server, ['violet-1', 'violet-2'], 30);
  for (let seed = FIRST; seed <= LAST; seed++) {
    let owner: string | null = null;
    let open: Episode | null = null;
    const pending: { ep: Episode; at: number }[] = [];
    let wasRunning = true;

    await server.play({
      agents: referenceTeam('lime') as never,
      transports: server.agents.transports(),
      halfSeconds: 180,
      seed,
      observe: (m: Match) => {
        const w = m.world;
        const now = w.clock;
        if (!w.running) {
          wasRunning = false;
          return;
        }
        const ball = w.ball;
        let near: string | null = null;
        let best = Infinity;
        for (const r of w.robots) {
          if (r.removed) continue;
          const d = Math.hypot(r.x - ball.x, r.z - ball.z) - r.radius - ball.radius;
          if (d < CONTACT && d < best) {
            best = d;
            near = r.id;
          }
        }
        if (near) owner = near;

        // Settle any episode that has aged enough to be judged.
        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i]!;
          if (now - p.at < SETTLE) continue;
          p.ep.after = owner ?? 'loose';
          if (!wasRunning) p.ep.restart = true;
          episodes.push(p.ep);
          pending.splice(i, 1);
        }

        if (near === 'violet-2') {
          if (!open) {
            holds++;
            open = { seed, start: now, end: now, startX: ball.x, startZ: ball.z, endX: ball.x, endZ: ball.z, after: '', restart: false };
          }
          open.end = now;
          open.endX = ball.x;
          open.endZ = ball.z;
        } else if (open && near && near !== 'violet-2') {
          pending.push({ ep: open, at: now });
          wasRunning = true;
          open = null;
        }
      },
    });
    console.error(`  seed ${seed}: ${episodes.filter((e) => e.seed === seed).length} keeper possessions`);
  }
} finally {
  if (child.pid) process.kill(-child.pid, 'SIGTERM');
  await server.close();
}

const seeds = LAST - FIRST + 1;
const n = episodes.length;
console.log(`\n  ${holds} keeper possessions over ${seeds} matches — ${(holds / seeds).toFixed(1)} a match`);
console.log(`  ${n} of them judged two seconds after the keeper lost contact:\n`);

const rows = new Map<string, number>();
for (const e of episodes) {
  const who =
    e.after === 'violet-1' ? 'team mate (the striker)'
    : e.after === 'violet-2' ? 'the keeper again'
    : e.after === 'loose' ? 'nobody — loose ball'
    : 'an opponent';
  rows.set(who, (rows.get(who) ?? 0) + 1);
}
for (const [who, count] of [...rows].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${who.padEnd(26)} ${String(count).padStart(4)}  ${((100 * count) / n).toFixed(0).padStart(3)}%`);
}

// A touch is not a possession. Split by how long the keeper actually had it:
// under a tenth of a second is a block or a deflection and there was never a
// decision to make; past half a second the dribbler has it and the outlet -
// pass, clear or carry - is a choice the program made.
console.log(`\n  by how long the keeper had it:`);
console.log(`  ${'hold'.padEnd(14)} ${'n'.padStart(5)} ${'opponent'.padStart(9)} ${'mate'.padStart(7)} ${'keeper'.padStart(7)} ${'loose'.padStart(7)}`);
for (const [lo, hi, label] of [[0, 0.1, 'deflection'], [0.1, 0.5, '0.1-0.5s'], [0.5, 99, 'over 0.5s']] as const) {
  const band = episodes.filter((e) => e.end - e.start >= lo && e.end - e.start < hi);
  if (band.length === 0) continue;
  const share = (who: string) =>
    `${((100 * band.filter((e) => e.after === who).length) / band.length).toFixed(0)}%`;
  const opp = `${((100 * band.filter((e) => e.after !== 'violet-1' && e.after !== 'violet-2' && e.after !== 'loose').length) / band.length).toFixed(0)}%`;
  console.log(
    `  ${label.padEnd(14)} ${String(band.length).padStart(5)} ${opp.padStart(9)} ${share('violet-1').padStart(7)} ${share('violet-2').padStart(7)} ${share('loose').padStart(7)}`,
  );
}

const held = episodes.map((e) => e.end - e.start).sort((a, b) => a - b);
// Total distance the ball moved while the keeper had it, not just along the
// field: the carry is mostly ACROSS the box, so an x-only measure reads zero
// for a keeper that has moved the ball 400 mm to the corner.
const advance = episodes
  .filter((e) => e.end - e.start >= 0.5)
  .map((e) => Math.hypot(e.endX - e.startX, e.endZ - e.startZ));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`\n  median time on the ball  ${(held[Math.floor(held.length / 2)] ?? 0).toFixed(2)}s`);
console.log(`  longest                  ${(held[held.length - 1] ?? 0).toFixed(2)}s`);
console.log(`  mean carry, holds >0.5s  ${mean(advance).toFixed(0)} mm`);
console.log(`  restart in the window    ${episodes.filter((e) => e.restart).length}`);
