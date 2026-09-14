/**
 * Playing a draw through, one fixture at a time, resumably.
 *
 * The loop is here and the football is not. `playLeg` is a callback because
 * that boundary is real rather than invented: a tournament at a venue spawns
 * two sandboxed submissions per side and streams the match to a hall, and a
 * test wants neither, but both play exactly the same sequence of fixtures and
 * both have to survive being killed halfway. Keeping the sequence separate from
 * the football is what lets the sequence be tested at all.
 *
 * Resuming is not a feature in here so much as a consequence: the loop asks
 * `nextFixture` what has no result yet, so starting fresh and carrying on after
 * a crash are the same code path.
 */

import type { MatchResult } from './match';
import {
  nextFixture,
  type Draw,
  type Fixture,
  type FixtureResult,
  type LegRecord,
} from './tournament';
import { loadResults, saveResult } from './tournament-store';

export interface PlayedLeg {
  result: MatchResult;
  /** sha256 per seat id, for whichever seats a real submission filled. */
  submissions: Record<string, string>;
}

export interface RunOptions {
  /** Play one leg of a fixture. Home is violet, away is lime. */
  playLeg: (fixture: Fixture, seed: number, leg: number) => Promise<PlayedLeg>;
  /** Called before a fixture's first leg, for logging. */
  onFixtureStart?: (fixture: Fixture, played: number, total: number) => void;
  /** Called once a fixture's result is safely on disk. */
  onFixtureDone?: (fixture: Fixture, result: FixtureResult) => void;
}

export async function runDraw(
  root: string,
  draw: Draw,
  opts: RunOptions,
): Promise<FixtureResult[]> {
  const results = await loadResults(root, draw);

  for (;;) {
    const fixture = nextFixture(draw, results);
    if (!fixture) break;

    opts.onFixtureStart?.(fixture, results.length, draw.fixtures.length);

    const legs: LegRecord[] = [];
    // Hashes are taken per leg and the last one wins, because a leg is the
    // only moment the code is known to have been loaded. They cannot differ
    // within a fixture in practice — a push between legs would have to race
    // the match — and if they ever did, what played last is the honest answer.
    let submissions: Record<string, string> = {};

    for (const [leg, seed] of fixture.seeds.entries()) {
      const played = await opts.playLeg(fixture, seed!, leg);
      legs.push({ seed: seed!, result: played.result });
      submissions = played.submissions;
    }

    const result: FixtureResult = {
      fixtureId: fixture.id,
      home: fixture.home,
      away: fixture.away,
      submissions,
      legs,
      completedAt: new Date().toISOString(),
    };

    // On disk before it counts. Everything above this line is replayable;
    // nothing below it is reached twice.
    await saveResult(root, draw, result);
    results.push(result);
    opts.onFixtureDone?.(fixture, result);
  }

  return results;
}
