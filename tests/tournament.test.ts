/**
 * What has to hold for a tournament to be trustworthy.
 *
 * Two claims are load-bearing and everything else is arithmetic. The first is
 * that a table is derived rather than kept, so reading it twice — or after a
 * restart — cannot give two answers. The second is that a fixture's result
 * appears whole or not at all, so a process killed mid-fixture replays that
 * fixture instead of half-counting it. Both are tested by doing the thing
 * rather than by inspecting a flag that claims it was done.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Match, type MatchAgents, type MatchResult } from '../src/match';
import { referenceTeam } from '../src/reference';
import { hashSubmission } from '../src/submission';
import {
  deriveTable,
  fixtureOutcome,
  makeDraw,
  nextFixture,
  type Draw,
  type FixtureResult,
} from '../src/tournament';
import { appendAmendment, loadDraw, loadResults, saveDraw, saveResult } from '../src/tournament-store';
import { runDraw } from '../src/tournament-run';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rcja-tournament-test-'));
}

function agents(): MatchAgents {
  return { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents;
}

/** A result with nothing in it but a score, for table arithmetic. */
function scored(violet: number, lime: number): MatchResult {
  return {
    score: { violet, lime },
    clock: 600,
    goals: [],
    slots: {},
    calls: {},
    events: [],
    refereeActions: [],
    scoreCorrections: [],
    abandoned: false,
  };
}

function fixtureResult(id: string, home: string, away: string, legs: [number, number][]): FixtureResult {
  return {
    fixtureId: id,
    home,
    away,
    submissions: {},
    legs: legs.map(([v, l], i) => ({ seed: i + 1, result: scored(v, l) })),
    completedAt: new Date().toISOString(),
  };
}

describe('a draw', () => {
  it('pairs every entrant with every other, both ways round', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC'], { name: 'state' });
    expect(draw.fixtures).toHaveLength(6);
    const pairs = draw.fixtures.map((f) => `${f.home}v${f.away}`);
    expect(pairs).toContain('ACTvQLD');
    expect(pairs).toContain('QLDvACT');
    expect(new Set(pairs).size).toBe(6);
  });

  it('never pairs an entrant with itself, even if named twice', () => {
    const draw = makeDraw(['ACT', 'QLD', 'ACT'], { name: 'state' });
    expect(draw.entrants).toEqual(['ACT', 'QLD']);
    expect(draw.fixtures).toHaveLength(2);
  });

  it('refuses a draw nobody could play', () => {
    expect(() => makeDraw(['ACT'], { name: 'lonely' })).toThrow(/at least two/);
  });

  it('records a seed for every leg, so a fixture replays as itself', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC'], { name: 'state', legs: 3 });
    for (const fixture of draw.fixtures) expect(fixture.seeds).toHaveLength(3);
    // Every seed in the whole draw is distinct: two fixtures sharing one would
    // be two meetings of the same match with different robots in it.
    const seeds = draw.fixtures.flatMap((f) => f.seeds);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('is refereed unless the organiser says otherwise', () => {
    expect(makeDraw(['A', 'B'], { name: 'x' }).refereed).toBe(true);
    expect(makeDraw(['A', 'B'], { name: 'x', refereed: false }).refereed).toBe(false);
  });

  it('provides a consistent pitch ballFriction across all legs of a fixture', () => {
    const draw = makeDraw(['ACT', 'QLD'], { name: 'finals', legs: 3 });
    for (const fixture of draw.fixtures) {
      expect(fixture.ballFriction).toBeDefined();
      expect(fixture.ballFriction).toBeGreaterThanOrEqual(0.9);
      expect(fixture.ballFriction).toBeLessThanOrEqual(1.1);
    }
  });
});

