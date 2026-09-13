/**
 * Why does the ball go out, and was anyone holding it when it did?
 *
 * `bench` says which robot touched the ball last before it left the playing
 * area, which is enough to know who is giving possession away and not enough to
 * know what to change. A ball dribbled over a touchline and a ball fired at one
 * are the same row in that table, and they have opposite fixes.
 *
 * So this classifies every out-of-play by what the last toucher was actually
 * doing at the moment of the last touch: holding the ball against the dribbler
 * (a carry), or merely in contact with it (a push), or neither because the ball
 * was already travelling fast when it left (a kick).
 *
 * Two seeds by default, and the robots are spawned once for all of them the way
 * the bench does rather than restarted per seed. What is wanted here is the
 * ratio between the three causes, not a precise per-match rate, and the ratio
 * settles long before the rate does.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Match } from '../src/match';
import { MatchServer } from '../src/server';
import { referenceTeam } from '../src/reference';
import { waitForSeats } from '../src/bench';
import { HALF_WIDTH } from '../src/field';

const RANGE = (process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '1-2')
  .split('-')
  .map(Number);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '90', 10);
const FIRST = RANGE[0]!;
const LAST = RANGE[1] ?? FIRST;

interface Row {
  by: string;
  kind: 'carry' | 'push' | 'kick';
  line: 'side' | 'end';
}
const rows: Row[] = [];

const server = new MatchServer({ port: 0, realtime: false, idealSensors: false });
const port = await server.listen();
const url = `ws://localhost:${port}/agent`;
const child = spawn(`python3 ${resolve('python/examples/play.py')} --only violet --url ${url}`, {
  shell: true,
  stdio: 'ignore',
  detached: true,
});

try {
  // Not `whenReady()`: that waits for all four seats, and only the two under
  // test are being spawned here - the other two are the built-in reference.
  await waitForSeats(server, ['violet-1', 'violet-2'], 30);
  for (let seed = FIRST; seed <= LAST; seed++) {
    let lastTouch: { id: string; held: boolean; speed: number } | null = null;
    // Where the ball was on the previous tick. The referee resolves an out and
    // moves the ball to a neutral point inside the same step, so by the time an
    // observer runs the ball is already back in play - the position that says
    // which line it crossed is the one from the tick before.
    let prevBall = { x: 0, z: 0 };
    const seen = new Set<unknown>();
    await server.play({
      // The bench's own configuration: the programs under test on violet, the
      // reference agent on lime, so the numbers compare to a bench run.
      agents: referenceTeam('lime') as never,
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed,
      observe: (m: Match) => {
        const w = m.world;
        if (!w.running) return;
        const ball = w.ball;
        const speed = Math.hypot(ball.vx, ball.vz);

        for (const robot of w.robots) {
          if (robot.removed) continue;
          const gap = Math.hypot(ball.x - robot.x, ball.z - robot.z);
          if (gap > robot.radius + ball.radius + 12) continue;
          // Same test the bench uses for possession: in contact and with the
          // ball inside the dribbler's arc rather than glancing off a flank.
          const bearing = Math.atan2(ball.z - robot.z, ball.x - robot.x) - robot.heading;
          const arc = Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing)));
          lastTouch = { id: robot.id, held: arc < 0.6, speed };
        }

        // The referee's own call, rather than a position test of our own: it
        // already knows a ball on its way into the goal is not out of play
        // (rule 5.9.1), and counting a goal as an out-of-play would inflate a
        // striker's figure by roughly the number of goals it scores.
        for (const event of w.events) {
          if (seen.has(event)) continue;
          seen.add(event);
          if (event.kind !== 'ball-out-of-play' || !lastTouch) continue;
          rows.push({
            by: lastTouch.id,
            // A ball already moving at better than two metres a second when it
            // was last touched left on a kick, whatever the contact looked like.
            kind: lastTouch.speed > 2000 ? 'kick' : lastTouch.held ? 'carry' : 'push',
            line: Math.abs(prevBall.z) > HALF_WIDTH ? 'side' : 'end',
          });
        }
        prevBall = { x: ball.x, z: ball.z };
      },
    });
    console.error(`  seed ${seed} done`);
  }
} finally {
  if (child.pid) process.kill(-child.pid, 'SIGTERM');
  await server.close();
}

const matches = LAST - FIRST + 1;
const ids = [...new Set(rows.map((r) => r.by))].sort();
console.log(`\n  ${matches} matches, ${rows.length} out-of-plays (${(rows.length / matches).toFixed(1)} per match)\n`);
console.log(`  ${'robot'.padEnd(10)} ${'carry'.padStart(7)} ${'push'.padStart(7)} ${'kick'.padStart(7)} ${'side'.padStart(7)} ${'end'.padStart(7)}`);
for (const id of ids) {
  const mine = rows.filter((r) => r.by === id);
  const n = (f: (r: Row) => boolean): string => (mine.filter(f).length / matches).toFixed(1).padStart(7);
  console.log(
    `  ${id.padEnd(10)} ${n((r) => r.kind === 'carry')} ${n((r) => r.kind === 'push')} ${n((r) => r.kind === 'kick')} ${n((r) => r.line === 'side')} ${n((r) => r.line === 'end')}`,
  );
}
