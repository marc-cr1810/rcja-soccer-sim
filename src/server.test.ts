/**
 * What a screen in a hall is sent.
 *
 * The frame has to survive a socket, arrive fast enough to look like football,
 * and carry nothing a spectator should not have. A viewer that could be given
 * more than the audience can see would be a way to leak a match.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Match, type MatchAgents } from './match';
import { referenceTeam } from './reference';
import { MatchServer } from './server';
import { VIEW_HZ, type ViewMessage } from './view';

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

describe('the frame rate', () => {
  it('sends at a rate an eye needs, not the rate the physics runs at', () => {
    // 100 Hz of physics streamed raw would be three times the bandwidth for
    // nothing visible, and venue wifi is the one thing that can be relied on
    // to be bad.
    expect(VIEW_HZ).toBeLessThan(60);
    expect(VIEW_HZ).toBeGreaterThanOrEqual(24);
  });
});
