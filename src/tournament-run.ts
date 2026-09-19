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
 *
 * **And once somebody agrees it.** `confirmResult` sits between the last leg and
 * the write, so at a venue a result is a decision rather than the side effect of
 * a clock running out. Three things now leave a fixture unwritten and therefore
 * replayable, and they are deliberately different: a referee abandoning it, a
 * referee declining it at full time (replayed in this run), and the run dying
 * (replayed on the next one).
 *
 * **And only once somebody opens it.** `openPregame` sits the other side of the
 * match, before anything is spawned, so a pitch comes up when a referee is
 * standing at it rather than when the loop gets round to it. That forces a
 * distinction this file did not used to make: being **eligible** — your turn has
 * come, your teams are free — is not the same as **occupying a slot**. A fixture
 * waiting for a referee costs a venue nothing, and a venue with three pitches
 * runs three of them however slow one referee is.
 */

import type { MatchResult } from './match';
import type { SeedInput } from './rand';
import {
  type Draw,
  type Fixture,
  type FixtureResult,
  type LegRecord,
} from './tournament';
import { loadResults, loadTournament, saveResult } from './tournament-store';

export interface PlayedLeg {
  result: MatchResult;
  /** sha256 per seat id, for whichever seats a real submission filled. */
  submissions: Record<string, string>;
  /** The same for the second half, when half-time changed it. See `LegRecord`. */
  secondHalf?: Record<string, string>;
}

/** A referee's answer at full time: write this down, or play it again. */
export type Confirmation = 'confirmed' | 'replay';

export interface RunOptions {
  /** Play one leg of a fixture. Home is violet, away is lime. */
  playLeg: (fixture: Fixture, seed: SeedInput, leg: number) => Promise<PlayedLeg>;
  /**
   * Agreed by a human before it counts.
   *
   * Nothing is on disk until this resolves with `confirmed`, which is what makes
   * a result a decision rather than a consequence of a clock running out. Left
   * out — a batch `tournament`, every test that does not care — a fixture still
   * commits itself the moment its last leg ends, exactly as before.
   *
   * `replay` writes nothing and hands the fixture back to the loop, which plays
   * it again in this same run. Throwing leaves it unwritten too, but as a
   * failure: not retried here, replayed on the next run.
   */
  confirmResult?: (fixture: Fixture, result: FixtureResult) => Promise<Confirmation>;
  /**
   * Opened by a human before anything is spawned.
   *
   * The mirror of `confirmResult`, at the other end of the match: nothing
   * exists until this resolves — no arena, no child process, no sandboxed
   * interpreters — so a fixture whose referee has not arrived costs the venue
   * nothing at all. Left out, a fixture is played the moment its turn comes,
   * exactly as before, which is what a batch `tournament` and every test want.
   *
   * Resolving `'dropped'` **recalls the offer**: this fixture is not the
   * fixture it was when it went out — voided, or substituted under new names —
   * so it is not played, not failed, and its teams are free at once. The loop
   * decides whether a fresh offer goes out, by asking the draw as it now
   * stands. That is how a correction made at eleven in the morning reaches a
   * schedule that started at nine.
   *
   * Throwing leaves the fixture unwritten and unplayed, as a failure.
   */
  openPregame?: (fixture: Fixture) => Promise<void | 'dropped'>;
  /** Called when a fixture's turn has come and it is waiting to be opened. */
  onFixtureDue?: (fixture: Fixture) => void;
  /** Called once a fixture has a pitch and is about to play its first leg. */
  onFixtureStart?: (fixture: Fixture, played: number, total: number) => void;
  /** Called once a fixture's result is safely on disk. */
  onFixtureDone?: (fixture: Fixture, result: FixtureResult) => void;
  /** Called when a played fixture was sent back to be played again. */
  onFixtureReplay?: (fixture: Fixture) => void;
  /** Called when an offer was recalled because the draw was corrected under it. */
  onFixtureDropped?: (fixture: Fixture) => void;
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
  /**
   * Whether a fixture is one somebody has given up on — asked, not snapshotted.
   *
   * Handing this over moves the whole decision to the caller: this loop reports
   * failures through `onFixtureFailed` and stops deciding for itself which of
   * them to offer again. A caller that supplies it **must** add a fixture when
   * it is told one failed, or a match that cannot be played is offered forever.
   *
   * It is asked on every pass rather than read once, and that is the point. A
   * league server holds the set, so an organiser pressing *play it again*
   * halfway through a competition day puts the fixture back into **this** run
   * rather than the next one — which, given that there may not be a next one,
   * is the difference between the button working and not.
   */
  skip?: { has(fixtureId: string): boolean };
  /**
   * Resolves when the caller thinks this loop should look again.
   *
   * Raced against the fixtures in flight. Without it the loop only reconsiders
   * when a match ends, so a fixture taken back out of `skip` while every other
   * offer is sitting with a referee would wait for one of them to finish.
   */
  poke?: () => Promise<unknown>;
}

