/**
 * What happens to the keeper's carry (the swap)?
 *
 * Plays the working-tree champion (violet) against the pinned pre-swap
 * champion (lime) and dissects every away-spell the working keeper makes: how
 * far it went, whether the ball came with it, and what the spell ended in —
 * a working goal, a conceded goal, or a quiet handback.
 *
 *   bun scratch/swap_probe.ts [seeds=1-10]
 *
 * Untracked on purpose: it imports the pinned champion from the duel worktree.
 */
import { Match } from '../packages/server/src/match/match';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as workChampion } from '../packages/server/src/champion/index';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as pinChampion } from './.wt-champion-ab6ce00/packages/server/src/champion/index';
import { distance } from '../packages/server/src/sim/physics';

const SEEDS = process.argv[2] ? process.argv[2].split('-').map(Number) : [1, 10];

// Violet defends the cyan goal at x=-915 in the first half (world.ts). HOME is
// OWN_LINE + PENALTY_DEPTH + 150 = -465, the same threshold brain.ts uses.
const GOAL_LINE = -915;
const HOME = -465;

interface Spell {
  duration: number;
  maxX: number;
  ballLost: boolean;
  outcome: 'goal' | 'conceded' | 'quiet';
  guardMinGap: number;
  contested: boolean;
  eventBallX: number | null;
  contestDelay: number | null;
  contestStartX: number | null;
}

const spells: Spell[] = [];
let matches = 0;
let workGoals = 0;
let pinGoals = 0;
let workWins = 0;
let pinWins = 0;

for (let seed = SEEDS[0]; seed <= SEEDS[1]; seed++) {
  const w = workChampion('violet');
  const p = pinChampion('lime');
  const agents = {
    'violet-1': w['violet-1']!,
    'violet-2': w['violet-2']!,
    'lime-1': p['lime-1']!,
    'lime-2': p['lime-2']!,
  };
  const KEEPER = 'violet-2';
  const STRIKER = 'violet-1';

  let spell: { start: number; maxX: number; ballLost: boolean; contested: boolean; guardMinGap: number; eventBallX: number | null; contestDelay: number | null; contestStartX: number | null } | null = null;
  let pending: 'goal' | 'conceded' | null = null;
  let seen = 0;
  let finalized = false;

  const finalise = (outcome: Spell['outcome']) => {
    if (spell) {
      spells.push({ duration: 0, maxX: spell.maxX, ballLost: spell.ballLost, outcome, guardMinGap: spell.guardMinGap, contested: spell.contested, eventBallX: spell.eventBallX, contestDelay: spell.contestDelay, contestStartX: spell.contestStartX });
      spell = null;
    }
    pending = null;
  };

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
          if (e.kind === 'goal') pending = e.team === 'violet' ? 'goal' : 'conceded';
        }
      }

      if (!world.running) {
        if (!finalized) {
          finalized = true;
          finalise(pending ?? 'quiet');
        }
        return;
      }

      const keeper = world.robots.find((r) => r.id === KEEPER);
      if (!keeper || keeper.removed) return;
      const striker = world.robots.find((r) => r.id === STRIKER);

      const away = keeper.x > HOME;
      const held = distance(world.ball, keeper) <= keeper.radius + world.ball.radius + 35;

      if (spell) {
        spell.maxX = Math.max(spell.maxX, keeper.x);
        if (!held && distance(world.ball, keeper) > 400) spell.ballLost = true;
        if (striker && !striker.removed) {
          const guardGap = striker.x - GOAL_LINE;
          spell.guardMinGap = Math.min(spell.guardMinGap, guardGap);
        }
        for (const r of world.robots) {
          if (r.team !== 'violet' && !r.removed && distance(r, world.ball) < 400) {
            spell.contested = true;
            if (spell.contestDelay === null) {
              spell.contestDelay = world.clock - spell.start;
              spell.contestStartX = world.ball.x;
            }
          }
        }
        if (pending && spell.eventBallX === null) spell.eventBallX = world.ball.x;
        if (!away) {
          const outcome = pending ?? 'quiet';
          spells.push({
            duration: world.clock - spell.start,
            maxX: spell.maxX,
            ballLost: spell.ballLost,
            outcome,
            guardMinGap: spell.guardMinGap,
            contested: spell.contested,
            eventBallX: spell.eventBallX,
            contestDelay: spell.contestDelay,
            contestStartX: spell.contestStartX,
          });
          spell = null;
          pending = null;
        }
      } else if (away && held) {
        spell = { start: world.clock, maxX: keeper.x, ballLost: false, contested: false, guardMinGap: 9999, eventBallX: null, contestDelay: null, contestStartX: null };
      }
    },
  });
  const res = m.run();
  matches++;
  workGoals += res.score.violet;
  pinGoals += res.score.lime;
  if (res.score.violet > res.score.lime) workWins++;
  else if (res.score.lime > res.score.violet) pinWins++;
  void res;
}

