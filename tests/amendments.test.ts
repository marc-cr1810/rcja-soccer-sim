/**
 * Correcting a draw that must never be rewritten.
 *
 * One claim is load-bearing and everything else follows from it: the draw on
 * disk is immutable, so what a competition actually reads is the draw folded
 * with whatever corrections have been appended beside it. These tests fold real
 * records over a real draw and ask the ordinary questions — what is the table,
 * what is next, who is playing whom — because that is how every screen in the
 * league asks them.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foldTournament, parseAmendment, type Amendment } from '../src/amendments';
import { parseKickoff } from '../src/cli';
import type { MatchResult } from '../src/match';
import {
  deriveTable,
  makeDraw,
  nextFixture,
  type Draw,
  type FixtureResult,
} from '../src/tournament';
import {
  appendAmendment,
  AMENDMENTS_DIRNAME,
  loadAmendments,
  loadTournament,
  saveDraw,
  saveResult,
} from '../src/tournament-store';

const TEAMS = ['Ada', 'Babbage', 'Curie'];

function draw(opts: { legs?: number } = {}): Draw {
  return makeDraw(TEAMS, { name: 'amend test', legs: opts.legs ?? 1, seed: 7 });
}

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

function played(made: Draw, fixtureId: string, legs: [number, number][], at?: string): FixtureResult {
  const fixture = made.fixtures.find((f) => f.id === fixtureId)!;
  return {
    fixtureId,
    home: fixture.home,
    away: fixture.away,
    submissions: {},
    legs: legs.map(([violet, lime], leg) => ({ seed: fixture.seeds[leg]!, result: scored(violet, lime) })),
    completedAt: at ?? new Date().toISOString(),
  };
}

/** A record of any kind, with the boilerplate every one of them carries. */
function amend(n: number, rest: Record<string, unknown>): Amendment {
  return {
    n,
    at: new Date(Date.UTC(2026, 8, 19, 9, n)).toISOString(),
    by: { id: null, slug: 'organiser' },
    reason: 'because somebody decided so',
    ...rest,
  } as Amendment;
}

function standing(made: Draw, results: FixtureResult[], team: string) {
  return deriveTable(made, results).find((s) => s.name === team)!;
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rcja-amend-test-'));
}

describe('a draw with nothing amended', () => {
  it('folds to exactly the draw on disk', () => {
    const made = draw();
    const results = [played(made, 'ada-v-babbage', [[3, 1]])];
    const folded = foldTournament(made, results, []);
    expect(folded.draw).toEqual(made);
    expect(folded.results).toEqual(results);
  });
});

describe('voiding a fixture', () => {
  it('takes it out of the draw, the table and what is next', () => {
    const made = draw();
    const first = made.fixtures[0]!;
    const { draw: folded, results } = foldTournament(
      made,
      [played(made, first.id, [[4, 0]])],
      [amend(1, { kind: 'void', fixtureId: first.id })],
    );

    expect(folded.fixtures.some((f) => f.id === first.id)).toBe(false);
    expect(folded.fixtures).toHaveLength(made.fixtures.length - 1);
    // Its result goes with it — a fixture that did not count cannot leave
    // points behind.
    expect(results).toHaveLength(0);
    expect(standing(folded, results, first.home).played).toBe(0);
    expect(nextFixture(folded, results)!.id).not.toBe(first.id);
  });

  it('is undone by a later restore, and redone by a later void', () => {
    const made = draw();
    const id = made.fixtures[0]!.id;
    const has = (records: Amendment[]) =>
      foldTournament(made, [], records).draw.fixtures.some((f) => f.id === id);

    expect(has([amend(1, { kind: 'void', fixtureId: id })])).toBe(false);
    expect(
      has([amend(1, { kind: 'void', fixtureId: id }), amend(2, { kind: 'restore', fixtureId: id })]),
    ).toBe(true);
    expect(
      has([
        amend(1, { kind: 'void', fixtureId: id }),
        amend(2, { kind: 'restore', fixtureId: id }),
        amend(3, { kind: 'void', fixtureId: id }),
      ]),
    ).toBe(false);
  });
});

