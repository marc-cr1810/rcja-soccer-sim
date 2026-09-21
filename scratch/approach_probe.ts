// How the strikers get to the ball: time to reach it, how square they arrive,
// and how long they dawdle beside it. Plays two python/ trees against each other
// through scratch/duel.py, headless, and measures both violet-1 and lime-1.
//
//   bun scratch/approach_probe.ts <violet-tree> <lime-tree> [seeds=1-4] [half=120]
import { spawn } from 'node:child_process';
import { MatchServer } from '../packages/server/src/infra/server';
import { referenceTeam } from '../packages/server/src/infra/reference';
import { waitForSeats } from '../packages/server/src/league/bench';
import type { MatchAgents } from '../packages/server/src/match/match';

const [violetTree, limeTree] = [process.argv[2]!, process.argv[3]!];
const [s0, s1] = (process.argv[4] ?? '1-4').split('-').map(Number);
const half = Number(process.argv[5] ?? 120);

const server = new MatchServer({ port: 0, realtime: false });
const port = await server.listen();
const url = `ws://localhost:${port}/agent`;
const child = spawn(
  `python3 scratch/duel.py --violet-src ${violetTree} --lime-src ${limeTree} --url ${url}`,
  { shell: true, stdio: 'ignore', detached: true },
);
const seats = ['violet-1', 'violet-2', 'lime-1', 'lime-2'];
await waitForSeats(server, seats, 30);

type Stat = { episodes: number[]; arriveErr: number[]; arriveSpeed: number[]; nearTicks: number; slowNearTicks: number; ticks: number; goals: number };
const stats: Record<string, Stat> = {};
const fresh = (): Stat => ({ episodes: [], arriveErr: [], arriveSpeed: [], nearTicks: 0, slowNearTicks: 0, ticks: 0, goals: 0 });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

try {
  for (let seed = s0!; seed <= s1!; seed++) {
    const ep: Record<string, number | null> = {};
    const result = await server.play({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
      transports: server.agents.transports(),
      halfSeconds: half,
      seed,
      mercyMargin: null,
      observe: (m) => {
        const w = m.world as any;
        if (w.kickOffPending || !w.running) {
          for (const k of Object.keys(ep)) ep[k] = null;
          return;
        }
        for (const r of w.robots) {
          if (!r.id.endsWith('-1') || r.removed) continue;
          const st = (stats[r.id] ??= fresh());
          st.ticks++;
          const gap = Math.hypot(w.ball.x - r.x, w.ball.z - r.z) - r.radius - w.ball.radius;
          const v = Math.hypot(r.vx, r.vz);
          if (gap > 30 && gap < 250) {
            st.nearTicks++;
            if (v < 250) st.slowNearTicks++;
          }
          // An approach starts when the robot is clearly off the ball and ends at contact.
          if (gap > 300 && ep[r.id] == null) ep[r.id] = w.clock;
          if (gap < 8 && ep[r.id] != null) {
            st.episodes.push(w.clock - ep[r.id]!);
            st.arriveErr.push(Math.abs(wrap(Math.atan2(w.ball.z - r.z, w.ball.x - r.x) - r.heading)) * 180 / Math.PI);
            st.arriveSpeed.push(v);
            ep[r.id] = null;
          }
        }
      },
    });
    stats['violet-1'] && (stats['violet-1'].goals += result.score.violet);
    stats['lime-1'] && (stats['lime-1'].goals += result.score.lime);
    console.error(`seed ${seed}: ${result.score.violet}-${result.score.lime}`);
  }
  const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)]! : NaN; };
  const frac = (a: number[], f: (x: number) => boolean) => a.filter(f).length / Math.max(a.length, 1);
  for (const [id, st] of Object.entries(stats)) {
    console.log(
      `${id.padEnd(9)} ${id.startsWith('violet') ? violetTree : limeTree}\n` +
        `   approaches ${st.episodes.length}  median time ${med(st.episodes).toFixed(2)} s\n` +
        `   facing error at contact: median ${med(st.arriveErr).toFixed(0)} deg, within 20 deg ${(100 * frac(st.arriveErr, (x) => x < 20)).toFixed(0)}%\n` +
        `   speed at contact median ${med(st.arriveSpeed).toFixed(0)} mm/s\n` +
        `   near the ball (30-250 mm gap) ${(100 * st.nearTicks / st.ticks).toFixed(0)}% of play, of which slow (<250 mm/s) ${(100 * st.slowNearTicks / Math.max(st.nearTicks, 1)).toFixed(0)}%\n` +
        `   goals ${st.goals}`,
    );
  }
} finally {
  try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
  await server.close();
  process.exit(0);
}
