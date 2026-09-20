/**
 * What a referee is shown, and what they are not.
 *
 * The thing being defended is a page that has to be right about a match that
 * has not started. A referee walks to a pitch twenty minutes early and asks
 * one question — is this one mine? — and until this slice the server could
 * only answer about matches already running, which is the moment the answer
 * stops being useful.
 *
 * The other half is the narrowing from Slice A, seen from the outside: that
 * two referees at a venue with two pitches are each shown one game, and that
 * a fixture id typed into the address bar is not a way around it.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../../src/league/league';
import type { PregameVerdict } from '../../src/match/pregame';
import { makeDraw } from '../../src/league/tournament';
import { appendAmendment, saveDraw } from '../../src/league/tournament-store';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../python');
const PASSWORD = 'a-long-enough-password';

const servers: LeagueServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Started {
  server: LeagueServer;
  port: number;
  drawId: string;
  /** Where a seeded push goes, for the tests that need code on disk. */
  submissionsDir: string;
  /** Where the draw lives, for the tests that append a correction to it. */
  tournamentsDir: string;
}

/**
 * A venue with a draw actually on disk.
 *
 * Every other harness in this repo leaves `tournamentId` out, so the server
 * answers "no tournament" to everything about a fixture. A referee's page is
 * the first thing that cannot be tested that way.
 */
async function start(withDraw = true): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-ref-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const tournamentsDir = join(dataDir, 'tournaments');
  const draw = makeDraw(['Alpha', 'Bravo', 'Charlie', 'Delta'], { name: 'test round' });
  if (withDraw) await saveDraw(tournamentsDir, draw);

  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir,
    tournamentId: withDraw ? draw.id : null,
    world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
  });
  servers.push(server);
  return { server, port: await server.listen(), drawId: draw.id, submissionsDir, tournamentsDir };
}

