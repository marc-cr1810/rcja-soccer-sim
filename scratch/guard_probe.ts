/**
 * Guard-behaviour during the keeper's away-sells.
 *
 * Same rig as swap_probe, but watches the striker-guard itself: what intent
 * it broadcasts while the keeper is away, and what it is doing at the exact
 * tick a goal goes in. Answers: are concessions sold because the guard
 * smothers off the line, stands glued to one post, gets shoved off (5.7.1.2),
 * or is simply beaten in position?
 *
 *   bun scratch/guard_probe.ts 1-40
 */
import { Match } from '../packages/server/src/match/match';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as workChampion } from '../packages/server/src/champion/index';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as pinChampion } from './.wt-champion-ab6ce00/packages/server/src/champion/index';
import { distance } from '../packages/server/src/sim/physics';
import type { ChampionIntent } from '../packages/server/src/champion/types';

const SEEDS = process.argv[2] ? process.argv[2].split('-').map(Number) : [1, 40];
const GOAL_LINE = -915;
const HOME = -465;

interface Spell {
  outcome: 'goal' | 'conceded' | 'quiet';
  duration: number;
  maxX: number;
  guardIntents: Record<string, number>;
  goalIntent: string | null;
  goalGuardGap: number | null;
  goalGuardZvBall: number | null;
  goalShooterGap: number | null;
  lastGuardMinGapToBall: number | null;
  goalKeeperX: number | null;
  goalStrikerX: number | null;
  guardedAnyTicks: boolean;
  goalKeeperBroadcastX: number | null;
  goalKeeperIntent: string | null;
}

let matches = 0;
const spells: Spell[] = [];

for (let seed = SEEDS[0]; seed <= SEEDS[1]; seed++) {
  const w = workChampion('violet');
  const p = pinChampion('lime');
  const strikerAgent = w['violet-1']!;
  const keeperAgent = w['violet-2']!;
  const origStrike = strikerAgent.tick.bind(strikerAgent);
  const origKeep = keeperAgent.tick.bind(keeperAgent);

  let lastIntent: ChampionIntent | null = null;
  let keeperSay: { pos?: [number, number]; intent?: string; held?: boolean } | null = null;
  (strikerAgent as unknown as { tick: (f: never) => unknown }).tick = (frame: never) => {
    const out = origStrike(frame as Parameters<typeof origStrike>[0]) as { say?: { intent?: ChampionIntent } };
    if (out?.say?.intent) lastIntent = out.say.intent;
    return out;
  };
  (keeperAgent as unknown as { tick: (f: never) => unknown }).tick = (frame: never) => {
    const out = origKeep(frame as Parameters<typeof origKeep>[0]) as unknown as { say?: { pos?: [number, number]; intent?: string; held?: boolean } };
    if (out?.say) keeperSay = out.say;
    return out;
  };

  const agents = {
    'violet-1': strikerAgent,
    'violet-2': w['violet-2']!,
    'lime-1': p['lime-1']!,
    'lime-2': p['lime-2']!,
  };
  const KEEPER = 'violet-2';
  const STRIKER = 'violet-1';

  let spell: {
    start: number;
    maxX: number;
    intents: Record<string, number>;
    goalIntent: string | null;
    goalGuardGap: number | null;
    goalGuardZvBall: number | null;
    goalShooterGap: number | null;
    lastGuardBallGap: number | null;
    goalKeeperX: number | null;
    goalStrikerX: number | null;
    guardedAny: boolean;
    goalKeeperBroadcastX: number | null;
    goalKeeperIntent: string | null;
  } | null = null;
  let pending: 'goal' | 'conceded' | null = null;
  let seen = 0;
  let finalized = false;

  const closeOutcome = (outcome: Spell['outcome']) => {
    if (spell) {
      spells.push({
        outcome,
        duration: 0,
        maxX: spell.maxX,
        guardIntents: spell.intents,
        goalIntent: spell.goalIntent,
        goalGuardGap: spell.goalGuardGap,
        goalGuardZvBall: spell.goalGuardZvBall,
        goalShooterGap: spell.goalShooterGap,
        lastGuardMinGapToBall: spell.lastGuardBallGap,
        goalKeeperX: spell.goalKeeperX,
        goalStrikerX: spell.goalStrikerX,
        guardedAnyTicks: spell.guardedAny,
        goalKeeperBroadcastX: spell.goalKeeperBroadcastX,
        goalKeeperIntent: spell.goalKeeperIntent,
      });
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
          closeOutcome(pending ?? 'quiet');
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
        let guardGap: number | null = null;
        if (striker && !striker.removed) guardGap = distance(world.ball, striker);
        if (guardGap !== null) spell.lastGuardBallGap = Math.min(spell.lastGuardBallGap ?? Infinity, guardGap);
        // Record the guard's intent every ten ticks (histogram), always
        // capturing a goal tick.
        const isGoalTick = pending !== null;
        const recordAt = isGoalTick || Math.floor(world.clock * 50) % 10 === 0;
        if (recordAt && lastIntent) {
          spell.intents[lastIntent] = (spell.intents[lastIntent] ?? 0) + 1;
          if (
            lastIntent === 'GUARD' ||
            lastIntent === 'COVER_MOUTH' ||
            lastIntent === 'SMOTHER' ||
            lastIntent === 'OFF_THE_LINE' ||
            lastIntent === 'COVER'
          ) {
            spell.guardedAny = true;
          }
          if (isGoalTick && spell.goalIntent === null) {
            spell.goalIntent = lastIntent;
            spell.goalKeeperX = keeper.x;
            spell.goalKeeperBroadcastX = keeperSay?.pos?.[0] ?? null;
            spell.goalKeeperHeld = keeperSay?.held ?? null;
            spell.goalKeeperIntent = keeperSay?.intent ?? null;
            if (striker && !striker.removed) spell.goalStrikerX = striker.x;
            if (striker && !striker.removed) {
              spell.goalGuardGap = distance(world.ball, striker);
              spell.goalGuardZvBall = Math.abs(striker.z - world.ball.z);
              const shooter = world.robots.find((r) => r.id === world.lastBallTouch?.robotId);
              if (shooter && !shooter.removed) spell.goalShooterGap = distance(world.ball, shooter);
            }
          }
        }
        if (!away) {
          spells.push({
            outcome: pending ?? 'quiet',
            duration: world.clock - spell.start,
            maxX: spell.maxX,
            guardIntents: spell.intents,
            goalIntent: spell.goalIntent,
            goalGuardGap: spell.goalGuardGap,
            goalGuardZvBall: spell.goalGuardZvBall,
            goalShooterGap: spell.goalShooterGap,
            lastGuardMinGapToBall: spell.lastGuardBallGap,
            goalKeeperX: spell.goalKeeperX,
            goalStrikerX: spell.goalStrikerX,
            guardedAnyTicks: spell.guardedAny,
            goalKeeperBroadcastX: spell.goalKeeperBroadcastX,
            goalKeeperIntent: spell.goalKeeperIntent,
          });
          spell = null;
          pending = null;
        }
      } else if (away && held) {
        spell = { start: world.clock, maxX: keeper.x, intents: {}, goalIntent: null, goalGuardGap: null, goalGuardZvBall: null, goalShooterGap: null, lastGuardBallGap: null, goalKeeperX: null, goalStrikerX: null, guardedAny: false, goalKeeperBroadcastX: null, goalKeeperIntent: null, goalKeeperHeld: null };
      }
    },
  });
  m.run();
  matches++;
}

