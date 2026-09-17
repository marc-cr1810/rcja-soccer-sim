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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../src/league';
import { makeDraw } from '../src/tournament';
import { saveDraw } from '../src/tournament-store';

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
  return { server, port: await server.listen(), drawId: draw.id };
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
function whenDue(started: Started, fixtureId: string): Promise<void> {
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
