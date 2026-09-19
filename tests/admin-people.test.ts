/**
 * Who may do what, from a browser.
 *
 * Phase 12 G is the slice that built two capabilities from nothing. Both had
 * been in the capability table since Phase 6, and `can()` had never once been
 * called with either:
 *
 * - **`referee.assign`** — `assign` / `unassign` existed in `accounts.ts` with
 *   no caller outside `cli.ts`, so deciding who runs a match was a
 *   terminal-only act at a venue whose organiser is holding a laptop.
 * - **`capability.grant`** — `grant()` could write a row; nothing could remove
 *   one and no screen ever showed one, so a grant made at Phase 6 was
 *   permanent and invisible.
 *
 * What is tested here is mostly the *refusals*, because the happy paths are
 * one-line calls into methods that already had tests. The refusals are new
 * rules, and two of them are the kind that only look wrong in a hall: a grant
 * that reaches nothing, and an organiser turning off the last account that
 * could turn it back on.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { LeagueServer } from '../src/league';
import { can } from '../src/capabilities';
import { makeDraw } from '../src/tournament';
import { appendAmendment, saveDraw } from '../src/tournament-store';

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

async function start(opts: { tournament?: boolean } = {}): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-people-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const tournamentsDir = join(dataDir, 'tournaments');
  const draw = makeDraw(['Alpha', 'Bravo', 'Charlie'], { name: 'test round' });
  if (opts.tournament !== false) await saveDraw(tournamentsDir, draw);

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

function make(started: Started, role: 'team' | 'referee' | 'admin', name: string): string {
  const made = started.server.accounts.createAccount({ role, displayName: name, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  return made.value.id;
}

async function signIn(started: Started, slug: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: slug, password: PASSWORD }),
    redirect: 'manual',
  });
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error(`${slug} could not sign in`);
  return raw.split(';')[0]!;
}

/** Make an account and sign in as it, which is what every test here starts with. */
async function person(
  started: Started,
  role: 'team' | 'referee' | 'admin',
  name: string,
): Promise<{ id: string; slug: string; cookie: string }> {
  const id = make(started, role, name);
  const account = started.server.accounts.byId(id)!;
  return { id, slug: account.slug, cookie: await signIn(started, account.slug) };
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

/** What `can()` says about this account right now, read back through the database. */
function may(started: Started, accountId: string, capability: Parameters<typeof can>[1], target?: string): boolean {
  const account = started.server.accounts.byId(accountId)!;
  return can(started.server.accounts.actorFor(account), capability, target);
}

describe('a grant, from a browser', () => {
  it('gives somebody one extra thing, and revoking takes it back', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    expect(may(started, ref.id, 'tournament.amend')).toBe(false);

    const given = await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, {
      capability: 'tournament.amend',
      scope: 'any',
    });
    expect(given.status).toBe(200);
    expect(may(started, ref.id, 'tournament.amend')).toBe(true);

    // The door itself, not just the predicate: this is what the grant is for.
    const reached = await get(started, '/api/admin/tournament', ref.cookie);
    expect(reached.status).toBe(200);

    const taken = await post(started, `/api/admin/accounts/${ref.id}/grants/revoke`, organiser.cookie, {
      capability: 'tournament.amend',
      scope: 'any',
    });
    expect(taken.status).toBe(200);
    expect(may(started, ref.id, 'tournament.amend')).toBe(false);
    expect((await get(started, '/api/admin/tournament', ref.cookie)).status).toBe(403);
  });

  it('is one row however many times the button is pressed', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    const body = { capability: 'arena.kill', scope: 'any' };
    await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, body);
    await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, body);

    expect(started.server.accounts.grantsFor(ref.id)).toHaveLength(1);
    // And so one Revoke is the whole of it — the thing a duplicated row would
    // have made a lie.
    await post(started, `/api/admin/accounts/${ref.id}/grants/revoke`, organiser.cookie, body);
    expect(may(started, ref.id, 'arena.kill')).toBe(false);
  });

  it('refuses the one row that could never be true', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    const tried = await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, {
      capability: 'match.control',
      scope: 'assigned',
    });
    expect(tried.status).toBe(400);
    expect(tried.payload.reason).toContain('reaches nothing at all');
    // Plain text, not markdown: this sentence is shown in an error box, and
    // asterisks around a word read as asterisks there.
    expect(tried.payload.reason).not.toContain('*');
    expect(started.server.accounts.grantsFor(ref.id)).toHaveLength(0);
  });

  it('lets a target narrow a grant whatever the scope says', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    // `any` *with* a target is a targeted grant: `satisfies()` checks the
    // grant's own target first, so the narrower of the two wins. The screen
    // says so, and this is the assertion behind that sentence.
    await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, {
      capability: 'team.submit',
      scope: 'any',
      target: 'alpha',
    });
    expect(may(started, ref.id, 'team.submit', 'alpha')).toBe(true);
    expect(may(started, ref.id, 'team.submit', 'bravo')).toBe(false);
  });

  it('answers only at the address it means', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');
    const body = { capability: 'arena.kill', scope: 'any' };

    // `path.includes('/grants')` would have taken this as a grant.
    const near = await post(started, `/api/admin/accounts/${ref.id}/grantsfoo`, organiser.cookie, body);
    expect(near.status).toBe(404);
    const deep = await post(started, `/api/admin/accounts/${ref.id}/grants/revoke/oops`, organiser.cookie, body);
    expect(deep.status).toBe(404);
    expect(started.server.accounts.grantsFor(ref.id)).toHaveLength(0);
  });

  it('says no such row rather than pretending a revoke happened', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    const tried = await post(started, `/api/admin/accounts/${ref.id}/grants/revoke`, organiser.cookie, {
      capability: 'tournament.amend',
      scope: 'any',
    });
    expect(tried.status).toBe(404);
    expect(tried.payload.reason).toContain('does not have');
  });

  it('is not a referee’s to hand out', async () => {
    const started = await start();
    const ref = await person(started, 'referee', 'Ref');
    const other = await person(started, 'referee', 'Other');

    const tried = await post(started, `/api/admin/accounts/${other.id}/grants`, ref.cookie, {
      capability: 'account.manage',
      scope: 'any',
    });
    expect(tried.status).toBe(403);
    expect(started.server.accounts.grantsFor(other.id)).toHaveLength(0);
  });

  it('lands in the log, in the words the screen used', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, {
      capability: 'tournament.amend',
      scope: 'any',
    });
    const [row] = started.server.accounts.audit({ capability: 'capability.grant' });
    expect(row!.actorName).toBe('Ana Organiser');
    expect(row!.target).toBe('ref');
    expect(row!.detail).toBe('granted tournament.amend (any)');
  });
});

