/**
 * What a screen in a hall is sent.
 *
 * The frame has to survive a socket, arrive fast enough to look like football,
 * and carry nothing a spectator should not have. A viewer that could be given
 * more than the audience can see would be a way to leak a match.
 */

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Match, type MatchAgents } from '../src/match';
import { PROTOCOL_VERSION } from '../src/protocol';
import { referenceTeam } from '../src/reference';
import { waller } from '../src/bots';
import { MatchServer } from '../src/server';
import { sandboxAvailable } from '../src/sandbox';
import { VIEW_HZ, type ViewMessage } from '../src/view';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../python');

function agents(): MatchAgents {
  return {
    ...referenceTeam('violet'),
    ...referenceTeam('lime'),
  } as unknown as MatchAgents;
}

function played(seconds = 6) {
  const match = new Match({
    agents: agents(),
    teams: { violet: 'ACT', lime: 'QLD' },
    halfSeconds: 60,
    seed: 3,
  });
  match.world.kickOff('violet');
  match.world.running = true;
  for (let i = 0; i < seconds * 100; i++) match.step(1 / 100);
  return match;
}

describe('the frame a viewer gets', () => {
  it('carries what a scoreboard and a renderer need', () => {
    const frame = played().snapshot();
    expect(frame.teams).toEqual({ violet: 'ACT', lime: 'QLD' });
    expect(frame.robots).toHaveLength(4);
    expect(frame.clock).toBeGreaterThan(0);
    expect(typeof frame.score.violet).toBe('number');
    expect(frame.ball.radius).toBeGreaterThan(0);
    for (const robot of frame.robots) {
      expect(typeof robot.heading).toBe('number');
      expect(['violet', 'lime']).toContain(robot.team);
    }
  });

  it('survives the trip as plain JSON', () => {
    // Anything with a method or a cycle would arrive at the viewer broken, and
    // it would arrive broken only at an event, which is the worst place to
    // find out.
    const frame = played().snapshot();
    const round = JSON.parse(JSON.stringify(frame));
    expect(round).toEqual(JSON.parse(JSON.stringify(frame)));
    expect(JSON.stringify(frame).length).toBeLessThan(4000);
  });

  it('is a copy, not a window onto the world', () => {
    const match = played();
    const before = match.snapshot();
    for (let i = 0; i < 100; i++) match.step(1 / 100);
    // The first frame must still say what it said when it was taken, or a
    // frame in flight would change under the viewer mid-send.
    expect(match.snapshot().clock).toBeGreaterThan(before.clock);
    const ball = before.ball.x;
    for (let i = 0; i < 100; i++) match.step(1 / 100);
    expect(before.ball.x).toBe(ball);
  });

  it('shows the last few referee calls and no more', () => {
    const frame = played(30).snapshot();
    expect(frame.events.length).toBeLessThanOrEqual(4);
    for (const event of frame.events) {
      expect(event.rule).toMatch(/^\d/);
      expect(event.message.length).toBeGreaterThan(0);
    }
  });

  it('tells a spectator nothing a spectator cannot see', () => {
    // A viewer is untrusted: anyone on the venue network can open it. It gets
    // positions, which are on the field for all to see, and nothing about what
    // a robot was thinking or sensing.
    const json = JSON.stringify(played().snapshot());
    for (const secret of ['motors', 'encoders', 'compass', 'camera', 'bearing', 'strength']) {
      expect(json).not.toContain(secret);
    }
  });
});

