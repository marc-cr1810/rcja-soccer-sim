/**
 * What a late team costs, and what happens when they never come at all.
 *
 * C1 shipped the venue default — the referee starts the match when they judge
 * it right, and nothing is on a clock. This is the other half: a clock a
 * referee can start, and the ceiling that stops it running all afternoon.
 *
 * Two things are worth saying about the shape of it, because both are decisions
 * rather than conveniences.
 *
 * **The clock banks a minute at a time.** A running total worked out from the
 * start time would be recomputed on every read, and readiness changes — so the
 * moment the late team walked in, every goal they had cost their opponent would
 * be handed straight back. A minute that has elapsed is awarded to whoever was
 * owed it then, and never revisited.
 *
 * **A walkover is an ordinary result.** Not an abandonment, which `runDraw`
 * leaves unwritten and replays. It goes through the referee's confirmation like
 * every other result in this server, which is the thing that makes it safe: a
 * team arriving a minute after the margin was reached is somebody pressing
 * "play it again", not an argument.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../../src/league/league';
import { decided, penaltyGoals, walkoverResult, wholeMinutes } from '../../src/match/pregame';
import type { PregameVerdict } from '../../src/match/pregame';
import { makeDraw } from '../../src/league/tournament';
import { saveDraw, loadResults } from '../../src/league/tournament-store';
import type { Fixture, FixtureResult } from '../../src/league/tournament';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../../../../python');
const PASSWORD = 'a-long-enough-password';
const MINUTE = 60_000;

const servers: LeagueServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the arithmetic of a late team', () => {
  const at = (mins: number): string => new Date(mins * MINUTE).toISOString();

  it('counts whole minutes and never a fraction of one', () => {
    // The promise made to a team being penalised: 2:59 of lateness is two
    // goals, not two and a bit rounded however the page felt like rounding it.
    expect(wholeMinutes(at(0), 2.99 * MINUTE)).toBe(2);
    expect(wholeMinutes(at(0), 0.99 * MINUTE)).toBe(0);
    // A clock that has not started, or a clock read backwards.
    expect(wholeMinutes(at(5), 1 * MINUTE)).toBe(0);
    expect(penaltyGoals(at(0), 4 * MINUTE, 1)).toBe(4);
    expect(penaltyGoals(at(0), 4 * MINUTE, 2)).toBe(8);
    // A venue that has turned the clock off gets nothing, whatever the minutes.
    expect(penaltyGoals(at(0), 40 * MINUTE, 0)).toBe(0);
  });

  it('knows when there is nothing left to play for', () => {
    expect(decided({ violet: 9, lime: 0 }, 10)).toBe(false);
    expect(decided({ violet: 10, lime: 0 }, 10)).toBe(true);
    expect(decided({ violet: 0, lime: 12 }, 10)).toBe(true);
    // No margin, no ceiling — a venue that turned the mercy rule off has also
    // turned off the only thing that ends a clock by itself.
    expect(decided({ violet: 99, lime: 0 }, null)).toBe(false);
  });

  it('writes a walkover as a result and not as an abandonment', () => {
    const result = walkoverResult({
      penalties: { violet: 10, lime: 0 },
      reason: 'Bravo did not arrive.',
    });
    expect(result.score).toEqual({ violet: 10, lime: 0 });
    // The distinction the whole design hangs off: `runDraw` throws on an
    // abandoned leg and leaves the fixture unwritten to be replayed.
    expect(result.abandoned).toBe(false);
    expect(result.mercy).toBe(true);
    // Nothing was played, so nothing was scored — and the scoreline says where
    // it came from instead of standing there unexplained.
    expect(result.goals).toEqual([]);
    expect(result.clock).toBe(0);
    expect(result.scoreCorrections).toEqual([
      { team: 'violet', from: 0, to: 10, reason: 'Bravo did not arrive.', at: 0 },
    ]);
  });
});

// ---------------------------------------------------------------- the venue

interface Started {
  server: LeagueServer;
  port: number;
  drawId: string;
  submissionsDir: string;
  tournamentsDir: string;
  draw: ReturnType<typeof makeDraw>;
  /** Move the venue's clock forward, in minutes. */
  wait: (mins: number) => void;
}

