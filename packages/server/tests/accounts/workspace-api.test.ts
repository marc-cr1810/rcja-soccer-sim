/**
 * The door a browser editor knocks on.
 *
 * The store itself is covered in `workspace.test.ts`; what is tested here is
 * the boundary — that a server with no teams configured has no workspace
 * surface at all, that the team always comes from the token rather than from
 * anything the caller says, and that submitting from a browser lands in
 * exactly the same place as pushing from a laptop.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MatchServer } from '../../src/infra/server';
import { sandboxAvailable } from '../../src/match/sandbox';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../../../../python');

const TOKENS = new Map([
  ['act-secret', 'ACT Robotics'],
  ['nsw-secret', 'NSW'],
]);

const servers: MatchServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function start(
  options: { tokens?: ReadonlyMap<string, string>; python?: boolean } = {},
): Promise<{ port: number; workspacesDir: string; submissionsDir: string }> {
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  dirs.push(workspacesDir, submissionsDir);

  const server = new MatchServer({
    port: 0,
    realtime: false,
    workspacesDir,
    submissionsDir,
    workspaceTokens: options.tokens ?? TOKENS,
    ...(options.python === false ? {} : { pythonLibDir: PYTHON_LIB_DIR }),
  });
  servers.push(server);
  return { port: await server.listen(), workspacesDir, submissionsDir };
}

async function call(
  port: number,
  action: string,
  token: string | null,
  body: Record<string, unknown> = {},
): Promise<{ status: number; payload: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/workspace-api/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

describe('a server that was not told to host workspaces', () => {
  it('has no workspace surface at all', async () => {
    const { port } = await start({ tokens: new Map() });
    for (const action of ['open', 'save', 'submit', 'delete']) {
      const { status } = await call(port, action, 'act-secret');
      expect(status, `${action} should not exist`).toBe(404);
    }
  });
});

describe('getting in', () => {
  it('refuses a token nobody was issued', async () => {
    const { port } = await start();
    const { status, payload } = await call(port, 'open', 'guessed-it');
    expect(status).toBe(401);
    expect(payload.reason).toContain('token');
  });

  it('refuses no token at all', async () => {
    const { port } = await start();
    expect((await call(port, 'open', null)).status).toBe(401);
  });

  it('opens onto a starter robot the first time', async () => {
    const { port } = await start();
    const { status, payload } = await call(port, 'open', 'act-secret');

    expect(status).toBe(200);
    expect(payload.team).toBe('ACT Robotics');
    expect(payload.robot).toBe(1);
    expect(payload.files.map((f: any) => f.name).sort()).toEqual([
      'board.py',
      'camera.py',
      'main.py',
      'manifest.json',
      'radio.py',
    ]);
  });

  it('opens robot 2 separately from robot 1', async () => {
    const { port } = await start();
    await call(port, 'save', 'act-secret', { robot: 1, name: 'main.py', content: 'first' });
    const second = await call(port, 'open', 'act-secret', { robot: 2 });

    expect(second.payload.robot).toBe(2);
    const entry = second.payload.files.find((f: any) => f.name === 'main.py');
    expect(entry.content).not.toBe('first');
  });
});

describe('whose workspace it is', () => {
  it('comes from the token, never from the body', async () => {
    const { port } = await start();
    await call(port, 'save', 'act-secret', { name: 'main.py', content: 'mine' });

    // NSW asks for ACT's folder by every name it can think of. It gets its own.
    const asNsw = await call(port, 'open', 'nsw-secret', { team: 'ACT Robotics' });
    expect(asNsw.payload.team).toBe('NSW');
    const robot = asNsw.payload.files.find((f: any) => f.name === 'main.py');
    expect(robot.content).not.toBe('mine');
  });
});

describe('editing', () => {
  it('saves and reads back', async () => {
    const { port } = await start();
    await call(port, 'open', 'act-secret');
    const saved = await call(port, 'save', 'act-secret', {
      name: 'helper.py',
      content: 'def go(): pass\n',
    });
    expect(saved.status).toBe(200);

    const reopened = await call(port, 'open', 'act-secret');
    const helper = reopened.payload.files.find((f: any) => f.name === 'helper.py');
    expect(helper.content).toBe('def go(): pass\n');
  });

  it('saves code that does not parse, because that is most of editing', async () => {
    const { port } = await start();
    const saved = await call(port, 'save', 'act-secret', {
      name: 'robot.py',
      content: 'def half_written(',
    });
    expect(saved.status).toBe(200);
  });

  it('refuses a filename that would reach outside the folder', async () => {
    const { port } = await start();
    const saved = await call(port, 'save', 'act-secret', {
      name: '../../escape.py',
      content: 'x',
    });
    expect(saved.status).toBe(400);
  });

  it('deletes', async () => {
    const { port } = await start();
    await call(port, 'open', 'act-secret');
    await call(port, 'save', 'act-secret', { name: 'helper.py', content: 'x' });
    const after = await call(port, 'delete', 'act-secret', { name: 'helper.py' });
    expect(after.payload.files.map((f: any) => f.name)).not.toContain('helper.py');
  });

  it('does not know any other action', async () => {
    const { port } = await start();
    expect((await call(port, 'reformat-the-disk', 'act-secret')).status).toBe(404);
  });
});

describe.skipIf(!sandboxAvailable())('submitting a workspace', () => {
  it('lands where a laptop push lands, and mints a join token', async () => {
    const { port, submissionsDir } = await start();
    await call(port, 'open', 'act-secret');

    const submitted = await call(port, 'submit', 'act-secret');
    expect(submitted.status, JSON.stringify(submitted.payload)).toBe(200);
    expect(submitted.payload.team).toBe('ACT Robotics');

    // The same tree `python/submit.py` writes into, with the same join token
    // beside it — the entry route must not change what a submission is.
    const dir = join(submissionsDir, 'act-robotics', '1');
    expect(await readFile(join(dir, 'main.py'), 'utf8')).toContain('Board()');
    const token = await readFile(join(dir, 'token'), 'utf8');
    expect(token.length).toBeGreaterThan(20);
  }, 60_000);

  it("reports the validator's reason rather than a stack trace", async () => {
    const { port } = await start();
    await call(port, 'open', 'act-secret');
    await call(port, 'save', 'act-secret', { name: 'main.py', content: 'def broken(:\n' });

    const submitted = await call(port, 'submit', 'act-secret');
    expect(submitted.status).toBe(400);
    expect(typeof submitted.payload.reason).toBe('string');
    expect(submitted.payload.reason).not.toContain('Traceback');
  }, 60_000);

  it("refuses a manifest that claims somebody else's team", async () => {
    const { port } = await start();
    await call(port, 'open', 'act-secret');
    await call(port, 'save', 'act-secret', {
      name: 'manifest.json',
      content: JSON.stringify({ team: 'NSW', robot: 1, entry: 'main.py' }),
    });

    const submitted = await call(port, 'submit', 'act-secret');
    expect(submitted.status).toBe(400);
    expect(submitted.payload.reason).toContain('ACT Robotics');
  }, 60_000);

  it('refuses an empty workspace', async () => {
    const { port } = await start();
    // Never opened, so never seeded.
    const submitted = await call(port, 'submit', 'act-secret');
    expect(submitted.status).toBe(400);
    expect(submitted.payload.reason).toContain('nothing');
  });
});
