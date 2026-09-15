/**
 * The front door.
 *
 * What is tested here is the boundary rather than the pages: that watching is
 * open to somebody with no account at all, that the areas a session may not
 * enter are refused *including their static files*, and that a team's push
 * credential is now an account's key which binds the push to that team.
 *
 * The last of those is the one worth having. `POST /submit` was never
 * authenticated before Phase 6 — the team came from the manifest, so anybody
 * who could reach a venue server could push over anybody's robot — and the
 * check that fixes it is invisible when it works.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../src/league';
import { sandboxAvailable } from '../src/sandbox';

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
  workspacesDir: string;
}

async function start(): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-league-'));
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
  return { server, port: await server.listen(), submissionsDir, workspacesDir };
}

interface Answer {
  status: number;
  payload: any;
  cookie: string | null;
}

async function call(
  port: number,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  Object.assign(headers, init.headers ?? {});
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
  const raw = res.headers.get('set-cookie');
  return {
    status: res.status,
    payload: await res.json().catch(() => null),
    cookie: raw ? raw.split(';')[0]! : null,
  };
}

/** An admin, an invitation, and a registered team — the whole way in, once. */
async function aTeam(started: Started, name = 'ACT Robotics'): Promise<{ cookie: string; key: string }> {
  const admin = started.server.accounts.createAccount({
    role: 'admin',
    displayName: 'Organiser',
    password: PASSWORD,
  });
  if (!admin.ok) throw new Error(admin.reason);
  const invite = started.server.accounts.createInvite({ role: 'team', team: name });
  if (!invite.ok) throw new Error(invite.reason);

  const registered = await call(started.port, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ code: invite.value.code, password: PASSWORD }),
  });
  expect(registered.status, JSON.stringify(registered.payload)).toBe(200);
  const cookie = registered.cookie!;
  expect(cookie).toContain('rcja_session=');

  const minted = await call(started.port, '/api/keys', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ label: 'test' }),
  });
  expect(minted.status).toBe(200);
  return { cookie, key: minted.payload.key as string };
}

/** One robot's folder, as `python/submit.py` sends it. */
function push(team: string): Record<string, string> {
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
    'robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)',
    '',
    '',
    '@robot.tick',
    'def think(s, me):',
    '    return robot.coast()',
    '',
    '',
    'robot.run(url=args.url)',
    '',
  ].join('\n');
  return {
    'manifest.json': Buffer.from(manifest).toString('base64'),
    'robot.py': Buffer.from(robot).toString('base64'),
  };
}

describe('watching, with no account at all', () => {
  it('answers the public pages', async () => {
    const { port } = await start();
    for (const path of ['/api/front', '/api/schedule', '/api/standings']) {
      const answer = await call(port, path);
      expect(answer.status, path).toBe(200);
      expect(answer.payload.ok, path).toBe(true);
    }
  });

  it('says there is nobody signed in, rather than refusing to say', async () => {
    const { port } = await start();
    const answer = await call(port, '/api/me');
    expect(answer.status).toBe(200);
    expect(answer.payload.account).toBeNull();
    expect(answer.payload.can).toEqual({ workspace: false, referee: false, admin: false });
  });
});

