/**
 * Playing every entry against every other, twice.
 *
 * This exists for three jobs, and only one of them is a competition.
 *
 * The first is testing the referee. Rule detectors fail on behaviour nobody
 * thought to write, and a well-behaved reference agent exercises only the
 * sensible half of each one. A ladder of deliberately poor robots produces the
 * other half — scrums that never resolve, robots parked in their own box,
 * robots that drive off the field — before a student produces it at a state
 * event.
 *
 * The second is balance. Sensor noise, IR occlusion, motor limits and the
 * referee's thresholds are all tuning numbers, and there is no way to reason
 * about whether a set of them makes a playable game. Run fifty matches and look
 * at the distribution of scores and restarts instead.
 *
 * The third is building practice opponents, which is the same run with the
 * results kept.
 *
 * Entries carry an origin so that a ladder result can never be mistaken for a
 * competition table: a machine-written robot and a student's are both just
 * programs here, and the record has to say which was which.
 */

import { Match, type MatchAgents } from './match';
import { deriveSeed, type SeedInput } from './rand';
import type { Agent } from './agent';

export type Origin = 'student' | 'reference' | 'generated';

export interface Entry {
  name: string;
  origin: Origin;
  /**
   * Build this entry's two robots for a side.
   *
   * A factory, not a pair of agents: programs carry state between ticks, so
   * every match needs its own, or the second match of a ladder starts with the
   * first one's memory.
   */
  make(team: 'violet' | 'lime'): Agent[];
}

export interface Standing {
  name: string;
  origin: Origin;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  for: number;
  against: number;
  points: number;
  /** Control cycles the entry's programs failed to answer, across the ladder. */
  missed: number;
  errors: number;
}

export interface LadderSummary {
  table: Standing[];
  matches: number;
  /** Referee calls per match, by kind. The balance numbers. */
  callsPerMatch: Record<string, number>;
  goalsPerMatch: number;
  /** Seconds of wall clock the whole ladder took. */
  wall: number;
}

export interface LadderOptions {
  /** How many times each ordered pairing is played. Default 1, so A-B and B-A. */
  rounds?: number;
  halfSeconds?: number;
  /**
   * Base of the per-match seeds. A numeric base keeps the whole run deterministic
   * and replayable across machines; a 64-bit seed is accepted for the same runs.
   */
  seed?: SeedInput;
  /**
   * When true, pairs (A v B) and (B v A) are played with the exact same twin seed
   * in each round. Eliminates environmental and noise variance when comparing teams.
   */
  twinSeeds?: boolean;
}

/**
 * Add one meeting to a side's row.
 *
 * The outcome is passed in rather than worked out from the goals, because what
 * decides a meeting is not always the score: a ladder match is decided by it,
 * but a best-of-three fixture is decided by legs won, and both end up in a
 * table that has to read the same way.
 */
export function award(
  side: Standing,
  goalsFor: number,
  goalsAgainst: number,
  outcome: 'won' | 'drawn' | 'lost',
): void {
  side.played++;
  side.for += goalsFor;
  side.against += goalsAgainst;
  if (outcome === 'won') {
    side.won++;
    side.points += 3;
  } else if (outcome === 'drawn') {
    side.drawn++;
    side.points++;
  } else {
    side.lost++;
  }
}

export function blankStanding(name: string, origin: Origin): Standing {
  return {
    name,
    origin,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    for: 0,
    against: 0,
    points: 0,
    missed: 0,
    errors: 0,
  };
}

function blank(entry: Entry): Standing {
  return blankStanding(entry.name, entry.origin);
}

/**
 * Every ordered pairing, so each entry plays each other one from both ends of
 * the field.
 *
 * Not a nicety. Kick-off placement, starting headings and which goal the camera
 * finds first all differ between violet and lime, so a single meeting measures
 * the colours as much as the robots.
 */
