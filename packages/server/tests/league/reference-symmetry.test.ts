/**
 * The reference agent, asked the same question from recorded play.
 *
 * `symmetry.test.ts` already asserts this agent is rotationally symmetric, and
 * it passes. It builds its own poses, though, and invented poses do not reach
 * the states a match reaches: this same check run against recorded matches
 * found 34 ticks where the keeper commanded different motors at the two ends.
 *
 * The cause was worth the trouble of finding, because it is not the kind of
 * mistake reading the code finds. `Math.atan2(0, this.attackX - me.x)` is a
 * correct way to say "which way is up the field" for every value of `me.x` but
 * one - and `locate` clamps its answer to ±HALF_LENGTH, the exact constant
 * `attackX` is built from, so a keeper whose position estimate has collapsed
 * onto the wall hands it `atan2(0, 0)`. That is 0 at both ends, where the two
 * ends need answers PI apart.
 *
 * A fifth of a second of a lost keeper, 34 ticks in 12,000. No scoreline was
 * ever going to show it, and neither was a test that only visits poses somebody
 * thought to write down. This file is the regression, and the reason the check
 * runs off recordings.
 */

import { describe, expect, it } from 'bun:test';
import { Match, type MatchAgents } from '../../src/match/match';
import { ReferenceAgent } from '../../src/infra/reference';
import { RecordingAgent, checkSymmetry, type SeatRecording } from '../../src/sim/symmetry';

const SEEDS = [1, 2, 3];
const HALF_SECONDS = 40;

const reference = (number: 1 | 2, team: 'violet' | 'lime' = 'violet'): ReferenceAgent =>
  new ReferenceAgent({ team, number, role: number === 2 ? 'goalie' : 'striker' });

function record(): SeatRecording[] {
  const seats: SeatRecording[] = [
    { id: 'violet-1', number: 1, frames: [] },
    { id: 'violet-2', number: 2, frames: [] },
  ];

  for (const seed of SEEDS) {
    const taped = seats.map((seat) => new RecordingAgent(reference(seat.number as 1 | 2)));
    const agents = {
      'violet-1': taped[0],
      'violet-2': taped[1],
      'lime-1': reference(1, 'lime'),
      'lime-2': reference(2, 'lime'),
    } as unknown as MatchAgents;

    new Match({ agents, halfSeconds: HALF_SECONDS, seed }).run();
    seats.forEach((seat, i) => seat.frames.push(...taped[i]!.frames));
  }
  return seats;
}

describe('the reference agent plays the same game at both ends', () => {
  const seats = record();

  it('commands identical motor powers replaying real matches rotated', () => {
    const report = checkSymmetry(seats, (seat) => reference(seat.number as 1 | 2));
    const where = report.divergences
      .slice(0, 5)
      .map((d) => `${d.seat} t=${d.tick} ${d.what}: ${d.upright} vs ${d.rotated}`)
      .join('\n  ');
    expect(where).toBe('');
    expect(report.ticks).toBeGreaterThan(10000);
  });

  it('holds up seat by seat, with no team radio to carry the difference', () => {
    // A single seat gets no messages during replay, so a divergence that
    // survives here is the program's own geometry rather than anything it was
    // told. Worth separating: the keeper bug above showed up identically with
    // and without the radio, and knowing that first saved chasing the radio.
    for (const seat of seats) {
      const solo = checkSymmetry([seat], (s) => reference(s.number as 1 | 2));
      expect({ seat: seat.id, divergences: solo.divergences.length }).toEqual({
        seat: seat.id,
        divergences: 0,
      });
    }
  });
});
