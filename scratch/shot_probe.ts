// What happens to the strikers' shots. For every kick by a *-1 robot (kick-offs
// excluded): where the heading pointed, where the ball actually went, whether the
// opposing keeper was already standing in the ball's path at the moment it was
// fired, and what the ball touched first before it scored, went out or stopped.
//
// The bench's "blkd-out" is an inference - on target by heading, then out - and
// this is the direct measurement behind it.
//
//   bun scratch/shot_probe.ts <violet-tree> <lime-tree> [seeds=1-6] [half=120]
import { spawn } from 'node:child_process';
import { MatchServer } from '../packages/server/src/infra/server';
import { referenceTeam } from '../packages/server/src/infra/reference';
import { waitForSeats } from '../packages/server/src/league/bench';
import type { MatchAgents } from '../packages/server/src/match/match';

const HALF_LENGTH = 915;
const HALF_WIDTH = 610;
const POST = 225;

const [violetTree, limeTree] = [process.argv[2]!, process.argv[3]!];
const [s0, s1] = (process.argv[4] ?? '1-6').split('-').map(Number);
const half = Number(process.argv[5] ?? 120);

const server = new MatchServer({ port: 0, realtime: false });
const port = await server.listen();
const url = `ws://localhost:${port}/agent`;
const child = spawn(
  `python3 scratch/duel.py --violet-src ${violetTree} --lime-src ${limeTree} --url ${url}`,
  { shell: true, stdio: 'ignore', detached: true },
);
await waitForSeats(server, ['violet-1', 'violet-2', 'lime-1', 'lime-2'], 30);

interface Shot {
  by: string;
  at: number;
  range: number;            // distance to the goal line along the ball's path
  headZ: number;            // where the heading crosses the goal line
  ballZ: number;            // where the ball's velocity crosses it
  launchErr: number;        // degrees between heading and ball velocity
  robotSpeed: number;
  sideSpeed: number;        // robot velocity across its heading
  keeperInPath: boolean;    // opposing keeper centre within reach of the path at launch
  keeperLateral: number;    // keeper's distance from the path, mm
  keeperDepth: number;      // keeper's distance ahead of the ball along the path
  touched: string | null;   // first robot the ball met after leaving
  outcome?: string;
}

const shots: Shot[] = [];
let live: Shot | null = null;
let prevSpeed = 0;
const deg = (a: number) => (a * 180) / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function crossing(x: number, z: number, dx: number, dz: number): { range: number; z: number } {
  if (Math.abs(dx) < 0.08) return { range: NaN, z: NaN };
  const goalX = dx > 0 ? HALF_LENGTH : -HALF_LENGTH;
  const t = (goalX - x) / dx;
  return t > 0 ? { range: t, z: z + dz * t } : { range: NaN, z: NaN };
}

