/**
 * Who did what, at a venue.
 *
 * Until Phase 12's H, three gated acts recorded nothing at all — opening a
 * practice field, running one, and writing in a team's workspace — so the log
 * could say who amended a draw and not who stopped somebody's field. What is
 * tested here is that the holes are filled, and the two things that follow
 * from filling them:
 *
 * - the venue records **everything**, the browser editor's autosave included,
 *   so the reader narrows rather than the writer dropping rows;
 * - the one act with no actor at all — the idle sweep closing a field — is
 *   recorded as having no actor, rather than being attributed to whoever
 *   happened to be looking.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { Accounts } from '../../src/accounts/accounts';
import { LeagueServer } from '../../src/league/league';

const servers: LeagueServer[] = [];
const dirs: string[] = [];
const open: Accounts[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const one of open.splice(0)) one.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PASSWORD = 'a-long-enough-password';

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `rcja-${prefix}-`));
  dirs.push(dir);
  return dir;
}

// --------------------------------------------------------------- the reader

describe('reading the log', () => {
  async function ledger(): Promise<Accounts> {
    const one = new Accounts({ file: join(await scratch('audit'), 'league.db') });
    open.push(one);
    return one;
  }

  it('narrows by capability, by person, and by when', async () => {
    const accounts = await ledger();
    const made = accounts.createAccount({ role: 'admin', displayName: 'Ana', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    const ana = made.value.id;

    accounts.record(ana, 'field.control', 'a-1', 'stopped it');
    accounts.record(null, 'field.control', 'a-2', 'closed by the idle sweep');
    accounts.record(ana, 'team.workspace.write', 'act/1', 'save robot.py');

    expect(accounts.audit({ capability: 'field.control' })).toHaveLength(2);
    expect(accounts.audit({ actorId: ana })).toHaveLength(2);
    expect(accounts.audit({ since: '2999-01-01T00:00:00.000Z' })).toHaveLength(0);
    expect(accounts.audit({ limit: 1 })).toHaveLength(1);
  });

  it('leaves out what it was told to, and still counts it', async () => {
    const accounts = await ledger();
    for (let n = 0; n < 40; n += 1) accounts.record(null, 'team.workspace.write', 'act/1', `save ${n}`);
    accounts.record(null, 'arena.kill', 'a-1', 'stopped an arena');

    // The whole design of the screen in one assertion: nothing is dropped from
    // the log, the first page leaves the noise out, and the count is what lets
    // the toggle say how much it is leaving out.
    const shown = accounts.audit({ without: ['team.workspace.write'] });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.capability).toBe('arena.kill');

    const counts = accounts.auditCounts();
    expect(counts.find((one) => one.capability === 'team.workspace.write')?.rows).toBe(40);
  });

  it('still answers with no query at all', async () => {
    const accounts = await ledger();
    accounts.record(null, 'arena.kill', 'a-1', 'stopped an arena');
    expect(accounts.audit()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the sweep

describe('the acts that used to record nothing', () => {
  interface Started {
    server: LeagueServer;
    port: number;
  }

  async function start(): Promise<Started> {
    const dataDir = await scratch('audit-league');
    const server = new LeagueServer({
      port: 0,
      dataDir,
      tournamentsDir: join(dataDir, 'tournaments'),
      world: {
        realtime: false,
        submissionsDir: await scratch('sub'),
        workspacesDir: await scratch('ws'),
      },
    });
    servers.push(server);
    return { server, port: await server.listen() };
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
    return {
      status: res.status,
      payload: await res.json().catch(() => null),
      cookie: raw ? raw.split(';')[0]! : null,
    };
  }

  async function signedIn(started: Started, role: 'admin' | 'team', name: string): Promise<string> {
    const made = started.server.accounts.createAccount({ role, displayName: name, password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    const res = await call(started.port, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
    });
    if (!res.cookie) throw new Error(`could not sign in as ${made.value.slug}`);
    return res.cookie;
  }

  it('records a workspace save, with the file in the row', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'team', 'ACT Robotics');

    const saved = await call(started.port, '/workspace-api/save', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ robot: 1, name: 'robot.py', content: 'print("one")' }),
    });
    expect(saved.status).toBe(200);

    const rows = started.server.accounts.audit({ capability: 'team.workspace.write' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe('act-robotics/1');
    expect(rows[0]!.detail).toContain('robot.py');
    expect(rows[0]!.actorName).toBe('ACT Robotics');
  });

  it('names an organiser writing in an editor, and the folder it went to', async () => {
    const started = await start();
    started.server.accounts.createAccount({ role: 'team', displayName: 'ACT Robotics', password: PASSWORD });
    const cookie = await signedIn(started, 'admin', 'Ana');

    await call(started.port, '/workspace-api/save', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ robot: 1, name: 'robot.py', content: 'print("edited")' }),
    });

    const rows = started.server.accounts.audit({ capability: 'team.workspace.write' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorName).toBe('Ana');
    // Worth stating where somebody will read it: an organiser holds
    // `team.workspace.write` at `any`, and **this door ignores that entirely**
    // — `authority.team` answers with the requester's own display name
    // (league.ts, `async team(req)`), so an organiser at `/workspace-api/` is
    // in a workspace of their own and never in a team's. The scope is real at
    // the seat door and nowhere else. If that is ever changed, this assertion
    // is the one that should fail first.
    expect(rows[0]!.target).toBe('ana/1');
  });

  it('records a deletion too, and not a mere read', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'team', 'ACT Robotics');

    // `open` seeds the folder and changes nothing the team chose — a read, and
    // a log that called it a write would be lying about the one thing it is for.
    await call(started.port, '/workspace-api/open', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ robot: 1 }),
    });
    expect(started.server.accounts.audit({ capability: 'team.workspace.write' })).toHaveLength(0);

    await call(started.port, '/workspace-api/save', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ robot: 1, name: 'scratch.py', content: '# notes' }),
    });
    await call(started.port, '/workspace-api/delete', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ robot: 1, name: 'scratch.py' }),
    });

    const kinds = started.server.accounts
      .audit({ capability: 'team.workspace.write' })
      .map((row) => row.detail?.split(' ')[0]);
    expect(kinds).toEqual(['delete', 'save']);
  });

  it('serves the log narrowed, with counts and people beside it', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');
    for (let n = 0; n < 5; n += 1) {
      started.server.accounts.record(null, 'team.workspace.write', 'act-robotics/1', `save ${n}`);
    }
    started.server.accounts.record(null, 'arena.kill', 'a-1', 'stopped an arena');

    const res = await call(started.port, '/api/admin/audit?without=team.workspace.write', { cookie });
    expect(res.status).toBe(200);
    expect(res.payload.audit.every((row: any) => row.capability !== 'team.workspace.write')).toBe(true);
    expect(res.payload.counts.find((one: any) => one.capability === 'team.workspace.write').rows).toBe(5);
    expect(res.payload.people.some((one: any) => one.displayName === 'Ana')).toBe(true);
  });

  it('is not readable by a team', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'team', 'ACT Robotics');
    const res = await call(started.port, '/api/admin/audit', { cookie });
    expect(res.status).toBe(403);
  });
});