describe('substituting a team', () => {
  it('replaces them in the fixtures they have not played yet', () => {
    const made = draw();
    const done = played(made, 'ada-v-babbage', [[2, 0]]);
    const { draw: folded, results } = foldTournament(
      made,
      [done],
      [amend(1, { kind: 'substitute', team: 'Ada', replacement: 'Dijkstra' })],
    );

    for (const fixture of folded.fixtures) {
      if (fixture.id === 'ada-v-babbage') continue;
      expect(fixture.home === 'Ada' || fixture.away === 'Ada').toBe(false);
    }
    expect(folded.fixtures.find((f) => f.id === 'ada-v-curie')!.home).toBe('Dijkstra');
    expect(folded.entrants).toContain('Dijkstra');

    // The game Ada actually played still counts for Ada, which it can only do
    // while their name is still in the table.
    expect(folded.entrants).toContain('Ada');
    expect(standing(folded, results, 'Ada').points).toBe(3);
    expect(standing(folded, results, 'Dijkstra').played).toBe(0);
  });

  it('keeps every fixture id and seed, so a fixture still replays as itself', () => {
    const made = draw({ legs: 3 });
    const { draw: folded } = foldTournament(
      made,
      [],
      [amend(1, { kind: 'substitute', team: 'Ada', replacement: 'Dijkstra' })],
    );
    expect(folded.fixtures.map((f) => f.id).sort()).toEqual(made.fixtures.map((f) => f.id).sort());
    for (const fixture of folded.fixtures) {
      expect(fixture.seeds).toEqual(made.fixtures.find((f) => f.id === fixture.id)!.seeds);
    }
  });
});

describe('a team withdrawing', () => {
  it('awards their remaining fixtures as walkovers, one per leg', () => {
    const made = draw({ legs: 3 });
    const { draw: folded, results } = foldTournament(
      made,
      [],
      [amend(1, { kind: 'withdraw', team: 'Ada', goals: 5 })],
    );

    const walkover = results.find((r) => r.fixtureId === 'ada-v-babbage')!;
    expect(walkover.legs).toHaveLength(3);
    expect(walkover.legs[0]!.result.score).toEqual({ violet: 0, lime: 5 });
    expect(walkover.legs[0]!.result.mercy).toBe(true);
    expect(walkover.legs[0]!.result.abandoned).toBe(false);
    // The other way round, the withdrawn team is away and the goals swap sides.
    expect(results.find((r) => r.fixtureId === 'babbage-v-ada')!.legs[0]!.result.score).toEqual({
      violet: 5,
      lime: 0,
    });

    // Every fixture the withdrawn team was in is accounted for — four of the
    // six, the other two being between the teams still here — so nobody ends
    // the day having played fewer games than their rivals because of somebody
    // else's bus.
    expect(results).toHaveLength(4);
    expect(folded.fixtures).toHaveLength(6);
    expect(standing(folded, results, 'Ada').played).toBe(4);
    expect(standing(folded, results, 'Ada').points).toBe(0);
    for (const team of ['Babbage', 'Curie']) {
      expect(standing(folded, results, team).played).toBe(2);
      expect(standing(folded, results, team).points).toBe(6);
    }
  });

  it('leaves the games they did play exactly as they were', () => {
    const made = draw();
    const real = played(made, 'ada-v-babbage', [[3, 1]]);
    const { draw: folded, results } = foldTournament(
      made,
      [real],
      [amend(1, { kind: 'withdraw', team: 'Ada', goals: 5 })],
    );
    expect(results.find((r) => r.fixtureId === 'ada-v-babbage')).toEqual(real);
    expect(standing(folded, results, 'Ada').points).toBe(3);
  });
});

describe('voiding a result', () => {
  it('drops that result and leaves the fixture to be played again', () => {
    const made = draw();
    const wrong = played(made, 'ada-v-babbage', [[9, 0]], '2026-09-19T09:00:00.000Z');
    const { draw: folded, results } = foldTournament(
      made,
      [wrong],
      [amend(1, { kind: 'void-result', fixtureId: 'ada-v-babbage', completedAt: wrong.completedAt })],
    );

    expect(results).toHaveLength(0);
    expect(folded.fixtures.some((f) => f.id === 'ada-v-babbage')).toBe(true);
    expect(nextFixture(folded, results)!.id).toBe('ada-v-babbage');
  });

  it('does not disown the replayed result that comes after it', () => {
    const made = draw();
    const wrong = played(made, 'ada-v-babbage', [[9, 0]], '2026-09-19T09:00:00.000Z');
    const again = played(made, 'ada-v-babbage', [[1, 2]], '2026-09-19T11:00:00.000Z');
    const { results } = foldTournament(
      made,
      [again],
      [amend(1, { kind: 'void-result', fixtureId: 'ada-v-babbage', completedAt: wrong.completedAt })],
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.legs[0]!.result.score).toEqual({ violet: 1, lime: 2 });
  });
});