describe('a draw with a programme', () => {
  const START = '2026-09-20T09:00:00.000Z';

  it('carries no time at all when nobody asked for one', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC'], { name: 'state' });
    // Not merely undefined: the key is absent, so a draw written today is
    // byte-identical to one written before kick-off times existed.
    for (const fixture of draw.fixtures) expect('playAt' in fixture).toBe(false);
  });

  it('kicks the first round off at the time it was given', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC'], {
      name: 'state',
      startAt: START,
      everyMinutes: 12,
    });
    expect(draw.fixtures[0]!.playAt).toBe(START);
  });

  it('gives one pitch one fixture at a time, every --every minutes', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC'], {
      name: 'state',
      startAt: START,
      everyMinutes: 12,
    });
    const times = draw.fixtures.map((f) => f.playAt!);
    expect(new Set(times).size).toBe(6);
    for (let i = 1; i < times.length; i++) {
      expect(Date.parse(times[i]!) - Date.parse(times[i - 1]!)).toBe(12 * 60_000);
    }
  });

  it('starts several fixtures together when the hall has several tables', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC', 'NSW', 'SA', 'WA'], {
      name: 'nationals',
      startAt: START,
      everyMinutes: 15,
      pitches: 3,
    });
    const first = draw.fixtures.filter((f) => f.playAt === START);
    expect(first).toHaveLength(3);
  });

  it('never puts a team on two pitches at once', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC', 'NSW', 'SA'], {
      name: 'nationals',
      startAt: START,
      everyMinutes: 15,
      pitches: 3,
    });
    const rounds = new Map<string, string[]>();
    for (const fixture of draw.fixtures) {
      const round = rounds.get(fixture.playAt!) ?? [];
      round.push(fixture.home, fixture.away);
      rounds.set(fixture.playAt!, round);
    }
    for (const [, teams] of rounds) expect(new Set(teams).size).toBe(teams.length);
    // Every fixture still gets a slot — a clash defers one, it never drops it.
    expect(draw.fixtures).toHaveLength(20);
  });

  it('writes the programme in time order, so the file reads like one', () => {
    const draw = makeDraw(['ACT', 'QLD', 'VIC', 'NSW'], {
      name: 'state',
      startAt: START,
      everyMinutes: 10,
      pitches: 2,
    });
    const times = draw.fixtures.map((f) => Date.parse(f.playAt!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('leaves a fixture the length of a fixture when nobody says otherwise', () => {
    const draw = makeDraw(['ACT', 'QLD'], {
      name: 'state',
      legs: 3,
      halfSeconds: 300,
      startAt: START,
    });
    // Three legs of two five-minute halves is thirty minutes.
    const gap = Date.parse(draw.fixtures[1]!.playAt!) - Date.parse(draw.fixtures[0]!.playAt!);
    expect(gap).toBe(30 * 60_000);
  });
});

describe('a best-of-three fixture', () => {
  it('is won by legs, not by aggregate goals', () => {
    // Lime wins one leg 9-0 and loses the other two narrowly. Aggregate says
    // lime; legs say violet, and legs is what decides it.
    const verdict = fixtureOutcome(
      fixtureResult('a-v-b', 'A', 'B', [
        [1, 0],
        [1, 0],
        [0, 9],
      ]),
    );
    expect(verdict.homeLegsWon).toBe(2);
    expect(verdict.awayLegsWon).toBe(1);
    expect(verdict.homeGoals).toBe(2);
    expect(verdict.awayGoals).toBe(9);
    expect(verdict.outcome).toBe('won');
  });

  it('is drawn when the legs are level', () => {
    const verdict = fixtureOutcome(
      fixtureResult('a-v-b', 'A', 'B', [
        [1, 0],
        [0, 1],
        [2, 2],
      ]),
    );
    expect(verdict.outcome).toBe('drawn');
    expect(verdict.drawnLegs).toBe(1);
  });
});

describe('the table', () => {
  it('gives three points for a fixture, not for a leg', () => {
    const draw = makeDraw(['A', 'B'], { name: 'x', legs: 3 });
    const table = deriveTable(draw, [
      fixtureResult('a-v-b', 'A', 'B', [
        [1, 0],
        [1, 0],
        [1, 0],
      ]),
    ]);
    const a = table.find((s) => s.name === 'A')!;
    expect(a.points).toBe(3);
    expect(a.played).toBe(1);
    expect(a.won).toBe(1);
    // Goals still aggregate across the legs — the fixture is one meeting, but
    // it was three matches' worth of football.
    expect(a.for).toBe(3);
  });

  it('orders on points, then goal difference, then goals for', () => {
    const draw = makeDraw(['A', 'B', 'C'], { name: 'x' });
    const table = deriveTable(draw, [
      fixtureResult('a-v-b', 'A', 'B', [[5, 0]]),
      fixtureResult('c-v-b', 'C', 'B', [[1, 0]]),
    ]);
    expect(table.map((s) => s.name)).toEqual(['A', 'C', 'B']);
  });

  it('ignores a result belonging to some other draw', () => {
    const draw = makeDraw(['A', 'B'], { name: 'x' });
    const table = deriveTable(draw, [fixtureResult('q-v-z', 'Q', 'Z', [[3, 0]])]);
    expect(table.every((s) => s.played === 0)).toBe(true);
  });

  it('reads the same after a reload as it did before', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'reload' });
    await saveDraw(dir, draw);
    await saveResult(dir, draw, fixtureResult('a-v-b', 'A', 'B', [[2, 1]]));
    await saveResult(dir, draw, fixtureResult('c-v-a', 'C', 'A', [[0, 0]]));

    const before = deriveTable(draw, await loadResults(dir, draw));
    const reloaded = await loadDraw(dir, 'reload');
    const after = deriveTable(reloaded, await loadResults(dir, reloaded));
    expect(after).toEqual(before);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('several fixtures at once', () => {
  /** A draw whose fixtures are played with a recorded start and finish order. */
  async function runWith(
    entrants: string[],
    slots: number,
    hold: () => Promise<void>,
  ): Promise<{ overlapped: string[][]; order: string[] }> {
    const dir = await root();
    const draw = makeDraw(entrants, { name: `slots-${slots}-${entrants.length}` });
    await saveDraw(dir, draw);

    const inFlight = new Set<string>();
    const overlapped: string[][] = [];
    const order: string[] = [];

    await runDraw(dir, draw, {
      slots,
      playLeg: async (fixture) => {
        inFlight.add(fixture.id);
        overlapped.push([...inFlight]);
        await hold();
        inFlight.delete(fixture.id);
        order.push(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
    });

    await rm(dir, { recursive: true, force: true });
    return { overlapped, order };
  }

  it('plays one at a time by default, as it always has', async () => {
    const { overlapped } = await runWith(['A', 'B', 'C'], 1, () => Promise.resolve());
    expect(Math.max(...overlapped.map((o) => o.length))).toBe(1);
  });

  it('plays several at once when there is room', async () => {
    const { overlapped, order } = await runWith(
      ['A', 'B', 'C', 'D'],
      2,
      () => new Promise((done) => setTimeout(done, 5)),
    );
    // A competition day is meaningfully shorter the moment two fixtures can
    // play at the same time, which is the whole reason for the phase.
    expect(Math.max(...overlapped.map((o) => o.length))).toBe(2);
    // Every fixture still gets played exactly once.
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(12);
  });

  /**
   * The one rule the sport imposes, and it is not a setting.
   *
   * A team has two robots, and two robots cannot be on two pitches. Get this
   * wrong and it fails silently: both matches look correct on their own, and
   * the only symptom is a team being asked to be in two places at once.
   */
  it('never puts a team in two fixtures at the same time', async () => {
    const { overlapped } = await runWith(
      ['A', 'B', 'C', 'D'],
      4,
      () => new Promise((done) => setTimeout(done, 5)),
    );

    for (const together of overlapped) {
      const teams = together.flatMap((id) => id.split('-v-'));
      expect(new Set(teams).size).toBe(teams.length);
    }
  });

  it('plays the rest out when one fixture cannot be played, and still fails loudly', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'one-bad' });
    await saveDraw(dir, draw);

    const played: string[] = [];
    await expect(
      runDraw(dir, draw, {
        slots: 2,
        playLeg: async (fixture) => {
          if (fixture.id === 'a-v-b') throw new Error('that arena died');
          played.push(fixture.id);
          return { result: scored(1, 0), submissions: {} };
        },
      }),
    ).rejects.toThrow('that arena died');

    // The others are real matches with people watching them: one failing does
    // not abandon them. And the failed one wrote nothing, so it replays.
    expect(played).toHaveLength(5);
    expect(await loadResults(dir, draw)).toHaveLength(5);
    await rm(dir, { recursive: true, force: true });
  });

  it('carries on without failing when the caller says to', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'keep-going' });
    await saveDraw(dir, draw);

    const failures: string[] = [];
    const results = await runDraw(dir, draw, {
      continueOnFailure: true,
      onFixtureFailed: (fixture) => failures.push(fixture.id),
      playLeg: async (fixture) => {
        if (fixture.id === 'a-v-b') throw new Error('no');
        return { result: scored(2, 0), submissions: {} };
      },
    });

    // A venue's front door does not fall over because one match did.
    expect(failures).toEqual(['a-v-b']);
    expect(results).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('does not offer what an earlier run gave up on, and plays what it did not', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'second-run' });
    await saveDraw(dir, draw);

    // The first run: one fixture cannot be played, the rest are.
    const gaveUp = new Set<string>();
    await runDraw(dir, draw, {
      continueOnFailure: true,
      onFixtureFailed: (fixture) => gaveUp.add(fixture.id),
      playLeg: async (fixture) => {
        if (fixture.id === 'a-v-b') throw new Error('that arena died');
        return { result: scored(1, 0), submissions: {} };
      },
    });
    expect([...gaveUp]).toEqual(['a-v-b']);

    // The second run, over the same draw with the same set carried across.
    // Without `skip` this would retry the broken fixture the instant anything
    // else woke the loop, which is the forever-retry `failed` exists to stop.
    const offered: string[] = [];
    await runDraw(dir, draw, {
      skip: gaveUp,
      continueOnFailure: true,
      playLeg: async (fixture) => {
        offered.push(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
    });
    expect(offered).toEqual([]);

    // And taken out of the set — somebody has said to try it again — it plays.
    gaveUp.delete('a-v-b');
    await runDraw(dir, draw, {
      skip: gaveUp,
      playLeg: async (fixture) => {
        offered.push(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
    });
    expect(offered).toEqual(['a-v-b']);
    expect(await loadResults(dir, draw)).toHaveLength(6);
    await rm(dir, { recursive: true, force: true });
  });

  it('offers a fixture the moment the caller takes it back out, mid-run', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'un-stalled' });
    await saveDraw(dir, draw);

    const gaveUp = new Set<string>(['a-v-b']);
    const offered: string[] = [];
    let poke: (() => void) | null = null;

    await runDraw(dir, draw, {
      skip: gaveUp,
      // Somebody presses "play it again" while the run is still going. The
      // loop is asked, rather than holding a copy taken when it started.
      poke: () => new Promise<void>((settle) => (poke = settle)),
      playLeg: async (fixture) => {
        offered.push(fixture.id);
        if (offered.length === 5) {
          gaveUp.delete('a-v-b');
          // Deliberately after the set changes: the poke is the signal to look
          // again, not the thing that changes the answer.
          queueMicrotask(() => poke?.());
        }
        return { result: scored(1, 0), submissions: {} };
      },
    });

    expect(offered).toContain('a-v-b');
    expect(await loadResults(dir, draw)).toHaveLength(6);
    await rm(dir, { recursive: true, force: true });
  });

  it('never reports a skipped fixture as one that failed in this run', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'skipped-not-failed' });
    await saveDraw(dir, draw);

    const failures: string[] = [];
    // No `continueOnFailure`, so a fixture that actually failed would throw.
    // A skipped one was never offered, so there is nothing to raise.
    const results = await runDraw(dir, draw, {
      skip: new Set(['a-v-b']),
      onFixtureFailed: (fixture) => failures.push(fixture.id),
      playLeg: async () => ({ result: scored(2, 0), submissions: {} }),
    });

    expect(failures).toEqual([]);
    expect(results).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('records the conditions of play when it is given them', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'conditions' });
    await saveDraw(dir, draw);

    await runDraw(dir, draw, {
      conditions: { seatCpuPercent: 25, seatMemoryMb: 256 },
      playLeg: async () => ({ result: scored(0, 0), submissions: {} }),
    });

    // A venue playing at 25% is playing a different game from one at 50%, so
    // it belongs in the record beside the seed and the code hashes.
    const [result] = await loadResults(dir, draw);
    expect(result!.conditions).toEqual({ seatCpuPercent: 25, seatMemoryMb: 256 });
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a draw already under way', () => {
  it('refuses to be rewritten', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'once' });
    await saveDraw(dir, draw);
    await expect(saveDraw(dir, draw)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('picks up at the fixture that never finished', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'resume' });
    await saveDraw(dir, draw);

    const played: string[] = [];
    // Stop after two fixtures, the way ctrl-c would.
    await expect(
      runDraw(dir, draw, {
        playLeg: async (fixture) => {
          if (played.length === 2) throw new Error('interrupted');
          played.push(fixture.id);
          return { result: scored(1, 0), submissions: {} };
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(played).toHaveLength(2);

    // A fresh process: nothing in memory, only what is on disk.
    const reloaded = await loadDraw(dir, 'resume');
    const resumed: string[] = [];
    const results = await runDraw(dir, reloaded, {
      playLeg: async (fixture) => {
        resumed.push(fixture.id);
        return { result: scored(0, 1), submissions: {} };
      },
    });

    expect(resumed).toHaveLength(draw.fixtures.length - 2);
    expect(resumed.some((id) => played.includes(id))).toBe(false);
    expect(results).toHaveLength(draw.fixtures.length);
    // Six fixtures played, six counted — nothing double-counted by the restart.
    const table = deriveTable(reloaded, results);
    expect(table.reduce((n, s) => n + s.played, 0)).toBe(draw.fixtures.length * 2);
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves nothing behind for a fixture that did not finish', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'partial', legs: 3 });
    await saveDraw(dir, draw);
    await expect(
      runDraw(dir, draw, {
        // Fall over on the third leg, after two are already played.
        playLeg: async (_fixture, _seed, leg) => {
          if (leg === 2) throw new Error('crash');
          return { result: scored(1, 0), submissions: {} };
        },
      }),
    ).rejects.toThrow('crash');

    const written = await readdir(join(dir, 'partial', 'results'));
    expect(written).toEqual([]);
    expect(nextFixture(draw, await loadResults(dir, draw))?.id).toBe(draw.fixtures[0]!.id);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('the record a fixture leaves', () => {
  it('carries more calls than the referee panel can hold', () => {
    // world.events is a 60-entry ring buffer. A real match makes far more than
    // that, and the record is the only thing that keeps them.
    const result = new Match({ agents: agents(), halfSeconds: 300, seed: 3 }).run();
    expect(result.events.length).toBeGreaterThan(60);
    // The count and the log agree — neither is derived from the other.
    const counted = Object.values(result.calls).reduce((a, b) => a + b, 0);
    expect(result.events).toHaveLength(counted);
  }, 60000);

  it('says what the referee did, in the order they did it', () => {
    const match = new Match({ agents: agents(), halfSeconds: 60, seed: 1 });
    match.kickOff('violet');
    match.pause();
    match.resume();
    match.correctScore('violet', 2, 'goal missed by the referee');
    match.abandon('field damaged');

    const actions = match.result().refereeActions.map((a) => a.action);
    expect(actions).toEqual(['kickoff', 'pause', 'resume', 'correct-score', 'abandon']);
    const correction = match.result().refereeActions[3]!;
    expect(correction.detail).toContain('goal missed by the referee');
  });

  it('does not claim a referee action that was refused', () => {
    const match = new Match({ agents: agents(), halfSeconds: 60, seed: 1 });
    // Resume before any kick-off does nothing — it is the wrong button at the
    // top of a half, and the match refuses it.
    match.resume();
    expect(match.result().refereeActions).toEqual([]);
  });
});

describe('a submission hash', () => {
  it('ignores the token, which rotates on every push', async () => {
    const dir = await root();
    await writeFile(join(dir, 'robot.py'), 'print("hello")');
    await writeFile(join(dir, 'manifest.json'), '{}');
    const before = await hashSubmission(dir);
    await writeFile(join(dir, 'token'), 'a-completely-different-token');
    expect(await hashSubmission(dir)).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('changes when the code does', async () => {
    const dir = await root();
    await writeFile(join(dir, 'robot.py'), 'print("hello")');
    const before = await hashSubmission(dir);
    await writeFile(join(dir, 'robot.py'), 'print("goodbye")');
    expect(await hashSubmission(dir)).not.toBe(before);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a division played through', () => {
  it('produces a table with every fixture in it', async () => {
    const dir = await root();
    const draw = makeDraw(['ACT', 'QLD', 'VIC'], { name: 'e2e', halfSeconds: 10, refereed: false });
    await saveDraw(dir, draw);

    const results = await runDraw(dir, draw, {
      playLeg: async (_fixture, seed) => ({
        result: new Match({ agents: agents(), halfSeconds: 10, seed }).run(),
        submissions: {},
      }),
    });

    expect(results).toHaveLength(6);
    const table = deriveTable(draw, results);
    expect(table).toHaveLength(3);
    // Three entrants, six fixtures, each entrant meeting each other twice.
    for (const side of table) expect(side.played).toBe(4);

    const onDisk: Draw = await loadDraw(dir, 'e2e');
    expect(deriveTable(onDisk, await loadResults(dir, onDisk))).toEqual(table);
    await rm(dir, { recursive: true, force: true });
  }, 60000);
});

/**
 * Somebody agreeing it, between the last whistle and the disk.
 *
 * The rule these defend is that a result is a decision and not the side effect
 * of a clock running out — so the interesting assertion in nearly every one of
 * them is about the *absence* of a file at a moment when the football is over.
 */
describe('a result nobody has agreed to', () => {
  it('is not on disk until the confirmation resolves', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'unconfirmed' });
    await saveDraw(dir, draw);

    // One gate every confirmation waits behind, so the assertion below happens
    // with both fixtures played out and neither one agreed.
    let open: () => void = () => {};
    const gate = new Promise<void>((released) => {
      open = released;
    });
    let asked = 0;

    const running = runDraw(dir, draw, {
      playLeg: async () => ({ result: scored(2, 1), submissions: {} }),
      confirmResult: async () => {
        asked++;
        await gate;
        return 'confirmed';
      },
    });

    while (asked === 0) await new Promise((t) => setTimeout(t, 5));
    // Full time has been and gone, and there is nothing in the results
    // directory — which is the whole point of the slice.
    expect(await loadResults(dir, draw)).toEqual([]);

    open();
    const results = await running;
    expect(results).toHaveLength(2);
    expect(await loadResults(dir, draw)).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('plays the fixture again in this same run when it is not agreed', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'replayed' });
    await saveDraw(dir, draw);

    const attempts: string[] = [];
    const replayed: string[] = [];
    const declinedOnce = new Set<string>();

    const results = await runDraw(dir, draw, {
      slots: 1,
      playLeg: async (fixture) => {
        attempts.push(fixture.id);
        // A different score the second time, so the written result can be
        // told apart from the one that was thrown away.
        return { result: scored(declinedOnce.has(fixture.id) ? 5 : 1, 0), submissions: {} };
      },
      confirmResult: async (fixture) => {
        if (declinedOnce.has(fixture.id)) return 'confirmed';
        declinedOnce.add(fixture.id);
        return 'replay';
      },
      onFixtureReplay: (fixture) => replayed.push(fixture.id),
    });

    // Two fixtures, each played twice, and not a word about failure.
    expect(attempts).toHaveLength(4);
    expect(replayed.length).toBe(2);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.legs[0]!.result.score.violet).toBe(5);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves the fixture for the next run when the confirmation throws', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'interrupted' });
    await saveDraw(dir, draw);

    const failures: string[] = [];
    const results = await runDraw(dir, draw, {
      continueOnFailure: true,
      playLeg: async () => ({ result: scored(1, 0), submissions: {} }),
      confirmResult: async () => {
        throw new Error('the league server stopped before the result was confirmed');
      },
      onFixtureFailed: (fixture) => failures.push(fixture.id),
    });

    // Nothing written, nothing retried here — a fixture that fails for a reason
    // that has not gone away is not worth playing twice in one run.
    expect(results).toEqual([]);
    expect(failures).toHaveLength(2);
    expect(await loadResults(dir, draw)).toEqual([]);

    // The next run finds them exactly as it finds a fixture nobody ever started.
    const later = await runDraw(dir, draw, {
      playLeg: async () => ({ result: scored(3, 0), submissions: {} }),
    });
    expect(later).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a fixture nobody has opened yet', () => {
  it('spawns nothing until somebody opens it', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'unopened' });
    await saveDraw(dir, draw);

    let open: () => void = () => {};
    const gate = new Promise<void>((released) => {
      open = released;
    });
    const due: string[] = [];
    const played: string[] = [];

    const running = runDraw(dir, draw, {
      onFixtureDue: (fixture) => due.push(fixture.id),
      openPregame: () => gate,
      playLeg: async (fixture) => {
        played.push(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
    });

    while (due.length === 0) await new Promise((t) => setTimeout(t, 5));
    // The fixture's turn has come and its teams are free, and still nothing has
    // been asked to play: at a venue that is a pitch that has not been started,
    // four robots that have not been spawned, and a referee who has not arrived
    // yet costing nobody anything.
    expect(due).toEqual(['a-v-b']);
    expect(played).toEqual([]);

    open();
    const results = await running;
    expect(played.length).toBeGreaterThan(0);
    expect(results).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Eligible is not the same as occupying a pitch.
   *
   * The whole reason this slice is not four lines. Before it, a fixture took
   * one of the venue's slots the instant the scheduler reached it — which was
   * also the instant it was spawned, so the two cost the same. With a referee
   * in front of the spawn they are different moments, and conflating them means
   * one slow referee holds a pitch that nothing is running on.
   */
  it('offers every fixture whose turn has come, however few pitches there are', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C', 'D'], { name: 'one-pitch' });
    await saveDraw(dir, draw);

    const due: string[] = [];
    const gates = new Map<string, () => void>();
    let openEverything = false;
    const inFlight = new Set<string>();
    const together: number[] = [];

    const running = runDraw(dir, draw, {
      slots: 1,
      onFixtureDue: (fixture) => due.push(fixture.id),
      openPregame: (fixture) => {
        if (openEverything) return Promise.resolve();
        return new Promise<void>((go) => gates.set(fixture.id, go));
      },
      playLeg: async (fixture) => {
        inFlight.add(fixture.id);
        together.push(inFlight.size);
        await new Promise((t) => setTimeout(t, 5));
        inFlight.delete(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
    });

    while (due.length < 2) await new Promise((t) => setTimeout(t, 5));
    // Two matches are ready for their referees although the venue has one
    // pitch, and nothing is running on either.
    expect(due).toEqual(['a-v-b', 'c-v-d']);
    expect(together).toEqual([]);

    openEverything = true;
    for (const go of gates.values()) go();
    const results = await running;

    // And the pitch is still one pitch.
    expect(Math.max(...together)).toBe(1);
    expect(results).toHaveLength(12);
    await rm(dir, { recursive: true, force: true });
  });

  it('hands the next free pitch to whoever asked for it first', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C', 'D'], { name: 'in-turn' });
    await saveDraw(dir, draw);

    const gates = new Map<string, () => void>();
    let openEverything = false;
    const started: string[] = [];

    const running = runDraw(dir, draw, {
      slots: 1,
      openPregame: (fixture) => {
        if (openEverything) return Promise.resolve();
        return new Promise<void>((go) => gates.set(fixture.id, go));
      },
      onFixtureStart: (fixture) => started.push(fixture.id),
      playLeg: async () => {
        await new Promise((t) => setTimeout(t, 5));
        return { result: scored(1, 0), submissions: {} };
      },
    });

    while (gates.size < 2) await new Promise((t) => setTimeout(t, 5));
    // The second fixture in the draw is opened first, and it is the one that
    // plays first: a referee who is ready does not queue behind one who is not.
    gates.get('c-v-d')!();
    gates.get('a-v-b')!();
    await new Promise((t) => setTimeout(t, 20));
    expect(started.slice(0, 2)).toEqual(['c-v-d', 'a-v-b']);

    openEverything = true;
    for (const go of gates.values()) go();
    await running;
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a fixture unwritten when it could not be opened', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'never-opened' });
    await saveDraw(dir, draw);

    const failed: string[] = [];
    const results = await runDraw(dir, draw, {
      continueOnFailure: true,
      openPregame: async (fixture) => {
        if (fixture.id === 'a-v-b') throw new Error('the league server stopped');
      },
      onFixtureFailed: (fixture) => failed.push(fixture.id),
      playLeg: async () => ({ result: scored(1, 0), submissions: {} }),
    });

    // Unwritten and unplayed, which is the answer a hub killed mid-match gives
    // too: it comes round again on the next run.
    expect(failed).toEqual(['a-v-b']);
    expect(results.map((r) => r.fixtureId)).toEqual(['b-v-a']);
    expect((await loadResults(dir, draw)).map((r) => r.fixtureId)).toEqual(['b-v-a']);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a match the referee called off', () => {
  it('writes nothing and is reported, rather than counting the board', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'abandoned' });
    await saveDraw(dir, draw);

    const failures: string[] = [];
    const results = await runDraw(dir, draw, {
      continueOnFailure: true,
      playLeg: async () => ({
        // Three-nil on the board when it was called off. Until this slice that
        // was written down and awarded three points.
        result: { ...scored(3, 0), abandoned: true, abandonReason: 'field damaged' },
        submissions: {},
      }),
      onFixtureFailed: (fixture, error) => failures.push(`${fixture.id}: ${error.message}`),
    });

    expect(results).toEqual([]);
    expect(await loadResults(dir, draw)).toEqual([]);
    expect(failures[0]).toContain('abandoned');
    expect(failures[0]).toContain('field damaged');
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * A day that is corrected while it is being played.
 *
 * A draw is immutable, so a correction is a record appended beside it — and
 * until this slice the loop went on playing the draw it was handed at nine in
 * the morning whatever anybody appended afterwards. What these defend is the
 * narrow version of "it reaches": a fixture **nobody has opened** follows the
 * corrected draw, and one that is already being refereed does not.
 */
describe('a draw amended while it runs', () => {
  it('never plays a fixture voided while it waited for its referee', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'voided-mid-run' });
    await saveDraw(dir, draw);

    const played: string[] = [];
    const dropped: string[] = [];
    const doomed = 'a-v-b';

    const results = await runDraw(dir, draw, {
      playLeg: async (fixture) => {
        played.push(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
      onFixtureDropped: (fixture) => dropped.push(fixture.id),
      openPregame: async (fixture) => {
        // The organiser gets to it while this one is sitting in the queue —
        // which is exactly when a fixture is amendable and nothing is running.
        if (fixture.id === doomed) {
          await appendAmendment(dir, draw.id, {
            kind: 'void',
            fixtureId: doomed,
            at: new Date().toISOString(),
            by: { id: null, slug: 'organiser' },
            reason: 'pitch flooded',
          });
          return 'dropped';
        }
      },
    });

    expect(played).not.toContain(doomed);
    expect(dropped).toEqual([doomed]);
    // Everything else in the draw still played, and the voided fixture is not
    // in the results the run reports.
    expect(played).toHaveLength(draw.fixtures.length - 1);
    expect(results.some((r) => r.fixtureId === doomed)).toBe(false);
    expect(await loadResults(dir, draw)).toHaveLength(draw.fixtures.length - 1);
    await rm(dir, { recursive: true, force: true });
  });

  it('frees the teams of a recalled fixture at once', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'recalled-frees-teams' });
    await saveDraw(dir, draw);

    // Both fixtures are between the same two teams, so the second can only be
    // offered once the first has let go of them.
    const offered: string[] = [];
    const results = await runDraw(dir, draw, {
      playLeg: async () => ({ result: scored(0, 0), submissions: {} }),
      openPregame: async (fixture) => {
        offered.push(fixture.id);
        if (offered.length === 1) {
          await appendAmendment(dir, draw.id, {
            kind: 'void',
            fixtureId: fixture.id,
            at: new Date().toISOString(),
            by: { id: null, slug: 'organiser' },
            reason: 'no time left in the day',
          });
          return 'dropped';
        }
      },
    });

    expect(offered).toHaveLength(2);
    expect(results).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('stops offering a withdrawn team, and counts their walkovers instead', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B', 'C'], { name: 'withdrawn-mid-run' });
    await saveDraw(dir, draw);

    const played: string[] = [];
    let withdrawn = false;

    const results = await runDraw(dir, draw, {
      playLeg: async (fixture) => {
        played.push(fixture.id);
        return { result: scored(1, 0), submissions: {} };
      },
      openPregame: async (fixture) => {
        // After one real match, A goes home. Their remaining fixtures should
        // never be offered again.
        if (!withdrawn && played.length >= 1) {
          withdrawn = true;
          await appendAmendment(dir, draw.id, {
            kind: 'withdraw',
            team: 'A',
            goals: 5,
            at: new Date().toISOString(),
            by: { id: null, slug: 'organiser' },
            reason: 'their bus did not arrive',
          });
          if (fixture.home === 'A' || fixture.away === 'A') return 'dropped';
        }
      },
    });

    const afterWithdrawal = played.slice(1);
    expect(afterWithdrawal.some((id) => id.includes('a'))).toBe(false);
    // The run reports the tournament as it stands: the walkovers count, which
    // is what keeps games played comparable across the table.
    expect(results).toHaveLength(draw.fixtures.length);
    const walkovers = results.filter((r) => r.legs[0]!.result.mercy === true);
    expect(walkovers.length).toBeGreaterThan(0);
    // Only the team that went home is walked over, and the game they did play
    // before going home is still a played game.
    for (const walkover of walkovers) expect(walkover.home === 'A' || walkover.away === 'A').toBe(true);
    expect(results.find((r) => r.fixtureId === played[0])!.legs[0]!.result.mercy).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it('re-offers a fixture under the names it has been substituted to', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'substituted-mid-run' });
    await saveDraw(dir, draw);

    const offers: string[] = [];
    await runDraw(dir, draw, {
      playLeg: async () => ({ result: scored(0, 0), submissions: {} }),
      openPregame: async (fixture) => {
        offers.push(`${fixture.home} v ${fixture.away}`);
        if (offers.length === 1) {
          await appendAmendment(dir, draw.id, {
            kind: 'substitute',
            team: 'B',
            replacement: 'D',
            at: new Date().toISOString(),
            by: { id: null, slug: 'organiser' },
            reason: 'B withdrew and D took their place',
          });
          return 'dropped';
        }
      },
    });

    expect(offers[0]).toBe('A v B');
    // The same fixture, offered again as the draw now reads it.
    expect(offers[1]).toBe('A v D');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps playing the last good draw when a record will not parse', async () => {
    const dir = await root();
    const draw = makeDraw(['A', 'B'], { name: 'broken-record' });
    await saveDraw(dir, draw);
    await mkdir(join(dir, draw.id, 'amendments'), { recursive: true });
    await writeFile(join(dir, draw.id, 'amendments', '0001.json'), '{ this is not json');

    // A venue's schedule does not stop because a file was caught half-written.
    // Every screen that reads a tournament is already loud about it.
    const results = await runDraw(dir, draw, {
      playLeg: async () => ({ result: scored(2, 0), submissions: {} }),
    });
    expect(results).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });
});
