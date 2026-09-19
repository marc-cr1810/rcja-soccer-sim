/**
 * Fixing a team's mis-uploaded file, from a browser.
 *
 * The store is covered in `pushes.test.ts`. What is tested here is the part
 * that cannot be: that the screen's rollback is **the ordinary push path** and
 * not a second way into `submissions/`. Everything below follows from that
 * rather than from code written to make it so — the validator runs, a fresh
 * join token is minted, and the record says an account did it rather than a
 * terminal user.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../src/league';
import { sandboxAvailable } from '../src/sandbox';
import { listEntrants } from '../src/tournament-store';
import { TOKEN_FILENAME } from '../src/manifest';

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
  submissionsDir: string;
  pushesDir: string;
}

async function start(keep = 10): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-teams-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  const pushesDir = await mkdtemp(join(tmpdir(), 'rcja-pushes-'));
  dirs.push(dataDir, submissionsDir, workspacesDir, pushesDir);

  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir: join(dataDir, 'tournaments'),
    pushesDir,
    settings: { pushes: { keep } },
    world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
  });
  servers.push(server);
  return { server, port: await server.listen(), submissionsDir, pushesDir };
}

async function call(
  port: number,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<{ status: number; payload: any; cookie: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  Object.assign(headers, init.headers ?? {});
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, redirect: 'manual' });
  const raw = res.headers.get('set-cookie');
  return { status: res.status, payload: await res.json().catch(() => null), cookie: raw ? raw.split(';')[0]! : null };
}

async function signIn(started: Started, slug: string): Promise<string> {
  const res = await call(started.port, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: slug, password: PASSWORD }),
  });
  if (!res.cookie) throw new Error(`could not sign in as ${slug}: ${JSON.stringify(res.payload)}`);
  return res.cookie;
}

async function account(started: Started, role: 'admin' | 'referee' | 'team', displayName: string): Promise<string> {
  const made = started.server.accounts.createAccount({ role, displayName, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  return made.value.slug;
}

/** A team with a push key, the whole way in. */
async function aTeam(started: Started, name = 'ACT Robotics'): Promise<{ slug: string; key: string }> {
  const slug = await account(started, 'team', name);
  const cookie = await signIn(started, slug);
  const minted = await call(started.port, '/api/keys', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ label: 'test' }),
  });
  if (minted.status !== 200) throw new Error(JSON.stringify(minted.payload));
  return { slug, key: minted.payload.key as string };
}

/** One robot's folder, as `python/submit.py` sends it. `mark` makes it distinguishable. */
function folder(team: string, mark: string): Record<string, string> {
  const manifest = JSON.stringify({ team, robot: 1, entry: 'robot.py' });
  const robot = [
    'import argparse',
    '',
    'from rcja_soccer import Robot',
    '',
    'parser = argparse.ArgumentParser()',
    'parser.add_argument("--team", default="violet")',
    'parser.add_argument("--number", type=int, default=1)',
    'parser.add_argument("--name", default=None)',
    'parser.add_argument("--url", default="ws://localhost:8080/agent")',
    'parser.add_argument("--token", default=None)',
    'args = parser.parse_args()',
    '',
    `MARK = "${mark}"`,
    '',
    'robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)',
    '',
    '',
    '@robot.tick',
    'def think(s, me):',
    '    return robot.coast()',
    '',
    '',
    'robot.run(url=args.url)',
  ].join('\n');
  return {
    'manifest.json': Buffer.from(manifest).toString('base64'),
    'robot.py': Buffer.from(robot).toString('base64'),
  };
}

async function pushAs(started: Started, key: string, mark: string, team = 'ACT Robotics'): Promise<any> {
  const res = await call(started.port, '/submit', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({ files: folder(team, mark) }),
  });
  if (res.status !== 200) throw new Error(`push failed: ${JSON.stringify(res.payload)}`);
  return res.payload;
}

