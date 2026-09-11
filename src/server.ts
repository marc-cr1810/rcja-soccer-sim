/**
 * The match server.
 *
 * Runs matches and lets people watch them. One authoritative process owns the
 * world; everyone else connects and is sent what happened.
 *
 * It runs at the venue, on the event's own network, which shapes two decisions.
 * There is no hosted service to depend on, so a state coordinator has to be
 * able to start this and have a screen working in the hall a minute later. And
 * the clock is wall-clock rather than as-fast-as-possible: a tournament runs
 * hundreds of matches headless at 400x real time, but the one on the screen has
 * to take five minutes a half, because people are watching it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { Match, PHYSICS_HZ, type MatchOptions, type MatchResult } from './match';
import { VIEW_HZ, type ViewMessage } from './view';
import { AGENT_PATH, AgentGateway } from './gateway';

export interface ServerOptions {
  port?: number;
  /** Built viewer to serve. Nothing is served without one. */
  viewerRoot?: string;
  /** Play at wall-clock speed, as a spectator needs. Off for a headless run. */
  realtime?: boolean;
  /** Frame rate for broadcasting snapshots to spectators. Defaults to VIEW_HZ. */
  viewHz?: number;
  /** Whether sensors operate without noise/drift/latency. Defaults to true. */
  idealSensors?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class MatchServer {
  private readonly http = createServer((req, res) => this.serve(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly viewers = new Set<WebSocket>();
  /** Where robot programs connect, on the same port as the viewers. */
  readonly agents = new AgentGateway();
  private current: Match | null = null;
  private readonly viewerRoot: string | null;
  private readonly realtime: boolean;

  constructor(private readonly opts: ServerOptions = {}) {
    this.viewerRoot = opts.viewerRoot ? resolve(opts.viewerRoot) : null;
    this.realtime = opts.realtime ?? true;

    this.http.on('upgrade', (req, socket, head) => {
      // One port for both, split by path: a venue has enough to configure
      // without a second hole in a firewall for the robots.
      const agent = (req.url ?? '/').split('?')[0] === AGENT_PATH;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (agent) this.agents.accept(ws);
        else this.join(ws);
      });
    });
  }

  /**
   * Start listening, and report the port actually bound.
   *
   * Not the port asked for: port 0 means "any free one", which is how tests
   * and a second instance on the same machine avoid fighting over 8080. An
   * earlier version returned the request rather than the result, so everything
   * pointed at port 0 and nothing could connect.
   */
  async listen(): Promise<number> {
    await new Promise<void>((ok) => this.http.listen(this.opts.port ?? 8080, ok));
    const address = this.http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server is not listening on a TCP port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    this.agents.closeAll();
    for (const ws of this.viewers) ws.close();
    this.viewers.clear();
    await new Promise<void>((ok) => this.wss.close(() => ok()));
    await new Promise<void>((ok) => this.http.close(() => ok()));
  }

  /** How many screens are watching. */
  get watching(): number {
    return this.viewers.size;
  }

  private join(ws: WebSocket): void {
    this.viewers.add(ws);
    ws.on('error', () => this.viewers.delete(ws));
    ws.on('close', () => this.viewers.delete(ws));
    // A viewer that joins at half time should see the field immediately rather
    // than a blank screen until the next frame, so bring it up to date at once.
    if (this.current) {
      this.send(ws, {
        type: 'hello',
        league: this.current.league,
        teams: this.current.teams,
        halfSeconds: this.current.halfLength,
      });
      this.send(ws, { type: 'frame', frame: this.current.snapshot() });
    }
  }

  private send(ws: WebSocket, message: ViewMessage): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        this.viewers.delete(ws);
      }
    }
  }

  private broadcast(message: ViewMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.viewers) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(text);
        } catch {
          this.viewers.delete(ws);
        }
      }
    }
  }

  /**
   * Play one match, streaming it as it goes.
   *
   * The physics still steps at its own fixed rate; what changes is that the
   * loop waits for wall-clock time to catch up. Stepping in a chunk per timer
   * tick rather than one step per tick keeps the physics exact and the timer
   * cheap — a 100 Hz setInterval is not something to rely on.
   */
  async play(options: MatchOptions): Promise<MatchResult> {
    const match = new Match({
      idealSensors: this.opts.idealSensors ?? true,
      ...options,
    });
    this.current = match;
    this.broadcast({
      type: 'hello',
      league: match.league,
      teams: match.teams,
      halfSeconds: match.halfLength,
    });

    if (!this.realtime) {
      const result = match.run();
      this.broadcast({ type: 'frame', frame: match.snapshot() });
      return result;
    }

    const dt = 1 / PHYSICS_HZ;
    const viewHz = Math.max(10, Math.min(100, this.opts.viewHz ?? VIEW_HZ));
    const framePeriod = 1000 / viewHz;

    for (const half of [1, 2] as const) {
      match.world.half = half;
      match.world.kickOff(half === 1 ? 'cyan' : 'yellow');
      match.resetAgents();
      match.world.running = true;

      const until = match.world.clock + match.halfLength;
      let owed = 0;
      let last = Date.now();

      while (match.world.clock < until) {
        await sleep(framePeriod);
        const now = Date.now();
        owed += (now - last) / 1000;
        last = now;
        // Never try to make up more than a moment: if the process was starved,
        // catching up by simulating a second of football at once would be worse
        // than dropping it.
        owed = Math.min(owed, 0.25);
        while (owed >= dt && match.world.clock < until) {
          match.step(dt);
          owed -= dt;
        }
        this.broadcast({ type: 'frame', frame: match.snapshot() });
      }
      match.world.running = false;
      this.broadcast({ type: 'frame', frame: match.snapshot() });
    }

    return match.result();
  }

  /** Serve the built viewer, if there is one. */
  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.viewerRoot) {
      res.writeHead(404).end('no viewer built; run: npm run build:viewer');
      return;
    }
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    const wanted = url === '/' ? 'index.html' : url.slice(1);
    // Normalise before joining, so a path cannot climb out of the viewer root.
    const file = join(this.viewerRoot, normalize(wanted));
    if (!file.startsWith(this.viewerRoot)) {
      res.writeHead(403).end('no');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}
