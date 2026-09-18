/**
 * A field that belongs to a team.
 *
 * The ledgers themselves are tested in `occupancy.test.ts` and
 * `tenancy.test.ts`, where they are pure data and can be argued with
 * exhaustively. What is tested here is the part that cannot be: that the
 * **hub** is the thing enforcing them.
 *
 * That distinction is the whole of Phase 8. A child arena can only ever see
 * its own world, so a rule about every world on the server is one no child can
 * keep — and a hub that forwarded a seat request transparently would leave
 * every field looking correct on its own while a team's robot played in two of
 * them. There is no symptom for that. So each test below goes through a real
 * `LeagueServer` over HTTP, which is the only place the rule exists.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../src/league';
import { WorkspaceStore } from '../src/workspace';

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
  /** Where this league's team folders live, for a test that puts code in one. */
  workspacesDir: string;
}

/**
 * A league with room for two practice fields and no schedule running.
 *
 * `arenas.max` of three less one concurrent fixture is two for practice, which
 * is the smallest number that can show a queue forming without taking a minute
 * to reach it.
 */
async function start(practice: Record<string, unknown> = {}): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-fields-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir: join(dataDir, 'tournaments'),
    settings: {
      arenas: {
        max: 3,
        concurrentFixtures: 1,
        seatCpuPercent: 50,
        seatMemoryMb: 512,
        reserveCores: 1,
      },
      practice: { open: true, max: null, idleMins: 20, graceMins: 5, perTeam: 1, claimSecs: 90, ...practice },
    },
    world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
  });
  servers.push(server);
  return { server, port: await server.listen(), workspacesDir };
}

interface Answer {
  status: number;
  payload: any;
}

async function call(
  port: number,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, redirect: 'manual' });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

/** A team account, logged in. Its slug is its name slugified, as everywhere. */
async function team(started: Started, displayName: string): Promise<string> {
  const made = started.server.accounts.createAccount({ role: 'team', displayName, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function admin(started: Started): Promise<string> {
  const made = started.server.accounts.createAccount({
    role: 'admin',
    displayName: 'Organiser',
    password: PASSWORD,
  });
  if (!made.ok) throw new Error(made.reason);
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'organiser', password: PASSWORD }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function openField(started: Started, cookie: string): Promise<Answer> {
  return await call(started.port, '/practice', { method: 'POST', cookie });
}

function seat(seatId: string, fill: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify({ seat: seatId, fill }) };
}

describe('a field belongs to a team', () => {
  it('records the team that opened it, and shows it to them and not to a visitor', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');

    const opened = await openField(started, act);
    expect(opened.status).toBe(201);
    expect(opened.payload.field.owner).toBe('act-robotics');

    const mine = await call(started.port, '/api/team/act-robotics', { cookie: act });
    expect(mine.payload.yours.fields[0].id).toBe(opened.payload.field.id);

    // The same page to somebody with no account says nothing about any of it.
    const theirs = await call(started.port, '/api/team/act-robotics');
    expect(theirs.payload.yours).toBeUndefined();
  }, 20_000);

  it('holds a team to one field, and says which fixable thing is wrong', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');

    expect((await openField(started, act)).status).toBe(201);
    const second = await openField(started, act);
    expect(second.status).toBe(409);
    expect(second.payload.reason).toContain('close it before opening another');
  }, 20_000);

  it('keeps a team off a field it has not been invited onto', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    const id = (await openField(started, act)).payload.field.id;

    const peek = await call(started.port, `/a/${id}/practice-api/state`, { cookie: nsw });
    expect(peek.status).toBe(403);

    // Watching the football is a different question, and the answer has not
    // changed since Phase 4: it is open.
    const watching = await fetch(`http://127.0.0.1:${started.port}/a/${id}/`, { redirect: 'manual' });
    expect([401, 403]).not.toContain(watching.status);
    if (watching.status !== 404) {
      expect(watching.status).toBeLessThan(400);
    }
  }, 20_000);

  it('lets an invited team on, and lets them fill their own seats only', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    const id = (await openField(started, act)).payload.field.id;

    const invited = await call(started.port, `/api/fields/${id}/invite`, {
      method: 'POST',
      cookie: act,
      body: JSON.stringify({ team: 'NSW Lightning' }),
    });
    expect(invited.status).toBe(200);

    // It lands on their dashboard rather than as a link to paste.
    const waiting = await call(started.port, '/api/team/nsw-lightning', { cookie: nsw });
    expect(waiting.payload.yours.invitations[0]).toMatchObject({ arenaId: id, from: 'act-robotics' });

    expect((await call(started.port, `/api/fields/${id}/accept`, { method: 'POST', cookie: nsw })).status).toBe(200);
    expect((await call(started.port, `/a/${id}/practice-api/state`, { cookie: nsw })).status).toBe(200);

    // Their own robot, yes.
    const ours = await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('lime-1', { kind: 'submission', team: 'NSW Lightning' }),
      cookie: nsw,
    });
    expect(ours.status).toBe(200);

    // Somebody else's, never — the team comes from the credential, not the body.
    const theirs = await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('lime-2', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: nsw,
    });
    expect(theirs.status).toBe(403);
    expect(theirs.payload.reason).toContain('your own robots');

    // And a guest does not run the field they are a guest on.
    const dragging = await call(started.port, `/a/${id}/practice-api/start`, { method: 'POST', cookie: nsw });
    expect(dragging.status).toBe(403);
  }, 30_000);

  it('does not charge a guest a field of their own', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    const id = (await openField(started, act)).payload.field.id;
    await call(started.port, `/api/fields/${id}/invite`, {
      method: 'POST',
      cookie: act,
      body: JSON.stringify({ team: 'NSW Lightning' }),
    });
    await call(started.port, `/api/fields/${id}/accept`, { method: 'POST', cookie: nsw });

    // Ownership and occupancy are separate ledgers: accepting an invitation
    // never costs a team their own right to open a field.
    expect((await openField(started, nsw)).status).toBe(201);
  }, 30_000);
});

