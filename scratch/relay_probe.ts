/**
 * Is projecting a relayed ball sighting forward better than using it as sent?
 *
 * `teammate_ball` now carries a relayed sighting forward by the age of the
 * packet it arrived in, using the velocity the sender put on the wire. That is
 * obviously right while the ball is rolling freely and obviously wrong the
 * moment it bounces: a ball that hit a wall or a robot since the sighting is
 * not where the old velocity says it is, and a confident wrong answer is worse
 * than an honestly stale one.
 *
 * Which of those dominates is a question about the ball, not about the code, so
 * it is measured rather than argued. This reconstructs exactly what a receiving
 * robot sees - the freshest packet from its team mate inside the link's 0.4 s
 * memory, and that packet's age - and scores both readings against where the
 * ball actually is at the moment of reading.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Match } from '../src/match';
import { MatchServer } from '../src/server';
import { referenceTeam } from '../src/reference';
import { waitForSeats, partnerId } from '../src/bench';

const RANGE = (process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '1-3')
  .split('-')
  .map(Number);
const FIRST = RANGE[0]!;
const LAST = RANGE[1] ?? FIRST;
/** The link's own staleness window, from src/perception.ts. */
const MESSAGE_TTL = 0.4;

interface Sent {
  at: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
}
const outbox = new Map<string, Sent[]>();
const raw: number[] = [];
const projected: number[] = [];
let byAge: { age: number; raw: number; projected: number }[] = [];

const server = new MatchServer({ port: 0, realtime: false, idealSensors: false });
const port = await server.listen();
const url = `ws://localhost:${port}/agent`;
const child = spawn(`python3 ${resolve('python/examples/play.py')} --only violet --url ${url}`, {
  shell: true,
  stdio: 'ignore',
  detached: true,
});

try {
  await waitForSeats(server, ['violet-1', 'violet-2'], 30);
  for (let seed = FIRST; seed <= LAST; seed++) {
    outbox.clear();
    await server.play({
      agents: referenceTeam('lime') as never,
      transports: server.agents.transports(),
      halfSeconds: 90,
      seed,
      observe: (m: Match) => {
        const w = m.world;
        if (!w.running) return;
        const now = w.clock;
        const ball = w.ball;

        // What each robot put on the wire this tick, kept with its timestamp
        // so a reader can be given exactly what the link would have handed it.
        for (const id of ['violet-1', 'violet-2']) {
          const said = m.actuators[id]?.say as { ball?: number[] | null } | undefined;
          const spot = said?.ball;
          if (!Array.isArray(spot) || spot.length < 4) continue;
          const list = outbox.get(id) ?? [];
          list.push({ at: now, x: spot[0]!, z: spot[1]!, vx: spot[2]!, vz: spot[3]! });
          while (list.length > 0 && now - list[0]!.at > MESSAGE_TTL) list.shift();
          outbox.set(id, list);
        }

        // And what each robot would read from its partner right now: the
        // freshest packet still inside the window, which is what the fixed
        // `_teammate_said` picks.
        for (const id of ['violet-1', 'violet-2']) {
          const list = outbox.get(partnerId(id)) ?? [];
          const packet = list[list.length - 1];
          if (!packet) continue;
          const age = now - packet.at;
          const rawErr = Math.hypot(packet.x - ball.x, packet.z - ball.z);
          const projErr = Math.hypot(
            packet.x + packet.vx * age - ball.x,
            packet.z + packet.vz * age - ball.z,
          );
          raw.push(rawErr);
          projected.push(projErr);
          byAge.push({ age, raw: rawErr, projected: projErr });
        }
      },
    });
    console.error(`  seed ${seed} done`);
  }
} finally {
  if (child.pid) process.kill(-child.pid, 'SIGTERM');
  await server.close();
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const pct90 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.9)] ?? 0;
};

console.log(`\n  ${raw.length} relayed readings\n`);
console.log(`  ${'error, mm'.padEnd(16)} ${'as sent'.padStart(9)} ${'projected'.padStart(10)}`);
console.log(`  ${'mean'.padEnd(16)} ${mean(raw).toFixed(0).padStart(9)} ${mean(projected).toFixed(0).padStart(10)}`);
console.log(`  ${'median'.padEnd(16)} ${median(raw).toFixed(0).padStart(9)} ${median(projected).toFixed(0).padStart(10)}`);
console.log(`  ${'90th pct'.padEnd(16)} ${pct90(raw).toFixed(0).padStart(9)} ${pct90(projected).toFixed(0).padStart(10)}`);

console.log(`\n  by packet age:`);
console.log(`  ${'age, ms'.padEnd(16)} ${'as sent'.padStart(9)} ${'projected'.padStart(10)} ${'n'.padStart(8)}`);
for (const [lo, hi] of [[0, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.4]] as const) {
  const band = byAge.filter((r) => r.age >= lo && r.age < hi);
  if (band.length === 0) continue;
  console.log(
    `  ${`${lo * 1000}-${hi * 1000}`.padEnd(16)} ${mean(band.map((r) => r.raw)).toFixed(0).padStart(9)}` +
      ` ${mean(band.map((r) => r.projected)).toFixed(0).padStart(10)} ${String(band.length).padStart(8)}`,
  );
}