describe('kick-off times', () => {
  it('puts the timed fixtures in time order, and the rest after them', () => {
    const made = draw();
    const [first, second, third] = made.fixtures as [
      Draw['fixtures'][number],
      Draw['fixtures'][number],
      Draw['fixtures'][number],
    ];
    const { draw: folded } = foldTournament(
      made,
      [],
      [
        amend(1, {
          kind: 'schedule',
          times: {
            [third.id]: '2026-09-19T09:00:00.000Z',
            [first.id]: '2026-09-19T10:00:00.000Z',
          },
        }),
      ],
    );

    expect(folded.fixtures[0]!.id).toBe(third.id);
    expect(folded.fixtures[0]!.playAt).toBe('2026-09-19T09:00:00.000Z');
    expect(folded.fixtures[1]!.id).toBe(first.id);
    // Untimed fixtures keep the order the draw made them in, after the ones
    // that have a time.
    expect(folded.fixtures[2]!.id).toBe(second.id);
    expect(folded.fixtures[2]!.playAt).toBeUndefined();
  });

  it('is moved by a later record without the earlier one being touched', () => {
    const made = draw();
    const id = made.fixtures[0]!.id;
    const { draw: folded } = foldTournament(
      made,
      [],
      [
        amend(1, { kind: 'schedule', times: { [id]: '2026-09-19T09:00:00.000Z' } }),
        amend(2, { kind: 'schedule', times: { [id]: '2026-09-19T14:40:00.000Z' } }),
      ],
    );
    expect(folded.fixtures.find((f) => f.id === id)!.playAt).toBe('2026-09-19T14:40:00.000Z');
  });
});

