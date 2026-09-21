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
  keeperMargin: number;     // how far the keeper must move across to block, mm (<=0: already blocking)
  keeperToward: number;     // keeper speed towards the path at launch, mm/s (negative: moving away)
  touched: string | null;   // first robot the ball met after leaving
  outcome?: string;
}

const shots: Shot[] = [];
// A striker's spell on the ball: from first contact until it has been clear of
// the ball for SPELL_GAP seconds, and how that spell ended.
const SPELL_GAP = 0.3;
interface Spell { by: string; start: number; lastContact: number; kicked: boolean; oppTouched: boolean; out: boolean }
const spells: Record<string, Spell | null> = {};
const spellEnds: Record<string, number> = {};
const spellLengths: number[] = [];
const endSpell = (sp: Spell) => {
  const why = sp.kicked ? 'kicked' : sp.out ? 'went out' : sp.oppTouched ? 'opponent took it' : 'loose / other';
  spellEnds[why] = (spellEnds[why] ?? 0) + 1;
  spellLengths.push(sp.lastContact - sp.start);
};
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

        // Possession spells for the strikers.
        const inContact = new Set<string>();
        if (!w.ballAway) {
          for (const r of w.robots) {
            if (r.removed) continue;
            if (Math.hypot(ball.x - r.x, ball.z - r.z) - r.radius - ball.radius < 10) inContact.add(r.id);
          }
        }
        for (const id of ['violet-1', 'lime-1']) {
          const sp = spells[id];
          const team = id.split('-')[0];
          if (sp) {
            if ([...inContact].some((o) => !o.startsWith(team))) sp.oppTouched = true;
            if (w.ballAway) sp.out = true;
            if (inContact.has(id)) sp.lastContact = w.clock;
            else if (w.clock - sp.lastContact > SPELL_GAP || w.ballAway) { endSpell(sp); spells[id] = null; }
          } else if (inContact.has(id)) {
            spells[id] = { by: id, start: w.clock, lastContact: w.clock, kicked: false, oppTouched: false, out: false };
          }
        }

        if (speed > 2000 && prevSpeed < 1500 && Math.hypot(ball.x, ball.z) > 150) {
          let by: any = null;
          let best = Infinity;
          for (const r of w.robots) {
            if (r.removed) continue;
            const g = Math.hypot(ball.x - r.x, ball.z - r.z);
            if (g < best) { best = g; by = r; }
          }
          if (by && spells[by.id]) spells[by.id]!.kicked = true;
          if (by && by.id.endsWith('-1')) {
            if (live) { live.outcome = 'superseded'; shots.push(live); }
            const h = crossing(ball.x, ball.z, Math.cos(by.heading), Math.sin(by.heading));
            const ux = ball.vx / speed, uz = ball.vz / speed;
            const b = crossing(ball.x, ball.z, ux, uz);
            const side = -by.vx * Math.sin(by.heading) + by.vz * Math.cos(by.heading);
            const other = by.id.startsWith('violet') ? 'lime-2' : 'violet-2';
            const k = w.robots.find((r: any) => r.id === other && !r.removed);
            let lateral = NaN, depth = NaN, inPath = false, margin = NaN, toward = NaN;
            if (k) {
              const rx = k.x - ball.x, rz = k.z - ball.z;
              depth = rx * ux + rz * uz;
              const signed = -rx * uz + rz * ux;
              lateral = Math.abs(signed);
              inPath = depth > 0 && lateral < k.radius + ball.radius;
              margin = lateral - k.radius - ball.radius;
              toward = -Math.sign(signed) * (-k.vx * uz + k.vz * ux);
            }
            live = {
              by: by.id, at: w.clock, range: b.range, headZ: h.z, ballZ: b.z,
              launchErr: deg(Math.abs(wrap(Math.atan2(uz, ux) - by.heading))),
              robotSpeed: Math.hypot(by.vx, by.vz), sideSpeed: side,
              keeperInPath: inPath, keeperLateral: lateral, keeperDepth: depth, touched: null,
              keeperMargin: margin, keeperToward: toward,
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
  console.log(`\nwhere on-target-by-path shots cross the line (|z| from goal centre, posts at 225):`);
  const pathOn = shots.filter((s) => onTarget(s.ballZ));
  for (const [lo, hi] of [[0, 60], [60, 120], [120, 160], [160, 204]]) {
    const xs = pathOn.filter((s) => Math.abs(s.ballZ) >= lo! && Math.abs(s.ballZ) < hi!);
    console.log(`   ${String(lo).padStart(3)}-${String(hi).padEnd(3)} n=${String(xs.length).padEnd(4)} goal ${pct(count(xs, (s) => s.outcome === 'goal'), xs.length).padEnd(9)} keeper-in-path ${pct(count(xs, (s) => s.keeperInPath), xs.length)}`);
  }
  console.log(`\noff target by heading: ${shots.length - heads.length}: ${outcomes(shots.filter((s) => !onTarget(s.headZ)))}`);
  console.log(`robot speed at kick median ${med(shots.map((s) => s.robotSpeed)).toFixed(0)} mm/s, |side| median ${med(shots.map((s) => Math.abs(s.sideSpeed))).toFixed(0)}`);

  console.log(`\nkeeper motion at launch (on target by ball path, keeper not already blocking):`);
  const open = shots.filter((s) => onTarget(s.ballZ) && s.keeperMargin > 0);
  for (const [lo, hi] of [[0, 60], [60, 120], [120, 200], [200, 999]]) {
    const xs = open.filter((s) => s.keeperMargin >= lo! && s.keeperMargin < hi!);
    console.log(`   must travel ${String(lo).padStart(3)}-${String(hi).padEnd(3)} mm  n=${String(xs.length).padEnd(4)} goal ${pct(count(xs, (s) => s.outcome === 'goal'), xs.length)}`);
  }
  for (const [label, f] of [['moving away (< -100 mm/s)', (v: number) => v < -100], ['still (+-100)', (v: number) => Math.abs(v) <= 100], ['moving toward (> 100)', (v: number) => v > 100]] as const) {
    const xs = open.filter((s) => f(s.keeperToward));
    console.log(`   keeper ${label.padEnd(26)} n=${String(xs.length).padEnd(4)} goal ${pct(count(xs, (s) => s.outcome === 'goal'), xs.length)}`);
  }

  const total = Object.values(spellEnds).reduce((a, b) => a + b, 0);
  const matches = (s1! - s0! + 1);
  console.log(`\nstriker spells on the ball: ${total} (${(total / matches / 2).toFixed(1)} per striker per match), median ${med(spellLengths).toFixed(2)} s`);
  for (const [k, v] of Object.entries(spellEnds).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(18)} ${pct(v, total)}`);
} finally {
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
  await server.close?.();
  process.exit(0);
}