async function signIn(started: Started, role: 'referee' | 'admin', name: string): Promise<string> {
  const made = started.server.accounts.createAccount({ role, displayName: name, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
    redirect: 'manual',
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error(`${name} could not sign in`);
  return raw.split(';')[0]!;
}

/**
 * A team account, signed in.
 *
 * `signIn` above takes only the two roles a referee's page cares about; the
 * pre-game room is the first thing here a team does anything on.
 */
async function signInTeam(started: Started, displayName: string): Promise<string> {
  const made = started.server.accounts.createAccount({ role: 'team', displayName, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
    redirect: 'manual',
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error(`${displayName} could not sign in`);
  return raw.split(';')[0]!;
}

function give(started: Started, slug: string, fixtureId: string): void {
  const account = started.server.accounts.bySlug(slug);
  if (!account) throw new Error(`no account ${slug}`);
  started.server.accounts.assign({ accountId: account.id, drawId: started.drawId, fixtureId, by: null });
}

async function get(started: Started, path: string, cookie: string): Promise<{ status: number; payload: any }> {
  const res = await fetch(`http://127.0.0.1:${started.port}${path}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

async function post(started: Started, path: string, cookie: string): Promise<{ status: number; payload: any }> {
  const res = await fetch(`http://127.0.0.1:${started.port}${path}`, {
    method: 'POST',
    headers: { cookie },
    redirect: 'manual',
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

/** A fixture played out and held at full time, exactly as the draw runner leaves it. */
function atFullTime(
  started: Started,
  fixtureId: string,
  score: [number, number] = [2, 1],
): Promise<string> {
  const fixture = { id: fixtureId, home: 'Alpha', away: 'Bravo', seeds: [1] };
  return started.server.awaitConfirmation(fixture as never, started.drawId, {
    fixtureId,
    home: fixture.home,
    away: fixture.away,
    submissions: {},
    legs: [
      {
        seed: 1,
        result: {
          score: { violet: score[0]!, lime: score[1]! },
          clock: 600,
          goals: [],
          slots: {},
          calls: {},
          events: [],
          refereeActions: [],
          scoreCorrections: [],
          abandoned: false,
        },
      },
    ],
    completedAt: new Date().toISOString(),
  });
}

describe("a referee's own fixtures", () => {
  it('shows an assigned match that has not started', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');

    // Nothing is running at all — no arena has ever been spawned here.
    const { payload } = await get(started, '/api/referee/fixtures', cookie);
    expect(payload.ok).toBe(true);
    expect(payload.fixtures.map((f: any) => f.id)).toEqual(['alpha-v-bravo']);
    expect(payload.fixtures[0].state).toBe('upcoming');
    // Nothing to take yet, and the page must not pretend otherwise.
    expect(payload.fixtures[0].console).toBeUndefined();
  });

  it('shows each referee their own game and not the other pitch', async () => {
    const started = await start();
    const sam = await signIn(started, 'referee', 'Sam Referee');
    const alex = await signIn(started, 'referee', 'Alex Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    give(started, 'alex-referee', 'charlie-v-delta');

    const hers = await get(started, '/api/referee/fixtures', sam);
    const theirs = await get(started, '/api/referee/fixtures', alex);
    expect(hers.payload.fixtures.map((f: any) => f.id)).toEqual(['alpha-v-bravo']);
    expect(theirs.payload.fixtures.map((f: any) => f.id)).toEqual(['charlie-v-delta']);
  });

  it('shows an admin every fixture in the draw, assigned or not', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const { payload } = await get(started, '/api/referee/fixtures', cookie);
    // Four entrants, home and away: twelve.
    expect(payload.fixtures.length).toBe(12);
  });

  it('tells a referee who has been given nothing that they have nothing', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Pat Referee');

    // An empty page rather than a shut door: at a venue, being bounced to
    // somewhere else looks like an account that does not work, and there is
    // nothing to protect here — the list can only ever show them their own.
    const list = await get(started, '/api/referee/fixtures', cookie);
    expect(list.status).toBe(200);
    expect(list.payload.fixtures).toEqual([]);

    // The matches themselves are still not theirs.
    expect((await get(started, '/api/referee/match/alpha-v-bravo', cookie)).status).toBe(403);
  });

  it('keeps a team account out of the referee pages entirely', async () => {
    const started = await start();
    const made = started.server.accounts.createAccount({
      role: 'team',
      displayName: 'Alpha',
      password: PASSWORD,
    });
    if (!made.ok) throw new Error(made.reason);
    const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', password: PASSWORD }),
      redirect: 'manual',
    });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect((await get(started, '/api/referee/fixtures', cookie)).status).toBe(403);
  });

  it('answers an empty list rather than an error when no draw is being run', async () => {
    const started = await start(false);
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const { payload } = await get(started, '/api/referee/fixtures', cookie);
    expect(payload.ok).toBe(true);
    expect(payload.tournament).toBe(null);
    expect(payload.fixtures).toEqual([]);
  });
});

describe('one fixture, at a name that does not move', () => {
  it('serves the match a referee was given, before there is an arena', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');

    const { status, payload } = await get(started, '/api/referee/match/alpha-v-bravo', cookie);
    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.fixture).toEqual({ id: 'alpha-v-bravo', home: 'Alpha', away: 'Bravo' });
    expect(payload.state).toBe('upcoming');
    expect(payload.live).toBe(null);
    expect(payload.console).toBe(null);
  });

  it('refuses the fixture on the next pitch over, typed in by hand', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');

    const { status, payload } = await get(started, '/api/referee/match/charlie-v-delta', cookie);
    expect(status).toBe(403);
    expect(payload.ok).toBe(false);
  });

  it('says so when the fixture is not in the draw', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const { payload } = await get(started, '/api/referee/match/alpha-v-zulu', cookie);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('no such fixture');
  });

  it('does not leak an assignment from another draw', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    // The same fixture id, in a division this server is not running.
    const account = started.server.accounts.bySlug('sam-referee')!;
    started.server.accounts.assign({
      accountId: account.id,
      drawId: 'some-other-round',
      fixtureId: 'alpha-v-bravo',
      by: null,
    });

    // They hold an assignment, so the door opens...
    const list = await get(started, '/api/referee/fixtures', cookie);
    expect(list.status).toBe(200);
    // ...onto nothing, because that fixture belongs to a different draw.
    expect(list.payload.fixtures).toEqual([]);
    expect((await get(started, '/api/referee/match/alpha-v-bravo', cookie)).status).toBe(403);
  });
});