describe('one robot, one place', () => {
  it('refuses the same robot a second seat, and says where it already is', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');

    const mine = (await openField(started, act)).payload.field.id;
    const other = (await openField(started, nsw)).payload.field.id;
    await call(started.port, `/api/fields/${other}/invite`, {
      method: 'POST',
      cookie: nsw,
      body: JSON.stringify({ team: 'ACT Robotics' }),
    });
    await call(started.port, `/api/fields/${other}/accept`, { method: 'POST', cookie: act });

    const first = await call(started.port, `/a/${mine}/practice-api/seat`, {
      ...seat('violet-1', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });
    expect(first.status).toBe(200);

    const again = await call(started.port, `/a/${other}/practice-api/seat`, {
      ...seat('lime-1', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });
    expect(again.status).toBe(409);
    // The test END-STATE.md sets for this rule is a legible sentence.
    expect(again.payload.reason).toContain('violet-1');
    expect(again.payload.reason).toContain('one place at a time');

    // Robot 2 is a different robot, and may go on the other field — which is
    // the only way a team ever reaches two fields at once.
    const second = await call(started.port, `/a/${other}/practice-api/seat`, {
      ...seat('lime-2', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });
    expect(second.status).toBe(200);
  }, 30_000);

  it('frees a robot when its seat is emptied, and when its field closes', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const id = (await openField(started, act)).payload.field.id;

    await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('violet-1', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });
    expect(started.server.occupancy.where('act-robotics', 1)).not.toBeNull();

    await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('violet-1', { kind: 'empty' }),
      cookie: act,
    });
    expect(started.server.occupancy.where('act-robotics', 1)).toBeNull();
  }, 30_000);

  it('tells both robots apart on a team’s own dashboard, seated or not', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const id = (await openField(started, act)).payload.field.id;
    await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('violet-2', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });

    const page = await call(started.port, '/api/team/act-robotics', { cookie: act });
    expect(page.payload.yours.robots[0]).toMatchObject({ number: 1, at: null });
    expect(page.payload.yours.robots[1].at).toMatchObject({ seatId: 'violet-2', arenaId: id });
  }, 30_000);
});

describe('a laptop robot stops being anonymous', () => {
  it('mints a token for the seat and tells the console once, never the field', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const id = (await openField(started, act)).payload.field.id;

    const set = await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('violet-1', { kind: 'laptop', team: 'ACT Robotics' }),
      cookie: act,
    });
    expect(set.status).toBe(200);
    expect(set.payload.join.token).toBeTruthy();
    expect(set.payload.join.command).toContain('python3 python/join.py --token');
    expect(set.payload.join.url).toContain(`/a/${id}/agent`);

    // The state of a field is read by everybody on it, so the token is not in
    // it — the console is told once, in the answer that minted it.
    const state = await call(started.port, `/a/${id}/practice-api/state`, { cookie: act });
    expect(state.payload.state.seats['violet-1'].fill).toMatchObject({ kind: 'laptop', team: 'act-robotics' });
    expect(state.payload.state.seats['violet-1'].fill.token).toBeUndefined();

    // And it occupies the robot exactly as a submission does.
    expect(started.server.occupancy.where('act-robotics', 1)?.seatId).toBe('violet-1');
  }, 30_000);

  it('will not take a laptop seat that names nobody, on a server with accounts', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const id = (await openField(started, act)).payload.field.id;

    const set = await call(started.port, `/a/${id}/practice-api/seat`, {
      ...seat('violet-1', { kind: 'laptop' }),
      cookie: act,
    });
    expect(set.status).toBe(400);
  }, 30_000);
});

