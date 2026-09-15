/**
 * Playing a draw through, resumably, several fixtures at a time.
 *
 * The loop is here and the football is not. `playLeg` is a callback because
 * that boundary is real rather than invented: a tournament at a venue spawns
 * two sandboxed submissions per side and streams the match to a hall, and a
 * test wants neither, but both play exactly the same sequence of fixtures and
 * both have to survive being killed halfway. Keeping the sequence separate from
 * the football is what lets the sequence be tested at all.
 *
 * Resuming is not a feature in here so much as a consequence: the loop asks
 * what has no result yet, so starting fresh and carrying on after a crash are
 * the same code path.
 *
 * **Several at once, with one rule.** A competition day is meaningfully shorter
 * the moment two fixtures can play at the same time, and the only constraint
 * the sport imposes is that no team may be in two of them: a team has two
 * robots, and two robots cannot be on two pitches. Everything else falls out of
 * that — the loop starts the first fixture whose teams are both free, and the
 * legs of one fixture still play in order, in the same arena.
 *
 * Nothing about resumability changes. A result is still written whole, once
 * every leg of a fixture has been played, so a hub killed with two fixtures in
 * flight writes neither and both are replayed as themselves.
 */

import type { MatchResult } from './match';
import type { SeedInput } from './rand';
import {
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
  playLeg: (fixture: Fixture, seed: SeedInput, leg: number) => Promise<PlayedLeg>;
  /** Called before a fixture's first leg, for logging. */
  onFixtureStart?: (fixture: Fixture, played: number, total: number) => void;
  /** Called once a fixture's result is safely on disk. */
  onFixtureDone?: (fixture: Fixture, result: FixtureResult) => void;
  /** Called when a fixture could not be played. It stays unwritten and replays. */
  onFixtureFailed?: (fixture: Fixture, error: Error) => void;
  /**
   * Carry on after a fixture that could not be played, rather than failing the
   * whole run.
   *
   * Off by default, and that default is the important half: a batch
   * `tournament` that swallowed a broken fixture would print a table with a
   * hole in it and say nothing. A venue's league server sets it, because its
   * front door must not fall over because one match did — the schedule keeps
   * going and the unwritten fixture is replayed on the next run.
   *
   * Either way the other fixtures in flight are played out rather than
   * abandoned: they are real matches with people watching them.
   */
  continueOnFailure?: boolean;
  /**
   * How many fixtures may be in flight at once.
   *
   * One by default, which is what every caller before Phase 7 wanted and what
   * a laptop still wants. A venue sets it from its arena budget, and a fixture
   * never queues behind a rehearsal because those slots are held separately.
   */
  slots?: number;
  /**
   * The conditions of play, recorded against every result this run writes.
   *
   * A venue playing at 25% seat grants is playing a different game from one at
   * 50%, so it belongs in the record beside the seed and the code hashes.
   */
  conditions?: FixtureResult['conditions'];
}

export async function runDraw(
  root: string,
  draw: Draw,
  opts: RunOptions,
): Promise<FixtureResult[]> {
  const results = await loadResults(root, draw);
  const slots = Math.max(1, opts.slots ?? 1);

  /** In flight now, by fixture id. */
  const playing = new Map<string, Promise<void>>();
  /** Teams currently on a pitch. A team has two robots and cannot be in two. */
  const busy = new Set<string>();
  /**
   * Fixtures that could not be played in this run.
   *
   * Left unwritten, so a later run replays them from the start — but not
   * retried here, because a fixture that fails for a reason that has not gone
   * away would otherwise be retried forever.
   */
  const failed = new Map<string, Error>();

  /** The first fixture with no result, not in flight, whose teams are free. */
  const startable = (): Fixture | null => {
    const played = new Set(results.map((r) => r.fixtureId));
    return (
      draw.fixtures.find(
        (f) =>
          !played.has(f.id) &&
          !playing.has(f.id) &&
          !failed.has(f.id) &&
          !busy.has(f.home) &&
          !busy.has(f.away),
      ) ?? null
    );
  };

  const play = async (fixture: Fixture): Promise<void> => {
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
      ...(opts.conditions ? { conditions: opts.conditions } : {}),
    };

    // On disk before it counts. Everything above this line is replayable;
    // nothing below it is reached twice.
    await saveResult(root, draw, result);
    results.push(result);
    opts.onFixtureDone?.(fixture, result);
  };

  for (;;) {
    while (playing.size < slots) {
      const fixture = startable();
      if (!fixture) break;
      busy.add(fixture.home);
      busy.add(fixture.away);
      const running = play(fixture)
        .catch((error: unknown) => {
          // One fixture failing is not the tournament failing. It is left
          // unwritten — which is exactly what an abandoned fixture looks like
          // — reported, and replayed on the next run.
          failed.set(fixture.id, error as Error);
          opts.onFixtureFailed?.(fixture, error as Error);
        })
        .finally(() => {
          playing.delete(fixture.id);
          busy.delete(fixture.home);
          busy.delete(fixture.away);
        });
      playing.set(fixture.id, running);
    }

    if (playing.size === 0) break;
    // Whichever finishes first frees its teams and its slot, so the next
    // fixture can start without waiting for the other one still playing.
    await Promise.race(playing.values());
  }

  // Every fixture that could survive has been played by now, including the ones
  // that were in flight alongside a failure. Only then is the failure raised,
  // so one broken match never costs another its result.
  if (failed.size > 0 && !opts.continueOnFailure) {
    const said = [...failed].map(([id, error]) => `${id}: ${error.message}`).join('; ');
    throw new Error(
      `${failed.size} fixture${failed.size === 1 ? '' : 's'} could not be played — ${said}`,
    );
  }

  return results;
}
