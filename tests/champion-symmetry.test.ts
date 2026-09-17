/**
 * The champion has to play the same game at both ends.
 *
 * There was a version of this file that asserted exactly that, passed 106,459
 * times, and was wrong. It built its own poses - a spread of random positions
 * and a short straight trajectory from each - ran the agent over them upright
 * and rotated, and compared motor powers to nine decimal places. All of that
 * was right. What it never did was reach the branch with the bug in it.
 *
 * Measured, that suite spent 61% of its ticks in SEARCH, because a ball placed
 * at random is usually somewhere the robot cannot see, and it never once
 * entered DRIBBLE_ROUND, BREAKOUT, RECEIVE, COVER, COVER_MOUTH or KICKOFF - six
 * of the agent's eleven states. The bug was in DRIBBLE_ROUND: a lateral dodge
 * whose side came from `meZ > 0 ? -1 : 1` with no attack direction on it, which
 * steered the dribbler infield at one end and into the wall at the other. In
 * matches it was 82 goals into one net against 33 into the other. In this file
 * it was invisible, because invented poses do not carry a ball to a blocked
 * lane while the robot is holding it. Real play does, constantly.
 *
 * So the frames come from real matches now, and the assertion has two halves:
 *
 *   1. upright and rotated agree, and
 *   2. there was something to agree ABOUT.
 *
 * The second is the one that was missing. `EXERCISED` is a floor, not a wish
 * list - every name in it is a state these recordings are known to enter - and
 * a failure means either the agent stopped doing something it used to do or the
 * recording stopped reaching it. Both are worth being told about, because both
 * turn the first assertion back into the one that passed 106,459 times.
 *
 * The synthetic sweep is kept, trimmed, at the bottom. Recorded play does not
 * put a robot outside the field or in a corner facing the wall, and those are
 * worth asserting too - they are just not a substitute for the rest.
 */

import { describe, expect, it } from 'bun:test';
import { Match, type MatchAgents } from '../src/match';
import { ChampionAgent } from '../src/champion';
import { RecordingAgent, checkSymmetry, unreached, type SeatRecording } from '../src/symmetry';
import { Senses, type MatchView, type SenseInput } from '../src/perception';
import type { SensorFrame } from '../src/protocol';

const SEEDS = [1, 2, 3];
const HALF_SECONDS = 40;

/**
 * States these recordings reach, and so states a green result covers.
 *
 * SEARCH and BREAKOUT are deliberately absent: one needs the ball lost for
 * longer than two champions normally allow, the other needs a stall. Listing
 * them here would make the floor a wish and stop it meaning anything.
 */
const EXERCISED = [
  'KICKOFF',
  'INTERCEPT',
  'APPROACH',
  'CARRY',
  'DRIBBLE_ROUND',
  'RECEIVE',
  'COVER',
  'COVER_MOUTH',
  'SMOTHER',
  'GUARD',
  'CLEAR',
  'PASS',
  'OFF_THE_LINE',
] as const;

const champion = (number: 1 | 2, team: 'violet' | 'lime' = 'violet'): ChampionAgent =>
  new ChampionAgent({ team, number, role: number === 2 ? 'goalie' : 'striker' });

/** Play some matches and keep every frame the violet seats were handed. */
function record(): SeatRecording[] {
  const seats: SeatRecording[] = [
    { id: 'violet-1', number: 1, frames: [] },
    { id: 'violet-2', number: 2, frames: [] },
  ];

  for (const seed of SEEDS) {
    const taped = seats.map((seat) => new RecordingAgent(champion(seat.number as 1 | 2)));
    const agents = {
      'violet-1': taped[0],
      'violet-2': taped[1],
      'lime-1': champion(1, 'lime'),
      'lime-2': champion(2, 'lime'),
    } as unknown as MatchAgents;

    new Match({ agents, halfSeconds: HALF_SECONDS, seed }).run();
    seats.forEach((seat, i) => seat.frames.push(...taped[i]!.frames));
  }
  return seats;
}

describe('the champion plays the same game at both ends', () => {
  const seats = record();
  const report = checkSymmetry(seats, (seat) => champion(seat.number as 1 | 2));

  it('commands identical motor powers in the rotated world', () => {
    // Name the branch rather than just the number. A divergence here is always
    // some expression that read an x or a z and did not say which way it was
    // playing, and the intent is the fastest way to the line it is on.
    const where = report.divergences
      .slice(0, 5)
      .map((d) => `${d.seat} t=${d.tick} ${d.intent} ${d.what}: ${d.upright} vs ${d.rotated}`)
      .join('\n  ');
    expect(where).toBe('');
    expect(report.ok).toBe(true);
  });

  it('exercised every state the assertion is supposed to cover', () => {
    expect(unreached(report, EXERCISED)).toEqual([]);
  });

  it('spent its ticks on play rather than on looking for the ball', () => {
    // The old suite's real failure, as a number. If the recordings ever drift
    // back to mostly-searching, the assertion above stops being worth much
    // and this is what says so first.
    const searching = report.intents['SEARCH'] ?? 0;
    expect(searching / report.ticks).toBeLessThan(0.2);
  });
});