export async function runDraw(
  root: string,
  draw: Draw,
  opts: RunOptions,
): Promise<FixtureResult[]> {
  const results = await loadResults(root, draw);
  const slots = Math.max(1, opts.slots ?? 1);

  /**
   * The draw as it stands right now, corrections and all.
   *
   * Re-read rather than closed over, because a competition day is corrected
   * while it runs: a team goes home at lunch and their remaining fixtures stop
   * being fixtures. Before this, the loop played the draw it was handed at nine
   * in the morning whatever anybody appended to it afterwards.
   *
   * A re-read that fails leaves the last good view in place. A venue's schedule
   * must not stop because a file was caught half-written, and a record that
   * will not parse is already shouted about by every screen that reads one.
   */
  let effective: { draw: Draw; results: FixtureResult[] } = { draw, results };
  const refresh = async (): Promise<boolean> => {
    try {
      const fresh = await loadTournament(root, draw.id);
      effective = { draw: fresh.draw, results: fresh.results };
      return true;
    } catch {
      // Keep playing what we were playing.
      return false;
    }
  };

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
   *
   * Only what failed *here*, which is what the failure raised at the end
   * reports. Whether a failed fixture is offered again is `givenUp`'s
   * question, and a caller that supplies `skip` answers it instead.
   */
  const failed = new Map<string, Error>();
  /**
   * Whether this run has stopped offering a fixture.
   *
   * The caller's answer when it gave one, and this run's own otherwise. Both
   * halves matter: a batch `tournament` wants the old behaviour exactly, and a
   * venue wants somebody to be able to change the answer while the day runs.
   */
  const givenUp = (id: string): boolean => (opts.skip ? opts.skip.has(id) : failed.has(id));

  /**
   * The first fixture with no result, not in flight, whose teams are free.
   *
   * Asked of the effective draw, so a voided fixture is not there to be found
   * and a withdrawn team's fixtures already have walkovers against them. The
   * run's own results are added to what the fold says, because a result written
   * a moment ago may not have been re-read yet.
   */
  const startable = (): Fixture | null => {
    const played = new Set([...effective.results, ...results].map((r) => r.fixtureId));
    return (
      effective.draw.fixtures.find(
        (f) =>
          !played.has(f.id) &&
          !playing.has(f.id) &&
          !givenUp(f.id) &&
          !busy.has(f.home) &&
          !busy.has(f.away),
      ) ?? null
    );
  };

  /**
   * The pitches, handed straight from one fixture to the next.
   *
   * A slot used to be taken by the scheduler the instant a fixture started,
   * which was the same moment it was spawned and so cost nothing to conflate.
   * With a referee in front of the spawn they are different moments, and a
   * fixture that is merely waiting to be opened must not be holding a pitch —
   * otherwise one slow referee closes a field. Hand-off rather than a counter,
   * so the fixture whose referee pressed first gets the next free pitch.
   */
  const queue: (() => void)[] = [];
  let onPitch = 0;
  const takeSlot = async (): Promise<void> => {
    if (onPitch < slots) {
      onPitch += 1;
      return;
    }
    await new Promise<void>((go) => queue.push(go));
  };
  const releaseSlot = (): void => {
    const next = queue.shift();
    if (next) next();
    else onPitch -= 1;
  };

  const playOut = async (fixture: Fixture): Promise<void> => {
    opts.onFixtureStart?.(fixture, results.length, draw.fixtures.length);

    const legs: LegRecord[] = [];
    // Hashes are taken per leg and the last one wins, because a leg is the
    // only moment the code is known to have been loaded. They cannot differ
    // within a fixture in practice — a push between legs would have to race
    // the match — and if they ever did, what played last is the honest answer.
    let submissions: Record<string, string> = {};

    for (const [leg, seed] of fixture.seeds.entries()) {
      const played = await opts.playLeg(fixture, seed!, leg);
      // An abandoned leg is not a leg. A referee who calls a match off has said
      // it did not happen, and until now the scoreline on the board at that
      // moment was written down and counted like any other — nothing outside
      // `match.ts` ever read this flag. Failing here is what leaves the fixture
      // unwritten, which is exactly what an abandoned fixture should look like.
      if (played.result.abandoned) {
        const why = played.result.abandonReason ?? 'no reason given';
        throw new Error(`the match was abandoned (${why})`);
      }
      legs.push({
        seed: seed!,
        result: played.result,
        ...(played.secondHalf ? { secondHalf: played.secondHalf } : {}),
      });
      // The code each seat *started* on, which is what the fixture-level map
      // has always meant. A half-time change lives on the leg it happened in,
      // because that is the only place it is true of.
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

    // Agreed by a human before it counts. A clock running out is not a result;
    // somebody saying so is. Whoever is asked holds the fixture — and its slot,
    // and its arena — until they answer, which is the honest cost of the rule.
    if (opts.confirmResult) {
      const verdict = await opts.confirmResult(fixture, result);
      if (verdict === 'replay') {
        // Nothing written and nothing failed, so `startable()` finds this
        // fixture again on the loop's next pass — it has no result, it is no
        // longer in flight, and it was never added to `failed`. That is the
        // whole of "play it again": the match is re-run this afternoon rather
        // than noted for the next boot.
        opts.onFixtureReplay?.(fixture);
        return;
      }
    }

    // On disk before it counts. Everything above this line is replayable;
    // nothing below it is reached twice.
    await saveResult(root, draw, result);
    results.push(result);
    opts.onFixtureDone?.(fixture, result);
  };

  const play = async (fixture: Fixture): Promise<void> => {
    // Nobody is on this pitch until somebody says so. Deliberately before the
    // slot is taken: what a venue is short of is arenas, and a fixture waiting
    // for its referee is not running one.
    if (opts.openPregame) {
      opts.onFixtureDue?.(fixture);
      // A recalled offer is not a played fixture and not a failed one. Nothing
      // was spawned and no slot was taken, so there is nothing to undo: the
      // teams go free with the `finally` every ending shares, and the loop asks
      // the corrected draw what to offer instead.
      if ((await opts.openPregame(fixture)) === 'dropped') {
        opts.onFixtureDropped?.(fixture);
        return;
      }
    }

    await takeSlot();
    try {
      await playOut(fixture);
    } finally {
      releaseSlot();
    }
  };

  /**
   * At most one outstanding poke, reused across passes.
   *
   * A fresh promise per pass would leave every earlier one unsettled for the
   * length of a competition day; this one is nulled when it fires, so the next
   * pass makes another and no more than one is ever waiting.
   */
  let poked: Promise<void> | null = null;
  const waitingOnAPoke = (): Promise<void>[] => {
    if (!opts.poke) return [];
    poked ??= opts.poke().then(() => {
      poked = null;
    });
    return [poked];
  };

  // Everything eligible is offered; how many of them are *played* at once is
  // the slot semaphore's business. Without a referee in front of the spawn the
  // two are the same thing, and bounding the offer by `slots` keeps a batch
  // `tournament` behaving exactly as it always has rather than merely
  // equivalently.
  const offerLimit = opts.openPregame ? Number.POSITIVE_INFINITY : slots;

  for (;;) {
    // What is worth offering is a question about the draw as it stands, so the
    // draw is re-read before it is asked — once a pass, not once a fixture.
    await refresh();
    while (playing.size < offerLimit) {
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
    // Blocking here forever is the right answer, not a hang: if everything
    // eligible has been offered and no referee has opened any of it, there is
    // nothing this loop could usefully do instead.
    await Promise.race([...playing.values(), ...waitingOnAPoke()]);
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

  // The tournament as it stands, not merely what this run wrote: a withdrawal's
  // walkovers count and a disowned result does not, so the table a caller
  // prints when the draw finishes is the table `rcja table` prints a second
  // later. Falls back to this run's own results if the last re-read failed.
  return (await refresh()) ? effective.results : results;
}
