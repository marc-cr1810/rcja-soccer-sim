/**
 * A draw, the fixtures in it, and the table that falls out.
 *
 * Nothing here touches a disk or plays a match — see `tournament-store.ts` for
 * the first and `cli.ts` for the second. This half is pure so that the rule
 * that actually matters can be tested without a tournament: **a table is
 * derived, never stored.**
 *
 * That is the whole design. There is no running total anywhere, no "current
 * round" pointer, no state file that a crash can catch halfway through. The
 * state of a tournament is the draw, which is written once and never modified,
 * plus whichever fixture results happen to exist on disk. Fold one over the
 * other and a table comes out; ask which fixture has no result yet and you know
 * where to carry on. A process killed mid-fixture leaves no result file, so
 * that fixture simply plays again — which is what should happen anyway, because
 * half a match is not a result.
 */

import { award, blankStanding, compareStandings, invert, type Standing } from './ladder';
import { slugifyTeam } from './manifest';
import { deriveSeed, foldSeed, type SeedInput } from './rand';
import type { MatchResult } from './match';
import type { LeagueId } from './leagues';

/**
 * One meeting of two entrants, played over one or more legs.
 *
 * Home always plays violet and away always lime. The pairing is played the
 * other way round as its own fixture, for the reason `runLadder` already
 * spells out: kick-off placement, starting headings and which goal the camera
 * finds first all differ between the colours, so a single meeting measures the
 * colours as much as the robots.
 */
export interface Fixture {
  id: string;
  home: string;
  away: string;
  /**
   * The seed for each leg, fixed when the draw was made.
   *
   * Recorded rather than derived at kick-off so that a fixture replayed after a
   * crash is the same fixture, and so that a result can be reproduced later by
   * anyone holding the draw and the two submissions. A number is a plain match
   * seed; `{ hi, lo }` is the full 64-bit form the CLI stores for a crypto
   * draw.
   */
  seeds: SeedInput[];
  /**
   * Pitch ball rolling friction multiplier, shared across all legs of this fixture.
   */
  ballFriction?: number;
}

export interface Draw {
  /** Slug, and the folder name this tournament lives in. */
  id: string;
  name: string;
  league: LeagueId;
  halfSeconds: number;
  /** Legs per fixture. 1 for a single meeting, 3 for best-of-three. */
  legs: number;
  /** Whether fixtures wait for a referee and play at wall-clock. */
  refereed: boolean;
  createdAt: string;
  entrants: string[];
  fixtures: Fixture[];
}

export interface LegRecord {
  seed: SeedInput;
  /** Home played violet, away played lime. */
  result: MatchResult;
}

/**
 * The published record of one fixture — the reviewable artifact.
 *
 * Phase 6's front page is built on these, so the shape is a public contract
 * rather than a private convenience.
 */
export interface FixtureResult {
  fixtureId: string;
  home: string;
  away: string;
  /**
   * sha256 of the code in each seat, keyed by seat id, at the moment it played.
   *
   * A seat missing from here was filled by the built-in agent, which is what a
   * team that pushed only one robot looks like. Team names cannot stand in for
   * this: a name is re-pointed at new code on every push.
   */
  submissions: Record<string, string>;
  legs: LegRecord[];
  completedAt: string;
  /**
   * The conditions this was played under, when they were not the defaults.
   *
   * A seat's CPU and memory grant is part of what a result means: a venue
   * playing at 25% is playing a different game from one at 50%, and a match
   * replayed under a different grant is not the same match. It sits here beside
   * the seed and the code hashes for the same reason they do.
   *
   * Optional, because every record written before Phase 7 predates the idea and
   * they all still load.
   */
  conditions?: {
    seatCpuPercent: number;
    seatMemoryMb: number;
  };
}

export interface DrawOptions {
  name: string;
  league?: LeagueId;
  halfSeconds?: number;
  legs?: number;
  refereed?: boolean;
  /**
   * Base of the fixture seeds, exactly `seed + index * SEED_STRIDE + leg` (the
   * 64-bit form carries). A numeric value reproduces a draw exactly; a 64-bit
   * one records fresh crypto seeds for a competition.
   */
  seed?: SeedInput;
}


/**
 * Build the fixture list: every ordered pairing, both ways round.
 *
 * `slugifyTeam` does the slugging for both the tournament's own id and each
 * fixture's — it is a general slugifier that happens to be named for its first
 * caller, and a second one would only be a second thing to keep in step.
 */
