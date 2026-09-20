/**
 * Practice fields on a venue server.
 *
 * These start real child processes and proxy real requests to them, because
 * every part of this that can go wrong is a part a fake would paper over: a
 * child that never listens, a proxied path that arrives rewritten, a field
 * that outlives the server that started it. They are correspondingly slow —
 * a couple of seconds each — and that is the honest price.
 */

import { MatchServer, type ServerOptions } from '../../src/infra/server';
import { ArenaSupervisor, type ArenaSupervisorOptions } from '../../src/league/arenas';

const servers: MatchServer[] = [];

async function venue(options: ServerOptions = {}): Promise<{ server: MatchServer; port: number }> {
  const server = new MatchServer({ port: 0, practiceFields: { maxArenas: 2 }, ...options });
  servers.push(server);
  const port = await server.listen();
  return { server, port };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('practice fields on a venue server', () => {
  it('opens one, and answers with somewhere to open it', async () => {
    const { port } = await venue();

    const made = await fetch(`http://127.0.0.1:${port}/practice`, { method: 'POST' });
    expect(made.status).toBe(201);
    const { field } = (await made.json()) as { field: { id: string; url: string } };
    expect(field.url).toBe(`/a/${field.id}/practice/`);

    // Reached through the venue's own port, not the child's: a field a robot
    // could only join by knowing a second port would not be much use at a
    // venue with one hole in its firewall.
    const state = await fetch(`http://127.0.0.1:${port}/a/${field.id}/practice-api/state`);
    expect(state.status).toBe(200);
    const payload = (await state.json()) as { ok: boolean; state: { seats: Record<string, unknown> } };
    expect(payload.ok).toBe(true);
    expect(Object.keys(payload.state.seats)).toHaveLength(4);
  }, 40_000);

  it('still answers on the old /f/ path', async () => {
    const { port } = await venue();
    const made = await fetch(`http://127.0.0.1:${port}/practice`, { method: 'POST' });
    const { field } = (await made.json()) as { field: { id: string } };

    // `/a/` is what Phase 7 calls an arena, and `/f/` is what Phase 4 called a
    // field. The alias is permanent: it is in the docs and in students'
    // browser history, and a link that stops working is somebody standing in
    // a hall with a dead URL.
    const alias = await fetch(`http://127.0.0.1:${port}/f/${field.id}/practice-api/state`);
    expect(alias.status).toBe(200);
  }, 40_000);

  it('runs several at once, and refuses past its cap', async () => {
    const { port } = await venue();

    const first = await fetch(`http://127.0.0.1:${port}/practice`, { method: 'POST' });
    const second = await fetch(`http://127.0.0.1:${port}/practice`, { method: 'POST' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const listed = (await (await fetch(`http://127.0.0.1:${port}/practice`)).json()) as {
      fields: { id: string }[];
    };
    expect(listed.fields).toHaveLength(2);

    // Each field is up to four sandboxed robots and a physics loop, so the cap
    // is a machine's CPU rather than a number — and hitting it has to say so.
    const third = await fetch(`http://127.0.0.1:${port}/practice`, { method: 'POST' });
    expect(third.status).toBe(503);
    const refused = (await third.json()) as { reason: string };
    expect(refused.reason).toMatch(/already running/);
  }, 60_000);

  it('answers for a field that does not exist rather than hanging', async () => {
    const { port } = await venue();
    const res = await fetch(`http://127.0.0.1:${port}/f/nosuchfield/practice-api/state`);
    expect(res.status).toBe(404);
  });

  it('does not offer fields at all unless the server was asked for them', async () => {
    const { port } = await venue({ practiceFields: false });
    const res = await fetch(`http://127.0.0.1:${port}/practice`, { method: 'POST' });
    // Not a practice server and not hosting fields: there is no such door.
    expect(res.status).toBe(404);
  });
});

/**
 * Giving a field back.
 *
 * The rule that changed in Phase 10 is what counts as *using* a field: a person
 * watching it or acting on it does, and a robot connected to it does not. That
 * distinction is the whole feature — before it, one laptop program left running
 * held an arena all afternoon while the team at the front of the queue waited —
 * so it is the thing tested here, along with the promise that nothing is closed
 * without being warned first.
 *
 * Real child processes, like the rest of this file. The clock is made short
 * rather than faked: `sweep()` is called directly so no test waits for the
 * half-minute timer.
 */
describe('giving a practice field back', () => {
  const supervisors: ArenaSupervisor[] = [];

  function supervisor(opts: Partial<ArenaSupervisorOptions> = {}): {
    arenas: ArenaSupervisor;
    warnings: { id: string; closingAt: string | null }[];
  } {
    const warnings: { id: string; closingAt: string | null }[] = [];
    const arenas = new ArenaSupervisor({
      // 0.6s quiet, 0.6s grace: short enough to test, long enough that the
      // spawn itself does not race it.
      idleMinutes: 0.01,
      graceMinutes: 0.01,
      onArenaWarned: (arena) => warnings.push({ id: arena.id, closingAt: arena.closingAt }),
      ...opts,
    });
    supervisors.push(arenas);
    return { arenas, warnings };
  }

  const quiet = (): Promise<void> => new Promise((done) => setTimeout(done, 700));

  afterEach(() => {
    for (const arenas of supervisors.splice(0)) arenas.closeAll();
  });

  it('warns first, and only closes if nobody comes back', async () => {
    const { arenas, warnings } = supervisor();
    const field = await arenas.create({ kind: 'practice', owner: 'act-robotics' });

    await quiet();
    arenas.sweep();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.closingAt).not.toBeNull();
    // Warned is not closed: a fifteen-year-old who walked away for lunch comes
    // back to an explanation, not an absence.
    expect(arenas.info(field.id)).not.toBeNull();

    await quiet();
    arenas.sweep();
    expect(arenas.info(field.id)).toBeNull();
  }, 40_000);

  it('is reprieved by somebody turning up, and says so', async () => {
    const { arenas, warnings } = supervisor();
    const field = await arenas.create({ kind: 'practice', owner: 'act-robotics' });

    await quiet();
    arenas.sweep();
    expect(warnings).toHaveLength(1);

    arenas.touch(field.id);
    // The reprieve is announced, not merely recorded: a banner that stopped
    // being true without saying so is worse than no banner.
    expect(warnings).toHaveLength(2);
    expect(warnings[1]!.closingAt).toBeNull();

    arenas.sweep();
    expect(arenas.info(field.id)).not.toBeNull();
  }, 40_000);

  it('is not held open by a robot that is still connected', async () => {
    const { arenas } = supervisor();
    const field = await arenas.create({ kind: 'practice', owner: 'act-robotics' });
    // A program somebody left running when they went home. It holds the arena
    // against being swept mid-request and nothing else.
    const robot = arenas.trackConnection(field.id, { presence: false });
    expect(robot).not.toBeNull();

    await quiet();
    arenas.sweep();
    await quiet();
    arenas.sweep();
    expect(arenas.info(field.id)).toBeNull();
  }, 40_000);

  it('is held open by somebody watching it', async () => {
    const { arenas, warnings } = supervisor();
    const field = await arenas.create({ kind: 'practice', owner: 'act-robotics' });
    const viewer = arenas.trackConnection(field.id, { presence: true });

    await quiet();
    arenas.sweep();
    expect(warnings).toHaveLength(0);
    expect(arenas.info(field.id)).not.toBeNull();

    viewer?.();
  }, 40_000);

  it('comes round sooner, and takes the quietest field, when somebody is waiting', async () => {
    let waiting = 0;
    const { arenas, warnings } = supervisor({
      // Six seconds of quiet normally; three once a team is in the queue. The
      // three minute floor is turned off, because no test can wait for it —
      // what is being checked is that the queue halves the wait and that only
      // one field goes per sweep.
      idleMinutes: 0.1,
      busyIdleFloorMinutes: 0,
      queued: () => waiting,
    });
    const first = await arenas.create({ kind: 'practice', owner: 'act-robotics' });
    await new Promise((done) => setTimeout(done, 1_500));
    const second = await arenas.create({ kind: 'practice', owner: 'nsw-lightning' });

    await new Promise((done) => setTimeout(done, 1_500));
    // Both have been quiet for less than the generous period, so on a quiet
    // afternoon neither is anybody's business.
    arenas.sweep();
    expect(warnings).toHaveLength(0);

    waiting = 1;
    arenas.sweep();
    // The longest-idle one only. Freeing a field for the team at the front is
    // the point; clearing every field that happens to be between drags is not.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toBe(first.id);
    expect(arenas.info(second.id)).not.toBeNull();
  }, 40_000);

  it('creates and closes an arena in worker mode', async () => {
    const sup = new ArenaSupervisor({ mode: 'worker' });
    try {
      const arena = await sup.create({ kind: 'practice' });
      expect(arena.url).toBe(`/a/${arena.id}/practice/`);
      expect(sup.portOf(arena.id)).not.toBeNull();
      const closed = sup.close(arena.id);
      expect(closed).toBe(true);
      expect(sup.info(arena.id)).toBeNull();
    } finally {
      sup.closeAll();
    }
  }, 40_000);
});