interface VenueOptions {
  autoStartMins?: number | null;
  penaltyPerMin?: number;
  mercyMargin?: number | null;
}

async function start(opts: VenueOptions = {}): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-clock-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const tournamentsDir = join(dataDir, 'tournaments');
  const draw = makeDraw(['Alpha', 'Bravo'], { name: 'test round' });
  await saveDraw(tournamentsDir, draw);

  // The venue's own clock, wound by hand. Whole minutes are the unit the rule
  // is written in, and a test that waited four of them would not be run.
  let offset = 0;
  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir,
    tournamentId: draw.id,
    now: () => Date.now() + offset,
    settings: {
      pregame: {
        autoStartMins: opts.autoStartMins ?? null,
        penaltyPerMin: opts.penaltyPerMin ?? 1,
      },
      rules: {
        mercyMargin: opts.mercyMargin === undefined ? 10 : opts.mercyMargin,
        // These fixtures never reach a second half, so the break between them
        // is nothing this file is about.
        halfTimeSeconds: 0,
      },
    },
    world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
  });
  servers.push(server);
  return {
    server,
    port: await server.listen(),
    drawId: draw.id,
    submissionsDir,
    tournamentsDir,
    draw,
    wait: (mins) => {
      offset += mins * MINUTE;
    },
  };
}

