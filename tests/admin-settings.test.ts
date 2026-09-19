/**
 * A venue's settings, changed from a browser.
 *
 * `saveSettings` has existed since the settings file did, with no callers
 * outside a test — it was written for this. What is tested here is the two
 * claims the screen makes, because neither is visible from a green typecheck:
 *
 * - **it takes effect now.** Nothing that holds a setting captured it —
 *   `ArenaSupervisor` reads its ceiling on every `create` and its quiet time
 *   on every `sweep`, `Tenancy` reads its per-team cap behind a getter — so a
 *   change is a write, not a restart. The test that matters is the one that
 *   changes a number and then watches the *running* venue obey it.
 * - **the file stays the truth.** A value out of range is clamped and
 *   complained about exactly as it would be in a text editor, and the file is
 *   written with what will actually be obeyed rather than with what was asked.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { LeagueServer } from '../src/league';

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
  dataDir: string;
}

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `rcja-${prefix}-`));
  dirs.push(dir);
  return dir;
}

async function start(
  opts: { sources?: Record<string, 'default' | 'file' | 'flag'>; perTeam?: number } = {},
): Promise<Started> {
  const dataDir = await scratch('settings');
  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir: join(dataDir, 'tournaments'),
    settings: {
      arenas: { max: 3, concurrentFixtures: 1, seatCpuPercent: 50, seatMemoryMb: 512, reserveCores: 1 },
      practice: { open: true, max: null, idleMins: 20, graceMins: 5, perTeam: opts.perTeam ?? 1, claimSecs: 90 },
    },
    settingSources: opts.sources,
    world: {
      realtime: false,
      submissionsDir: await scratch('sub'),
      workspacesDir: await scratch('ws'),
    },
  });
  servers.push(server);
  return { server, port: await server.listen(), dataDir };
}

async function call(
  port: number,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<{ status: number; payload: any; cookie: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, redirect: 'manual' });
  const raw = res.headers.get('set-cookie');
  return {
    status: res.status,
    payload: await res.json().catch(() => null),
    cookie: raw ? raw.split(';')[0]! : null,
  };
}

async function signedIn(started: Started, role: 'admin' | 'referee' | 'team', name: string): Promise<string> {
  const made = started.server.accounts.createAccount({ role, displayName: name, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  const res = await call(started.port, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
  });
  if (!res.cookie) throw new Error(`could not sign in as ${made.value.slug}`);
  return res.cookie;
}

async function fileOn(dataDir: string): Promise<any> {
  return JSON.parse(await readFile(join(dataDir, 'league.json'), 'utf8'));
}

describe('settings, from a browser', () => {
  it('shows what is set, where it came from, and what the machine allows', async () => {
    const started = await start({ sources: { 'arenas.max': 'file' } });
    const cookie = await signedIn(started, 'admin', 'Ana');

    const res = await call(started.port, '/api/admin/settings', { cookie });
    expect(res.status).toBe(200);
    expect(res.payload.settings.practice.idleMins).toBe(20);
    expect(res.payload.sources['arenas.max']).toBe('file');
    expect(typeof res.payload.budget.max).toBe('number');
  });

  it('writes the file and changes the running venue in the same breath', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');

    const res = await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ practice: { idleMins: 3 } }),
    });
    expect(res.status).toBe(200);
    expect(res.payload.settings.practice.idleMins).toBe(3);
    expect((await fileOn(started.dataDir)).practice.idleMins).toBe(3);

    // The assertion the whole slice exists for. Not "the file says 3" — the
    // supervisor that was built with 20 and never restarted now sweeps at 3.
    expect((started.server.arenas as any).opts.idleMinutes).toBe(3);
  });

  it('leaves the rest of a section alone', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');

    await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ practice: { idleMins: 3 } }),
    });

    // A top-level spread would have replaced `practice` wholesale and quietly
    // reset the other five numbers in it to their defaults.
    const after = await fileOn(started.dataDir);
    expect(after.practice.graceMins).toBe(5);
    expect(after.practice.claimSecs).toBe(90);
    expect(after.arenas.max).toBe(3);
  });

  it('clamps out of range exactly as the file does, and says so', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');

    const res = await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ practice: { idleMins: 99999 } }),
    });
    expect(res.status).toBe(200);
    expect(res.payload.complaints.join(' ')).toContain('practice.idleMins');

    // And the file holds what will be obeyed, not what was asked for — a file
    // that disagreed with the screen beside it is what settings.ts refuses.
    const clamped = res.payload.settings.practice.idleMins;
    expect(clamped).toBeLessThan(99999);
    expect((await fileOn(started.dataDir)).practice.idleMins).toBe(clamped);
  });

  it('refuses a key that is not a setting rather than writing it', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');

    const res = await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ practice: { idelMins: 3 } }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a change that says nothing', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');
    const res = await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('beats a flag on the key it names, and leaves other flags alone', async () => {
    // `perTeam` is 2 here and the default is 1, so "the flag was not written
    // down" is a claim that can fail — with both at 1 the assertion would pass
    // whatever the code did.
    const started = await start({
      perTeam: 2,
      sources: { 'practice.idleMins': 'flag', 'practice.perTeam': 'flag' },
    });
    const cookie = await signedIn(started, 'admin', 'Ana');

    const res = await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ practice: { idleMins: 7 } }),
    });
    expect(res.status).toBe(200);

    // An organiser who changes a number and watches nothing happen has been
    // told a lie by the screen: the edit wins, and the source is now true.
    expect(res.payload.settings.practice.idleMins).toBe(7);
    expect(res.payload.sources['practice.idleMins']).toBe('file');

    // The flag they did not touch still decides its own key for this run.
    expect(res.payload.sources['practice.perTeam']).toBe('flag');
    expect(res.payload.settings.practice.perTeam).toBe(2);

    // And it is not written down. A flag is for one run — `--per-team 1`
    // quietly becoming the venue's permanent setting because somebody changed
    // an unrelated number is the kind of thing nobody would find for a season.
    const written = await fileOn(started.dataDir);
    expect(written.practice.idleMins).toBe(7);
    expect(written.practice.perTeam).toBe(1);
  });

  it('records who changed what', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'admin', 'Ana');
    await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ pushes: { keep: 4 } }),
    });

    const rows = started.server.accounts.audit({ capability: 'account.manage' });
    const row = rows.find((one) => one.target === 'settings');
    expect(row?.actorName).toBe('Ana');
    expect(row?.detail).toContain('pushes.keep');
  });

  it('is not a referee\'s to change, or to read', async () => {
    const started = await start();
    const cookie = await signedIn(started, 'referee', 'Sam');

    expect((await call(started.port, '/api/admin/settings', { cookie })).status).toBe(403);
    const put = await call(started.port, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ practice: { idleMins: 3 } }),
    });
    expect(put.status).toBe(403);
  });
});