export function runLadder(entries: Entry[], opts: LadderOptions = {}): LadderSummary {
  const rounds = opts.rounds ?? 1;
  const halfSeconds = opts.halfSeconds ?? 300;
  const baseSeed = opts.seed ?? 1;

  const table = new Map(entries.map((e) => [e.name, blank(e)]));
  const calls: Record<string, number> = {};
  let matches = 0;
  let goals = 0;
  const started = Date.now();

  for (let round = 0; round < rounds; round++) {
    for (const home of entries) {
      for (const away of entries) {
        if (home === away) continue;

        const [c1, c2] = home.make('violet');
        const [y1, y2] = away.make('lime');
        const agents = {
          'violet-1': c1!,
          'violet-2': c2!,
          'lime-1': y1!,
          'lime-2': y2!,
        } satisfies MatchAgents;

        const seed = opts.twinSeeds
          ? deriveSeed(baseSeed, 'ladder-twin', [home.name, away.name].sort().join(':'), round)
          : deriveSeed(baseSeed, 'ladder', home.name, away.name, round);
        const result = new Match({ agents, halfSeconds, seed }).run();
        matches++;
        goals += result.score.violet + result.score.lime;
        for (const [kind, n] of Object.entries(result.calls)) {
          calls[kind] = (calls[kind] ?? 0) + n;
        }

        const h = table.get(home.name)!;
        const a = table.get(away.name)!;
        const homeOutcome =
          result.score.violet > result.score.lime
            ? 'won'
            : result.score.lime > result.score.violet
              ? 'lost'
              : 'drawn';
        award(h, result.score.violet, result.score.lime, homeOutcome);
        award(a, result.score.lime, result.score.violet, invert(homeOutcome));

        for (const [id, slot] of Object.entries(result.slots)) {
          const side = id.startsWith('violet') ? h : a;
          side.missed += slot.missed;
          side.errors += slot.errors;
        }
      }
    }
  }

  const wall = (Date.now() - started) / 1000;
  const callsPerMatch: Record<string, number> = {};
  for (const [kind, n] of Object.entries(calls)) {
    callsPerMatch[kind] = matches ? n / matches : 0;
  }

  return {
    table: [...table.values()].sort(compareStandings),
    matches,
    callsPerMatch,
    goalsPerMatch: matches ? goals / matches : 0,
    wall,
  };
}

/** The same meeting from the other side. */
export function invert(outcome: 'won' | 'drawn' | 'lost'): 'won' | 'drawn' | 'lost' {
  if (outcome === 'won') return 'lost';
  if (outcome === 'lost') return 'won';
  return 'drawn';
}

/** Points, then goal difference, then goals for — as every other Soccer league. */
export function compareStandings(a: Standing, b: Standing): number {
  if (b.points !== a.points) return b.points - a.points;
  const gd = b.for - b.against - (a.for - a.against);
  if (gd !== 0) return gd;
  return b.for - a.for;
}

/** The table as text, for a terminal or a commit message. */
export function formatLadder(summary: LadderSummary): string {
  const width = Math.max(4, ...summary.table.map((s) => s.name.length));
  const lines = [
    `${'entry'.padEnd(width)}  P   W  D  L    GF  GA  GD  PTS  origin`,
    '-'.repeat(width + 38),
  ];
  for (const s of summary.table) {
    const gd = s.for - s.against;
    lines.push(
      [
        s.name.padEnd(width),
        String(s.played).padStart(2),
        String(s.won).padStart(3),
        String(s.drawn).padStart(2),
        String(s.lost).padStart(2),
        String(s.for).padStart(5),
        String(s.against).padStart(3),
        `${gd > 0 ? '+' : ''}${gd}`.padStart(4),
        String(s.points).padStart(4),
        `  ${s.origin}`,
      ].join(' '),
    );
  }
  lines.push('');
  lines.push(`${summary.matches} matches in ${summary.wall.toFixed(1)}s wall`);
  lines.push(`goals per match: ${summary.goalsPerMatch.toFixed(1)}`);
  const calls = Object.entries(summary.callsPerMatch)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind} ${n.toFixed(1)}`)
    .join(', ');
  lines.push(`calls per match: ${calls}`);
  return lines.join('\n');
}