describe('a robot standing down under rule 5.7', () => {
  /**
   * Play until somebody is sent off.
   *
   * Wallers drive themselves off the field, so 5.7.1.6 fires within seconds
   * rather than once or twice in a whole match.
   */
  function untilRemoved() {
    const match = new Match({
      agents: {
        ...referenceTeam('violet'),
        'lime-1': waller,
        'lime-2': waller,
      } as unknown as MatchAgents,
      teams: { violet: 'ACT', lime: 'WALLERS' },
      halfSeconds: 120,
      seed: 2,
    });
    match.world.kickOff('violet');
    match.world.running = true;
    for (let i = 0; i < 120 * 100; i++) {
      match.step(1 / 100);
      if (match.snapshot().robots.some((r) => r.removed)) return match;
    }
    throw new Error('nobody was sent off');
  }

  it('tells a viewer how long the robot has left', () => {
    // Without this a robot simply vanished from the field with nothing to say
    // why or for how long, and a team playing a robot short is the most
    // consequential thing that happens in a match short of a goal.
    const off = untilRemoved().snapshot().robots.find((r) => r.removed)!;
    expect(Number.isFinite(off.penaltyRemaining)).toBe(true);
    expect(off.penaltyRemaining).toBeGreaterThan(0);
  });

  it('names the rule it came off under', () => {
    const off = untilRemoved().snapshot().robots.find((r) => r.removed)!;
    expect(off.removalRule ?? '').toMatch(/^5\./);
    expect(off.removalReason ?? '').not.toBe('');
  });

  it('counts the stand-down down as the match runs', () => {
    const match = untilRemoved();
    const id = match.snapshot().robots.find((r) => r.removed)!.id;
    const before = match.snapshot().robots.find((r) => r.id === id)!.penaltyRemaining;
    for (let i = 0; i < 300; i++) match.step(1 / 100);
    const after = match.snapshot().robots.find((r) => r.id === id)!.penaltyRemaining;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it('serves no more than the 30 seconds 5.7.2 asks for in a five-minute half', () => {
    const off = untilRemoved().snapshot().robots.find((r) => r.removed)!;
    expect(off.penaltyRemaining).toBeLessThanOrEqual(30);
  });
});

describe('the match server', () => {
  const servers: MatchServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function start(): Promise<{ server: MatchServer; port: number }> {
    const server = new MatchServer({ port: 0, realtime: false });
    servers.push(server);
    return { server, port: await server.listen() };
  }

  function connect(port: number): Promise<{ socket: WebSocket; messages: ViewMessage[] }> {
    return new Promise((ok, fail) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const messages: ViewMessage[] = [];
      socket.addEventListener('message', (e: MessageEvent) => {
        messages.push(JSON.parse(String(e.data)) as ViewMessage);
      });
      socket.addEventListener('open', () => ok({ socket, messages }));
      socket.addEventListener('error', () => fail(new Error('could not connect')));
    });
  }

  it('accepts a viewer and counts it', async () => {
    const { server, port } = await start();
    const { socket } = await connect(port);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(server.watching).toBe(1);
    socket.close();
  });

  it('tells a viewer which league and who is playing', async () => {
    const { server, port } = await start();
    const { socket, messages } = await connect(port);
    await server.play({
      agents: agents(),
      teams: { violet: 'ACT', lime: 'QLD' },
      halfSeconds: 2,
      seed: 1,
    });
    await new Promise((ok) => setTimeout(ok, 50));

    const hello = messages.find((m) => m.type === 'hello');
    expect(hello).toBeDefined();
    if (hello?.type === 'hello') {
      expect(hello.league.id).toBe('open');
      expect(hello.teams.violet).toBe('ACT');
    }
    socket.close();
  });

  it('brings a viewer that joins mid-match straight up to date', async () => {
    // Somebody plugging a laptop into the projector at half time should see
    // the field at once, not a blank screen until the next thing happens.
    const { server, port } = await start();
    void server.play({ agents: agents(), teams: { violet: 'A', lime: 'B' }, halfSeconds: 2 });
    await new Promise((ok) => setTimeout(ok, 30));
    const { socket, messages } = await connect(port);
    await new Promise((ok) => setTimeout(ok, 80));
    expect(messages.some((m) => m.type === 'hello')).toBe(true);
    expect(messages.some((m) => m.type === 'frame')).toBe(true);
    socket.close();
  });

  it('serves nothing useful when no viewer has been built', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('build:viewer');
  });

  it('refuses to serve files outside the viewer', async () => {
    const server = new MatchServer({ port: 0, viewerRoot: 'dist/viewer', realtime: false });
    servers.push(server);
    const port = await server.listen();
    const res = await fetch(`http://127.0.0.1:${port}/../package.json`);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('rcja-soccer-sim');
  });
});