/**
 * The moment a match becomes a result.
 *
 * Everything above is about what a referee is shown. This is the one thing they
 * decide: until somebody presses a button here the fixture is played but not
 * recorded, and the table does not know about it.
 */
describe('agreeing the score', () => {
  it('writes nothing until the referee says so, then answers the promise', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    const waiting = atFullTime(started, 'alpha-v-bravo');

    // The fixture reads as neither playing nor played, on their page and on
    // the public schedule both.
    const mine = await get(started, '/api/referee/match/alpha-v-bravo', cookie);
    expect(mine.payload.state).toBe('confirming');
    expect(mine.payload.final.homeScore).toBe(2);
    expect(mine.payload.final.awayScore).toBe(1);

    const sheet = await get(started, '/api/schedule', cookie);
    expect(sheet.payload.fixtures.find((f: any) => f.id === 'alpha-v-bravo').state).toBe('confirming');

    const answered = await post(started, '/api/referee/match/alpha-v-bravo/confirm', cookie);
    expect(answered.status).toBe(200);
    expect(await waiting).toBe('confirmed');
  });

  it('hands the match back to be played again', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    const waiting = atFullTime(started, 'alpha-v-bravo');

    expect((await post(started, '/api/referee/match/alpha-v-bravo/replay', cookie)).status).toBe(200);
    expect(await waiting).toBe('replay');
  });

  it('refuses the referee on the next pitch over', async () => {
    const started = await start();
    const sam = await signIn(started, 'referee', 'Sam Referee');
    const alex = await signIn(started, 'referee', 'Alex Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    give(started, 'alex-referee', 'charlie-v-delta');
    const waiting = atFullTime(started, 'alpha-v-bravo');

    const refused = await post(started, '/api/referee/match/alpha-v-bravo/confirm', alex);
    expect(refused.status).toBe(403);
    expect(refused.payload.ok).toBe(false);

    // And it is still there afterwards for the referee it belongs to.
    expect((await post(started, '/api/referee/match/alpha-v-bravo/confirm', sam)).status).toBe(200);
    expect(await waiting).toBe('confirmed');
  });

  it('lets an admin agree it when the referee has walked away', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    // Nobody is even assigned to it — the draw is stalled and somebody has to
    // be able to unstick it without an ssh session.
    const waiting = atFullTime(started, 'alpha-v-bravo');
    expect((await post(started, '/api/referee/match/alpha-v-bravo/confirm', cookie)).status).toBe(200);
    expect(await waiting).toBe('confirmed');
  });

  it('says nothing is waiting, rather than pretending it agreed', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const answered = await post(started, '/api/referee/match/alpha-v-bravo/confirm', cookie);
    expect(answered.status).toBe(404);
    expect(answered.payload.ok).toBe(false);
  });

  it('only answers once, so two referees cannot both confirm it', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const waiting = atFullTime(started, 'alpha-v-bravo');
    expect((await post(started, '/api/referee/match/alpha-v-bravo/confirm', cookie)).status).toBe(200);
    expect((await post(started, '/api/referee/match/alpha-v-bravo/replay', cookie)).status).toBe(404);
    expect(await waiting).toBe('confirmed');
  });

  it('keeps a team account away from the buttons entirely', async () => {
    const started = await start();
    const made = started.server.accounts.createAccount({
      role: 'team',
      displayName: 'Alpha',
      password: PASSWORD,
    });
    if (!made.ok) throw new Error(made.reason);
    const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', password: PASSWORD }),
      redirect: 'manual',
    });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const waiting = atFullTime(started, 'alpha-v-bravo');

    expect((await post(started, '/api/referee/match/alpha-v-bravo/confirm', cookie)).status).toBe(403);
    // Left held, not quietly resolved by the refusal.
    await started.server.close();
    await expect(waiting).rejects.toThrow('stopped before the result was confirmed');
  });

  it('rejects a waiting confirmation when the hub goes down, rather than hanging', async () => {
    const started = await start();
    const waiting = atFullTime(started, 'alpha-v-bravo');
    await started.server.close();
    // A hub killed at full time writes nothing, which is the same answer as a
    // hub killed mid-match: the fixture replays as itself.
    await expect(waiting).rejects.toThrow('stopped before the result was confirmed');
  });
});

