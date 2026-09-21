/**
 * The demo arena, two matches back to back, with the draw forced:
 *   match 1  Gemini (violet) v Claude examples (lime)
 *   match 2  Claude examples (violet) v Gemini (lime)
 * and reports, at each kick-off, whether every transport the match was handed
 * is actually connected. Gemini taking the seats the examples just held is
 * what froze it for whole matches.
 *
 *   bun scratch/demo_seat_race.ts
 */
import { resolve } from 'node:path';
import { MatchServer } from '../packages/server/src/infra/server';
import { DemoArena } from '../packages/server/src/league/arena';

// Draw: pool index i for violet, j for lime, then the randomSides coin.
// Match 1: i=0 (Gemini) j=0->1 (Claude), no swap. Match 2: same, then swap.
const draws = [0.0, 0.0, 0.9, 0.0, 0.0, 0.1];
Math.random = () => draws.shift() ?? 0.9;

const server = new MatchServer({ port: 0, realtime: false, pythonLibDir: resolve('python'), submissionsDir: resolve('data/submissions') });
const demo = new DemoArena(server, {
  teamList: [{ name: 'Gemini', bots: 'gemini' }, { name: 'Claude', bots: 'examples' }],
  halfSeconds: 10,
  gapSeconds: 1,
  randomSides: true,
  submissionsDir: resolve('data/submissions'),
  pythonLibDir: resolve('python'),
  log: (l) => { if (!l.startsWith('[')) console.log('  log:', l); },
});

const play = server.play.bind(server);
let n = 0;
let bad = 0;
(server as any).play = async (opts: any) => {
  n++;
  const state = Object.entries(opts.transports ?? {}).map(([id, t]: any) => `${id}:${t.connected ? 'up' : 'DEAD'}`);
  if (state.some((s) => s.endsWith('DEAD'))) bad++;
  console.log(`match ${n} ${opts.teams.violet} v ${opts.teams.lime}  transports ${state.join(' ')}`);
  const r = await play(opts);
  if (n >= 2) {
    demo.stop();
    await server.close();
    console.log(bad ? `FAIL: ${bad} match(es) handed a dead transport` : 'OK: every seat live');
    process.exit(bad ? 1 : 0);
  }
  return r;
};

await server.listen();
demo.start();