describe('the private agent socket', () => {
  const servers: MatchServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function start(): Promise<MatchServer> {
    const server = new MatchServer({ port: 0, realtime: false });
    servers.push(server);
    await server.listen();
    return server;
  }

  /** `unix://<path>?path=<encoded>` (this project's own convention) to `ws+unix://<path>:<path>` (ws's). */
  function wsUnixUrl(agentSocketUrl: string): string {
    const match = /^unix:\/\/(.+)\?path=(.+)$/.exec(agentSocketUrl);
    if (!match) throw new Error(`unexpected agentSocketUrl shape: ${agentSocketUrl}`);
    return `ws+unix://${match[1]}:${decodeURIComponent(match[2]!)}`;
  }

  it('feeds the same gateway as the public /agent path', async () => {
    const server = await start();
    const ws = new WebSocket(wsUnixUrl(server.agentSocketUrl));
    await new Promise<void>((ok, fail) => {
      ws.addEventListener('open', () => ok(), { once: true });
      ws.addEventListener('error', () => fail(new Error('unix ws connect error')), { once: true });
    });
    ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, team: 'violet', robot: 1 }));
    const message = await new Promise<{ type: string }>((ok) => {
      ws.addEventListener('message', (e: MessageEvent) => ok(JSON.parse(String(e.data)) as { type: string }), { once: true });
    });
    expect(message.type).toBe('welcome');
    expect(server.agents.filled).toBe(1);
    ws.close();
  });

  it('is separate from the public port — no path can reach it from outside', async () => {
    const server = await start();
    // The whole point is that this is a filesystem path, not something with a
    // port a network client could be pointed at instead.
    expect(server.agentSocketUrl.startsWith('unix://')).toBe(true);
  });
});

describe.skipIf(!sandboxAvailable())('POST /submit', () => {
  const servers: MatchServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function start(): Promise<{ port: number; submissionsDir: string }> {
    const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-server-submit-test-'));
    const server = new MatchServer({
      port: 0,
      realtime: false,
      pythonLibDir: PYTHON_LIB_DIR,
      submissionsDir,
    });
    servers.push(server);
    return { port: await server.listen(), submissionsDir };
  }

  const ROBOT_PY = `
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet")
parser.add_argument("--number", type=int, default=1)
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()

from rcja_soccer import Robot

robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)

@robot.tick
def think(s, me):
    return robot.coast()

robot.run(args.url)
`;

  function push(manifest: Record<string, unknown>, files: Record<string, string> = {}): Record<string, string> {
    const encoded: Record<string, string> = { 'manifest.json': b64(JSON.stringify(manifest)) };
    for (const [name, content] of Object.entries(files)) encoded[name] = b64(content);
    return encoded;
  }

  function b64(text: string): string {
    return Buffer.from(text).toString('base64');
  }

  it('accepts a valid robot folder and stores it under <team>/<robot>', async () => {
    const { port, submissionsDir } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      body: JSON.stringify({
        files: push({ team: 'Test Team', robot: 1, entry: 'robot.py' }, { 'robot.py': ROBOT_PY }),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; team: string; robot: number; token: string };
    expect(body).toMatchObject({ ok: true, team: 'Test Team', robot: 1 });
    expect(body.token).toEqual(expect.any(String));
    expect(body.token.length).toBeGreaterThan(0);

    const landed = await readdir(join(submissionsDir, 'test-team', '1'));
    expect(landed.sort()).toEqual(['manifest.json', 'robot.py', 'token']);
  }, 15000);

  it('rejects a bad manifest and writes nothing', async () => {
    const { port, submissionsDir } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      body: JSON.stringify({ files: push({ team: 'Test Team', robot: 9, entry: 'robot.py' }, { 'robot.py': ROBOT_PY }) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('robot');
    await expect(readdir(submissionsDir)).resolves.toEqual([]);
  });

  it('rejects a path that is not a flat, safe filename', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      body: JSON.stringify({ files: { '../../etc/passwd': b64('x'), 'manifest.json': b64('{}') } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('safe filename');
  });

  it('rejects an oversized push', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      body: JSON.stringify({ files: { 'robot.py': b64('x'.repeat(3 * 1024 * 1024)) } }),
    });
    expect(res.status).toBe(413);
  });

  it("does not touch the other robot's slot when one is repushed", async () => {
    const { port, submissionsDir } = await start();
    const submit = (robot: number): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          files: push({ team: 'Test Team', robot, entry: 'robot.py' }, { 'robot.py': ROBOT_PY }),
        }),
      });

    expect((await submit(1)).status).toBe(200);
    expect((await submit(2)).status).toBe(200);
    // Re-push robot 1 with a manifest that fails validation; robot 2 must survive untouched.
    await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      body: JSON.stringify({ files: push({ team: 'Test Team', robot: 1, entry: 'missing.py' }) }),
    });

    await expect(readdir(join(submissionsDir, 'test-team', '2'))).resolves.toContain('robot.py');
  }, 15000);
});