async function call(
  started: Started,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<{ status: number; payload: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(`http://127.0.0.1:${started.port}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

async function signIn(
  started: Started,
  role: 'team' | 'admin',
  displayName: string,
): Promise<string> {
  const made = started.server.accounts.createAccount({ role, displayName, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
    redirect: 'manual',
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

/** A robot on disk, the way a validated push leaves one. */
async function push(started: Started, slug: string, robot: 1 | 2): Promise<void> {
  const dir = join(started.submissionsDir, slug, String(robot));
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'manifest.json'), JSON.stringify({ team: slug, robot, entry: 'robot.py' }));
  await Bun.write(join(dir, 'robot.py'), `# ${slug} robot ${robot}\n`);
  await Bun.write(join(dir, 'token'), `token-${slug}-${robot}`);
}

const FIXTURE: Fixture = { id: 'alpha-v-bravo', home: 'Alpha', away: 'Bravo', seeds: [1] } as Fixture;

/**
 * A pre-game room with a real pitch under it and Alpha standing at it.
 *
 * A real arena, because the clock only ever awards against a team whose
 * opponent is *ready* — and readiness is a robot in a seat, which needs
 * somewhere to sit.
 */
async function roomWithAlpha(opts: VenueOptions = {}): Promise<{
  started: Started;
  organiser: string;
  alpha: string;
  bravo: string;
  gate: Promise<PregameVerdict>;
}> {
  const started = await start(opts);
  const organiser = await signIn(started, 'admin', 'Organiser');
  const alpha = await signIn(started, 'team', 'Alpha');
  const bravo = await signIn(started, 'team', 'Bravo');
  for (const slug of ['alpha', 'bravo']) {
    for (const robot of [1, 2] as const) await push(started, slug, robot);
  }

  const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
  const gate = started.server.awaitLineup(FIXTURE, started.drawId, arenaId);
  await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
  return { started, organiser, alpha, bravo, gate };
}

function goals(started: Started, cookie: string): Promise<{ status: number; payload: any }> {
  return call(started, '/api/referee/match/alpha-v-bravo', { cookie });
}

/** What the public schedule calls a fixture — the same fold every page uses. */
async function publicState(started: Started, fixtureId = 'alpha-v-bravo'): Promise<string> {
  const { payload } = await call(started, '/api/schedule');
  return payload.fixtures.find((f: { id: string }) => f.id === fixtureId).state;
}

describe('the penalty clock', () => {
  it(
    'awards a goal a minute to the team that is here, and stops when the other arrives',
    async () => {
      const { started, organiser, alpha, bravo, gate } = await roomWithAlpha();
      void gate.catch(() => {});

      // Nothing runs on its own. This is the shape of the whole phase: the
      // referee is the only one who can see whether the delay is the team's
      // fault or the venue's network.
      started.wait(3);
      await started.server.sweepPregames();
      expect((await goals(started, organiser)).payload.pregame.penalty.goals).toEqual({
        violet: 0,
        lime: 0,
      });

      const on = await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: true }),
      });
      expect(on.status).toBe(200);
      expect(on.payload.running).toBe(true);

      started.wait(3);
      await started.server.sweepPregames();
      const three = (await goals(started, organiser)).payload.pregame;
      expect(three.penalty.goals).toEqual({ violet: 3, lime: 0 });
      expect(three.penalty.running).toBe(true);

      // Bravo walk in. The three goals they have already cost Alpha are
      // theirs to have cost — a scoreline that could be wound back by turning
      // up would make the clock pointless.
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: bravo });
      started.wait(5);
      await started.server.sweepPregames();
      const after = (await goals(started, organiser)).payload.pregame;
      expect(after.penalty.goals).toEqual({ violet: 3, lime: 0 });
      expect(after.penalty.running).toBe(false);

      // And they travel to the match, which is the only way they mean anything.
      const started_ = await call(started, '/api/referee/match/alpha-v-bravo/start', {
        method: 'POST',
        cookie: organiser,
      });
      expect(started_.status).toBe(200);
      const verdict = await gate;
      expect(verdict).toEqual({ kind: 'play', penalties: { violet: 3, lime: 0 } });
      void alpha;
    },
    40_000,
  );

  it(
    'awards nothing while neither team is here, and says so',
    async () => {
      const started = await start();
      const organiser = await signIn(started, 'admin', 'Organiser');
      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      const gate = started.server.awaitLineup(FIXTURE, started.drawId, arenaId);
      void gate.catch(() => {});

      await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: true }),
      });
      started.wait(20);
      await started.server.sweepPregames();

      // Twenty minutes and not a goal: there is nobody to award one to. The
      // fixture is not decided against two absent teams by a timer.
      const room = (await goals(started, organiser)).payload.pregame;
      expect(room.penalty.goals).toEqual({ violet: 0, lime: 0 });
      // Said out loud, so it is somebody's decision rather than a pitch
      // quietly sitting idle.
      expect(room.nobodyHere).toBe(true);
      expect(await publicState(started)).toBe('pregame');
    },
    40_000,
  );

  it(
    'keeps what it earned when the referee stops it',
    async () => {
      const { started, organiser, gate } = await roomWithAlpha();
      void gate.catch(() => {});

      await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: true }),
      });
      started.wait(2);
      const off = await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: false }),
      });
      expect(off.payload.running).toBe(false);
      expect(off.payload.penalties).toEqual({ violet: 2, lime: 0 });

      // Stopped means stopped: the next ten minutes cost Bravo nothing.
      started.wait(10);
      await started.server.sweepPregames();
      expect((await goals(started, organiser)).payload.pregame.penalty.goals).toEqual({
        violet: 2,
        lime: 0,
      });
    },
    40_000,
  );

  it(
    'does not hand the minutes back when a referee presses start twice',
    async () => {
      const { started, organiser, gate } = await roomWithAlpha();
      void gate.catch(() => {});

      const press = () =>
        call(started, '/api/referee/match/alpha-v-bravo/penalty', {
          method: 'POST',
          cookie: organiser,
          body: JSON.stringify({ on: true }),
        });
      await press();
      started.wait(4);
      // A referee refreshing the page and pressing it again. Restarting the
      // clock here would quietly forgive the four minutes.
      await press();
      await started.server.sweepPregames();
      expect((await goals(started, organiser)).payload.pregame.penalty.goals).toEqual({
        violet: 4,
        lime: 0,
      });
    },
    40_000,
  );

  it(
    'is not a button anybody can press',
    async () => {
      const { started, alpha, gate } = await roomWithAlpha();
      void gate.catch(() => {});
      const refused = await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: alpha,
        body: JSON.stringify({ on: true }),
      });
      expect(refused.status).toBe(403);
    },
    40_000,
  );

  it(
    'is not offered at all by a venue that turned it off',
    async () => {
      const { started, organiser, gate } = await roomWithAlpha({ penaltyPerMin: 0 });
      void gate.catch(() => {});
      const refused = await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: true }),
      });
      expect(refused.status).toBe(409);
      expect((await goals(started, organiser)).payload.pregame.penalty.available).toBe(false);
    },
    40_000,
  );
});

