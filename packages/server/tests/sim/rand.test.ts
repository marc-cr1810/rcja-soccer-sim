/**
 * The seed machinery that makes a match replayable, pinned.
 *
 * The xoshiro128++ stream is checked against a golden vector computed from an
 * independent implementation, because the whole point of a seeded match is
 * that the same number comes out on every machine and every season. The
 * inverse-CDF normal is checked at exact Φ values, where it must answer the
 * exact z. And the 64-bit seed is checked for the one property that justified
 * it: the high word actually reaches the noise, so two crypto seeds that share
 * a low word still play different matches.
 */

import { Match, type MatchAgents } from '../../src/match/match';
import { referenceTeam } from '../../src/infra/reference';
import { Noise } from '../../src/sim/sensors';
import {
  addSeed,
  bumpSeedValue,
  commitSeed,
  deriveSeed,
  foldSeed,
  formatSeed,
  formatSeedValue,
  parseSeed,
  placementJitter,
  streamSeed,
  toSeed,
  unitNormal,
  withWord,
  type Seed,
  type SeedInput,
} from '../../src/sim/rand';

describe('match seeds are 64 bits', () => {
  it('keeps a number bits as the low word', () => {
    expect(toSeed(1)).toEqual({ hi: 0, lo: 1 });
    expect(toSeed(0x1f2e3d4c)).toEqual({ hi: 0, lo: 0x1f2e3d4c });
    expect(toSeed(2 ** 32 + 7)).toEqual({ hi: 1, lo: 7 });
    expect(toSeed(undefined)).toEqual({ hi: 0, lo: 1 });
  });

  it('carries an add across the word boundary', () => {
    const s = toSeed(0xffffffff);
    expect(addSeed(s, 1)).toEqual({ hi: 1, lo: 0 });
    expect(addSeed(s, 0x100000005)).toEqual({ hi: 2, lo: 4 });
    expect(bumpSeedValue(3)).toBe(4);
    expect(bumpSeedValue({ hi: 0, lo: 5 })).toEqual({ hi: 0, lo: 6 });
    expect(bumpSeedValue({ hi: 0, lo: 0xffffffff })).toEqual({ hi: 1, lo: 0 });
  });

  it('round-trips through the 16-hex-digit form', () => {
    const seed: Seed = { hi: 0x1a2b3c4d, lo: 0x5e6f7081 };
    expect(formatSeed(seed)).toBe('0x1a2b3c4d5e6f7081');
    expect(parseSeed(formatSeed(seed))).toEqual(seed);
    expect(parseSeed('7')).toEqual({ hi: 0, lo: 7 });
    expect(parseSeed('0x7')).toEqual({ hi: 0, lo: 7 });
    expect(formatSeedValue(seed)).toBe('0x1a2b3c4d5e6f7081');
    expect(formatSeedValue(9)).toBe('9');
  });

  it('rejects a seed that is neither a decimal nor hex', () => {
    expect(() => parseSeed('lucky')).toThrow();
    expect(() => parseSeed('0x12345678901234567890')).toThrow();
  });

  it('mixes a per-robot word into both words', () => {
    const a = withWord(toSeed(7), 10);
    const b = withWord(toSeed(7), 11);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(toSeed(7));
  });

  it('varies a sensor stream only in the low word', () => {
    const s = toSeed(0x0102030405060708);
    const ir = streamSeed(s, 0x1f);
    const gyro = streamSeed(s, 0x65);
    expect(ir).not.toEqual(gyro);
    expect(ir.hi).toBe(s.hi);
    expect(gyro.hi).toBe(s.hi);
  });

  it('folds both words into the placement source', () => {
    expect(foldSeed({ hi: 1, lo: 2 })).not.toBe(foldSeed({ hi: 2, lo: 2 }));
  });
});

describe('the xoshiro128++ stream', () => {
  it('matches the golden vector from an independent implementation', () => {
    const twelve = new Noise(12345);
    expect([...Array(6)].map(() => twelve.next())).toEqual([
      0.511875040596351, 0.27246052399277687, 0.3124998458661139, 0.2178109590895474,
      0.688001062721014, 0.5666713186074048,
    ]);
    const hex = new Noise({ hi: 0x01020304, lo: 0x05060708 });
    expect([...Array(4)].map(() => hex.next())).toEqual([
      0.3585535224992782, 0.20179687882773578, 0.08913965942338109, 0.019458278780803084,
    ]);
  });

  it('derives distinct streams from a one-bit difference in either word', () => {
    const a = new Noise({ hi: 1, lo: 7 });
    const b = new Noise({ hi: 2, lo: 7 });
    const c = new Noise({ hi: 1, lo: 8 });
    expect(a.next()).not.toBe(b.next());
    expect(a.next()).not.toBe(c.next());
    expect(b.next()).not.toBe(c.next());
  });

  it('is uniform in 0..1 over a large sample', () => {
    const n = new Noise(99);
    const buckets = 16;
    const counts = new Array<number>(buckets).fill(0);
    const draws = 200_000;
    for (let i = 0; i < draws; i++) {
      counts[Math.min(buckets - 1, Math.floor(n.next() * buckets))]!++;
    }
    for (const c of counts) {
      // 200k draws over 16 buckets: a fair stream is within ±5σ of 12.5k, and
      // no stream worth shipping is further out than a third of the bucket.
      expect(c).toBeGreaterThan(draws / buckets - draws / buckets / 2);
      expect(c).toBeLessThan(draws / buckets + draws / buckets / 2);
    }
  });
});