describe.skipIf(!sandboxAvailable())('what an organiser can see of a team', () => {
  it('shows what is live, and how many earlier pushes are kept', async () => {
    const started = await start();
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));

    await pushAs(started, key, 'first');
    await pushAs(started, key, 'second');

    const seen = await call(started.port, '/api/admin/teams', { cookie: organiser });
    expect(seen.status, JSON.stringify(seen.payload)).toBe(200);
    const team = seen.payload.teams.find((one: any) => one.slug === slug);
    const robot = team.robots.find((one: any) => one.robot === 1);

    expect(robot.live.entry).toBe('robot.py');
    // The question the screen exists to answer: will this actually load, or
    // will the built-in agent play wearing the team's name?
    expect(robot.live.loads).toBe(true);
    expect(robot.live.why).toBeNull();
    expect(robot.kept).toBe(2);
    // Robot 2 has never been pushed. Not an error — most teams are like this.
    expect(team.robots.find((one: any) => one.robot === 2).live).toBeNull();
  }, 60_000);

  it('lists the pushes newest first, with the files of one of them', async () => {
    const started = await start();
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));

    await pushAs(started, key, 'first');
    await pushAs(started, key, 'second');

    const listed = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });
    expect(listed.payload.pushes).toHaveLength(2);
    // A team's own push is a key, not an account: `by.id` is null, and that is
    // the whole difference a rollback below makes visible.
    expect(listed.payload.pushes[0].by.id).toBeNull();
    expect(listed.payload.pushes[0].via).toBe('push');

    const oldest = listed.payload.pushes[1].stamp;
    const opened = await call(started.port, `/api/admin/teams/${slug}/1/${oldest}`, { cookie: organiser });
    const robotPy = opened.payload.files.find((one: any) => one.name === 'robot.py');
    expect(robotPy.text).toContain('MARK = "first"');
    // The credential is never archived, so it can never be read back out.
    expect(opened.payload.files.map((one: any) => one.name)).not.toContain(TOKEN_FILENAME);
  }, 60_000);

  it('is not a screen a referee can open', async () => {
    const started = await start();
    const referee = await signIn(started, await account(started, 'referee', 'Whistle'));

    expect((await call(started.port, '/api/admin/teams', { cookie: referee })).status).toBe(403);
  }, 30_000);
});