describe('a robot program that goes away', () => {
  const servers: MatchServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  /** A program that answers every frame with the same command. */
  function join(
    port: number,
    team: 'violet' | 'lime',
    robot: 1 | 2,
    token?: string,
  ): Promise<{ socket: WebSocket; rejected: string | null }> {
    return new Promise((ok, fail) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, team, robot, name: team, token }));
      });
      socket.addEventListener('message', (e: MessageEvent) => {
        const message = JSON.parse(String(e.data)) as {
          type: string;
          reason?: string;
        };
        if (message.type === 'welcome') ok({ socket, rejected: null });
        else if (message.type === 'reject') ok({ socket, rejected: message.reason ?? '' });
        else if (message.type === 'sensors') {
          socket.send(JSON.stringify({ type: 'command', frame: { motors: [0.3, 0.3, 0.3, 0.3] } }));
        }
      });
      socket.addEventListener('error', () => fail(new Error('could not connect')));
    });
  }

  it('is taken off for thirty seconds and may not simply come back', async () => {
    /*
     * Rule 5.7: a robot that has stopped is a damaged robot.
     *
     * A program losing its socket is not different in kind from a battery
     * falling out, and treating it as free would make a crash cost nothing -
     * worse, it would make a crash-loop a tactic, because a robot nobody can
     * shove is a robot that keeps dying and reappearing.
     */
    const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
    servers.push(server);
    const port = await server.listen();

    const first = await join(port, 'violet', 1);
    const second = await join(port, 'violet', 2);
    expect(first.rejected).toBeNull();

    const playing = server.play({
      agents: agents(),
      transports: server.agents.transports(),
      halfSeconds: 30,
      seed: 1,
    });

    await new Promise((ok) => setTimeout(ok, 300));
    first.socket.close();
    await new Promise((ok) => setTimeout(ok, 200));

    const match = server.currentMatch!;
    const robot = match.world.robots.find((r) => r.id === 'violet-1')!;
    expect(robot.removed).toBe(true);
    expect(robot.removalRule).toBe('5.7.1');
    expect(match.standDown('violet-1')).toBeGreaterThan(20);

    // Coming straight back is refused, and the refusal says why.
    const tooSoon = await join(port, 'violet', 1);
    expect(tooSoon.rejected).toContain('5.7.2');
    tooSoon.socket.close();

    // Nobody else can take the seat either: it is still that team's.
    expect(server.agents.filled).toBe(2);

    await playing;
    second.socket.close();
  }, 30000);

  it('keeps the seat and the record when the program comes back', async () => {
    const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
    servers.push(server);
    const port = await server.listen();

    const first = await join(port, 'violet', 1);
    const playing = server.play({
      agents: agents(),
      transports: server.agents.transports(),
      halfSeconds: 2,
      seed: 1,
    });
    await playing;

    // Between matches nothing is standing down, so a rejoin is allowed and
    // lands in the same seat rather than a new one.
    first.socket.close();
    await new Promise((ok) => setTimeout(ok, 50));
    const again = await join(port, 'violet', 1);
    expect(again.rejected).toBeNull();
    expect(server.agents.filled).toBe(1);
    expect(server.agents.report()['violet-1']?.reconnects).toBe(1);
    again.socket.close();
  }, 20000);

  it('plays a real match at speed when programs are attached', async () => {
    /*
     * `match.run()` never yields, so a "fast" match with sockets on it used to
     * be played out in milliseconds against four programs that were never
     * asked anything. The tell is that every cycle is a missed one.
     */
    const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
    servers.push(server);
    const port = await server.listen();
    const one = await join(port, 'violet', 1);

    const result = await server.play({
      agents: agents(),
      transports: server.agents.transports(),
      halfSeconds: 4,
      seed: 1,
    });

    const slot = result.slots['violet-1']!;
    const cycles = 4 * 2 * 50;
    expect(slot.missed).toBeLessThan(cycles / 2);
    expect(slot.worstRun).toBeLessThan(25);
    one.socket.close();
  }, 20000);

  describe('a seat with a server-issued token', () => {
    it('rejects a join with no token', async () => {
      const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
      servers.push(server);
      const port = await server.listen();
      server.agents.expectToken('violet-1', 'the-real-token');

      const attempt = await join(port, 'violet', 1);
      expect(attempt.rejected).toContain('violet-1');
      attempt.socket.close();
    });

    it('rejects a join with the wrong token', async () => {
      const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
      servers.push(server);
      const port = await server.listen();
      server.agents.expectToken('violet-1', 'the-real-token');

      const attempt = await join(port, 'violet', 1, 'not-it');
      expect(attempt.rejected).not.toBeNull();
      attempt.socket.close();
    });

    it('accepts a join with the right token', async () => {
      const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
      servers.push(server);
      const port = await server.listen();
      server.agents.expectToken('violet-1', 'the-real-token');

      const attempt = await join(port, 'violet', 1, 'the-real-token');
      expect(attempt.rejected).toBeNull();
      attempt.socket.close();
    });

    it('still requires the token on reconnect', async () => {
      const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
      servers.push(server);
      const port = await server.listen();
      server.agents.expectToken('violet-1', 'the-real-token');

      const first = await join(port, 'violet', 1, 'the-real-token');
      first.socket.close();
      await new Promise((ok) => setTimeout(ok, 50));

      const wrong = await join(port, 'violet', 1, 'not-it');
      expect(wrong.rejected).not.toBeNull();
      wrong.socket.close();

      const right = await join(port, 'violet', 1, 'the-real-token');
      expect(right.rejected).toBeNull();
      right.socket.close();
    });

    it('leaves a seat with no expected token joining exactly as before', async () => {
      // The regression guard: --agents mode, bun run bench, and local dev
      // never register a token for any seat, and must keep working unchanged.
      const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
      servers.push(server);
      const port = await server.listen();

      const attempt = await join(port, 'violet', 1);
      expect(attempt.rejected).toBeNull();
      attempt.socket.close();
    });
  });
});