const by = (f: (sp: Spell) => boolean) => spells.filter(f).length;
const avg = (f: (sp: Spell) => number) =>
  spells.length ? (spells.reduce((a, sp) => a + f(sp), 0) / spells.length).toFixed(2) : '-';
console.log(
  JSON.stringify(
    {
      matches,
      aggregate: { work: workGoals, pinned: pinGoals, ratio: (workGoals / (pinGoals || 1)).toFixed(2), workWins, pinWins },
      spells: spells.length,
      spellsPerMatch: (spells.length / matches).toFixed(1),
      outcome: { goal: by((s) => s.outcome === 'goal'), conceded: by((s) => s.outcome === 'conceded'), quiet: by((s) => s.outcome === 'quiet') },
      avgDurationS: avg((s) => s.duration),
      avgMaxX: avg((s) => s.maxX),
      maxXdistribution: { pastOurBox: by((s) => s.maxX > -300), theirHalf: by((s) => s.maxX > 0), deep_gt400: by((s) => s.maxX > 400) },
      ballLost: by((s) => s.ballLost),
      ballLostAndConceded: by((s) => s.ballLost && s.outcome === 'conceded'),
      avgGuardMinGap: avg((s) => s.guardMinGap),
      concededGuardGap: (() => {
        const c = spells.filter((s) => s.outcome === 'conceded');
        return c.length ? (c.reduce((a, s) => a + s.guardMinGap, 0) / c.length).toFixed(0) : '-';
      })(),
      concededDeep: by((s) => s.outcome === 'conceded' && s.maxX > 0),
      concededContested: by((s) => s.outcome === 'conceded' && s.contested),
      goalContested: by((s) => s.outcome === 'goal' && s.contested),
      goalDeep: by((s) => s.outcome === 'goal' && s.maxX > 0),
      goalBallLost: by((s) => s.outcome === 'goal' && s.ballLost),
      contestDelayGoal: (() => {
        const c = spells.filter((s) => s.outcome === 'goal' && s.contestDelay !== null);
        return c.length ? (c.reduce((a, s) => a + s.contestDelay!, 0) / c.length).toFixed(2) : '-';
      })(),
      contestDelayConceded: (() => {
        const c = spells.filter((s) => s.outcome === 'conceded' && s.contestDelay !== null);
        return c.length ? (c.reduce((a, s) => a + s.contestDelay!, 0) / c.length).toFixed(2) : '-';
      })(),
      contestStartX: {
        goal: (() => {
          const c = spells.filter((s) => s.outcome === 'goal' && s.contestStartX !== null);
          return c.length ? (c.reduce((a, s) => a + s.contestStartX!, 0) / c.length).toFixed(0) : '-';
        })(),
        conceded: (() => {
          const c = spells.filter((s) => s.outcome === 'conceded' && s.contestStartX !== null);
          return c.length ? (c.reduce((a, s) => a + s.contestStartX!, 0) / c.length).toFixed(0) : '-';
        })(),
      },
      concededEventBallX: Array.from(new Set(spells.filter((s) => s.outcome === 'conceded').map((s) => Math.round((s.eventBallX ?? -9999) / 300) * 300).sort((a, b) => a - b))),
    },
    null,
    2,
  ),
);