describe('the areas a visitor may not enter', () => {
  it('refuses the referee console, including its static files', async () => {
    const { port } = await start();
    // Not an API call: the bundle itself. On a match server this is fetchable
    // because it is a login screen; on a league server the login screen is the
    // site's, so a spectator never downloads match-control code at all.
    const bundle = await fetch(`http://127.0.0.1:${port}/referee/`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    // A browser is sent to the login screen with where it was going, because
    // a blank 403 twenty minutes before a match is not information.
    expect(bundle.status).toBe(302);
    expect(bundle.headers.get('location')).toContain('/login');

    // Anything that is not a browser asking for a page gets the status code,
    // because a redirect to HTML would arrive at a fetch as a parse error.
    const asFetch = await fetch(`http://127.0.0.1:${port}/referee/`, { redirect: 'manual' });
    expect(asFetch.status).toBe(401);

    // There is no console at the hub's root any more: the world moved into
    // child arenas, so match control lives on the arena playing the match.
    const gone = await call(port, '/referee-api/kickoff', { method: 'POST' });
    expect(gone.status).toBe(404);
  });

  it('refuses the admin area', async () => {
    const { port } = await start();
    expect((await call(port, '/api/admin/accounts')).status).toBe(401);
    expect((await call(port, '/api/admin/invites', { method: 'POST' })).status).toBe(401);
  });

  it('refuses a team the admin area even once they are signed in', async () => {
    const started = await start();
    const { cookie } = await aTeam(started);
    const answer = await call(started.port, '/api/admin/accounts', { cookie });
    expect(answer.status).toBe(403);
  });

  /**
   * The check that has to live in the hub.
   *
   * An arena's referee surface is held to a token the supervisor minted, and
   * the hub is what decides — from a session and a capability — whether to
   * present it. A child can only ever see its own world, so if this check were
   * left to the children every arena would look correct on its own while
   * anybody who knew an arena id could kick off a final.
   */
  it('refuses match control on an arena to a guest and to a team', async () => {
    const started = await aTeamAndAnArena();
    const { port, arenaId, cookie } = started;

    const guest = await call(port, `/a/${arenaId}/referee-api/kickoff`, { method: 'POST' });
    expect(guest.status).toBe(401);

    const team = await call(port, `/a/${arenaId}/referee-api/kickoff`, { method: 'POST', cookie });
    expect(team.status).toBe(403);

    // And the arena is genuinely there — otherwise the refusals above would be
    // passing for the wrong reason.
    const watching = await fetch(`http://127.0.0.1:${port}/a/${arenaId}/`, { redirect: 'manual' });
    expect(watching.status).not.toBe(404);
  }, 40_000);
});

/** A signed-in team, and a real arena running on the hub to aim at. */
async function aTeamAndAnArena(): Promise<{
  port: number;
  arenaId: string;
  cookie: string | null;
}> {
  const started = await start();
  const { cookie } = await aTeam(started);
  const arena = await started.server.arenas.create({ kind: 'fixture' });
  return { port: started.port, arenaId: arena.id, cookie };
}

describe('registering', () => {
  it('takes the team name from the invitation, never from the form', async () => {
    const started = await start();
    const invite = started.server.accounts.createInvite({ role: 'team', team: 'ACT Robotics' });
    if (!invite.ok) throw new Error(invite.reason);

    const registered = await call(started.port, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ code: invite.value.code, name: 'Somebody Else', password: PASSWORD }),
    });
    expect(registered.payload.account.displayName).toBe('ACT Robotics');
  });

  it('refuses a code that was never issued, and one that has been used', async () => {
    const started = await start();
    const first = await call(started.port, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ code: 'invented', password: PASSWORD }),
    });
    expect(first.status).toBe(400);

    const invite = started.server.accounts.createInvite({ role: 'team', team: 'NSW' });
    if (!invite.ok) throw new Error(invite.reason);
    const body = JSON.stringify({ code: invite.value.code, password: PASSWORD });
    expect((await call(started.port, '/auth/register', { method: 'POST', body })).status).toBe(200);
    expect((await call(started.port, '/auth/register', { method: 'POST', body })).status).toBe(400);
  });

  it('says one thing whether the name or the password was wrong', async () => {
    const started = await start();
    await aTeam(started);
    const wrongPassword = await call(started.port, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name: 'ACT Robotics', password: 'not-the-password' }),
    });
    const noSuchTeam = await call(started.port, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nobody', password: PASSWORD }),
    });
    expect(wrongPassword.status).toBe(401);
    expect(noSuchTeam.payload.reason).toBe(wrongPassword.payload.reason);
  });

  it('signs out, and the cookie stops working', async () => {
    const started = await start();
    const { cookie } = await aTeam(started);
    expect((await call(started.port, '/api/keys', { cookie })).status).toBe(200);

    await call(started.port, '/auth/logout', { method: 'POST', cookie });
    const after = await call(started.port, '/api/me', { cookie });
    expect(after.payload.account).toBeNull();
  });
});