describe.skipIf(!sandboxAvailable())('putting an earlier push back', () => {
  it('restores the code, mints a new token, and records who did it', async () => {
    const started = await start();
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));

    await pushAs(started, key, 'good');
    const broken = await pushAs(started, key, 'the-wrong-file');
    const live = join(started.submissionsDir, slug, '1');
    expect(await readFile(join(live, 'robot.py'), 'utf8')).toContain('the-wrong-file');

    const listed = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });
    const good = listed.payload.pushes.find((one: any) => one.via === 'push' && one.stamp === listed.payload.pushes[1].stamp);

    const done = await call(started.port, `/api/admin/teams/${slug}/1/rollback`, {
      method: 'POST',
      cookie: organiser,
      body: JSON.stringify({ stamp: good.stamp, reason: 'uploaded robot 2 by mistake' }),
    });
    expect(done.status, JSON.stringify(done.payload)).toBe(200);

    expect(await readFile(join(live, 'robot.py'), 'utf8')).toContain('MARK = "good"');
    // A fresh one every successful push — it authenticates this validated
    // copy, not a standing account, and a rollback is an ordinary push.
    expect((await readFile(join(live, TOKEN_FILENAME), 'utf8')).trim()).not.toBe(broken.token);

    // The half an organiser does not expect, said back every time.
    expect(done.payload.workspace).toContain('workspace is unchanged');

    const rows = started.server.accounts.audit();
    const row = rows.find((one) => one.capability === 'team.submit');
    expect(row?.target).toBe(`${slug}/1`);
    expect(row?.detail).toContain('uploaded robot 2 by mistake');
  }, 90_000);

  it('archives the rollback itself, as an account rather than a key', async () => {
    const started = await start();
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));

    await pushAs(started, key, 'good');
    await pushAs(started, key, 'bad');
    const before = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });

    await call(started.port, `/api/admin/teams/${slug}/1/rollback`, {
      method: 'POST',
      cookie: organiser,
      body: JSON.stringify({ stamp: before.payload.pushes[1].stamp, reason: 'wrong file' }),
    });

    const after = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });
    expect(after.payload.pushes).toHaveLength(3);
    // So undoing a rollback is just another rollback.
    expect(after.payload.pushes[0].via).toBe('rollback');
    expect(after.payload.pushes[0].by.id).not.toBeNull();
    expect(after.payload.pushes[0].by.slug).toBe('organiser');
  }, 90_000);

  it('refuses without a reason, and refuses a push that is not there', async () => {
    const started = await start();
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));
    await pushAs(started, key, 'good');
    const listed = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });

    // Like every `amend` verb, and for the same stated reason: without one
    // this is an edit rather than a correction.
    const blank = await call(started.port, `/api/admin/teams/${slug}/1/rollback`, {
      method: 'POST',
      cookie: organiser,
      body: JSON.stringify({ stamp: listed.payload.pushes[0].stamp, reason: '   ' }),
    });
    expect(blank.status).toBe(400);

    const nowhere = await call(started.port, `/api/admin/teams/${slug}/1/rollback`, {
      method: 'POST',
      cookie: organiser,
      body: JSON.stringify({ stamp: '20200101T000000000Z', reason: 'nope' }),
    });
    expect(nowhere.status).toBe(404);
  }, 60_000);

  it('is not something a referee can do', async () => {
    const started = await start();
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));
    const referee = await signIn(started, await account(started, 'referee', 'Whistle'));
    await pushAs(started, key, 'good');
    const listed = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });

    const tried = await call(started.port, `/api/admin/teams/${slug}/1/rollback`, {
      method: 'POST',
      cookie: referee,
      body: JSON.stringify({ stamp: listed.payload.pushes[0].stamp, reason: 'not mine to do' }),
    });
    expect(tried.status).toBe(403);
  }, 60_000);
});

describe.skipIf(!sandboxAvailable())('where the history lands by default', () => {
  it('goes in the data directory, not the working directory', async () => {
    // Found by reviewing a diff, not by a failing test: defaulting this to
    // `resolve('pushes')` meant every LeagueServer built without one archived
    // into whatever directory the process happened to be started in — which,
    // for the test suite, is the repository.
    const dataDir = await mkdtemp(join(tmpdir(), 'rcja-teams-'));
    const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
    const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
    dirs.push(dataDir, submissionsDir, workspacesDir);

    const server = new LeagueServer({
      port: 0,
      dataDir,
      tournamentsDir: join(dataDir, 'tournaments'),
      world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
    });
    servers.push(server);
    const started: Started = { server, port: await server.listen(), submissionsDir, pushesDir: join(dataDir, 'pushes') };

    const { key, slug } = await aTeam(started);
    await pushAs(started, key, 'one');

    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));
    const listed = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });
    expect(listed.payload.pushes).toHaveLength(1);
    expect(await readdir(join(dataDir, 'pushes'))).toEqual(['act-robotics']);
  }, 60_000);
});

describe.skipIf(!sandboxAvailable())('the history and the submissions tree', () => {
  it('keeps to its cap without disturbing what plays', async () => {
    const started = await start(2);
    const { key, slug } = await aTeam(started);
    const organiser = await signIn(started, await account(started, 'admin', 'Organiser'));

    await pushAs(started, key, 'one');
    await pushAs(started, key, 'two');
    await pushAs(started, key, 'three');

    const listed = await call(started.port, `/api/admin/teams/${slug}/1`, { cookie: organiser });
    expect(listed.payload.pushes).toHaveLength(2);

    // The mistake the layout is chosen to avoid: history inside the
    // submissions tree is something `listEntrants` reads as a team.
    expect(await listEntrants(started.submissionsDir)).toEqual(['ACT Robotics']);
  }, 90_000);
});
