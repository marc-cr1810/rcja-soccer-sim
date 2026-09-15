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

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
import { loadDraw, loadResults, saveDraw, saveResult } from '../src/tournament-store';
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