/** A fixture whose turn has come, exactly as the draw runner leaves it. */
function whenDue(started: Started, fixtureId: string): Promise<void | 'dropped'> {
  const [home, away] = fixtureId.split('-v-');
  return started.server.awaitPregame(
    { id: fixtureId, home: home!, away: away!, seeds: [1] } as never,
    started.drawId,
  );
}

describe('opening the match', () => {
  it('waits for the referee, and spawns nothing until they open it', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');

    let opened = false;
    void whenDue(started, 'alpha-v-bravo').then(() => {
      opened = true;
    });

    // The referee's own page and the sheet on the wall agree, and neither of
    // them is describing anything that is running: no arena exists.
    const mine = await get(started, '/api/referee/match/alpha-v-bravo', cookie);
    expect(mine.payload.state).toBe('due');
    const sheet = await get(started, '/api/schedule', cookie);
    expect(sheet.payload.fixtures.find((f: any) => f.id === 'alpha-v-bravo').state).toBe('due');
    expect(started.server.live).toEqual([]);
    expect(opened).toBe(false);

    const res = await post(started, '/api/referee/match/alpha-v-bravo/open', cookie);
    expect(res.status).toBe(200);
    expect(res.payload.ok).toBe(true);
    await new Promise((t) => setTimeout(t, 5));
    expect(opened).toBe(true);

    // And it says so while the pitch comes up, rather than reading as "not
    // started" to the person who just started it.
    const after = await get(started, '/api/referee/match/alpha-v-bravo', cookie);
    expect(after.payload.state).toBe('opening');
  });

  it('will not let a referee open somebody else’s match', async () => {
    const started = await start();
    const sam = await signIn(started, 'referee', 'Sam Referee');
    const alex = await signIn(started, 'referee', 'Alex Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    give(started, 'alex-referee', 'charlie-v-delta');

    let opened = false;
    void whenDue(started, 'alpha-v-bravo').then(() => {
      opened = true;
    });

    const refused = await post(started, '/api/referee/match/alpha-v-bravo/open', alex);
    expect(refused.status).toBe(403);
    await new Promise((t) => setTimeout(t, 5));
    expect(opened).toBe(false);

    // Still Sam's to open — a refusal must not consume the fixture.
    expect((await get(started, '/api/referee/match/alpha-v-bravo', sam)).payload.state).toBe('due');
    expect((await post(started, '/api/referee/match/alpha-v-bravo/open', sam)).status).toBe(200);
  });

  it('lets an admin open a fixture nobody was assigned', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');

    let opened = false;
    void whenDue(started, 'alpha-v-bravo').then(() => {
      opened = true;
    });

    // The referee has not arrived and somebody has to start the match.
    expect((await post(started, '/api/referee/match/alpha-v-bravo/open', cookie)).status).toBe(200);
    await new Promise((t) => setTimeout(t, 5));
    expect(opened).toBe(true);
  });

  it('answers a match that is not ready with a 404', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const res = await post(started, '/api/referee/match/alpha-v-bravo/open', cookie);
    expect(res.status).toBe(404);
  });

  it('does not treat a second press as a mistake', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    void whenDue(started, 'alpha-v-bravo');

    expect((await post(started, '/api/referee/match/alpha-v-bravo/open', cookie)).status).toBe(200);
    // A referee who presses a button and sees nothing happen presses it again,
    // and a child process takes a moment to come up.
    const again = await post(started, '/api/referee/match/alpha-v-bravo/open', cookie);
    expect(again.status).toBe(200);
    expect(again.payload.already).toBe(true);
  });

  it('gives up waiting when the server stops, rather than hanging', async () => {
    const started = await start();
    const waiting = whenDue(started, 'alpha-v-bravo');
    await started.server.close();
    // Without this the draw runner waits forever for a referee who has gone
    // home, and the process never exits.
    await expect(waiting).rejects.toThrow(/stopped before the match was opened/);
  });

  it('writes down who opened it', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    void whenDue(started, 'alpha-v-bravo');
    await post(started, '/api/referee/match/alpha-v-bravo/open', cookie);

    const rows = started.server.accounts.audit();
    expect(rows[0]).toMatchObject({
      capability: 'match.control',
      target: `${started.drawId}:alpha-v-bravo`,
      detail: 'opened pre-game',
    });
  });
});