const by = (f: (s: Spell) => boolean) => spells.filter(f).length;
const intentHist = (outcome: Spell['outcome']) => {
  const sub = spells.filter((s) => s.outcome === outcome);
  const acc: Record<string, number> = {};
  for (const s of sub) for (const [k, v] of Object.entries(s.guardIntents)) acc[k] = (acc[k] ?? 0) + v;
  return Object.fromEntries(Object.entries(acc).sort((a, b) => b[1] - a[1]));
};
const goalIntentHist = (outcome: Spell['outcome']) => {
  const sub = spells.filter((s) => s.outcome === outcome && s.goalIntent);
  const acc: Record<string, number> = {};
  for (const s of sub) acc[s.goalIntent!] = (acc[s.goalIntent!] ?? 0) + 1;
  return Object.fromEntries(Object.entries(acc).sort((a, b) => b[1] - a[1]));
};
const avg = (f: (s: Spell) => number | null) => {
  const vals = spells.map(f).filter((v): v is number => v !== null);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0) : '-';
};
console.log(
  JSON.stringify(
    {
      matches,
      spells: spells.length,
      outcome: { goal: by((s) => s.outcome === 'goal'), conceded: by((s) => s.outcome === 'conceded'), quiet: by((s) => s.outcome === 'quiet') },
      guardIntentsDuring: {
        goal: intentHist('goal'),
        conceded: intentHist('conceded'),
        quiet: intentHist('quiet'),
      },
      guardIntentAtGoal: {
        conceded: goalIntentHist('conceded'),
        goal: goalIntentHist('goal'),
      },
      concededGoal: {
        avgGuardGapMm: avg((s) => (s.outcome === 'conceded' ? s.goalGuardGap : null)),
        avgGuardZvBallMm: avg((s) => (s.outcome === 'conceded' ? s.goalGuardZvBall : null)),
        avgShooterGapMm: avg((s) => (s.outcome === 'conceded' ? s.goalShooterGap : null)),
        minBallGapInLastTicksMm: avg((s) => (s.outcome === 'conceded' ? s.lastGuardMinGapToBall : null)),
        avgKeeperX: avg((s) => (s.outcome === 'conceded' ? s.goalKeeperX : null)),
        avgStrikerX: avg((s) => (s.outcome === 'conceded' ? s.goalStrikerX : null)),
        keeperStillAway: by((s) => s.outcome === 'conceded' && (s.goalKeeperX ?? -100) > HOME),
        strikerNearMouth:
          by((s) => s.outcome === 'conceded' && (s.goalStrikerX ?? -1000) < HOME + 150),
        everGuarded: by((s) => s.outcome === 'conceded' && s.guardedAnyTicks),
        avgKeeperBroadcastX: avg((s) => (s.outcome === 'conceded' ? s.goalKeeperBroadcastX : null)),
        keeperBroadcastHome:
          by((s) => s.outcome === 'conceded' && (s.goalKeeperBroadcastX ?? -100) <= HOME),
        keeperBroadcastAway:
          by((s) => s.outcome === 'conceded' && (s.goalKeeperBroadcastX ?? -100) > HOME),
        keeperHeldAtConcede: by((s) => s.outcome === 'conceded' && s.goalKeeperHeld === true),
        keeperIntentHist: (() => {
          const acc: Record<string, number> = {};
          for (const s of spells.filter((x) => x.outcome === 'conceded' && x.goalKeeperIntent))
            acc[s.goalKeeperIntent!] = (acc[s.goalKeeperIntent!] ?? 0) + 1;
          return Object.fromEntries(Object.entries(acc).sort((a, b) => b[1] - a[1]));
        })(),
      },
      scoredGoal: {
        avgGuardGapMm: avg((s) => (s.outcome === 'goal' ? s.goalGuardGap : null)),
        avgGuardZvBallMm: avg((s) => (s.outcome === 'goal' ? s.goalGuardZvBall : null)),
      },
    },
    null,
    2,
  ),
);