export function makeDraw(entrants: string[], opts: DrawOptions): Draw {
  const unique = [...new Set(entrants)];
  if (unique.length < 2) {
    throw new Error(`a draw needs at least two entrants, got ${unique.length}`);
  }
  const legs = opts.legs ?? 1;
  if (!Number.isInteger(legs) || legs < 1) {
    throw new Error(`legs must be a whole number of at least 1, got ${legs}`);
  }
  const baseSeed = opts.seed ?? 1;

  const fixtures: Fixture[] = [];
  for (const home of unique) {
    for (const away of unique) {
      if (home === away) continue;
      // Derive an ungameable, uncorrelated fixture seed using SHA-256
      const fixtureSeed = deriveSeed(baseSeed, opts.name, home, away);
      const ballFriction = 0.9 + (foldSeed(deriveSeed(fixtureSeed, 'friction')) / 0x100000000) * 0.2;
      const seeds = Array<SeedInput>(legs);
      for (let leg = 0; leg < legs; leg++) {
        seeds[leg] = deriveSeed(fixtureSeed, 'leg', leg);
      }
      fixtures.push({
        id: `${slugifyTeam(home)}-v-${slugifyTeam(away)}`,
        home,
        away,
        seeds,
        ballFriction,
      });
    }
  }

  return {
    id: slugifyTeam(opts.name),
    name: opts.name,
    league: opts.league ?? 'open',
    halfSeconds: opts.halfSeconds ?? 300,
    legs,
    refereed: opts.refereed ?? true,
    createdAt: new Date().toISOString(),
    entrants: unique,
    fixtures,
  };
}

export interface FixtureVerdict {
  homeLegsWon: number;
  awayLegsWon: number;
  drawnLegs: number;
  homeGoals: number;
  awayGoals: number;
  /** From the home side's point of view. */
  outcome: 'won' | 'drawn' | 'lost';
}

/**
 * Who won a fixture, and by what.
 *
 * Legs won decides it, not aggregate goals. Playing three legs exists to stop a
 * single noisy meeting deciding a table — the Phase 0 test measured sixteen
 * matches to separate a skill dial of 1.0 from 0.35 — and aggregating the goals
 * would hand the fixture back to whichever leg happened to be a blowout, which
 * is the thing being defended against.
 */
export function fixtureOutcome(result: FixtureResult): FixtureVerdict {
  let homeLegsWon = 0;
  let awayLegsWon = 0;
  let drawnLegs = 0;
  let homeGoals = 0;
  let awayGoals = 0;

  for (const leg of result.legs) {
    const home = leg.result.score.violet;
    const away = leg.result.score.lime;
    homeGoals += home;
    awayGoals += away;
    if (home > away) homeLegsWon++;
    else if (away > home) awayLegsWon++;
    else drawnLegs++;
  }

  const outcome =
    homeLegsWon > awayLegsWon ? 'won' : awayLegsWon > homeLegsWon ? 'lost' : 'drawn';
  return { homeLegsWon, awayLegsWon, drawnLegs, homeGoals, awayGoals, outcome };
}

/**
 * The table, folded fresh out of the draw and whatever results exist.
 *
 * Points are awarded once per fixture, not once per leg: a best-of-three is one
 * meeting played three times, so three points for taking it, and a table whose
 * rows count fixtures reads like every other league's.
 */
export function deriveTable(draw: Draw, results: FixtureResult[]): Standing[] {
  const table = new Map(draw.entrants.map((name) => [name, blankStanding(name, 'student')]));
  const known = new Map(draw.fixtures.map((f) => [f.id, f]));

  for (const result of results) {
    // A result whose fixture is not in this draw is not this tournament's.
    if (!known.has(result.fixtureId)) continue;
    const home = table.get(result.home);
    const away = table.get(result.away);
    if (!home || !away) continue;

    const verdict = fixtureOutcome(result);
    award(home, verdict.homeGoals, verdict.awayGoals, verdict.outcome);
    award(away, verdict.awayGoals, verdict.homeGoals, invert(verdict.outcome));

    for (const leg of result.legs) {
      for (const [id, slot] of Object.entries(leg.result.slots)) {
        const side = id.startsWith('violet') ? home : away;
        side.missed += slot.missed;
        side.errors += slot.errors;
      }
    }
  }

  return [...table.values()].sort(compareStandings);
}

/** The next fixture with no result on disk, or null when the draw is played out. */
export function nextFixture(draw: Draw, results: FixtureResult[]): Fixture | null {
  const played = new Set(results.map((r) => r.fixtureId));
  return draw.fixtures.find((f) => !played.has(f.id)) ?? null;
}

/** The table as text, for a terminal. Shaped like `formatLadder`'s. */
export function formatTable(draw: Draw, results: FixtureResult[]): string {
  const table = deriveTable(draw, results);
  const width = Math.max(5, ...table.map((s) => s.name.length));
  const lines = [
    `${draw.name} — ${results.length} of ${draw.fixtures.length} fixtures played`,
    '',
    `${'entry'.padEnd(width)}  P   W  D  L    GF  GA  GD  PTS`,
    '-'.repeat(width + 30),
  ];
  for (const s of table) {
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
      ].join(' '),
    );
  }
  return lines.join('\n');
}