/**
 * A fixture with a pitch under it, waiting for its teams — exactly as the draw
 * runner leaves it once a referee has opened pre-game.
 *
 * No arena is spawned here. The gate is about who may end pre-game and what
 * the checklist says while it is open, and a child process holding four
 * sandboxed interpreters proves none of that. The half that is about robots
 * actually moving is `tests/pregame-join.test.ts`, which does spawn them.
 */
function inPregame(
  started: Started,
  fixtureId: string,
  arenaId = 'test-arena',
): Promise<PregameVerdict> {
  const [home, away] = fixtureId.split('-v-');
  return started.server.awaitLineup(
    { id: fixtureId, home: home!, away: away!, seeds: [1] } as never,
    started.drawId,
    arenaId,
  );
}

/** A robot on disk, the way a validated push leaves one. */
async function push(started: Started, slug: string, robot: 1 | 2): Promise<void> {
  const dir = join(started.submissionsDir, slug, String(robot));
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'manifest.json'), JSON.stringify({ team: slug, robot, entry: 'robot.py' }));
  await Bun.write(join(dir, 'robot.py'), `# ${slug} robot ${robot}\n`);
  // The token is what `resolveLineup` refuses a folder for the lack of, so a
  // seeded push without one is not a push at all.
  await Bun.write(join(dir, 'token'), `token-${slug}-${robot}`);
}