// --------------------------------------------------------- synthetic corners

interface Pose {
  x: number;
  z: number;
  heading: number;
  bx: number;
  bz: number;
}

const rotate = (p: Pose): Pose => ({
  x: -p.x,
  z: -p.z,
  heading: p.heading + Math.PI,
  bx: -p.bx,
  bz: -p.bz,
});

function poses(count: number): Pose[] {
  let state = 12345;
  const rnd = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const span = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  return Array.from({ length: count }, () => ({
    x: span(-1000, 1000),
    z: span(-700, 700),
    heading: span(-Math.PI, Math.PI),
    bx: span(-880, 880),
    bz: span(-580, 580),
  }));
}

function trajectory(p: Pose, ticks: number): Pose[] {
  return Array.from({ length: ticks }, (_, i) => ({
    x: p.x + Math.cos(p.heading) * 4 * i,
    z: p.z + Math.sin(p.heading) * 4 * i,
    heading: p.heading + 0.01 * i,
    bx: p.bx + 3 * i,
    bz: p.bz - 1.5 * i,
  }));
}

function others(p: Pose, team: 'violet' | 'lime') {
  const foe = team === 'violet' ? 'lime' : 'violet';
  return [
    { id: `${team}-2`, team, number: 2 as const, x: p.x * 0.2 - 300, z: p.z * 0.3 + 40, heading: p.heading + 0.5 },
    { id: `${foe}-1`, team: foe, number: 1 as const, x: (p.x + p.bx) / 2 + 90, z: (p.z + p.bz) / 2 - 30, heading: p.heading - 1.1 },
    { id: `${foe}-2`, team: foe, number: 2 as const, x: p.bx * 0.6 + 250, z: p.bz * 0.4 + 70, heading: p.heading + 2.2 },
  ];
}

function frames(seq: Pose[], attackDirection: 1 | -1, held: boolean, rotated: boolean): SensorFrame[] {
  const senses = new Senses(0xbeef, 4, true);
  let clock = 0;
  const s = rotated ? -1 : 1;
  return seq.map((base) => {
    clock += 0.02;
    const p = rotated ? rotate(base) : base;
    const self = { id: 'violet-1', team: 'violet' as const, number: 1 as const, x: p.x, z: p.z, heading: p.heading };
    const rest = others(base, 'violet').map((r) => ({
      ...r,
      x: s * r.x,
      z: s * r.z,
      heading: r.heading + (rotated ? Math.PI : 0),
    }));
    const view: MatchView = {
      clock,
      playing: true,
      ball: { x: p.bx, z: p.bz },
      robots: [self, ...rest],
      kickoff: { pending: false, team: null, countdown: 0 },
    };
    const input: SenseInput = {
      view,
      self,
      wheelSpeeds: [100, -100, 100, -100],
      omega: 0,
      held,
      messages: [],
      attackDirection,
      dt: 0.02,
    };
    return senses.read(input);
  });
}

describe('the champion plays the same game in places real matches do not go', () => {
  for (const [label, held] of [
    ['in open play', false],
    ['while holding the ball', true],
  ] as const) {
    it(`commands identical motor powers under 180-degree rotation, ${label}`, () => {
      for (const [role, number] of [
        ['striker', 1],
        ['goalie', 2],
      ] as const) {
        for (const pose of poses(20)) {
          const a = new ChampionAgent({ team: 'violet', number, role: role as 'striker' | 'goalie' });
          const b = new ChampionAgent({ team: 'violet', number, role: role as 'striker' | 'goalie' });
          const fa = frames(trajectory(pose, 30), 1, held, false);
          const fb = frames(trajectory(pose, 30), -1, held, true);

          for (let i = 0; i < fa.length; i++) {
            const ca = a.tick(fa[i]!);
            const cb = b.tick(fb[i]!);
            expect(!!cb).toBe(!!ca);
            if (!ca || !cb) continue;
            for (let m = 0; m < ca.motors.length; m++) {
              expect(cb.motors[m]!).toBeCloseTo(ca.motors[m]!, 9);
            }
            expect(cb.dribbler ?? 0).toBeCloseTo(ca.dribbler ?? 0, 9);
            expect(cb.kicker === true).toBe(ca.kicker === true);
          }
        }
      }
    });
  }
});
