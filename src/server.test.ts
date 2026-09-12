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
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Match, type MatchAgents } from './match';
import { PROTOCOL_VERSION } from './protocol';
import { referenceTeam } from './reference';
import { waller } from './bots';
import { MatchServer } from './server';
import { sandboxAvailable } from './sandbox';
import { VIEW_HZ, type ViewMessage } from './view';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../python');

function agents(): MatchAgents {
  return {
    ...referenceTeam('cyan'),
    ...referenceTeam('yellow'),
  } as unknown as MatchAgents;
}

function played(seconds = 6) {
  const match = new Match({
    agents: agents(),
    teams: { cyan: 'ACT-01', yellow: 'QLD-04' },
    halfSeconds: 60,
    seed: 3,
  });
  match.world.kickOff('cyan');
  match.world.running = true;
  for (let i = 0; i < seconds * 100; i++) match.step(1 / 100);
  return match;
}

describe('the frame a viewer gets', () => {
  it('carries what a scoreboard and a renderer need', () => {
    const frame = played().snapshot();
    expect(frame.teams).toEqual({ cyan: 'ACT-01', yellow: 'QLD-04' });
    expect(frame.robots).toHaveLength(4);
    expect(frame.clock).toBeGreaterThan(0);
    expect(typeof frame.score.cyan).toBe('number');
    expect(frame.ball.radius).toBeGreaterThan(0);
    for (const robot of frame.robots) {
      expect(typeof robot.heading).toBe('number');
      expect(['cyan', 'yellow']).toContain(robot.team);
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
        ...referenceTeam('cyan'),
        'yellow-1': waller,
        'yellow-2': waller,
      } as unknown as MatchAgents,
      teams: { cyan: 'ACT-01', yellow: 'WALLERS' },
      halfSeconds: 120,
      seed: 2,
    });
    match.world.kickOff('cyan');
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
      socket.addEventListener('message', (e) => {
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
      teams: { cyan: 'ACT-01', yellow: 'QLD-04' },
      halfSeconds: 2,
      seed: 1,
    });
    await new Promise((ok) => setTimeout(ok, 50));

    const hello = messages.find((m) => m.type === 'hello');
    expect(hello).toBeDefined();
    if (hello?.type === 'hello') {
      expect(hello.league.id).toBe('open');
      expect(hello.teams.cyan).toBe('ACT-01');
    }
    socket.close();
  });

  it('brings a viewer that joins mid-match straight up to date', async () => {
    // Somebody plugging a laptop into the projector at half time should see
    // the field at once, not a blank screen until the next thing happens.
    const { server, port } = await start();
    void server.play({ agents: agents(), teams: { cyan: 'A', yellow: 'B' }, halfSeconds: 2 });
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
    const server = new MatchServer({ port: 0, viewerRoot: 'dist-viewer', realtime: false });
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
      ws.once('open', () => ok());
      ws.once('error', fail);
    });
    ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, team: 'cyan', robot: 1 }));
    const message = await new Promise<{ type: string }>((ok) => {
      ws.once('message', (data) => ok(JSON.parse(String(data)) as { type: string }));
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
parser.add_argument("--team", default="cyan")
parser.add_argument("--number", type=int, default=1)
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
args = parser.parse_args()

from rcja_soccer import Robot

robot = Robot(team=args.team, number=args.number, name=args.name)

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
    const body = (await res.json()) as { ok: boolean; team: string; robot: number };
    expect(body).toEqual({ ok: true, team: 'Test Team', robot: 1 });

    const landed = await readdir(join(submissionsDir, 'test-team', '1'));
    expect(landed.sort()).toEqual(['manifest.json', 'robot.py']);
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
    team: 'cyan' | 'yellow',
    robot: 1 | 2,
  ): Promise<{ socket: WebSocket; rejected: string | null }> {
    return new Promise((ok, fail) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join', protocol: 1, team, robot, name: team }));
      });
      socket.addEventListener('message', (e) => {
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

    const first = await join(port, 'cyan', 1);
    const second = await join(port, 'cyan', 2);
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
    const robot = match.world.robots.find((r) => r.id === 'cyan-1')!;
    expect(robot.removed).toBe(true);
    expect(robot.removalRule).toBe('5.7.1');
    expect(match.standDown('cyan-1')).toBeGreaterThan(20);

    // Coming straight back is refused, and the refusal says why.
    const tooSoon = await join(port, 'cyan', 1);
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

    const first = await join(port, 'cyan', 1);
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
    const again = await join(port, 'cyan', 1);
    expect(again.rejected).toBeNull();
    expect(server.agents.filled).toBe(1);
    expect(server.agents.report()['cyan-1']?.reconnects).toBe(1);
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
    const one = await join(port, 'cyan', 1);

    const result = await server.play({
      agents: agents(),
      transports: server.agents.transports(),
      halfSeconds: 4,
      seed: 1,
    });

    const slot = result.slots['cyan-1']!;
    const cycles = 4 * 2 * 50;
    expect(slot.missed).toBeLessThan(cycles / 2);
    expect(slot.worstRun).toBeLessThan(25);
    one.socket.close();
  }, 20000);
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