describe('the pre-game room', () => {
  it('lists four seats and says who is not here yet', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    await push(started, 'alpha', 1);
    await push(started, 'alpha', 2);
    await push(started, 'bravo', 1);

    void inPregame(started, 'alpha-v-bravo').catch(() => {});
    const { payload } = await get(started, '/api/referee/match/alpha-v-bravo', cookie);

    expect(payload.state).toBe('pregame');
    expect(payload.seats.map((s: any) => s.id)).toEqual(['violet-1', 'violet-2', 'lime-1', 'lime-2']);
    // Nobody has arrived, so nothing is seated — the negative that makes the
    // checklist worth reading at all.
    expect(payload.seats.every((s: any) => s.seated === false)).toBe(true);
    // Which code would play is answered before anybody turns up, because that
    // is the question a team asks ninety seconds after pushing a fix.
    expect(payload.seats.find((s: any) => s.id === 'violet-1').pushed.hash).toMatch(/^[0-9a-f]{64}$/);
    // And a robot nobody has pushed says so rather than showing a hash.
    expect(payload.seats.find((s: any) => s.id === 'lime-2').pushed).toBeNull();
    expect(payload.seats.find((s: any) => s.id === 'lime-2').detail).toContain('have not pushed');
  });

  it('seats an arrived team and leaves the one that has not arrived', async () => {
    const started = await start();
    const referee = await signIn(started, 'referee', 'Sam Referee');
    const alpha = await signInTeam(started, 'Alpha');
    give(started, 'sam-referee', 'alpha-v-bravo');
    await push(started, 'alpha', 1);
    await push(started, 'alpha', 2);
    await push(started, 'bravo', 1);

    void inPregame(started, 'alpha-v-bravo').catch(() => {});
    const arrived = await post(started, '/api/team/match/alpha-v-bravo/arrive', alpha);
    expect(arrived.status).toBe(200);
    expect(arrived.payload.ready).toBe(true);

    const { payload } = await get(started, '/api/referee/match/alpha-v-bravo', referee);
    const seated = payload.seats.filter((s: any) => s.seated).map((s: any) => s.id);
    expect(seated).toEqual(['violet-1', 'violet-2']);
    expect(payload.seats.find((s: any) => s.id === 'lime-1').detail).toContain('have not arrived');
    // The ledger is the thing that actually changed: Alpha's robots are in this
    // fixture's seats, which is what stops them being in a practice field's.
    expect(started.server.occupancy.where('alpha', 1)?.seatId).toBe('violet-1');
    expect(started.server.occupancy.where('bravo', 1)).toBeNull();
  });

  it('is ready with one robot, which is the minimum for both teams', async () => {
    const started = await start();
    const alpha = await signInTeam(started, 'Alpha');
    // One robot pushed and one still being written — the ordinary case, not an
    // edge one, and a team in that state turns up and plays.
    await push(started, 'alpha', 2);

    void inPregame(started, 'alpha-v-bravo').catch(() => {});
    const arrived = await post(started, '/api/team/match/alpha-v-bravo/arrive', alpha);
    expect(arrived.payload.ready).toBe(true);
    expect(arrived.payload.seats.filter((s: any) => s.seated).map((s: any) => s.id)).toEqual(['violet-2']);
  });

  it('starts the match when the referee says so, empty seats and all', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');

    let started_ = false;
    void inPregame(started, 'alpha-v-bravo')
      .then(() => {
        started_ = true;
      })
      .catch(() => {});
    expect((await get(started, '/api/referee/match/alpha-v-bravo', cookie)).payload.state).toBe('pregame');

    // Nobody arrived. A referee decides when a match starts, and a team that
    // never turns up must be able to delay a fixture without stopping one.
    const res = await post(started, '/api/referee/match/alpha-v-bravo/start', cookie);
    expect(res.status).toBe(200);
    await new Promise((t) => setTimeout(t, 5));
    expect(started_).toBe(true);
  });

  it('will not let a referee start somebody else’s match', async () => {
    const started = await start();
    const sam = await signIn(started, 'referee', 'Sam Referee');
    const alex = await signIn(started, 'referee', 'Alex Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    give(started, 'alex-referee', 'charlie-v-delta');

    let begun = false;
    void inPregame(started, 'alpha-v-bravo')
      .then(() => {
        begun = true;
      })
      .catch(() => {});

    expect((await post(started, '/api/referee/match/alpha-v-bravo/start', alex)).status).toBe(403);
    await new Promise((t) => setTimeout(t, 5));
    expect(begun).toBe(false);
    // Still Sam's to start — a refusal must not consume the fixture.
    expect((await get(started, '/api/referee/match/alpha-v-bravo', sam)).payload.state).toBe('pregame');
    expect((await post(started, '/api/referee/match/alpha-v-bravo/start', sam)).status).toBe(200);
  });

  it('lets an admin start a fixture nobody was assigned', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    let begun = false;
    void inPregame(started, 'alpha-v-bravo')
      .then(() => {
        begun = true;
      })
      .catch(() => {});
    expect((await post(started, '/api/referee/match/alpha-v-bravo/start', cookie)).status).toBe(200);
    await new Promise((t) => setTimeout(t, 5));
    expect(begun).toBe(true);
  });

  it('answers a match that is not in pre-game with a 404', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    expect((await post(started, '/api/referee/match/alpha-v-bravo/start', cookie)).status).toBe(404);
  });

  it('will not let a referee lock somebody else’s lineup', async () => {
    const started = await start();
    const alex = await signIn(started, 'referee', 'Alex Referee');
    give(started, 'alex-referee', 'charlie-v-delta');
    void inPregame(started, 'alpha-v-bravo').catch(() => {});

    // The same targeted check as Start, because it is the same job: deciding
    // what is about to be played rather than controlling the football.
    expect((await post(started, '/api/referee/match/alpha-v-bravo/lock', alex)).status).toBe(403);
  });

  it('has nothing to lock for a match that is neither in pre-game nor at half-time', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    const refused = await post(started, '/api/referee/match/alpha-v-bravo/lock', cookie);
    expect(refused.status).toBe(404);
    // Both rooms named, because a referee holding a team's fix has to know
    // which of the two they are waiting for.
    expect(refused.payload.reason).toContain('half-time');
  });

  it('has nobody to be ready for a match that is not at half-time', async () => {
    const started = await start();
    const team = await signInTeam(started, 'Alpha');
    const refused = await post(started, '/api/team/match/alpha-v-bravo/ready', team);
    expect(refused.status).toBe(404);
    expect(refused.payload.reason).toContain('not at half-time');
  });

  it('leaves the lineup unlocked when the arena does not answer', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Marc Admin');
    void inPregame(started, 'alpha-v-bravo').catch(() => {});

    // There is no arena behind this room — the gate is driven directly here.
    // A lock the football would not keep must not be one the referee is shown,
    // so it fails outright rather than half-locking.
    const refused = await post(started, '/api/referee/match/alpha-v-bravo/lock', cookie);
    expect(refused.status).toBe(502);
    expect((await get(started, '/api/referee/match/alpha-v-bravo', cookie)).payload.pregame.lockedAt).toBeNull();
  });

  it('records who started it, against the fixture', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Sam Referee');
    give(started, 'sam-referee', 'alpha-v-bravo');
    void inPregame(started, 'alpha-v-bravo').catch(() => {});
    await post(started, '/api/referee/match/alpha-v-bravo/start', cookie);

    const rows = started.server.accounts.audit({ limit: 10 });
    // `fixture.setup` rather than `match.control`: the capability table has
    // carried it since Phase 6 and this is the thing it was named for.
    expect(rows[0]).toMatchObject({
      capability: 'fixture.setup',
      target: `${started.drawId}:alpha-v-bravo`,
      detail: 'started the match',
    });
  });

  it('lets go rather than hanging when the server stops', async () => {
    const started = await start();
    const waiting = inPregame(started, 'alpha-v-bravo');
    await started.server.close();
    servers.length = 0;
    await expect(waiting).rejects.toThrow(/stopped before the match was started/);
  });

  it('keeps a team out of another team’s seat', async () => {
    const started = await start();
    const charlie = await signInTeam(started, 'Charlie');
    void inPregame(started, 'alpha-v-bravo').catch(() => {});
    // Not their fixture. `match.join` is `own`, so this is the ordinary
    // scope check rather than a rule invented for pre-game.
    const res = await post(started, '/api/team/match/alpha-v-bravo/arrive', charlie);
    expect(res.status).toBe(403);
  });
});

