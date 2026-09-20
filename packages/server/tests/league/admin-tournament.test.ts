/**
 * Correcting a draw from a browser, and putting a fixture back into a schedule.
 *
 * Two claims are load-bearing. The first is that the browser and the terminal
 * write the *same records through the same writer*, so an organiser with a
 * laptop and one with a shell cannot make a draw say two things — the only
 * difference is that the browser knows whose hands these were.
 *
 * The second is the one that was a real defect rather than a gap: a fixture a
 * referee abandoned was out of the schedule for the life of the process, and a
 * result voided after the last fixture had nothing left to replay it. Nothing
 * here runs football; what is tested is whether the schedule can be asked for
 * a fixture back and told there is work to do.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../../src/league/league';
import { makeDraw } from '../../src/league/tournament';
import { appendAmendment, loadAmendments, saveDraw, saveResult } from '../../src/league/tournament-store';
import type { FixtureResult } from '../../src/league/tournament';
import type { MatchResult } from '../../src/match/match';

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
  tournamentsDir: string;
  draw: ReturnType<typeof makeDraw>;
}

async function start(): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-admin-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const tournamentsDir = join(dataDir, 'tournaments');
  const draw = makeDraw(['Alpha', 'Bravo', 'Charlie'], { name: 'test round' });
  await saveDraw(tournamentsDir, draw);

  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir,
    tournamentId: draw.id,
    world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
  });
  servers.push(server);
  return { server, port: await server.listen(), drawId: draw.id, tournamentsDir, draw };
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

async function post(
  started: Started,
  path: string,
  cookie: string,
  body: unknown,
): Promise<{ status: number; payload: any }> {
  const res = await fetch(`http://127.0.0.1:${started.port}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

async function get(started: Started, path: string, cookie: string): Promise<{ status: number; payload: any }> {
  const res = await fetch(`http://127.0.0.1:${started.port}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, payload: await res.json().catch(() => null) };
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

function played(started: Started, fixtureId: string): FixtureResult {
  const fixture = started.draw.fixtures.find((f) => f.id === fixtureId)!;
  return {
    fixtureId,
    home: fixture.home,
    away: fixture.away,
    submissions: {},
    legs: [{ seed: 1, result: scored(3, 1) }],
    completedAt: new Date().toISOString(),
  };
}

describe('the draw, from a browser', () => {
  it('is not a referee’s to correct', async () => {
    const started = await start();
    const cookie = await signIn(started, 'referee', 'Ref');

    const seen = await get(started, '/api/admin/tournament', cookie);
    expect(seen.status).toBe(403);

    const tried = await post(started, '/api/admin/tournament/amend', cookie, {
      kind: 'void',
      fixtureId: 'alpha-v-bravo',
      reason: 'because I can',
    });
    expect(tried.status).toBe(403);
    expect(await loadAmendments(started.tournamentsDir, started.drawId)).toHaveLength(0);
  });

  it('refuses a correction with no reason, and writes nothing', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');

    const tried = await post(started, '/api/admin/tournament/amend', cookie, {
      kind: 'void',
      fixtureId: 'alpha-v-bravo',
      reason: '   ',
    });
    expect(tried.status).toBe(400);
    expect(await loadAmendments(started.tournamentsDir, started.drawId)).toHaveLength(0);
  });

  it('writes the same record the terminal writes, but says whose hands', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');

    const done = await post(started, '/api/admin/tournament/amend', cookie, {
      kind: 'void',
      fixtureId: 'alpha-v-bravo',
      reason: 'the pitch flooded',
    });
    expect(done.payload.ok).toBe(true);
    expect(done.payload.fixtures.after).toBe(done.payload.fixtures.before - 1);

    const [record] = await loadAmendments(started.tournamentsDir, started.drawId);
    expect(record!.kind).toBe('void');
    expect(record!.reason).toBe('the pitch flooded');
    // The whole of "the audit log saying who did each one": the CLI writes a
    // null id because a terminal is not an account, and this does not.
    expect(record!.by.id).toBe(started.server.accounts.bySlug('organiser')!.id);
    expect(started.server.accounts.audit().some((row) => row.capability === 'tournament.amend')).toBe(true);
  });

  it('refuses a fixture the draw does not have', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    const tried = await post(started, '/api/admin/tournament/amend', cookie, {
      kind: 'void',
      fixtureId: 'alpha-v-nobody',
      reason: 'typo',
    });
    expect(tried.status).toBe(400);
    expect(tried.payload.reason).toContain('no such fixture');
  });

  it('withdraws a team, and the walkovers show up in the same payload', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');

    const done = await post(started, '/api/admin/tournament/amend', cookie, {
      kind: 'withdraw',
      team: 'alpha',
      reason: 'their bus did not arrive',
    });
    expect(done.payload.ok).toBe(true);
    // Four of the six fixtures involve Alpha, and every one of them is now
    // decided without football.
    expect(done.payload.results.after).toBe(4);

    const seen = await get(started, '/api/admin/tournament', cookie);
    expect(seen.payload.fixtures.filter((f: { state: string }) => f.state === 'played')).toHaveLength(4);
  });

  it('shows what the schedule gave up on, and who may not touch what', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    started.server.markStalled('alpha-v-bravo', 'the match was abandoned (flat battery)');

    const seen = await get(started, '/api/admin/tournament', cookie);
    const card = seen.payload.fixtures.find((f: { id: string }) => f.id === 'alpha-v-bravo');
    expect(card.stalled).toContain('abandoned');
    expect(card.theirs).toBe(false);
    expect(seen.payload.scheduleRunning).toBe(false);
  });
});

describe('putting a fixture back into a schedule', () => {
  it('asks for one the schedule gave up on, without touching the draw', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    started.server.markStalled('alpha-v-bravo', 'the match was abandoned');
    expect(started.server.stalledIds().has('alpha-v-bravo')).toBe(true);

    const waiting = started.server.awaitWork();
    const done = await post(started, '/api/admin/tournament/replay', cookie, {
      fixtureId: 'alpha-v-bravo',
      reason: 'the battery has been changed',
    });
    expect(done.payload).toEqual({ ok: true, wasPlayed: false });

    // Woken at once: this is the same process, so there is nothing to poll for.
    expect(await waiting).toBe(true);
    expect(started.server.stalledIds().has('alpha-v-bravo')).toBe(false);
    // An unplayed fixture needs no amendment. Nothing was written.
    expect(await loadAmendments(started.tournamentsDir, started.drawId)).toHaveLength(0);
  });

  it('disowns the result first when the fixture was actually played', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    await saveResult(started.tournamentsDir, started.draw, played(started, 'alpha-v-bravo'));

    const done = await post(started, '/api/admin/tournament/replay', cookie, {
      fixtureId: 'alpha-v-bravo',
      reason: 'the referee scored it wrong',
    });
    expect(done.payload).toEqual({ ok: true, wasPlayed: true });

    const [record] = await loadAmendments(started.tournamentsDir, started.drawId);
    expect(record!.kind).toBe('void-result');
    // Named by result, not merely by fixture, so the replay's own result is not
    // dropped by the record that disowned the old one.
    expect((record as { completedAt: string }).completedAt).toBeTruthy();

    const seen = await get(started, '/api/admin/tournament', cookie);
    const card = seen.payload.fixtures.find((f: { id: string }) => f.id === 'alpha-v-bravo');
    expect(card.state).toBe('upcoming');
  });

  it('wakes a drained schedule when work is appended from another process', async () => {
    const started = await start();
    // Everything played: this is a draw with nothing left to offer, which is
    // exactly the state in which nothing used to be able to put a match back.
    for (const fixture of started.draw.fixtures) {
      await saveResult(started.tournamentsDir, started.draw, played(started, fixture.id));
    }
    let woke = false;
    const waiting = started.server.awaitWork().then((answer) => (woke = answer));
    expect(woke).toBe(false);

    // `amend` is a different process. Nothing notifies this server; it looks.
    await appendAmendment(started.tournamentsDir, started.drawId, {
      kind: 'void-result',
      fixtureId: 'alpha-v-bravo',
      completedAt: await resultTime(started, 'alpha-v-bravo'),
      at: new Date().toISOString(),
      by: { id: null, slug: 'organiser' },
      reason: 'it was scored wrong',
    });

    expect(await waiting).toBe(true);
  }, 20_000);

  it('does not wake for a fixture it has already given up on', async () => {
    const started = await start();
    for (const fixture of started.draw.fixtures) {
      if (fixture.id === 'alpha-v-bravo') continue;
      await saveResult(started.tournamentsDir, started.draw, played(started, fixture.id));
    }
    started.server.markStalled('alpha-v-bravo', 'the match was abandoned');

    let woke: boolean | null = null;
    void started.server.awaitWork().then((answer) => (woke = answer));
    // Long enough for two polls. An abandoned match is abandoned for a reason,
    // and a loop that retried it on a timer would spend the afternoon
    // reopening the same broken pitch.
    await new Promise((settle) => setTimeout(settle, 11_000));
    expect(woke).toBeNull();
  }, 20_000);

  it('leaves a match its referee is standing at alone', async () => {
    const started = await start();
    const cookie = await signIn(started, 'admin', 'Organiser');
    const fixture = started.draw.fixtures[0]!;
    // A pre-game room, which is a pitch with people standing on it. It is left
    // open: closing the server at the end of the test is what settles it, and
    // that arrives as a rejection nobody is waiting for.
    started.server.awaitLineup(fixture, started.drawId, 'arena-1').catch(() => {});

    const tried = await post(started, '/api/admin/tournament/replay', cookie, {
      fixtureId: fixture.id,
      reason: 'I would like it played again',
    });
    expect(tried.status).toBe(409);
    expect(tried.payload.reason).toContain('referee');
  });
});

/** The `completedAt` of whatever is on disk for a fixture. */
async function resultTime(started: Started, fixtureId: string): Promise<string> {
  const { loadDraw, loadResults } = await import('../../src/league/tournament-store');
  const raw = await loadDraw(started.tournamentsDir, started.drawId);
  const results = await loadResults(started.tournamentsDir, raw);
  return results.find((r) => r.fixtureId === fixtureId)!.completedAt;
}