describe('the frame rate', () => {
  it('sends at a rate an eye needs, not the rate the physics runs at', () => {
    // 100 Hz of physics streamed raw would be three times the bandwidth for
    // nothing visible, and venue wifi is the one thing that can be relied on
    // to be bad.
    expect(VIEW_HZ).toBeLessThan(60);
    expect(VIEW_HZ).toBeGreaterThanOrEqual(24);
  });
});

describe('referee actions', () => {
  const servers: MatchServer[] = [];
  const TOKEN = 'referee-secret';

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function start(refereeToken?: string): Promise<{ server: MatchServer; port: number }> {
    const server = new MatchServer({ port: 0, realtime: false, refereeToken });
    servers.push(server);
    return { server, port: await server.listen() };
  }

  function post(port: number, action: string, token?: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/referee-api/${action}`, {
      method: 'POST',
      headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('is entirely absent when no refereeToken is configured', async () => {
    // The regression guard: bench, --agents and plain `serve` never set
    // refereeToken, so this whole surface must not exist for them.
    const { port } = await start(undefined);
    const res = await post(port, 'pause', 'anything');
    expect(res.status).toBe(404);
  });

  it('rejects an action with no token', async () => {
    const { port } = await start(TOKEN);
    const res = await post(port, 'pause');
    expect(res.status).toBe(401);
  });

  it('rejects an action with the wrong token', async () => {
    const { port } = await start(TOKEN);
    const res = await post(port, 'pause', 'not-it');
    expect(res.status).toBe(401);
  });

  it('refuses an action when no refereed match is in progress', async () => {
    const { port } = await start(TOKEN);
    const res = await post(port, 'pause', TOKEN);
    expect(res.status).toBe(409);
  });

  it('refuses to even start a refereed match with no refereeToken configured', async () => {
    const { server } = await start(undefined);
    await expect(server.play({ agents: agents(), halfSeconds: 5, refereed: true })).rejects.toThrow(
      /refereeToken/,
    );
  });

  it('kicks off, pauses, resumes and abandons a refereed match end to end', async () => {
    const { server, port } = await start(TOKEN);
    const result = server.play({ agents: agents(), halfSeconds: 5, refereed: true, seed: 1 });

    // Nothing happens until the referee says so.
    await new Promise((ok) => setTimeout(ok, 30));
    expect(server.currentMatch!.world.running).toBe(false);
    expect(server.currentMatch!.world.clock).toBe(0);

    expect((await post(port, 'kickoff', TOKEN, { team: 'violet' })).status).toBe(200);
    expect(server.currentMatch!.world.running).toBe(true);

    expect((await post(port, 'pause', TOKEN)).status).toBe(200);
    expect(server.currentMatch!.world.running).toBe(false);

    expect((await post(port, 'resume', TOKEN)).status).toBe(200);
    expect(server.currentMatch!.world.running).toBe(true);

    expect((await post(port, 'abandon', TOKEN, { reason: 'testing' })).status).toBe(200);

    const final = await result;
    expect(final.abandoned).toBe(true);
    expect(final.abandonReason).toBe('testing');
    // Abandoning mid-first-half must not play a second half nobody asked for.
    expect(final.clock).toBeLessThan(5);
  });

  it('lets the referee correct the score, with a reason recorded against the match', async () => {
    const { server, port } = await start(TOKEN);
    const result = server.play({ agents: agents(), halfSeconds: 5, refereed: true, seed: 1 });
    await post(port, 'kickoff', TOKEN, { team: 'violet' });

    const corrected = await post(port, 'correct-score', TOKEN, {
      team: 'violet',
      to: 3,
      reason: 'scoreboard miscount',
    });
    expect(corrected.status).toBe(200);
    expect(server.currentMatch!.world.score.violet).toBe(3);

    await post(port, 'abandon', TOKEN, { reason: 'done' });
    const final = await result;
    expect(final.scoreCorrections).toEqual([
      { team: 'violet', from: 0, to: 3, reason: 'scoreboard miscount', at: expect.any(Number) },
    ]);
  });

  it('a robot manually removed still returns on its own once its penalty is served', async () => {
    // autoDamaged defaults true even for a refereed match now - only the
    // kick-off itself is gated on the referee, per the same default a
    // self-running match uses.
    const { server, port } = await start(TOKEN);
    const result = server.play({ agents: agents(), halfSeconds: 5, refereed: true, seed: 1 });
    await post(port, 'kickoff', TOKEN, { team: 'violet' });

    expect(
      (await post(port, 'remove-robot', TOKEN, { robotId: 'violet-1', rule: '5.7.1', reason: 'testing' })).status,
    ).toBe(200);
    const robot = server.currentMatch!.world.robots.find((r) => r.id === 'violet-1')!;
    expect(robot.removed).toBe(true);

    // Serve the penalty out directly rather than waiting real seconds, and
    // let the server's own loop step past it - no referee action needed.
    robot.penaltyRemaining = 0;
    await new Promise((ok) => setTimeout(ok, 30));
    expect(robot.removed).toBe(false);

    await post(port, 'abandon', TOKEN, { reason: 'done' });
    await result;
  });

  it('a referee can still ask for the fully-manual mode, where nothing auto-returns', async () => {
    const { server, port } = await start(TOKEN);
    const result = server.play({
      agents: agents(),
      halfSeconds: 5,
      refereed: true,
      autoResolve: false,
      autoDamaged: false,
      seed: 1,
    });
    await post(port, 'kickoff', TOKEN, { team: 'violet' });

    expect(
      (await post(port, 'remove-robot', TOKEN, { robotId: 'violet-1', rule: '5.7.1', reason: 'testing' })).status,
    ).toBe(200);
    const robot = server.currentMatch!.world.robots.find((r) => r.id === 'violet-1')!;
    expect(robot.removed).toBe(true);

    expect((await post(port, 'return-robot', TOKEN, { robotId: 'violet-1' })).status).toBe(409);

    robot.penaltyRemaining = 0;
    await new Promise((ok) => setTimeout(ok, 30));
    expect(robot.removed).toBe(true); // still off - nothing auto-returns it in this mode

    expect((await post(port, 'return-robot', TOKEN, { robotId: 'violet-1' })).status).toBe(200);
    expect(robot.removed).toBe(false);

    await post(port, 'abandon', TOKEN, { reason: 'done' });
    await result;
  });

  it('end-half moves on to the second half rather than ending the match', async () => {
    const { server, port } = await start(TOKEN);
    const result = server.play({ agents: agents(), halfSeconds: 30, refereed: true, seed: 1 });
    await post(port, 'kickoff', TOKEN, { team: 'violet' });

    expect((await post(port, 'end-half', TOKEN)).status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 30));
    expect(server.currentMatch!.world.half).toBe(2);
    expect(server.currentMatch!.world.running).toBe(false);

    await post(port, 'abandon', TOKEN, { reason: 'done' });
    const final = await result;
    expect(final.abandoned).toBe(true);
  });

  it('end-match skips the second half entirely', async () => {
    const { server, port } = await start(TOKEN);
    const result = server.play({ agents: agents(), halfSeconds: 30, refereed: true, seed: 1 });
    await post(port, 'kickoff', TOKEN, { team: 'violet' });

    expect((await post(port, 'end-match', TOKEN)).status).toBe(200);
    const final = await result;
    expect(final.abandoned).toBe(false);
    // Never reached, let alone played, a second half.
    expect(final.clock).toBeLessThan(30);
  });

  it('a robot removed in the first half stays off across end-half into the second', async () => {
    const { server, port } = await start(TOKEN);
    const result = server.play({ agents: agents(), halfSeconds: 30, refereed: true, seed: 1 });
    await post(port, 'kickoff', TOKEN, { team: 'violet' });
    await post(port, 'remove-robot', TOKEN, { robotId: 'violet-1', rule: '5.7.1', reason: 'testing' });

    await post(port, 'end-half', TOKEN);
    await new Promise((ok) => setTimeout(ok, 30));
    expect(server.currentMatch!.world.half).toBe(2);

    await post(port, 'kickoff', TOKEN, { team: 'lime' });
    const robot = server.currentMatch!.world.robots.find((r) => r.id === 'violet-1')!;
    expect(robot.removed).toBe(true);

    await post(port, 'abandon', TOKEN, { reason: 'done' });
    await result;
  });
});
