/**
 * Correcting a draw without rewriting one.
 *
 * `draw.json` is written once and never modified — that is what makes resuming
 * a consequence rather than a feature, and what makes a fixture replay as
 * itself. But a competition day needs corrections: a team withdraws at lunch, a
 * fixture is voided, a result was wrong, a game moves to half past two. So an
 * amendment is an **appended record**, and the draw everything reads is the
 * draw folded with its amendments — exactly as the table is the results folded
 * together, and for the same reason: two copies of one fact can disagree after
 * a crash, and a fold cannot.
 *
 * Nothing in here touches a disk. `tournament-store.ts` reads and writes the
 * records; this half is pure so that the arithmetic of "what does the draw
 * actually say now" can be tested exhaustively without a tournament.
 *
 * **The fold returns a plain `Draw` and a plain `FixtureResult[]`**, which is
 * the whole reason it is cheap: `deriveTable`, `nextFixture` and `formatTable`
 * never learn that amendments exist, and neither does any screen.
 */

import { fail, ok, type Result } from './manifest';
import { walkoverResult } from './pregame';
import type { Draw, Fixture, FixtureResult, LegRecord } from './tournament';

/** Every amendment carries who, when and — always — why. */
export interface AmendmentBase {
  /** Sequence number, 1-based, and the name of the file it lives in. */
  n: number;
  at: string;
  /**
   * Who made it. A null id means the terminal: `amend` run by somebody with a
   * shell, which is the hatch this repository keeps open on purpose.
   */
  by: { id: string | null; slug: string };
  /**
   * Why, in a sentence somebody can be shown.
   *
   * Required, and not a courtesy: the whole point of an appended record over an
   * edit is that the reason survives beside the change.
   */
  reason: string;
}

/**
 * Everything an organiser may do to a draw, written out whole.
 *
 * The same argument `capabilities.ts` makes for its table: the value of the
 * list is that it can be read in one sitting and argued with. Later phases add
 * ways to *produce* these, not new kinds.
 */
export type Amendment =
  /** This fixture is not played and does not count. */
  | (AmendmentBase & { kind: 'void'; fixtureId: string })
  /** Cancels an earlier `void` of the same fixture. */
  | (AmendmentBase & { kind: 'restore'; fixtureId: string })
  /** Somebody else plays this team's remaining fixtures. */
  | (AmendmentBase & { kind: 'substitute'; team: string; replacement: string })
  /** This team has gone home; their remaining fixtures are walkovers. */
  | (AmendmentBase & { kind: 'withdraw'; team: string; goals: number })
  /** When these fixtures are due, as ISO times. */
  | (AmendmentBase & { kind: 'schedule'; times: Record<string, string> })
  /** This result does not count — the fixture becomes unplayed again. */
  | (AmendmentBase & { kind: 'void-result'; fixtureId: string; completedAt: string });

export type AmendmentKind = Amendment['kind'];

/**
 * An amendment before it has been given its place in the sequence.
 *
 * Distributed over the union rather than a plain `Omit`, which would collapse
 * six kinds into the fields they have in common and quietly lose every one that
 * matters.
 */
export type DraftAmendment = Amendment extends infer One
  ? One extends Amendment
    ? Omit<One, 'n'>
    : never
  : never;

export const AMENDMENT_KINDS: readonly AmendmentKind[] = [
  'void',
  'restore',
  'substitute',
  'withdraw',
  'schedule',
  'void-result',
];

/**
 * One record, checked rather than trusted.
 *
 * These are files an organiser is expected to be able to write by hand at
 * eleven at night, which is exactly why every field is checked here: a typo in
 * a hand-written amendment should say what is wrong with it, not quietly fold
 * into a different draw.
 */
