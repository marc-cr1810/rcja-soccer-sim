/**
 * The demo arena — football for a hall screen.
 *
 * Two things worth testing, and both are real processes because the parts
 * that go wrong are the parts a fake would paper over: that a standalone
 * `DemoArena` kicks off its own matches and keeps playing them one after
 * another ("the screen never sits still"), and that a supervised arena — a
 * real child running the `arena --kind demo` command — answers the hub's
 * state poll as an always-playing, never-finished world.
 *
 * Both use reference-vs-reference, which plays in-process with nothing to
 * spawn, and halves measured in seconds so a match turns over while a test
 * watches.
 */

import { MatchServer } from '../src/server';
import { DemoArena } from '../src/arena';
import { ArenaSupervisor } from '../src/arenas';

const servers: MatchServer[] = [];
const supervisors: ArenaSupervisor[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const arenas of supervisors.splice(0)) arenas.closeAll();
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('the demo arena, from the inside', () => {
  it('plays reference versus reference, match after match, never finishing', async () => {
    const logs: string[] = [];
    // `control` wires the DemoArena's state endpoint into the server — same as
    // the CLI does — so the fetch to `/arena-api/state` reaches the handler.
    let demoRef: InstanceType<typeof DemoArena> | null = null;
    const server = new MatchServer({
      port: 0,
      realtime: true,
      control: (req, url) => demoRef?.handle(req, url) ?? null,
    });
    servers.push(server);
    const port = await server.listen();

    const demo = new DemoArena(server, {
      teams: { violet: 'Violet', lime: 'Lime' },
      bots: 'reference',
      halfSeconds: 2,
      gapSeconds: 0,
      log: (line) => logs.push(line),
    });
    demoRef = demo;
    demo.start(port);

    // Kicks off itself — a hall screen should not need a referee.
    const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    expect(answer.status).toBe(200);
    const { state } = (await answer.json()) as {
      state: { playing: boolean; running: boolean; finished: unknown; error: unknown };
    };
    expect(state.playing).toBe(true);
    expect(state.finished).toBeNull();
    expect(state.error).toBeNull();

    // And it turns over forever: two full-time lines mean a second match has
    // begun — the loop is real, not a long single match.
    await waitFor(() => logs.filter((line) => line.startsWith('full time:')).length >= 2, 40_000, 'two full times');

    const later = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    const { state: after } = (await later.json()) as { state: { playing: boolean } };
    expect(after.playing).toBe(true);
    demo.stop();
  }, 60_000);

  it('supports per-team bot configuration and resolves submitted team name', async () => {
    let demoRef: InstanceType<typeof DemoArena> | null = null;
    const server = new MatchServer({
      port: 0,
      realtime: true,
      control: (req, url) => demoRef?.handle(req, url) ?? null,
    });
    servers.push(server);
    const port = await server.listen();

    const demo = new DemoArena(server, {
      teams: { violet: 'Violet', lime: 'Lime' },
      homeBots: 'reference',
      awayBots: 'rehearsal',
      submissionsDir: 'submissions',
      halfSeconds: 2,
      gapSeconds: 0,
    });
    demoRef = demo;
    demo.start(port);

    await waitFor(async () => {
      const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
      if (answer.status !== 200) return false;
      const data = (await answer.json()) as { state: { playing: boolean; teams?: { violet: string; lime: string } } };
      return data.state.playing && data.state.teams?.lime === 'Rehearsal';
    }, 10_000, 'state with resolved rehearsal team name');

    const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    const { state } = (await answer.json()) as {
      state: { playing: boolean; teams: { violet: string; lime: string } };
    };
    expect(state.playing).toBe(true);
    expect(state.teams.violet).toBe('Reference');
    expect(state.teams.lime).toBe('Rehearsal');
    demo.stop();
  }, 60_000);
});

describe('a demo arena, supervised', () => {
  it('opens a real child that answers as an always-playing world', async () => {
    const arenas = new ArenaSupervisor({ log: () => {} });
    supervisors.push(arenas);

    const arena = await arenas.create({
      kind: 'demo',
      demo: { home: 'Violet', away: 'Lime', bots: 'reference', halfSeconds: 2, league: null, gapSeconds: 0 },
    });
    expect(arena.kind).toBe('demo');

    const port = arenas.portOf(arena.id);
    expect(port).not.toBeNull();
    const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    expect(answer.status).toBe(200);
    const payload = (await answer.json()) as {
      ok: boolean;
      state: { playing: boolean; finished: unknown; error: unknown };
    };
    expect(payload.ok).toBe(true);
    expect(payload.state.playing).toBe(true);
    // The promise of the demo: it never finishes and never refuses.
    expect(payload.state.finished).toBeNull();
    expect(payload.state.error).toBeNull();

    // A demo must not be reaped by the idle sweep, which only touches practice.
    arenas.sweep();
    expect(arenas.info(arena.id)).not.toBeNull();
  }, 60_000);

  it('passes homeBots and awayBots to the child arena process and resolves team names', async () => {
    const arenas = new ArenaSupervisor({ submissionsDir: 'submissions', log: () => {} });
    supervisors.push(arenas);

    const arena = await arenas.create({
      kind: 'demo',
      demo: {
        home: 'Violet',
        away: 'Lime',
        bots: 'reference',
        homeBots: 'reference',
        awayBots: 'rehearsal',
        halfSeconds: 2,
        league: null,
        gapSeconds: 0,
      },
    });
    const port = arenas.portOf(arena.id);
    expect(port).not.toBeNull();

    await waitFor(async () => {
      const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
      if (answer.status !== 200) return false;
      const data = (await answer.json()) as { state: { playing: boolean; teams?: { violet: string; lime: string } } };
      return data.state.playing && data.state.teams?.lime === 'Rehearsal';
    }, 15_000, 'supervised demo state with resolved rehearsal team name');

    const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    const payload = (await answer.json()) as {
      ok: boolean;
      state: { playing: boolean; teams: { violet: string; lime: string } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.state.teams.violet).toBe('Reference');
    expect(payload.state.teams.lime).toBe('Rehearsal');
  }, 60_000);
});