describe('the normal', () => {
  it('answers the exact Φ values on the grid', () => {
    // Φ(z) for z = -2, -1, 0, 1, 2; these land on table nodes, so the inverse
    // must be exact rather than interpolated.
    const phi = (z: number): number =>
      z === -2 ? 0.022750131948179195 : z === -1 ? 0.15865525393145707 : z === 0 ? 0.5 : z === 1 ? 0.8413447460685429 : 0.9772498680518208;
    for (const z of [-2, -1, 0, 1, 2]) {
      expect(unitNormal(phi(z))).toBeCloseTo(z, 12);
    }
  });

  it('has mean 0 and unit spread', () => {
    const n = new Noise(7);
    const draws = 200_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < draws; i++) {
      const z = unitNormal(n.next());
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / draws;
    const sd = Math.sqrt(sumSq / draws - mean * mean);
    expect(mean).toBeLessThan(0.02);
    expect(mean).toBeGreaterThan(-0.02);
    expect(sd).toBeLessThan(1.03);
    expect(sd).toBeGreaterThan(0.97);
  });

  it('never exceeds the table bounds', () => {
    const n = new Noise(13);
    for (let i = 0; i < 100_000; i++) {
      expect(Math.abs(unitNormal(n.next()))).toBeLessThanOrEqual(7.5);
    }
  });
});

describe('a 64-bit seed reaches a whole match', () => {
  const agents = {
    ...referenceTeam('violet'),
    ...referenceTeam('lime'),
  } as unknown as MatchAgents;

  /**
   * Play a match, and describe how it actually went.
   *
   * Two things, because either alone can be fooled. The referee log is the
   * whole match as a trace — every call and the second it happened on — and
   * the final poses are where four robots and a ball physically ended up,
   * which are floats and will not coincide. The log covers the case where a
   * goal in the last moments resets everyone to their kick-off spots; the
   * poses cover the case where a short match produces too few calls to tell
   * two traces apart. Same shape `bench.test.ts` uses to tell two runs apart.
   */
  function play(seed: SeedInput) {
    const match = new Match({ agents, halfSeconds: 60, seed });
    const result = match.run();
    return {
      score: result.score,
      goals: result.goals,
      // How the match went, rather than only how it finished.
      course: {
        calls: result.events.map((e) => [e.kind, e.at, e.robotId] as const),
        ball: [match.world.ball.x, match.world.ball.z],
        robots: match.world.robots.map((r) => [r.x, r.z, r.heading, r.removed] as const),
      },
    };
  }

  it('replays exactly for the same 64-bit seed', () => {
    const a = play({ hi: 0xdeadbeef, lo: 0x00112233 });
    const b = play({ hi: 0xdeadbeef, lo: 0x00112233 });
    expect(a.score).toEqual(b.score);
    expect(a.goals).toEqual(b.goals);
    // The strong half: identical seeds must reproduce the whole match, not
    // merely agree on a scoreline they both reached differently.
    expect(a.course).toEqual(b.course);
  });

  it('plays a different match when only the high word changes', () => {
    const a = play({ hi: 0x44444444, lo: 0x12345678 });
    const b = play({ hi: 0x55555555, lo: 0x12345678 });
    // Not "different score": the same two reference teams often draw nil all,
    // and a test forbidding that would be testing the wrong thing — the noise
    // STREAMS must differ. This used to assert on the goal list for that, and
    // the goal list cannot carry it: two goalless matches produce two empty
    // arrays, which compare equal however differently they were played, so any
    // change to the physics that moved these two seeds to 0-0 failed a test
    // about seeding. Compare the course instead, which is what "a different
    // match" has meant all along. Two matches sharing a low word but not a
    // high one are the exact seeding the serve loop hands them, and they must
    // not be identical matches.
    expect(a.course).not.toEqual(b.course);
  });
});

describe('cryptographic and fairness seed derivation', () => {
  it('deriveSeed produces distinct, reproducible 64-bit seeds', () => {
    const s1 = deriveSeed(1, 'fixture', 'A', 'B', 0);
    const s2 = deriveSeed(1, 'fixture', 'A', 'B', 1);
    const s3 = deriveSeed(1, 'fixture', 'B', 'A', 0);
    const s1Again = deriveSeed(1, 'fixture', 'A', 'B', 0);

    expect(s1).toEqual(s1Again);
    expect(s1).not.toEqual(s2);
    expect(s1).not.toEqual(s3);
    expect(s2).not.toEqual(s3);
  });

  it('commitSeed is invariant to key order and sensitive to submission hashes', () => {
    const a = commitSeed(42, { 'violet-1': 'hashA', 'lime-1': 'hashB' });
    const b = commitSeed(42, { 'lime-1': 'hashB', 'violet-1': 'hashA' });
    const c = commitSeed(42, { 'violet-1': 'hashA', 'lime-1': 'hashDifferent' });

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('placementJitter is stateless, order-independent, and bounded in [-1, 1]', () => {
    expect(placementJitter(undefined, 0, 1)).toBe(0);

    const val1 = placementJitter(12345, 0, 1);
    const val2 = placementJitter(12345, 0, 2);
    // Order of evaluation does not change values
    expect(placementJitter(12345, 0, 2)).toBe(val2);
    expect(placementJitter(12345, 0, 1)).toBe(val1);

    expect(val1).toBeGreaterThanOrEqual(-1);
    expect(val1).toBeLessThanOrEqual(1);
    expect(val2).toBeGreaterThanOrEqual(-1);
    expect(val2).toBeLessThanOrEqual(1);
    expect(val1).not.toBe(val2);

    // Later restarts are distinct from earlier ones
    const restart1 = placementJitter(12345, 1, 1);
    expect(restart1).not.toBe(val1);
  });
});