/**
 * Gemini's striker at its own kick-offs: how many were called illegal, and
 * how many were a real strike rather than a back-off that left the ball on the
 * spot.
 *
 *   bun scratch/gemini_ko_trace.ts 1,2,3 violet     # half 1 kick-offs
 *   bun scratch/gemini_ko_trace.ts 1,2,3 lime v     # half 2, trace failures
 *   REALTIME=1 HALF=6 bun scratch/gemini_ko_trace.ts 1,2 violet
 *
 * The seeds run back to back against ONE lineup on purpose. The bug this was
 * written for only showed from the second match on: the Python runtime
 * replayed the whole last match's encoder edges when the totals restarted at
 * zero, and the robot answered nothing for the first ~0.6s of a fast match.
 */
import { resolve } from 'node:path';
import { MatchServer } from '../packages/server/src/infra/server';
import { resolveLineup, spawnLineup } from '../packages/server/src/accounts/lineup';
import { referenceTeam } from '../packages/server/src/infra/reference';
import type { MatchAgents } from '../packages/server/src/match/match';

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const side = (process.argv[3] ?? 'violet') as 'violet' | 'lime';
const verbose = process.argv[4] === 'v';
const id = `${side}-1`;

const server = new MatchServer({ port: 0, realtime: process.env.REALTIME === '1', pythonLibDir: resolve('python') });
await server.listen();
const lineup = await spawnLineup(
  server,
  await resolveLineup(
    resolve('data/submissions'),
    side === 'violet' ? { violet: 'Gemini', lime: '__none__' } : { violet: '__none__', lime: 'Gemini' },
  ),
  { pythonLibDir: resolve('python'), connectTimeoutSeconds: 5 },
  (line) => {
    if (verbose) console.log('[AGENT]', line);
  },
);

let illegal = 0;
let kickOffs = 0;
/** Ball speed at the moment each of our kick-offs stopped being pending. */
const clears: number[] = [];
try {
  for (const seed of seeds) {
    const log: string[] = [];
    let wasPending = false;
    let since = 0;
    const result = await server.play({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
      transports: lineup.transports,
      halfSeconds: Number(process.env.HALF ?? 15),
      seed,
      observe: (m) => {
        const w: any = m.world;
        if (wasPending && !w.kickOffPending && w.kickingOffTeam === side && w.clock - since < 3.5) {
          clears.push(Math.hypot(w.ball.vx, w.ball.vz));
        }
        if (w.kickOffPending && !wasPending) since = w.clock;
        wasPending = w.kickOffPending;
        if (!verbose || !w.kickOffPending) return;
        const r = w.robots.find((x: any) => x.id === id)!;
        const b = w.ball;
        const gap = Math.hypot(r.x - b.x, r.z - b.z) - (r.radius + b.radius);
        log.push(
          `t=${w.clock.toFixed(2)} robot=(${r.x.toFixed(0)},${r.z.toFixed(0)}) ball=(${b.x.toFixed(0)},${b.z.toFixed(0)}) ` +
            `v=(${b.vx.toFixed(0)},${b.vz.toFixed(0)}) gap=${gap.toFixed(1)} act=${JSON.stringify(m.actuators[id])}`,
        );
      },
    });
    const ours = result.events.filter((e: any) => e.kind === 'kickoff' && e.team === side).length;
    const calls = result.events.filter((e: any) => e.kind === 'illegal-kickoff' && e.team === side).length;
    kickOffs += ours;
    illegal += calls;
    console.log(`seed ${seed}: ${side} kick-offs=${ours} illegal=${calls}`);
    if (calls && verbose) for (const line of log) console.log('  ', line);
  }
  const struck = clears.filter((v) => v > 1000).length;
  console.log(`TOTAL ${side}: illegal ${illegal}/${kickOffs}, struck ${struck}/${clears.length}`);
} finally {
  lineup.stop();
  await server.close();
}