describe('a push key', () => {
  it('is shown once and then only listed', async () => {
    const started = await start();
    const { cookie, key } = await aTeam(started);
    const listed = await call(started.port, '/api/keys', { cookie });

    expect(listed.payload.keys).toHaveLength(1);
    expect(JSON.stringify(listed.payload.keys)).not.toContain(key);
  });

  it('opens what a session opens', async () => {
    const started = await start();
    const { key } = await aTeam(started);
    const asKey = await call(started.port, '/api/me', { headers: { authorization: `Bearer ${key}` } });
    expect(asKey.payload.account.displayName).toBe('ACT Robotics');
  });
});

describe('pushing to a league server', () => {
  it('refuses a push with no key at all', async () => {
    const { port } = await start();
    const answer = await call(port, '/submit', {
      method: 'POST',
      body: JSON.stringify({ files: push('ACT Robotics') }),
    });
    expect(answer.status).toBe(401);
  });

  it('refuses a key nobody was issued', async () => {
    const { port } = await start();
    const answer = await call(port, '/submit', {
      method: 'POST',
      headers: { authorization: 'Bearer rcja_invented' },
      body: JSON.stringify({ files: push('ACT Robotics') }),
    });
    expect(answer.status).toBe(401);
  });
});

describe.skipIf(!sandboxAvailable())('a push that is validated', () => {
  it('lands in the submissions tree with a join token beside it', async () => {
    const started = await start();
    const { key } = await aTeam(started);

    const answer = await call(started.port, '/submit', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ files: push('ACT Robotics') }),
    });
    expect(answer.status, JSON.stringify(answer.payload)).toBe(200);

    const dir = join(started.submissionsDir, 'act-robotics', '1');
    expect(await readFile(join(dir, 'robot.py'), 'utf8')).toContain('@robot.tick');
    expect((await readFile(join(dir, 'token'), 'utf8')).length).toBeGreaterThan(20);
  }, 60_000);

  it("refuses a manifest naming somebody else's team", async () => {
    const started = await start();
    const { key } = await aTeam(started);

    const answer = await call(started.port, '/submit', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ files: push('NSW Lightning') }),
    });
    expect(answer.status).toBe(403);
    expect(answer.payload.reason).toContain('ACT Robotics');
  }, 60_000);
});

describe('a workspace', () => {
  it('opens on the session, with no separate secret to paste', async () => {
    const started = await start();
    const { cookie } = await aTeam(started);

    const opened = await call(started.port, '/workspace-api/open', { method: 'POST', cookie });
    expect(opened.status, JSON.stringify(opened.payload)).toBe(200);
    expect(opened.payload.team).toBe('ACT Robotics');
    expect(opened.payload.files.map((f: any) => f.name).sort()).toEqual(['manifest.json', 'robot.py']);
  });

  it('is still whoever the credential says, never whoever the body says', async () => {
    const started = await start();
    const act = await aTeam(started, 'ACT Robotics');
    await call(started.port, '/workspace-api/save', {
      method: 'POST',
      cookie: act.cookie,
      body: JSON.stringify({ name: 'robot.py', content: 'mine' }),
    });

    const invite = started.server.accounts.createInvite({ role: 'team', team: 'NSW Lightning' });
    if (!invite.ok) throw new Error(invite.reason);
    const nsw = await call(started.port, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ code: invite.value.code, password: PASSWORD }),
    });

    const asNsw = await call(started.port, '/workspace-api/open', {
      method: 'POST',
      cookie: nsw.cookie,
      body: JSON.stringify({ team: 'ACT Robotics' }),
    });
    expect(asNsw.payload.team).toBe('NSW Lightning');
    const robot = asNsw.payload.files.find((f: any) => f.name === 'robot.py');
    expect(robot.content).not.toBe('mine');
  });

  it('is refused to somebody with no account', async () => {
    const { port } = await start();
    expect((await call(port, '/workspace-api/open', { method: 'POST' })).status).toBe(401);
  });
});