/**
 * A correction appended by somebody else, while this server is running.
 *
 * `amend` is a terminal on the same machine, not this process, so the only way
 * a league server hears about a void is by looking — which is what `sweepDue`
 * does, on the clock that already sweeps pre-game rooms. What these defend is
 * the reach: a fixture **nobody has opened** follows the corrected draw, and a
 * room somebody is standing in does not.
 */
describe('a draw corrected while the server runs', () => {
  /** Append a record the way `amend` does, from outside the server. */
  async function correct(started: Started, record: Parameters<typeof appendAmendment>[2]): Promise<void> {
    await appendAmendment(started.tournamentsDir, started.drawId, record);
  }

  it('shows a kick-off on every page that shows a fixture', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    give(started, 'organiser', 'alpha-v-bravo');

    // Before: nothing anywhere carries a time, and the key is absent rather
    // than null, so a venue with no programme reads exactly as it did.
    const bare = await get(started, '/api/schedule', cookie);
    expect(bare.payload.fixtures.every((f: { playAt?: string }) => f.playAt === undefined)).toBe(true);

    const nine = '2026-09-20T09:00:00.000Z';
    await correct(started, {
      kind: 'schedule',
      times: { 'alpha-v-bravo': nine },
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'the programme is out',
    });

    const schedule = await get(started, '/api/schedule', cookie);
    // A timed fixture sorts to the front of the effective draw, so it is also
    // the one the schedule lists first.
    expect(schedule.payload.fixtures[0].id).toBe('alpha-v-bravo');
    expect(schedule.payload.fixtures[0].playAt).toBe(nine);

    const front = await get(started, '/api/front', cookie);
    expect(front.payload.upcoming[0].playAt).toBe(nine);

    const team = await get(started, '/api/team/alpha', cookie);
    expect(team.payload.fixtures.find((f: { id: string }) => f.id === 'alpha-v-bravo').playAt).toBe(nine);

    const mine = await get(started, '/api/referee/fixtures', cookie);
    expect(mine.payload.fixtures.find((f: { id: string }) => f.id === 'alpha-v-bravo').playAt).toBe(nine);

    const one = await get(started, '/api/match/alpha-v-bravo', cookie);
    expect(one.payload.fixture.playAt).toBe(nine);
  });

  it('recalls a fixture voided while it waited for a referee', async () => {
    const started = await start();
    const waiting = whenDue(started, 'alpha-v-bravo');

    await correct(started, {
      kind: 'void',
      fixtureId: 'alpha-v-bravo',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'pitch flooded',
    });
    await started.server.sweepDue();

    // The runner hears "this offer is withdrawn" rather than a failure, so the
    // fixture is neither played nor reported as broken.
    expect(await waiting).toBe('dropped');
  });

  it('recalls one the draw has decided without football', async () => {
    const started = await start();
    const waiting = whenDue(started, 'alpha-v-bravo');

    // A withdrawal leaves the fixture in the draw and puts a walkover against
    // it. Without this the room stayed open and a referee could spawn a pitch
    // for a match that already had a score — found by running it, not by a test.
    await correct(started, {
      kind: 'withdraw',
      team: 'Alpha',
      goals: 5,
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'their bus did not arrive',
    });
    await started.server.sweepDue();

    expect(await waiting).toBe('dropped');
  });

  it('leaves a room its referee is standing in, and says it has been voided', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    const room = inPregame(started, 'alpha-v-bravo');

    await correct(started, {
      kind: 'void',
      fixtureId: 'alpha-v-bravo',
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'voided while its referee had it',
    });
    await started.server.sweepDue();

    // Untouched: no admin button pulls a pitch out from under a whistle.
    const page = await get(started, '/api/referee/match/alpha-v-bravo', cookie);
    expect(page.payload.ok).toBe(true);
    expect(page.payload.state).toBe('pregame');
    // But said out loud, and still on the list — otherwise the one page that
    // can end this match denies the match exists.
    expect(page.payload.voided).toBe(true);
    const list = await get(started, '/api/referee/fixtures', cookie);
    const card = list.payload.fixtures.find((f: { id: string }) => f.id === 'alpha-v-bravo');
    expect(card.voided).toBe(true);

    await started.server.close();
    await room.catch(() => {});
  });
});
