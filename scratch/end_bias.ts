// Goals by the end they were scored from, for the built-in TypeScript teams.
//
// Every python duel of 21 Sep 2026 scored ~2.5x as many goals attacking one end
// as the other, whichever team was there. The built-in teams share neither
// `rcja_soccer` nor the examples, so if they show it too the cause is in the
// simulator; if they do not, it is in the python side.
//
//   bun scratch/end_bias.ts [reference|champion|<python tree>] [seeds=1-20] [half=90]
//
// A python tree (a path) plays itself through scratch/duel.py, over the socket,
// the way every duel does.
import { spawn } from 'node:child_process';
import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { referenceTeam } from '../packages/server/src/infra/reference';
import { championTeam } from '../packages/server/src/champion/index';
import { MatchServer } from '../packages/server/src/infra/server';
import { waitForSeats } from '../packages/server/src/league/bench';

const which = process.argv[2] ?? 'reference';
const [s0, s1] = (process.argv[3] ?? '1-20').split('-').map(Number);
const half = Number(process.argv[4] ?? 90);
const team = which === 'champion' || process.env.OPP === 'champion' ? championTeam : referenceTeam;
const python = which.includes('/');
let server: MatchServer | null = null;
let child: ReturnType<typeof spawn> | null = null;
if (python) {
  server = new MatchServer({ port: 0, realtime: false });
  const port = await server.listen();
  // ONLY=violet plays the python tree on violet alone, against the built-in team.
  const only = process.env.ONLY;
  child = only
    ? spawn(`python3 ${which}/examples/play.py --only ${only} --url ws://localhost:${port}/agent`, { shell: true, stdio: 'ignore', detached: true })
    : spawn(`python3 scratch/duel.py --violet-src ${which} --lime-src ${which} --url ws://localhost:${port}/agent`, { shell: true, stdio: 'ignore', detached: true });
  await waitForSeats(server, only ? [`${only}-1`, `${only}-2`] : ['violet-1', 'violet-2', 'lime-1', 'lime-2'], 30);
}

// Goals scored INTO each goal, which is the same as "attacking towards it".
const into: Record<string, number> = { cyan: 0, yellow: 0 };
// By team as well, for a mixed match: `${team} into ${goal}`.
const byTeam: Record<string, number> = {};
// Keepers: where they say they are (radio `pos`) against where they are, and
// where they stand, split by the goal they are defending.
const keeper: Record<string, { n: number; err: number[]; unconfident: number; ticks: number; depth: number[]; lateral: number[]; state: Record<string, number>; ballErr: number[]; ballErrNear: number[] }> = {};
for (let seed = s0!; seed <= s1!; seed++) {
  let last = { violet: 0, lime: 0 };
  const observe = (match: any) => {
      const w = match.world;
      if (w.running && !w.kickOffPending) {
        for (const r of w.robots) {
          if (!r.id.endsWith('-2') || r.removed) continue;
          const t = r.id.split('-')[0];
          const g = w.defendingGoal(t);
          const k = (keeper[`${t} ${g}`] ??= { n: 0, err: [], unconfident: 0, ticks: 0, depth: [], lateral: [], state: {}, ballErr: [], ballErrNear: [] });
          k.ticks++;
          const say = match.actuators?.[r.id]?.say;
          const pos = say?.pos;
          if (Array.isArray(pos)) k.err.push(Math.hypot(pos[0] - r.x, pos[1] - r.z));
          else if (say) k.unconfident++;
          const b = say?.ball;
          if (Array.isArray(b) && w.ball && !w.ballAway) {
            const e = Math.hypot(b[0] - w.ball.x, b[1] - w.ball.z);
            k.ballErr.push(e);
            // The half of the field the keeper is defending: the ball it has to save.
            if (Math.sign(w.ball.x) === Math.sign(r.x)) k.ballErrNear.push(e);
          }
          if (say?.intent) k.state[say.intent] = (k.state[say.intent] ?? 0) + 1;
          k.depth.push(915 - Math.abs(r.x));
          k.lateral.push(r.z);
        }
      }
      for (const t of ['violet', 'lime'] as const) {
        if (w.score[t] > last[t]) {
          const g = w.attackingGoal(t);
          into[g] = (into[g] ?? 0) + (w.score[t] - last[t]);
          byTeam[`${t} into ${g}`] = (byTeam[`${t} into ${g}`] ?? 0) + (w.score[t] - last[t]);
        }
      }
      last = { violet: w.score.violet, lime: w.score.lime };
  };
  const agents = { ...team('violet'), ...team('lime') } as unknown as MatchAgents;
  const r: any = python
    ? await server!.play({ agents, transports: server!.agents.transports(), halfSeconds: half, seed, mercyMargin: null, observe, idealSensors: process.env.IDEAL === '1' } as any)
    : new Match({ agents, halfSeconds: half, seed, mercyMargin: null, observe } as any).run();
  console.error(`seed ${seed}: ${r.score.violet}-${r.score.lime}`);
}
console.log(`${which} v ${which}: into cyan ${into.cyan}, into yellow ${into.yellow}`);
const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)]! : NaN; };
const p90 = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * 0.9)]! : NaN; };
for (const [g, k] of Object.entries(keeper)) {
  const states = Object.entries(k.state).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, v]) => `${s} ${((100 * v) / k.ticks).toFixed(0)}%`).join(' ');
  console.log(`keeper defending ${g}: fix error median ${med(k.err).toFixed(0)} p90 ${p90(k.err).toFixed(0)} mm, no fix ${((100 * k.unconfident) / k.ticks).toFixed(1)}%, depth median ${med(k.depth).toFixed(0)}, ball error median ${med(k.ballErr).toFixed(0)} (own half ${med(k.ballErrNear).toFixed(0)}, p90 ${p90(k.ballErrNear).toFixed(0)}), |z| median ${med(k.lateral.map(Math.abs)).toFixed(0)}\n   ${states}`);
}
console.log(`   ${Object.entries(byTeam).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (child) { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ } }
process.exit(0);