describe('a fixture nobody turned up for', () => {
  it(
    'is awarded once the clock reaches the mercy margin, without playing',
    async () => {
      const { started, organiser, gate } = await roomWithAlpha();

      await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: true }),
      });
      started.wait(10);
      await started.server.sweepPregames();

      const verdict = await gate;
      expect(verdict.kind).toBe('walkover');
      expect(verdict.penalties).toEqual({ violet: 10, lime: 0 });
      if (verdict.kind === 'walkover') expect(verdict.reason).toContain('Bravo');

      // And the room is gone, so the pitch goes back to the venue rather than
      // sitting through a match that is not going to happen.
      expect(await publicState(started)).not.toBe('pregame');
    },
    40_000,
  );

  it(
    'writes as an ordinary result that the table can read',
    async () => {
      // The end of the path: what the hub does with that verdict is build a
      // `FixtureResult` and save it, and nothing downstream is allowed to need
      // a special case for a match that was never played.
      const started = await start();
      const result: FixtureResult = {
        fixtureId: FIXTURE.id,
        home: FIXTURE.home,
        away: FIXTURE.away,
        submissions: {},
        legs: [
          {
            seed: 1,
            result: walkoverResult({
              penalties: { violet: 10, lime: 0 },
              reason: 'Bravo did not arrive.',
            }),
          },
        ],
        completedAt: new Date().toISOString(),
      };
      const { saveResult } = await import('../../src/league/tournament-store');
      await saveResult(started.tournamentsDir, started.draw, result);

      const back = await loadResults(started.tournamentsDir, started.draw);
      expect(back).toHaveLength(1);
      expect(back[0]!.legs[0]!.result.score).toEqual({ violet: 10, lime: 0 });
      expect(back[0]!.legs[0]!.result.abandoned).toBe(false);

      // And the public schedule reads it as played, like any other.
      expect(await publicState(started)).toBe('played');
    },
    40_000,
  );
});

describe('a room that starts itself', () => {
  it(
    'plays whatever is on disk once the configured wait has passed',
    async () => {
      const { started, gate } = await roomWithAlpha({ autoStartMins: 15 });

      started.wait(14);
      await started.server.sweepPregames();
      expect(await publicState(started)).toBe('pregame');

      started.wait(2);
      await started.server.sweepPregames();
      const verdict = await gate;
      // No clock was running, so nobody is penalised — auto-start and the
      // penalty clock are a setting and a referee action, not two halves of
      // one policy.
      expect(verdict).toEqual({ kind: 'play', penalties: { violet: 0, lime: 0 } });
    },
    40_000,
  );

  it(
    'never starts itself at a venue that did not ask for it',
    async () => {
      // The shipped default, and the answer this phase has now given four
      // times: nothing is on a clock until somebody says so.
      const { started, organiser, gate } = await roomWithAlpha();
      void gate.catch(() => {});
      started.wait(240);
      await started.server.sweepPregames();
      expect(await publicState(started)).toBe('pregame');
      expect((await goals(started, organiser)).payload.pregame.autoStartAt).toBeNull();
    },
    40_000,
  );
});
