/**
 * Goal-origin census. Wraps all four agents' ticks to catch each seat's latest
 * broadcast, then classifies every goal by the scorer's last intent before it
 * crossed the line (kickoff strike, carry, pass-out, smother-run, intercept
 * run, loose tap-in, ...). Shows which mechanic over-performs and which leaks,
 * for the work champion (violet) vs the pinned champion (lime).
 *
 *   bun scratch/goal_sources.ts 1-60
 */
import { Match } from '../packages/server/src/match/match';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as workChampion } from '../packages/server/src/champion/index';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as pinChampion } from './.wt-champion-ab6ce00/packages/server/src/champion/index';

const SEEDS = process.argv[2] ? process.argv[2].split('-').map(Number) : [1, 60];

interface Row {
  match: number;
  scorer: string;
  intent: string;
  scorerX: number;
  defKeeperX: number;
  clock: number;
}

const goals: Row[] = [];
let matches = 0;

const wrapSeat = (agent: never) => {
  const holder: { say: { intent?: string; pos?: [number, number] } | null } = { say: null };
  const orig = (agent as unknown as { tick: (f: never) => unknown }).tick.bind(agent);
  (agent as unknown as { tick: (f: never) => unknown }).tick = (frame: never) => {
    const out = orig(frame) as { say?: { intent?: string; pos?: [number, number] } };
    if (out?.say?.intent) holder.say = out.say;
    return out;
  };
  return () => holder.say;
};

for (let seed = SEEDS[0]; seed <= SEEDS[1]; seed++) {
  const w = workChampion('violet');
  const p = pinChampion('lime');

  const ids = ['violet-1', 'violet-2', 'lime-1', 'lime-2'] as const;
  const lastSay: Record<string, ReturnType<typeof wrapSeat>> = {} as never;
  for (const id of ids) {
    const seat = id.startsWith('violet') ? w[id]! : p[id as 'lime-1' | 'lime-2']!;
    lastSay[id] = wrapSeat(seat as never);
  }
  const agents = {
    'violet-1': w['violet-1']!,
    'violet-2': w['violet-2']!,
    'lime-1': p['lime-1']!,
    'lime-2': p['lime-2']!,
  };

  let seen = 0;
  const m = new Match({
    agents,
    halfSeconds: 120,
    seed,
    observe: () => {
      const world = m.world;
      if (world.events.length !== seen) {
        const fresh = world.events.slice(seen);
        seen = world.events.length;
        for (const e of fresh) {
          if (e.kind !== 'goal') continue;
          const touch = world.lastBallTouch;
          const scorerId = touch?.robotId ?? (e.team === 'violet' ? 'violet-1' : 'lime-1');
          const say = lastSay[scorerId]?.() ?? {};
          const scorer = world.robots.find((r) => r.id === scorerId);
          const defKeeper = world.robots.find(
            (r) => r.id === (e.team === 'violet' ? 'lime-2' : 'violet-2'),
          );
          goals.push({
            match: seed,
            scorer: e.team,
            intent: say.intent ?? '(none)',
            scorerX: scorer && !scorer.removed ? scorer.x : Infinity,
            defKeeperX: defKeeper && !defKeeper.removed ? defKeeper.x : Infinity,
            clock: world.clock,
          });
        }
      }
    },
  });
  m.run();
  matches++;
}

for (const team of ['violet', 'lime'] as const) {
  const sub = goals.filter((g) => g.scorer === team);
  const acc: Record<string, number> = {};
  for (const g of sub) acc[g.intent] = (acc[g.intent] ?? 0) + 1;
  const sorted = Object.entries(acc).sort((a, b) => b[1] - a[1]);
  console.log(
    `\n${team} goals (${sub.length}/${matches} matches, ${(sub.length / matches).toFixed(2)}/match)`,
  );
  for (const [intent, n] of sorted) console.log(`  ${intent.padEnd(16)} ${n}`);
}
const byKickoff = (team: 'violet' | 'lime') =>
  goals.filter((g) => g.scorer === team && (g.intent === 'KICKOFF' || g.clock < 6)).length;
console.log(`\nkickoff-window goals (clock<6s or intent KICKOFF): violet ${byKickoff('violet')}, lime ${byKickoff('lime')}`);
console.log(`carry-sourced goals (intent CARRY/DRIBBLE_ROUND): violet ${goals.filter((g) => g.scorer === 'violet' && /CARRY|DRIBBLE_ROUND/.test(g.intent)).length}, lime ${goals.filter((g) => g.scorer === 'lime' && /CARRY|DRIBBLE_ROUND/.test(g.intent)).length}`);
