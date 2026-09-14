/**
 * Match seeds, and the deterministic mixer that fans one out into noise.
 *
 * A seed fixes everything random in a match — restart placement and every
 * noise stream of every robot — so that a result can be replayed and a protest
 * checked against the record that was actually played. A competition match gets
 * its randomness from `randomBytes(8)` arriving here as 64 fresh bits; a plain
 * number is the compact form everyone writes by hand, and its bits ARE the
 * seed's low word (high word zero). Nothing here consults a wall clock or a
 * global `Math` source: the same `Seed` always produces the same numbers out.
 */

/**
 * The two 16-hex-digit hex seeds the CLI accepts and prints, as a pair of
 * 32-bit words. Stored rather than as a single number because a number keeps
 * only 53 bits of precision, which is enough for dice but not for a protest.
 */
export interface Seed {
  /** Most-significant 32 bits, an unsigned word. */
  hi: number;
  /** Least-significant 32 bits, an unsigned word. */
  lo: number;
}

/** What any seedable place accepts: the full 64-bit form, or a plain number. */
export type SeedInput = number | Seed;

/** The golden-ratio constant, soft-overflowed, as splitmix uses it. */
const GOLDEN = 0x9e3779b9;

/** The largest integer every 64-bit seed value fits in, to 2^53. */
const MAX_SAFE = 0x20000000000000;

/**
 * Normalize whatever a caller passed to the canonical `{ hi, lo }` form.
 *
 * A missing seed is the reference default of 1. A number keeps its bits as the
 * low word — everyone writing `seed: 3` means a small hand-typed value, not a
 * 64-bit one — with the high word zero always.
 */
export function toSeed(value: SeedInput | null | undefined, fallback: SeedInput = 1): Seed {
  const v = value ?? fallback;
  if (typeof v === 'number') {
    return { hi: Math.floor(v / 0x100000000) >>> 0, lo: v >>> 0 };
  }
  return { hi: v.hi >>> 0, lo: v.lo >>> 0 };
}

/** Add `n` to a seed's 64-bit value, carrying into the high word. */
export function addSeed(seed: Seed, n: number): Seed {
  const lo = seed.lo + (n % 0x100000000);
  return {
    hi: (seed.hi + Math.floor(n / 0x100000000) + (lo >= 0x100000000 ? 1 : 0)) >>> 0,
    lo: lo >>> 0,
  };
}

/** Advance a seed by one, for a sequence of matches from an explicit `--seed`. */
export function bumpSeedValue(value: SeedInput): SeedInput {
  return typeof value === 'number' ? value + 1 : addSeed(value, 1);
}

/**
 * A 32-bit avalanche, the splitmix64 finalizer folded to one word.
 *
 * Cheap and statistical-quality: two of these feed a xoshiro, one turns a
 * 32-bit word into a 32-bit word that shares none of its structure.
 */
export function mix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Mix a per-robot identity word into the match seed.
 *
 * The two robots on a team must not see the same noise — identical streams would
 * let them "coordinate" without any communication, which is neither how sensors
 * work nor fair on the side that talks. The identity contributes to both words.
 */
export function withWord(seed: Seed, word: number): Seed {
  const h = mix32(word);
  return { hi: (seed.hi ^ h) >>> 0, lo: (seed.lo + h + GOLDEN) >>> 0 };
}

/**
 * The seed for one sensor's own noise stream.
 *
 * Each sensor XORs a fixed tag into `lo`, `hi` unchanged. Distinct sensors on
 * the same robot differ, and a NEW sensor picking its own tag cannot shift what
 * existing sensors hear — the property that has so far kept replays together
 * across two sensor additions.
 */
export function streamSeed(seed: Seed, tag: number): Seed {
  return { hi: seed.hi, lo: (seed.lo ^ tag) >>> 0 };
}

/**
 * Collapse the full seed to a 32-bit value for the restart placement source
 * (`World`'s mulberry32). Both words contribute, so two 64-bit seeds that
 * differ anywhere at all still place differently.
 */
export function foldSeed(seed: Seed): number {
  return mix32(seed.lo ^ mix32(seed.hi));
}

const HEX_SEED = /^0x([0-9a-f]{1,16})$/i;

/**
 * `0x<up to 16 hex digits>` — the form a serve log prints, safe to paste back
 * in — or a non-negative decimal below 2^53. Anything else throws rather than
 * silently defaulting: seeding with the wrong value is how a replay becomes
 * unreplayable without anyone noticing.
 */
export function parseSeed(text: string): Seed {
  const raw = text.trim().toLowerCase();
  const hex = raw.match(HEX_SEED);
  if (hex) {
    const padded = hex[1]!.padStart(16, '0');
    return {
      hi: parseInt(padded.slice(0, 8), 16),
      lo: parseInt(padded.slice(8), 16),
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= MAX_SAFE) {
    throw new Error(`not a seed: "${text}" — use a decimal below 2^53 or a 0x… 64-bit seed`);
  }
  return toSeed(n);
}

/** The stable 16-hex-digit form, e.g. `0x1a2b3c4d5e6f7081`. */
export function formatSeed(seed: Seed): string {
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  return `0x${hex(seed.hi)}${hex(seed.lo)}`;
}

/** Human form of either accepted seed type. */
export function formatSeedValue(value: SeedInput): string {
  return typeof value === 'number' ? String(value) : formatSeed(value);
}

// ------------------------------------------------------------------ the normal

import { NORMAL_Q, NORMAL_Z } from './normal-tables';

/**
 * A standard normal from one uniform draw.
 *
 * The table is the exact inverse of the cumulative distribution function of
 * N(0,1), sampled 0 → 7.5σ at 0.01σ, with Φ(z) evaluated in Python. A draw is
 * a binary search for the cell its CDF value falls in, then a lerp between the
 * cell's edges — arithmetic only, no transcendentals, one fixed number of
 * draws per reading. It is a true normal with the two tails clamped at 7.5σ,
 * which no sensor noise ever reaches (they are scaled by sd 0.012–0.12, so
 * that is 0.9 mm on the largest one).
 */
export function unitNormal(u: number): number {
  const sign = u < 0.5 ? -1 : 1;
  const v = Math.abs(u - 0.5) * 2;
  let lo = 0;
  let hi = NORMAL_Q.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (NORMAL_Q[mid]! <= v) lo = mid;
    else hi = mid;
  }
  const q0 = NORMAL_Q[lo]!;
  const q1 = NORMAL_Q[hi]!;
  const z0 = NORMAL_Z[lo]!;
  const z1 = NORMAL_Z[hi]!;
  const t = q1 > q0 ? (v - q0) / (q1 - q0) : 0;
  return sign * (z0 + (z1 - z0) * t);
}