export function parseAmendment(raw: unknown): Result<Amendment> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not a JSON object');
  const record = raw as Record<string, unknown>;

  const named = record.kind;
  if (typeof named !== 'string' || !(AMENDMENT_KINDS as readonly string[]).includes(named)) {
    return fail(`"kind" must be one of ${AMENDMENT_KINDS.join(', ')}`);
  }
  const kind = named as AmendmentKind;
  if (typeof record.n !== 'number' || !Number.isInteger(record.n) || record.n < 1) {
    return fail('"n" must be a whole number of at least 1');
  }
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) {
    return fail('"at" must be an ISO timestamp');
  }
  if (typeof record.reason !== 'string' || record.reason.trim() === '') {
    return fail('"reason" is required — an amendment without one is an edit');
  }
  const by = record.by as Record<string, unknown> | undefined;
  if (!by || typeof by !== 'object' || typeof by.slug !== 'string') {
    return fail('"by" must say who made this, as { id, slug }');
  }
  if (by.id !== null && typeof by.id !== 'string') return fail('"by.id" must be an account id or null');

  const base: AmendmentBase = {
    n: record.n,
    at: record.at,
    by: { id: (by.id as string | null) ?? null, slug: by.slug },
    reason: record.reason,
  };

  const text = (field: string): Result<string> => {
    const value = record[field];
    if (typeof value !== 'string' || value.trim() === '') return fail(`"${field}" is required`);
    return ok(value);
  };

  switch (kind) {
    case 'void':
    case 'restore': {
      const fixtureId = text('fixtureId');
      if (!fixtureId.ok) return fixtureId;
      return ok({ ...base, kind, fixtureId: fixtureId.value });
    }
    case 'substitute': {
      const team = text('team');
      if (!team.ok) return team;
      const replacement = text('replacement');
      if (!replacement.ok) return replacement;
      return ok({ ...base, kind, team: team.value, replacement: replacement.value });
    }
    case 'withdraw': {
      const team = text('team');
      if (!team.ok) return team;
      const goals = record.goals;
      if (typeof goals !== 'number' || !Number.isInteger(goals) || goals < 1) {
        return fail('"goals" must be the whole number of goals a walkover is awarded by');
      }
      return ok({ ...base, kind, team: team.value, goals });
    }
    case 'schedule': {
      const times = record.times;
      if (!times || typeof times !== 'object' || Array.isArray(times)) {
        return fail('"times" must be an object of fixture id -> ISO time');
      }
      for (const [fixtureId, at] of Object.entries(times as Record<string, unknown>)) {
        if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
          return fail(`"times.${fixtureId}" must be an ISO timestamp`);
        }
      }
      return ok({ ...base, kind, times: times as Record<string, string> });
    }
    case 'void-result': {
      const fixtureId = text('fixtureId');
      if (!fixtureId.ok) return fixtureId;
      const completedAt = text('completedAt');
      if (!completedAt.ok) return completedAt;
      // Which result, not just which fixture: a fixture that is voided, played
      // again and rewritten would otherwise have its new, good result dropped
      // by the record that disowned the old one.
      return ok({ ...base, kind, fixtureId: fixtureId.value, completedAt: completedAt.value });
    }
  }
}

/**
 * A fixture decided by a team going home.
 *
 * The same `walkoverResult` a referee's no-show produces, once per leg — which
 * is the shape a real walkover already has, because the pre-game verdict is
 * cached for the whole tie rather than re-asked per leg. Synthesised on every
 * read rather than written to disk: the record is the only mutable thing, so a
 * withdrawal can be undone by another record and nothing has to be unlinked.
 */
function walkoverFor(fixture: Fixture, absent: string, goals: number, at: string): FixtureResult {
  const home = fixture.home !== absent;
  const penalties = { violet: home ? goals : 0, lime: home ? 0 : goals };
  const reason = `${absent} withdrew — the match was awarded ${penalties.violet}-${penalties.lime}.`;
  const legs: LegRecord[] = fixture.seeds.map((seed) => ({
    seed,
    result: walkoverResult({ penalties, reason }),
  }));
  return {
    fixtureId: fixture.id,
    home: fixture.home,
    away: fixture.away,
    // Nothing was loaded, so no seat played any code. An empty map is what a
    // fixture of built-in agents looks like, and this is less than that.
    submissions: {},
    legs,
    completedAt: at,
  };
}