describe('a record on disk', () => {
  it('is appended, numbered, and read back in order', async () => {
    const dir = await root();
    const made = draw();
    await saveDraw(dir, made);

    const first = await appendAmendment(dir, made.id, {
      kind: 'void',
      fixtureId: 'ada-v-babbage',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'pitch flooded',
    });
    expect(first.n).toBe(1);

    const second = await appendAmendment(dir, made.id, {
      kind: 'restore',
      fixtureId: 'ada-v-babbage',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'mopped up',
    });
    expect(second.n).toBe(2);

    const read = await loadAmendments(dir, made.id);
    expect(read.map((a) => a.n)).toEqual([1, 2]);
    expect(read.map((a) => a.kind)).toEqual(['void', 'restore']);
    await rm(dir, { recursive: true, force: true });
  });

  it('never loses one organiser\u2019s record to another\u2019s', async () => {
    const dir = await root();
    const made = draw();
    await saveDraw(dir, made);

    const one = (reason: string) =>
      appendAmendment(dir, made.id, {
        kind: 'void',
        fixtureId: 'ada-v-babbage',
        at: new Date().toISOString(),
        by: { id: null, slug: 'organiser' },
        reason,
      });

    await Promise.all([one('one'), one('two'), one('three')]);
    const read = await loadAmendments(dir, made.id);
    expect(read).toHaveLength(3);
    expect(new Set(read.map((a) => a.n)).size).toBe(3);
    expect(new Set(read.map((a) => a.reason))).toEqual(new Set(['one', 'two', 'three']));
    await rm(dir, { recursive: true, force: true });
  });

  it('is loud about a record it cannot read, rather than quietly ignoring it', async () => {
    const dir = await root();
    const made = draw();
    await saveDraw(dir, made);
    const amendments = join(dir, made.id, AMENDMENTS_DIRNAME);
    await mkdir(amendments, { recursive: true });
    await writeFile(join(amendments, '0001.json'), JSON.stringify({ kind: 'void', n: 1 }));

    // Skipping it would silently un-void a fixture somebody voided.
    await expect(loadAmendments(dir, made.id)).rejects.toThrow(/0001\.json/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('reading a tournament', () => {
  it('folds the draw, the results and the corrections together', async () => {
    const dir = await root();
    const made = draw();
    await saveDraw(dir, made);
    await saveResult(dir, made, played(made, 'ada-v-babbage', [[2, 1]]));
    await appendAmendment(dir, made.id, {
      kind: 'void',
      fixtureId: 'babbage-v-ada',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'no time left in the day',
    });

    const { draw: folded, results, amendments } = await loadTournament(dir, made.id);
    expect(amendments).toHaveLength(1);
    expect(folded.fixtures.some((f) => f.id === 'babbage-v-ada')).toBe(false);
    expect(results).toHaveLength(1);
    expect(standing(folded, results, 'Ada').points).toBe(3);

    // And the draw itself is untouched on disk, which is the whole point.
    expect((await readdir(join(dir, made.id))).sort()).toEqual(['amendments', 'draw.json', 'results']);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a hand-written record', () => {
  it('refuses one with no reason, because a reason is the point', () => {
    const parsed = parseAmendment({
      n: 1,
      kind: 'void',
      fixtureId: 'ada-v-babbage',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
    });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a kind nobody has defined', () => {
    const parsed = parseAmendment({
      n: 1,
      kind: 'delete-everything',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'why not',
    });
    expect(parsed.ok).toBe(false);
  });

  it('takes one an organiser could plausibly have typed', () => {
    const parsed = parseAmendment({
      n: 4,
      kind: 'withdraw',
      team: 'Ada',
      goals: 10,
      at: '2026-09-19T09:00:00.000Z',
      by: { id: null, slug: 'marc' },
      reason: 'their bus did not arrive',
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('a kick-off time as a person types it', () => {
  const noon = new Date('2026-09-20T12:00:00');

  it('reads a bare clock time as that time today', () => {
    const at = new Date(parseKickoff('09:00', noon));
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(0);
    expect(at.getDate()).toBe(20);
    // Seconds are cleared: a programme is written in minutes.
    expect(at.getSeconds()).toBe(0);
  });

  it('reads a whole stamp, with or without the T', () => {
    expect(parseKickoff('2026-09-21T09:00')).toBe(parseKickoff('2026-09-21 09:00'));
    expect(new Date(parseKickoff('2026-09-21T09:00')).getDate()).toBe(21);
  });

  it('refuses what is not a time, rather than writing Invalid Date into a draw', () => {
    expect(() => parseKickoff('banana')).toThrow(/not a time/);
    expect(() => parseKickoff('25:00')).toThrow(/not a time of day/);
    expect(() => parseKickoff('09:77')).toThrow(/not a time of day/);
  });
});

describe('amend schedule, from a terminal', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcja-amend-cli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(['bun', 'src/cli.ts', ...args, '--tournaments', dir, '--data', join(dir, 'league')], {
      cwd: join(import.meta.dirname, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: out + err };
  }

  it('moves one fixture, and only that one', async () => {
    const made = draw();
    await saveDraw(dir, made);
    const moving = made.fixtures[2]!;

    const { code } = await runCli([
      'amend', 'schedule',
      '--draw', made.id,
      '--fixture', moving.id,
      '--at', '2026-09-20T14:20',
      '--why', 'their bus is late',
    ]);
    expect(code).toBe(0);

    const { draw: after } = await loadTournament(dir, made.id);
    // The only fixture with a time is the one that was given one — and it now
    // sorts to the front, because the fold puts timed fixtures first.
    expect(after.fixtures.filter((f) => f.playAt)).toHaveLength(1);
    expect(after.fixtures[0]!.id).toBe(moving.id);
  });

  it('re-lays the rest of the day and leaves the played part of it alone', async () => {
    const made = draw();
    await saveDraw(dir, made);
    const done = made.fixtures[0]!;
    await saveResult(dir, made, played(made, done.id, [[3, 1]]));

    const { code } = await runCli([
      'amend', 'schedule',
      '--draw', made.id,
      // Spelled in UTC, because the CLI runs in the venue's own timezone and
      // `bun test` runs in UTC — a bare clock time would mean two things.
      '--start', '2026-09-20T13:40:00Z',
      '--every', '15',
      '--why', 'the morning overran',
    ]);
    expect(code).toBe(0);

    const { draw: after } = await loadTournament(dir, made.id);
    expect(after.fixtures.find((f) => f.id === done.id)!.playAt).toBeUndefined();
    const timed = after.fixtures.filter((f) => f.playAt);
    expect(timed).toHaveLength(made.fixtures.length - 1);
    expect(timed[0]!.playAt).toBe('2026-09-20T13:40:00.000Z');
    expect(Date.parse(timed[1]!.playAt!) - Date.parse(timed[0]!.playAt!)).toBe(15 * 60_000);
  });

  it('refuses a fixture that is not in the draw, and says what is', async () => {
    const made = draw();
    await saveDraw(dir, made);
    const { code, out } = await runCli([
      'amend', 'schedule',
      '--draw', made.id,
      '--fixture', 'ada-v-nobody',
      '--at', '09:00',
      '--why', 'typo',
    ]);
    expect(code).toBe(1);
    expect(out).toContain('has no fixture');
    expect(out).toContain(made.fixtures[0]!.id);
    expect(await loadAmendments(dir, made.id)).toHaveLength(0);
  });

  it('refuses to guess when nobody said when', async () => {
    const made = draw();
    await saveDraw(dir, made);
    const { code, out } = await runCli(['amend', 'schedule', '--draw', made.id, '--why', 'because']);
    expect(code).toBe(1);
    expect(out).toContain('when?');
  });
});
