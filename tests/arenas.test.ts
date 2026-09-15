/**
 * Practice fields on a venue server.
 *
 * These start real child processes and proxy real requests to them, because
 * every part of this that can go wrong is a part a fake would paper over: a
 * child that never listens, a proxied path that arrives rewritten, a field
 * that outlives the server that started it. They are correspondingly slow —
 * a couple of seconds each — and that is the honest price.
 */

import { MatchServer, type ServerOptions } from '../src/server';

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
