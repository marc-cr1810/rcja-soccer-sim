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

import { MatchServer } from '../../src/infra/server';
import { DemoArena } from '../../src/league/arena';
import { ArenaSupervisor } from '../../src/league/arenas';

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

describe('the demo arena, when the example robots change sides', () => {
  /**
   * A seat outlives the program that sat in it, and the demo used to hand the
   * whole gateway to the next match.
   *
   * `randomSides` moves the Python examples from one side to the other between
   * matches. The seats they leave behind are never released — during a match a
   * program going quiet is rule 5.7's business, not a withdrawal — so they
   * stayed in `agents.transports()` with a closed socket behind them, and
   * `seatExamples` returned that whole map. A transport beats the built-in
   * agent for the same seat id, so from the first change of sides onwards the
   * *other* team was two robots wired to a dead socket: they answered nothing,
   * every control cycle of every match went down as missed, and they stood on
   * the field being shoved around by the ball for the rest of the demo.
   *
   * The name in the match record is what tells the two apart, so that is what
   * this asserts. A remote program is `Team/seat-id`; a built-in agent is its
   * own name. Both sides being remote means a side that has no program is
   * wearing the leftovers of one.
   */
  it('leaves the other side to its own built-in agents', async () => {
    let demoRef: InstanceType<typeof DemoArena> | null = null;
    const server = new MatchServer({
      port: 0,
      realtime: true,
      // Two seconds of football per match, so the sides turn over while a test
      // watches; there is nothing about a kick-off countdown being tested here.
      kickoffCountdown: 0,
      control: (req, url) => demoRef?.handle(req, url) ?? null,
    });
    servers.push(server);
    const port = await server.listen();

    // Every finished match says who actually drove each seat.
    const summaries: Record<string, { name: string }>[] = [];
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/`);
    viewer.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        result?: { slots: Record<string, { name: string }> };
      };
      if (message.type === 'summary' && message.result) summaries.push(message.result.slots);
    };

    const logs: string[] = [];
    const demo = new DemoArena(server, {
      teams: { violet: 'Purple', lime: 'Green' },
      homeBots: 'reference',
      awayBots: 'examples',
      randomSides: true,
      halfSeconds: 1,
      gapSeconds: 0,
      log: (line) => logs.push(line),
    });
    demoRef = demo;
    demo.start(port);

    const spawned = (side: string): boolean =>
      logs.some((line) => line.includes(`spawned example robots (${side})`));
    // Both sides means the examples have moved at least once, which is the
    // only way to leave a seat behind.
    await waitFor(() => spawned('violet') && spawned('lime'), 90_000, 'the examples to change sides');
    const before = summaries.length;
    await waitFor(() => summaries.length > before, 40_000, 'a match played after the change of sides');
    demo.stop();
    viewer.close();

    const slots = summaries[summaries.length - 1]!;
    const remote = Object.keys(slots).filter((id) => slots[id]!.name.includes('/'));
    // Exactly one side is the examples. The other is the reference agent, by
    // name, with nothing left over from where the examples used to sit.
    expect(remote.length).toBe(2);
    expect(new Set(remote.map((id) => id.split('-')[0])).size).toBe(1);
    for (const id of Object.keys(slots)) {
      if (remote.includes(id)) continue;
      expect(slots[id]!.name).toStartWith('reference-');
    }
  }, 150_000);
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

  it('supports randomSides to alternate home and away assignments across matches', async () => {
    let demoRef: InstanceType<typeof DemoArena> | null = null;
    const server = new MatchServer({
      port: 0,
      realtime: true,
      control: (req, url) => demoRef?.handle(req, url) ?? null,
    });
    servers.push(server);
    const port = await server.listen();

    const seenOrientations = new Set<string>();
    const demo = new DemoArena(server, {
      teams: { violet: 'Purple', lime: 'Green' },
      homeBots: 'champion',
      awayBots: 'reference',
      randomSides: true,
      halfSeconds: 1,
      gapSeconds: 0,
      log: () => {
        const t = demo.state().teams;
        if (t) seenOrientations.add(`${t.violet} vs ${t.lime}`);
      },
    });
    demoRef = demo;
    demo.start(port);

    // Run until both permutations (Purple vs Green and Green vs Purple) are observed
    await waitFor(() => seenOrientations.size >= 2, 55_000, 'both side orientations seen with randomSides');
    expect(seenOrientations.has('Purple vs Green')).toBe(true);
    expect(seenOrientations.has('Green vs Purple')).toBe(true);
    demo.stop();
  }, 70_000);

  it('plays against itself when exactly one team is in the list', async () => {
    let demoRef: InstanceType<typeof DemoArena> | null = null;
    const server = new MatchServer({
      port: 0,
      realtime: true,
      control: (req, url) => demoRef?.handle(req, url) ?? null,
    });
    servers.push(server);
    const port = await server.listen();

    const demo = new DemoArena(server, {
      teams: ['Solo Team'],
      bots: 'reference',
      halfSeconds: 1,
      gapSeconds: 0,
    });
    demoRef = demo;
    demo.start(port);

    await waitFor(async () => {
      const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
      if (answer.status !== 200) return false;
      const data = (await answer.json()) as { state: { playing: boolean; teams?: { violet: string; lime: string } } };
      return data.state.playing && data.state.teams?.violet === 'Solo Team' && data.state.teams?.lime === 'Solo Team';
    }, 15_000, 'state with Solo Team vs itself');

    const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    const payload = (await answer.json()) as {
      ok: boolean;
      state: { playing: boolean; teams: { violet: string; lime: string } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.state.teams.violet).toBe('Solo Team');
    expect(payload.state.teams.lime).toBe('Solo Team');
    demo.stop();
  }, 60_000);

  it('randomly selects two distinct teams when > 1 teams are in the list', async () => {
    let demoRef: InstanceType<typeof DemoArena> | null = null;
    const server = new MatchServer({
      port: 0,
      realtime: true,
      control: (req, url) => demoRef?.handle(req, url) ?? null,
    });
    servers.push(server);
    const port = await server.listen();

    const seenMatchups = new Set<string>();
    const demo = new DemoArena(server, {
      teams: ['Team Alpha', 'Team Beta', 'Team Gamma'],
      bots: 'reference',
      halfSeconds: 1,
      gapSeconds: 0,
      log: () => {
        const t = demo.state().teams;
        if (t) {
          expect(t.violet).not.toBe(t.lime);
          seenMatchups.add(`${t.violet} vs ${t.lime}`);
        }
      },
    });
    demoRef = demo;
    demo.start(port);

    // Wait until at least 2 distinct pairings are seen across matches
    await waitFor(() => seenMatchups.size >= 2, 55_000, 'at least two distinct matchups seen');
    for (const matchup of seenMatchups) {
      const [v, l] = matchup.split(' vs ');
      expect(v).not.toBe(l);
    }
    demo.stop();
  }, 70_000);

  it('supervised demo arena supports demo.teams with single team vs itself', async () => {
    const arenas = new ArenaSupervisor({ log: () => {} });
    supervisors.push(arenas);

    const arena = await arenas.create({
      kind: 'demo',
      demo: {
        teams: ['Single Team'],
        home: 'Violet',
        away: 'Lime',
        bots: 'reference',
        halfSeconds: 1,
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
      return data.state.playing && data.state.teams?.violet === 'Single Team' && data.state.teams?.lime === 'Single Team';
    }, 15_000, 'supervised demo state with Single Team vs itself');

    const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
    const payload = (await answer.json()) as {
      ok: boolean;
      state: { playing: boolean; teams: { violet: string; lime: string } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.state.teams.violet).toBe('Single Team');
    expect(payload.state.teams.lime).toBe('Single Team');
  }, 60_000);
});