/**
 * The draw and the results as they actually stand, folded from the records.
 *
 * Applied strictly in order, which is what makes `restore` a plain cancellation
 * of an earlier `void` and what lets a team be substituted twice.
 */
export function foldTournament(
  draw: Draw,
  results: readonly FixtureResult[],
  amendments: readonly Amendment[],
): { draw: Draw; results: FixtureResult[] } {
  if (amendments.length === 0) return { draw, results: [...results] };

  const voided = new Set<string>();
  /** Results disowned, keyed by fixture id and the exact record they name. */
  const disowned = new Set<string>();
  const times = new Map<string, string>();
  /** Fixture id -> the walkover a withdrawal awards it. */
  const walkovers = new Map<string, FixtureResult>();
  const entrants = [...draw.entrants];
  let fixtures = draw.fixtures.map((f) => ({ ...f }));

  /**
   * Whether this fixture already happened, at the moment this record applies.
   *
   * A substitution rewrites who is *going* to play and never who did, so this
   * is asked per record rather than once — and a withdrawal awards walkovers
   * for the same set, which is the same question asked at the other end.
   */
  const played = (fixtureId: string): boolean =>
    results.some((r) => r.fixtureId === fixtureId && !disowned.has(`${r.fixtureId}@${r.completedAt}`)) ||
    walkovers.has(fixtureId);

  for (const amendment of amendments) {
    switch (amendment.kind) {
      case 'void':
        voided.add(amendment.fixtureId);
        break;
      case 'restore':
        voided.delete(amendment.fixtureId);
        break;
      case 'substitute': {
        if (!entrants.includes(amendment.replacement)) entrants.push(amendment.replacement);
        fixtures = fixtures.map((f) => {
          if (played(f.id) || voided.has(f.id)) return f;
          if (f.home === amendment.team) return { ...f, home: amendment.replacement };
          if (f.away === amendment.team) return { ...f, away: amendment.replacement };
          return f;
        });
        break;
      }
      case 'withdraw': {
        for (const fixture of fixtures) {
          if (played(fixture.id) || voided.has(fixture.id)) continue;
          if (fixture.home !== amendment.team && fixture.away !== amendment.team) continue;
          walkovers.set(
            fixture.id,
            walkoverFor(fixture, amendment.team, amendment.goals, amendment.at),
          );
        }
        break;
      }
      case 'schedule':
        for (const [fixtureId, at] of Object.entries(amendment.times)) times.set(fixtureId, at);
        break;
      case 'void-result':
        disowned.add(`${amendment.fixtureId}@${amendment.completedAt}`);
        // A result that no longer counts leaves its fixture unplayed, and an
        // unplayed fixture may be substituted or walked over again.
        walkovers.delete(amendment.fixtureId);
        break;
    }
  }

  const kept = fixtures
    .filter((f) => !voided.has(f.id))
    .map((f) => {
      const at = times.get(f.id);
      return at === undefined ? f : { ...f, playAt: at };
    });

  // Timed fixtures in time order, then untimed ones in the order the draw made
  // them. At a venue either everything has a time or nothing does; the mixed
  // case is a morning that has been scheduled and an afternoon that has not,
  // which reads as "the programme, then the rest".
  const order = new Map(kept.map((f, at) => [f.id, at]));
  const ordered = [...kept].sort((a, b) => {
    if (a.playAt && b.playAt) {
      const gap = Date.parse(a.playAt) - Date.parse(b.playAt);
      if (gap !== 0) return gap;
    } else if (a.playAt) return -1;
    else if (b.playAt) return 1;
    return order.get(a.id)! - order.get(b.id)!;
  });

  const folded = results.filter((r) => !disowned.has(`${r.fixtureId}@${r.completedAt}`));
  for (const walkover of walkovers.values()) {
    if (!folded.some((r) => r.fixtureId === walkover.fixtureId)) folded.push(walkover);
  }

  return {
    draw: { ...draw, entrants, fixtures: ordered },
    // In the effective draw's own fixture order, and only for fixtures it still
    // has — the same two promises `loadResults` makes, kept after the fold.
    results: ordered.flatMap((f) => folded.filter((r) => r.fixtureId === f.id)),
  };
}
