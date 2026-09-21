// Gemini vs reference: find freezes (a Gemini robot not moving for >=4 s of live play),
// own goals, and anything the Python processes print.
// bun scratch/gemini_diag.ts [side=lime] [halfSeconds=120] [seed=1]
import { resolve } from 'node:path';
import { MatchServer } from '../packages/server/src/infra/server';
import { resolveLineup, spawnLineup } from '../packages/server/src/accounts/lineup';
import { referenceTeam } from '../packages/server/src/infra/reference';
import type { MatchAgents } from '../packages/server/src/match/match';

const side = (process.argv[2] ?? 'lime') as 'violet' | 'lime';
const halfSeconds = Number(process.argv[3] ?? 120);
const seed = Number(process.argv[4] ?? 1);
const ROOT = process.cwd();
const PY = resolve(ROOT, 'python');

const server = new MatchServer({ port: 0, realtime: process.env.RT === '1', pythonLibDir: PY });
await server.listen();
const lineup = { violet: '__none__', lime: '__none__' } as Record<string, string>;
lineup[side] = 'Gemini';
if (process.argv[5] === 'both') { lineup.violet = 'Gemini'; lineup.lime = 'Gemini'; }
const resolved = await resolveLineup(resolve(ROOT, 'data/submissions'), lineup as never);
const lines: string[] = [];
const spawned = await spawnLineup(server, resolved, { pythonLibDir: PY, connectTimeoutSeconds: 5 }, (l) => lines.push(l));

const hist: Record<string, { t: number; x: number; z: number }[]> = {};
const freezes: string[] = [];
const frozenSince: Record<string, number | null> = {};
const touches: { t: number; id: string }[] = [];
try {
  const result = await server.play({
    agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
    transports: spawned.transports,
    halfSeconds,
    seed,
    mercyMargin: null,
    observe: (m) => {
      const w = m.world as any;
      const live = !w.kickOffPending;
      // Referee stop/resume: at PAUSE_AT, stop play for a second and restart it where everyone stands.
      const pauseAt = Number(process.env.PAUSE_AT ?? -1);
      const st = w.robots.find((r: any) => r.id === `${side}-1`);
      const deep = w.defendingGoal(side) === 'yellow' ? st.x < -400 : st.x > 400;
      if (pauseAt > 0 && w.clock >= pauseAt && deep && w.running && !w.kickOffPending && Math.abs(w.ball.x) < 500 && !(globalThis as any).paused) {
        (globalThis as any).paused = Date.now();
        w.running = false;
        const pos = w.robots.map((r: any) => `${r.id}(${r.x.toFixed(0)},${r.z.toFixed(0)})`).join(' ');
        console.log(`PAUSE at t=${w.clock.toFixed(2)} ${pos} ball=(${w.ball.x.toFixed(0)},${w.ball.z.toFixed(0)})`);
        (globalThis as any).resumeIn = 75;
      }
      if ((globalThis as any).resumeIn > 0 && --(globalThis as any).resumeIn === 0) { w.running = true; console.log('RESUME'); }
      const g = globalThis as any;
      if (g.paused && w.clock < (g.pausedClock ??= w.clock) + 10 && Math.floor(w.clock * 2) !== g.lastPrint) {
        g.lastPrint = Math.floor(w.clock * 2);
        const r = w.robots.find((r: any) => r.id === `${side}-1`);
        const say = (m.actuators[r.id] as any)?.say;
        console.log(`  t=${w.clock.toFixed(1)} ${r.id} at (${r.x.toFixed(0)},${r.z.toFixed(0)}) intent=${say?.intent} ball=(${w.ball.x.toFixed(0)},${w.ball.z.toFixed(0)})`);
      }
      for (const r of w.robots) {
        if (Math.hypot(r.x - w.ball.x, r.z - w.ball.z) < r.radius + w.ball.radius + 8) {
          if (!touches.length || touches[touches.length - 1].id !== r.id) touches.push({ t: w.clock, id: r.id });
        }
      }
      for (const r of w.robots) {
        if (!lineup[r.team].startsWith('Gemini')) continue;
        const k = r.id;
        const last = (hist[k] ??= [{ t: w.clock, x: r.x, z: r.z }]);
        const a = last[0];
        if (!live || Math.hypot(r.x - a.x, r.z - a.z) > 15) {
          if (live === false || w.clock - a.t < 4) {}
          if (w.clock - a.t >= 4 && frozenSince[k] != null) {
            freezes.push(`${k} still ${(w.clock - a.t).toFixed(1)} s from t=${a.t.toFixed(1)} at (${a.x.toFixed(0)},${a.z.toFixed(0)}) ${(frozenSince as any)[k + 'say']}`);
          }
          frozenSince[k] = null;
          last[0] = { t: w.clock, x: r.x, z: r.z };
        } else if (w.clock - a.t >= 4 && frozenSince[k] == null) {
          frozenSince[k] = a.t;
          const act = m.actuators[r.id] as any;
          (frozenSince as any)[k + 'say'] = `ball=(${w.ball.x.toFixed(0)},${w.ball.z.toFixed(0)}) intent=${act?.say?.intent} role=${act?.say?.role} motors=${JSON.stringify(r.motors.map((v: number) => +v.toFixed(2)))}`;
        }
      }
    },
  });
  console.log('score', result.score);
  for (const e of result.events) {
    if (e.kind === 'goal' && !String((e as any).robotId).startsWith((e as any).team)) console.log('OWN GOAL', JSON.stringify(e));
    if ( e.kind.includes('illegal') || e.kind.includes('own'))
      console.log('event', JSON.stringify(e));
  }
  for (const [k, v] of Object.entries(frozenSince)) if (typeof v === 'number') freezes.push(`${k} STILL AT END since t=${v.toFixed(1)} ${(frozenSince as any)[k + 'say']}`);
  console.log('goals', result.events.filter((e) => e.kind === 'goal').map((e: any) => `${e.at.toFixed(0)}:${e.robotId}->${e.team}`).join(' '));
  for (const e of result.events as any[]) {
    if (e.kind !== 'goal') continue;
    const before = touches.filter((t) => t.t <= e.at);
    const last = before[before.length - 1];
    if (last && !last.id.startsWith(e.team)) console.log(`OWN GOAL? t=${e.at.toFixed(1)} credited ${e.team}, last touch ${last.id} at ${last.t.toFixed(1)}; prior: ${before.slice(-4).map((t) => t.id + '@' + t.t.toFixed(1)).join(' ')}`);
  }
  console.log('--- freezes');
  for (const f of freezes) console.log(f);
  console.log('--- python output (' + lines.length + ' lines, first 40)');
  for (const l of lines.slice(0, 40)) console.log(l);
} finally {
  spawned.stop();
  await server.close();
}
