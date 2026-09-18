/**
 * What a late team costs, and what a fixture nobody turned up for looks like.
 *
 * The pre-game room itself is in `league.ts` — who has arrived, which seats are
 * filled, and the gate a referee opens. This is the arithmetic of the clock
 * that can run inside it and the record it can produce, kept apart for the same
 * reason `occupancy.ts` and `capacity.ts` are: both are pure, both are worth
 * testing without a server, and `league.ts` is long enough.
 *
 * **Nothing accrues on its own.** A referee starts the clock, because the
 * referee is the only one who can see whether a delay is the team's fault or
 * the venue's network. What the clock does is bounded by the mercy rule — once
 * the goals it has awarded reach that margin there is no match left to play,
 * and the fixture is decided without one.
 *
 * **A walkover is an ordinary result.** Not an abandonment, which `runDraw`
 * leaves unwritten and replays, and not a special case anywhere downstream: it
 * is a `MatchResult` with a scoreline, no goals, no clock, and the two score
 * corrections that say why. The table, the front page and the result file all
 * read it without knowing it was never played — and it still passes the
 * referee's confirmation, so a team that turns up a minute late is somebody
 * pressing *play it again* rather than an argument.
 */

import type { MatchResult } from './match';
import type { TeamId } from './world';

/** Goals owed, by side. Violet is the home team, as everywhere else. */
export interface Penalties {
  violet: number;
  lime: number;
}

/** How the pre-game gate ended. */
export type PregameVerdict =
  | { kind: 'play'; penalties: Penalties }
  | { kind: 'walkover'; penalties: Penalties; reason: string };

export const NO_PENALTIES: Penalties = { violet: 0, lime: 0 };

/**
 * Whole minutes between `since` and `now`, and nothing else.
 *
 * Whole, because a checklist polled every two seconds and a result written
 * whenever a referee gets to it must never be able to disagree about a
 * half-minute — and rounding down is the only version of that a team being
 * penalised would accept.
 *
 * It is the *unit of banking* rather than a running total, which is what makes
 * the clock safe to stop: a minute that has elapsed is awarded to whoever was
 * owed it at the time and never recomputed. A total worked out from the start
 * time on every read would hand the goals back the moment the late team walked
 * in, which is precisely backwards.
 */
export function wholeMinutes(since: string, now: number): number {
  const elapsed = now - Date.parse(since);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.floor(elapsed / 60_000);
}

/** Goals those minutes are worth. */
export function penaltyGoals(since: string, now: number, perMin: number): number {
  if (perMin <= 0) return 0;
  return wholeMinutes(since, now) * perMin;
}

/** Whether these penalties have already settled the fixture. */
export function decided(penalties: Penalties, margin: number | null): boolean {
  if (margin === null) return false;
  return Math.abs(penalties.violet - penalties.lime) >= margin;
}

export interface WalkoverOptions {
  penalties: Penalties;
  /** Why, in a sentence a team can be shown. */
  reason: string;
}

/**
 * A fixture decided without football.
 *
 * `clock: 0` and no goals, because none were scored: the scoreline is entirely
 * corrections, and each one carries the reason. `mercy` rather than `abandoned`
 * — this counts, and a table wants to be able to say which of the two a short
 * match was.
 */
export function walkoverResult({ penalties, reason }: WalkoverOptions): MatchResult {
  const at = 0;
  const corrections = (['violet', 'lime'] as const)
    .filter((team) => penalties[team] > 0)
    .map((team: TeamId) => ({ team, from: 0, to: penalties[team as 'violet' | 'lime'], reason, at }));

  return {
    score: { violet: penalties.violet, lime: penalties.lime },
    clock: at,
    goals: [],
    slots: {},
    calls: {},
    events: [
      {
        kind: 'mercy',
        rule: '—',
        message: reason,
        at,
      },
    ],
    refereeActions: [{ action: 'walkover', at, detail: reason }],
    scoreCorrections: corrections,
    abandoned: false,
    mercy: true,
  };
}