try {
  for (let seed = s0!; seed <= s1!; seed++) {
    let scored = { violet: 0, lime: 0 };
    live = null;
    const result = await server.play({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
      transports: server.agents.transports(),
      halfSeconds: half,
      seed,
      mercyMargin: null,
      observe: (m) => {
        const w = m.world as any;
        const ball = w.ball;
        const speed = Math.hypot(ball.vx, ball.vz);
        const score = w.score;

        if (live) {
          const done = (outcome: string) => { live!.outcome = outcome; shots.push(live!); live = null; };
          const team = live.by.split('-')[0] as 'violet' | 'lime';
          if (score[team] > scored[team]) done('goal');
          else if (w.ballAway || Math.abs(ball.x) > HALF_LENGTH + 30 || Math.abs(ball.z) > HALF_WIDTH + 30) {
            done(Math.abs(ball.z) < POST && Math.abs(ball.x) > HALF_LENGTH ? 'mouth-no-goal' : 'out');
          } else if (speed < 250) done('stopped');
          else if (w.clock - live.at > 3) done('stopped');
          else if (!live.touched) {
            for (const r of w.robots) {
              if (r.removed) continue;
              if (r.id === live.by && w.clock - live.at < 0.15) continue;
              const gap = Math.hypot(ball.x - r.x, ball.z - r.z) - r.radius - ball.radius;
              if (gap < 6) { live.touched = r.id; break; }
            }
          }
        }
        scored = { violet: score.violet, lime: score.lime };

        if (speed > 2000 && prevSpeed < 1500 && Math.hypot(ball.x, ball.z) > 150) {
          let by: any = null;
          let best = Infinity;
          for (const r of w.robots) {
            if (r.removed) continue;
            const g = Math.hypot(ball.x - r.x, ball.z - r.z);
            if (g < best) { best = g; by = r; }
          }
          if (by && by.id.endsWith('-1')) {
            if (live) { live.outcome = 'superseded'; shots.push(live); }
            const h = crossing(ball.x, ball.z, Math.cos(by.heading), Math.sin(by.heading));
            const ux = ball.vx / speed, uz = ball.vz / speed;
            const b = crossing(ball.x, ball.z, ux, uz);
            const side = -by.vx * Math.sin(by.heading) + by.vz * Math.cos(by.heading);
            const other = by.id.startsWith('violet') ? 'lime-2' : 'violet-2';
            const k = w.robots.find((r: any) => r.id === other && !r.removed);
            let lateral = NaN, depth = NaN, inPath = false;
            if (k) {
              const rx = k.x - ball.x, rz = k.z - ball.z;
              depth = rx * ux + rz * uz;
              lateral = Math.abs(-rx * uz + rz * ux);
              inPath = depth > 0 && lateral < k.radius + ball.radius;
            }
            live = {
              by: by.id, at: w.clock, range: b.range, headZ: h.z, ballZ: b.z,
              launchErr: deg(Math.abs(wrap(Math.atan2(uz, ux) - by.heading))),
              robotSpeed: Math.hypot(by.vx, by.vz), sideSpeed: side,
              keeperInPath: inPath, keeperLateral: lateral, keeperDepth: depth, touched: null,
            };
          }
        }
        prevSpeed = speed;
      },
    });
    console.error(`seed ${seed}: ${result.score.violet}-${result.score.lime}`);
  }

  const onTarget = (z: number) => Math.abs(z) < POST - 21;
  const med = (a: number[]) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)]! : NaN; };
  const pct = (n: number, d: number) => `${n} (${((100 * n) / Math.max(d, 1)).toFixed(0)}%)`;
  const count = (xs: Shot[], f: (s: Shot) => boolean) => xs.filter(f).length;

  const heads = shots.filter((s) => onTarget(s.headZ));
  console.log(`\nstriker kicks ${shots.length}, on target by heading ${heads.length}, by ball path ${count(shots, (s) => onTarget(s.ballZ))}`);
  console.log(`launch error heading->ball path: median ${med(shots.map((s) => s.launchErr)).toFixed(1)} deg, p90 ${(() => { const a = shots.map((s) => s.launchErr).sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)]?.toFixed(1); })()}`);
  console.log(`on-target-by-heading shots whose BALL path was off target: ${pct(count(heads, (s) => !onTarget(s.ballZ)), heads.length)}`);

  const outcomes = (xs: Shot[]) => {
    const m: Record<string, number> = {};
    for (const s of xs) m[s.outcome!] = (m[s.outcome!] ?? 0) + 1;
    return Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
  };
  console.log(`\noutcomes, on target by heading: ${outcomes(heads)}`);
  const blocked = heads.filter((s) => s.outcome === 'out');
  console.log(`\n"blocked-out" (on target by heading, then out): ${blocked.length}`);
  const touch = (xs: Shot[]) => {
    const m: Record<string, number> = {};
    for (const s of xs) {
      const who = s.touched == null ? 'nothing' : s.touched === s.by ? 'shooter' : s.touched.split('-')[0] === s.by.split('-')[0] ? 'own keeper' : s.touched.endsWith('-2') ? 'their keeper' : 'their striker';
      m[who] = (m[who] ?? 0) + 1;
    }
    return Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
  };
  console.log(`   first touched: ${touch(blocked)}`);
  console.log(`   ball path on target too: ${pct(count(blocked, (s) => onTarget(s.ballZ)), blocked.length)}`);
  console.log(`   their keeper already in the ball's path at launch: ${pct(count(blocked, (s) => s.keeperInPath), blocked.length)}`);
  console.log(`   range median ${med(blocked.map((s) => s.range)).toFixed(0)} mm`);

  console.log(`\nby range (on target by heading):`);
  for (const [lo, hi] of [[0, 400], [400, 600], [600, 800], [800, 1000], [1000, 1400]]) {
    const xs = heads.filter((s) => s.range >= lo! && s.range < hi!);
    console.log(`   ${String(lo).padStart(4)}-${String(hi).padEnd(4)} n=${String(xs.length).padEnd(4)} goal ${pct(count(xs, (s) => s.outcome === 'goal'), xs.length).padEnd(9)} keeper-in-path ${pct(count(xs, (s) => s.keeperInPath), xs.length).padEnd(9)} out ${pct(count(xs, (s) => s.outcome === 'out'), xs.length)}`);
  }
  console.log(`\nkeeper in path at launch vs not (on target by heading):`);
  for (const inPath of [true, false]) {
    const xs = heads.filter((s) => s.keeperInPath === inPath);
    console.log(`   ${inPath ? 'in path    ' : 'not in path'} n=${xs.length}: ${outcomes(xs)}`);
  }
  console.log(`\noff target by heading: ${shots.length - heads.length}: ${outcomes(shots.filter((s) => !onTarget(s.headZ)))}`);
  console.log(`robot speed at kick median ${med(shots.map((s) => s.robotSpeed)).toFixed(0)} mm/s, |side| median ${med(shots.map((s) => Math.abs(s.sideSpeed))).toFixed(0)}`);
} finally {
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
  await server.close?.();
  process.exit(0);
}