describe('a referee’s fixture, from a browser', () => {
  it('reaches a match they could not a moment earlier', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');
    const fixtureId = started.draw.fixtures[0]!.id;

    const before = await get(started, '/api/referee/fixtures', ref.cookie);
    expect(before.payload.fixtures).toHaveLength(0);

    const done = await post(started, '/api/admin/assignments', organiser.cookie, {
      fixtureId,
      accountId: ref.id,
    });
    expect(done.status).toBe(200);

    // No restart between the two reads: an assignment is a row, and
    // `actorFor` builds the grants from it on every request.
    const after = await get(started, '/api/referee/fixtures', ref.cookie);
    expect(after.payload.fixtures.map((f: { id: string }) => f.id)).toEqual([fixtureId]);
  });

  it('can be taken back even once the fixture is gone from the draw', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');
    const fixtureId = started.draw.fixtures[0]!.id;

    await post(started, '/api/admin/assignments', organiser.cookie, { fixtureId, accountId: ref.id });
    await appendAmendment(started.tournamentsDir, started.drawId, {
      kind: 'void',
      fixtureId,
      reason: 'the pitch flooded',
      at: new Date().toISOString(),
      by: { id: null, slug: 'terminal' },
    });

    // Voiding does not unassign anybody, so the row outlives the fixture. An
    // assignment nobody can remove is a row that outlives its reason, which is
    // why removal is deliberately not held to the draw.
    const gone = await post(started, '/api/admin/assignments', organiser.cookie, {
      fixtureId,
      accountId: ref.id,
      remove: true,
    });
    expect(gone.status).toBe(200);
    expect(started.server.accounts.assignmentsFor(ref.id)).toHaveLength(0);
  });

  it('leaves a person their own way out of a fixture the draw forgot', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');
    const fixtureId = started.draw.fixtures[0]!.id;
    await post(started, '/api/admin/assignments', organiser.cookie, { fixtureId, accountId: ref.id });
    await appendAmendment(started.tournamentsDir, started.drawId, {
      kind: 'void',
      fixtureId,
      reason: 'the pitch flooded',
      at: new Date().toISOString(),
      by: { id: null, slug: 'terminal' },
    });

    // The screen lists the draw's fixtures, and a voided one nobody is
    // standing at is not in the draw — so the row is gone from that list while
    // the assignment is still there. It has to stay reachable from the person,
    // or it is an assignment nobody can remove.
    const seen = await get(started, '/api/admin/people', organiser.cookie);
    const them = seen.payload.people.find((one: { id: string }) => one.id === ref.id);
    expect(them.assignments).toEqual([{ drawId: started.drawId, fixtureId }]);
    expect(seen.payload.draw.fixtures.map((f: { id: string }) => f.id)).not.toContain(fixtureId);
  });

  it('refuses a fixture the draw does not have', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    const tried = await post(started, '/api/admin/assignments', organiser.cookie, {
      fixtureId: 'delta-v-echo',
      accountId: ref.id,
    });
    expect(tried.status).toBe(404);
    expect(started.server.accounts.assignmentsFor(ref.id)).toHaveLength(0);
  });

  it('refuses a team, because a team does not referee', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const team = await person(started, 'team', 'Alpha');

    const tried = await post(started, '/api/admin/assignments', organiser.cookie, {
      fixtureId: started.draw.fixtures[0]!.id,
      accountId: team.id,
    });
    expect(tried.status).toBe(400);
    expect(tried.payload.reason).toContain('not a referee');
  });

  it('is not a referee’s to hand to themselves', async () => {
    const started = await start();
    const ref = await person(started, 'referee', 'Ref');

    const tried = await post(started, '/api/admin/assignments', ref.cookie, {
      fixtureId: started.draw.fixtures[0]!.id,
      accountId: ref.id,
    });
    expect(tried.status).toBe(403);
    expect(started.server.accounts.assignmentsFor(ref.id)).toHaveLength(0);
  });

  it('lands in the log in the same words the terminal writes', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');
    const fixtureId = started.draw.fixtures[0]!.id;

    await post(started, '/api/admin/assignments', organiser.cookie, { fixtureId, accountId: ref.id });
    const [row] = started.server.accounts.audit({ capability: 'referee.assign' });
    expect(row!.target).toBe(`${started.drawId}:${fixtureId}`);
    expect(row!.detail).toBe('assigned ref');
  });
});