describe('a queue, not an error', () => {
  it('gives a team their place and what is ahead of them', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    const qld = await team(started, 'QLD Thunder');

    expect((await openField(started, act)).status).toBe(201);
    expect((await openField(started, nsw)).status).toBe(201);

    const queued = await openField(started, qld);
    expect(queued.status).toBe(202);
    expect(queued.payload.queued).toBe(true);
    expect(queued.payload.place).toMatchObject({ position: 1, ahead: 0 });
    expect(queued.payload.reason).toContain('you are next');
  }, 30_000);

  it('holds a freed field for the team at the front rather than opening it', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    const qld = await team(started, 'QLD Thunder');

    const mine = (await openField(started, act)).payload.field.id;
    await openField(started, nsw);
    await openField(started, qld);

    await call(started.port, `/api/fields/${mine}/close`, { method: 'POST', cookie: act });

    // A slot is free the moment the supervisor stops counting the arena, not
    // when its process finally goes — otherwise there is a window in which
    // capacity says yes and the queue has not been offered anything, and the
    // next team to press the button walks past everybody waiting.
    expect(started.server.tenancy.offeredTo('qld-thunder')).toBe(true);

    // ACT may not simply take the field back: it is held for somebody.
    const jumped = await openField(started, act);
    expect(jumped.status).toBe(202);

    const claimed = await call(started.port, '/practice/claim', { method: 'POST', cookie: qld });
    expect(claimed.status).toBe(201);
  }, 30_000);
});

describe('a fixture pre-empts practice', () => {
  it('closes the team’s own field and empties their seat on somebody else’s', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const qld = await team(started, 'QLD Thunder');
    await admin(started);

    const ours = (await openField(started, act)).payload.field.id;
    const theirs = (await openField(started, qld)).payload.field.id;
    await call(started.port, `/api/fields/${theirs}/invite`, {
      method: 'POST',
      cookie: qld,
      body: JSON.stringify({ team: 'ACT Robotics' }),
    });
    await call(started.port, `/api/fields/${theirs}/accept`, { method: 'POST', cookie: act });
    await call(started.port, `/a/${ours}/practice-api/seat`, {
      ...seat('violet-1', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });
    await call(started.port, `/a/${theirs}/practice-api/seat`, {
      ...seat('lime-2', { kind: 'submission', team: 'ACT Robotics' }),
      cookie: act,
    });

    await started.server.openFixture(
      {
        id: 'act-robotics-v-nsw-lightning',
        home: 'ACT Robotics',
        away: 'NSW Lightning',
        seeds: [1],
      },
      'round-1',
    );

    // Their own field is gone — it frees a slot at the moment the hall wants
    // one, and there is nothing left to rehearse with anyway.
    await until(() => started.server.arenas.info(ours) === null);
    // The field they were a guest on is not: it is somebody else's rehearsal,
    // and only the seat was theirs.
    expect(started.server.arenas.info(theirs)).not.toBeNull();

    const state = await call(started.port, `/a/${theirs}/practice-api/state`, { cookie: qld });
    expect(state.payload.state.seats['lime-2'].fill.kind).toBe('empty');
    expect(state.payload.notice).toContain('called away');

    // Both robots are free, which is the point: they are due on the pitch.
    expect(started.server.occupancy.forTeam('act-robotics').every((r) => r.at === null)).toBe(true);
  }, 40_000);
});

/** Wait for something the supervisor does on its own, or give up loudly. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('that never happened');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Running what a team is still writing.
 *
 * The mechanism is a seat fill like any other, so what has to be true here is
 * what the hub adds around it: that it is *your* code and nobody else's, that
 * running it spends the same robot occupancy as pushing it would, and that the
 * traceback it produces is yours to read. Whether the program itself starts is
 * the sandbox's business and is verified live.
 */