describe('the last organiser', () => {
  it('cannot be turned off, because somebody has to be able to get back in', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');

    const tried = await post(started, `/api/admin/accounts/${organiser.id}/disabled`, organiser.cookie, {
      disabled: true,
    });
    expect(tried.status).toBe(409);
    expect(tried.payload.reason).toContain('only organiser');
    expect(started.server.accounts.byId(organiser.id)!.disabledAt).toBeNull();
  });

  it('is only the last one — two organisers means either may go', async () => {
    const started = await start();
    const ana = await person(started, 'admin', 'Ana Organiser');
    const ben = make(started, 'admin', 'Ben Organiser');

    const done = await post(started, `/api/admin/accounts/${ben}/disabled`, ana.cookie, { disabled: true });
    expect(done.status).toBe(200);
    expect(started.server.accounts.byId(ben)!.disabledAt).not.toBeNull();

    // And now Ana is the last one, so the rule closes behind her.
    const tried = await post(started, `/api/admin/accounts/${ana.id}/disabled`, ana.cookie, { disabled: true });
    expect(tried.status).toBe(409);
  });
});

describe('the people screen’s payload', () => {
  it('separates what a role carries from what was granted on top', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');

    await post(started, `/api/admin/accounts/${ref.id}/grants`, organiser.cookie, {
      capability: 'tournament.amend',
      scope: 'any',
    });

    const seen = await get(started, '/api/admin/people', organiser.cookie);
    const them = seen.payload.people.find((one: { id: string }) => one.id === ref.id);
    // The extra row is the only thing with a Revoke against it. Merging the
    // two would offer to take away something no row holds.
    expect(them.grants).toEqual([{ capability: 'tournament.amend', scope: 'any', target: null }]);
    expect(them.disabledAt).toBeNull();

    // With the reach of each, never the bare names. A referee *has*
    // `match.control` — over nothing, until a fixture is named — so a screen
    // holding only the names would call widening it to `any` a no-op, which is
    // the opposite of what it does.
    expect(them.roleCapabilities).toContainEqual({ capability: 'match.control', scope: 'assigned' });
    expect(them.roleCapabilities).toContainEqual({ capability: 'match.watch', scope: 'any' });
    expect(them.roleCapabilities.map((one: { capability: string }) => one.capability)).not.toContain(
      'tournament.amend',
    );
  });

  it('says who has each fixture, and carries the table’s own vocabularies', async () => {
    const started = await start();
    const organiser = await person(started, 'admin', 'Ana Organiser');
    const ref = await person(started, 'referee', 'Ref');
    const fixtureId = started.draw.fixtures[0]!.id;
    await post(started, '/api/admin/assignments', organiser.cookie, { fixtureId, accountId: ref.id });

    const seen = await get(started, '/api/admin/people', organiser.cookie);
    const fixture = seen.payload.draw.fixtures.find((one: { id: string }) => one.id === fixtureId);
    expect(fixture.referees).toEqual([{ accountId: ref.id, displayName: 'Ref' }]);
    // The grant form offers what `capabilities.ts` holds, not a second copy
    // of the table kept in a browser.
    expect(seen.payload.capabilities).toContain('capability.grant');
    expect(seen.payload.capabilities).toHaveLength(20);
    expect(seen.payload.scopes).toEqual(['own', 'assigned', 'any']);
  });

  it('is not a referee’s to read', async () => {
    const started = await start();
    const ref = await person(started, 'referee', 'Ref');
    expect((await get(started, '/api/admin/people', ref.cookie)).status).toBe(403);
  });
});