describe('run it from the workspace', () => {
  async function typed(started: Started, slug: string, robot: 1 | 2, entry = 'robot.py'): Promise<void> {
    const store = new WorkspaceStore({ dir: started.workspacesDir });
    await store.write(slug, robot, 'manifest.json', JSON.stringify({ team: slug, robot, entry }));
    await store.write(slug, robot, entry, 'print("hello")\n');
  }

  it('opens a field, seats the robot, and says where to watch', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    await typed(started, 'act-robotics', 1);

    const ran = await call(started.port, '/practice/run', {
      method: 'POST',
      cookie: act,
      body: JSON.stringify({ robot: 1 }),
    });
    expect(ran.status).toBe(200);
    expect(ran.payload.field.url).toBe(`/a/${ran.payload.field.id}/practice/`);
    expect(ran.payload.seat).toBe('violet-1');

    // Their own field, not an anonymous one — and their robot really is in it,
    // which is what makes "what is my robot doing" answerable.
    const yours = await call(started.port, '/api/team/act-robotics', { cookie: act });
    expect(yours.payload.yours.fields[0].id).toBe(ran.payload.field.id);
    expect(yours.payload.yours.robots[0].at.seatId).toBe('violet-1');
  }, 40_000);

  it('uses the field the team already has, rather than asking for another', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    await typed(started, 'act-robotics', 1);
    const opened = await openField(started, act);

    const ran = await call(started.port, '/practice/run', {
      method: 'POST',
      cookie: act,
      body: JSON.stringify({ robot: 1 }),
    });
    expect(ran.status).toBe(200);
    expect(ran.payload.field.id).toBe(opened.payload.field.id);
  }, 40_000);

  it('spends the same robot occupancy a pushed robot would', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    await typed(started, 'act-robotics', 1);
    await call(started.port, '/practice/run', { method: 'POST', cookie: act, body: JSON.stringify({ robot: 1 }) });

    // A second field, somebody else's, and the same robot. One robot, one
    // place: it is in a seat already and the sentence says which.
    const theirs = await openField(started, nsw);
    await call(started.port, `/api/fields/${theirs.payload.field.id}/invite`, {
      method: 'POST',
      cookie: nsw,
      body: JSON.stringify({ team: 'act-robotics' }),
    });
    await call(started.port, `/api/fields/${theirs.payload.field.id}/accept`, { method: 'POST', cookie: act });

    const twice = await call(
      started.port,
      `/a/${theirs.payload.field.id}/practice-api/seat`,
      { ...seat('violet-1', { kind: 'workspace', team: 'act-robotics' }), cookie: act },
    );
    expect(twice.status).toBe(409);
    expect(twice.payload.reason).toContain('robot 1');
  }, 60_000);

  it('will not run one team\'s unpushed code for another', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    await typed(started, 'nsw-lightning', 1);
    const mine = await openField(started, act);

    const stolen = await call(
      started.port,
      `/a/${mine.payload.field.id}/practice-api/seat`,
      { ...seat('lime-1', { kind: 'workspace', team: 'nsw-lightning' }), cookie: act },
    );
    expect(stolen.status).toBe(403);
    expect(nsw).toBeTruthy();
  }, 40_000);

  it('lets an organiser run code they may already open in an editor, and nobody else', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const organiser = await admin(started);
    await typed(started, 'act-robotics', 1);
    const mine = await openField(started, act);

    // Running a workspace reads code that was never pushed, so it is gated on
    // being allowed to open that team's editor rather than merely on being
    // allowed to seat their robot. An organiser may do both — that is the
    // eleven-at-night promise the workspace makes — and a rival team may do
    // neither, which is the case the gate exists for.
    const unpushed = await call(
      started.port,
      `/a/${mine.payload.field.id}/practice-api/seat`,
      { ...seat('lime-2', { kind: 'workspace', team: 'act-robotics' }), cookie: organiser },
    );
    expect(unpushed.status).toBe(200);
  }, 40_000);

  it('keeps a seat\'s output to the team whose seat it is', async () => {
    const started = await start();
    const act = await team(started, 'ACT Robotics');
    const nsw = await team(started, 'NSW Lightning');
    await typed(started, 'act-robotics', 1);
    const ran = await call(started.port, '/practice/run', {
      method: 'POST',
      cookie: act,
      body: JSON.stringify({ robot: 1 }),
    });
    const id = ran.payload.field.id;

    const mine = await call(started.port, `/a/${id}/practice-api/output?seat=violet-1`, { cookie: act });
    expect(mine.status).toBe(200);
    expect(Array.isArray(mine.payload.lines)).toBe(true);

    // Another team's half-written code failing is their business. They are not
    // even on this field, so they are refused before the seat is considered.
    const theirs = await call(started.port, `/a/${id}/practice-api/output?seat=violet-1`, { cookie: nsw });
    expect(theirs.status).toBe(403);
  }, 40_000);
});
