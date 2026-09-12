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
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { Match, CONTROL_HZ, PHYSICS_HZ, type MatchOptions, type MatchResult } from './match';
import { VIEW_HZ, type ViewMessage } from './view';
import { AGENT_PATH, AgentGateway } from './gateway';
import { slugifyTeam, TOKEN_FILENAME } from './manifest';
import { validateSubmission } from './submission';

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
  /** The repo's python/ directory, for validating a push. No /submit without one. */
  pythonLibDir?: string;
  /** Where validated pushes are kept, as <team>/<robot>. Defaults to ./submissions. */
  submissionsDir?: string;
  /** Built referee console to serve, on its own path. Nothing is served without one. */
  refereeRoot?: string;
  /**
   * Hand-issued credential for the referee console, same style as a Phase 1
   * push token: minted once, handed out of band, checked on every referee
   * request. Absent — the default — means referee mode does not exist on
   * this server at all: `/referee-api/*` always answers 404 and `play()`
   * refuses a `refereed` match, so nothing about today's `bench`, `--agents`
   * or plain `serve` behaviour changes unless this is set.
   */
  refereeToken?: string;
}

const MAX_SUBMIT_BYTES = 2 * 1024 * 1024;
const MAX_SUBMIT_FILES = 50;
/** Flat filenames only — no subdirectories, this slice's whole team folder is one level. */
const SAFE_SUBMIT_PATH = /^[A-Za-z0-9_.-]+$/;

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
  /**
   * A second, private door to the same gateway, on a Unix socket rather than
   * the public port.
   *
   * A sandboxed submission has no network — that is the point of sandboxing
   * it — so it cannot reach the public `/agent` path over TCP even on
   * loopback. This is the same escape hatch `submission.ts` uses for its
   * one-tick check, held open for the server's whole lifetime instead of one
   * validation: a filesystem path bound into the sandbox, not a network hole.
   */
  private readonly agentSocket = createServer();
  private agentSocketPath: string | null = null;
  private agentScratchDir: string | null = null;
  private current: Match | null = null;
  private readonly viewerRoot: string | null;
  private readonly refereeRoot: string | null;
  private readonly refereeToken: string | null;
  private readonly realtime: boolean;
  private readonly pythonLibDir: string | null;
  private readonly submissionsDir: string;

  constructor(private readonly opts: ServerOptions = {}) {
    this.viewerRoot = opts.viewerRoot ? resolve(opts.viewerRoot) : null;
    this.refereeRoot = opts.refereeRoot ? resolve(opts.refereeRoot) : null;
    this.refereeToken = opts.refereeToken ?? null;
    this.realtime = opts.realtime ?? true;
    this.pythonLibDir = opts.pythonLibDir ? resolve(opts.pythonLibDir) : null;
    this.submissionsDir = resolve(opts.submissionsDir ?? 'submissions');

    this.http.on('upgrade', (req, socket, head) => {
      // One port for both, split by path: a venue has enough to configure
      // without a second hole in a firewall for the robots.
      const agent = (req.url ?? '/').split('?')[0] === AGENT_PATH;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (agent) this.agents.accept(ws);
        else this.join(ws);
      });
    });
    this.agentSocket.on('upgrade', (req, socket, head) => {
      // No path split here: this door only ever speaks the agent protocol.
      this.wss.handleUpgrade(req, socket, head, (ws) => this.agents.accept(ws));
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
    this.agentScratchDir = await mkdtemp(join(tmpdir(), 'rcja-agent-socket-'));
    this.agentSocketPath = join(this.agentScratchDir, 'agents.sock');
    await new Promise<void>((ok) => this.agentSocket.listen(this.agentSocketPath, ok));

    await new Promise<void>((ok) => this.http.listen(this.opts.port ?? 8080, ok));
    const address = this.http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server is not listening on a TCP port');
    }
    return address.port;
  }

  /**
   * Where a sandboxed, network-less submission connects for a whole match —
   * a Unix socket, with the request path baked into the query string since
   * there is no host/port half of the URL to carry it. Matches the `unix://`
   * convention `python/rcja_soccer/_ws.py` already understands.
   */
  get agentSocketUrl(): string {
    if (!this.agentSocketPath) {
      throw new Error('server is not listening yet — call listen() first');
    }
    return `unix://${this.agentSocketPath}?path=${encodeURIComponent(AGENT_PATH)}`;
  }

  /**
   * The directory the agent socket lives in.
   *
   * A caller sandboxing its own connection to `agentSocketUrl` (`lineup.ts`
   * does, for a match-time submission) has to bind this in — the socket path
   * is otherwise just as invisible to a sandboxed process as everything else
   * on the host is.
   */
  get agentSocketDir(): string {
    if (!this.agentScratchDir) {
      throw new Error('server is not listening yet — call listen() first');
    }
    return this.agentScratchDir;
  }

  async close(): Promise<void> {
    this.agents.closeAll();
    for (const ws of this.viewers) ws.close();
    this.viewers.clear();
    await new Promise<void>((ok) => this.wss.close(() => ok()));
    await new Promise<void>((ok) => this.http.close(() => ok()));
    await new Promise<void>((ok) => this.agentSocket.close(() => ok()));
    if (this.agentScratchDir) await rm(this.agentScratchDir, { recursive: true, force: true }).catch(() => {});
  }

  /** How many screens are watching. */
  get watching(): number {
    return this.viewers.size;
  }

  /** The match in progress, for a caller that needs to ask it something. */
  get currentMatch(): Match | null {
    return this.current;
  }

  /** Where a validated push lands, as `<slugified team>/<robot>`. */
  get submissionsDirectory(): string {
    return this.submissionsDir;
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
    if (options.refereed && !this.refereeToken) {
      throw new Error(
        'a refereed match needs a refereeToken configured on the server — otherwise nothing could ever kick it off',
      );
    }
    const match = new Match({
      idealSensors: this.opts.idealSensors ?? true,
      ...options,
    });
    this.current = match;
    // A program that dropped out mid-match may not simply reconnect and carry
    // on; the gateway refuses it until rule 5.7.2's stand-down is served, and
    // only the match knows how much of it is left.
    this.agents.standDown = (robotId) => match.standDown(robotId);
    this.broadcast({
      type: 'hello',
      league: match.league,
      teams: match.teams,
      halfSeconds: match.halfLength,
    });

    if (match.refereed) {
      const result = await this.playRefereed(match);
      this.broadcast({ type: 'frame', frame: match.snapshot() });
      return result;
    }

    // Programs over a socket need the event loop, and `match.run()` never
    // gives it up. See playFast.
    const remote = Object.keys(options.transports ?? {}).length > 0;

    if (!this.realtime) {
      const result = remote ? await this.playFast(match) : match.run();
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

  /**
   * Play as fast as the programs can answer, rather than as fast as possible.
   *
   * `match.run()` steps the whole match inside one synchronous loop, which is
   * exactly right for the built-in agents — they are function calls — and
   * exactly wrong for programs on a socket. Nothing on the event loop runs
   * while it is going, so not one sensor frame is delivered and not one reply
   * is collected: the match is played out in milliseconds against four
   * programs that were never asked anything, and every one of them sits at its
   * last command until the sockets time out and reconnect. `--fast --agents`
   * used to churn 182 goalless matches in thirty seconds that way.
   *
   * Yielding once per control cycle fixes it and still runs at better than ten
   * times real time, because a local round trip costs well under the
   * millisecond the timer rounds up to. A program that cannot keep up just
   * misses cycles, which is what it would do on a slow field too, and the
   * misses are already in the match record.
   */
  private async playFast(match: Match): Promise<MatchResult> {
    const dt = 1 / PHYSICS_HZ;
    const perControl = Math.max(1, Math.round(PHYSICS_HZ / CONTROL_HZ));
    for (const half of [1, 2] as const) {
      match.world.half = half;
      match.world.kickOff(half === 1 ? 'cyan' : 'yellow');
      match.resetAgents();
      match.world.running = true;
      const until = match.world.clock + match.halfLength;
      while (match.world.clock < until) {
        for (let i = 0; i < perControl && match.world.clock < until; i++) match.step(dt);
        await sleep(0);
      }
      match.world.running = false;
    }
    return match.result();
  }

  /**
   * Play a match one half at a time, doing nothing until a referee says to.
   *
   * Every other loop in this file decides for itself when to kick off and
   * when a half ends. This one decides nothing: it waits for
   * `match.world.running` to go true (set by the referee's `kickoff` call,
   * via `Match.kickOff`'s wrapper) before it steps any physics at all, and it
   * stops stepping the moment `running` goes false again — a pause, or a
   * goal `autoResolve: false` left stopped for the referee to act on — rather
   * than treating that as the half being over. Only three things end the
   * half's loop: its own time budget, `match.endHalf()`/`endMatch()`/
   * `abandon()` (all surfaced through `consumeHalfEndRequest()`), or the
   * match already being ended. `match.isEnded` breaks out of both halves
   * entirely, so `endMatch()`/`abandon()` mid-first-half never plays a
   * second half nobody asked for.
   */
  private async playRefereed(match: Match): Promise<MatchResult> {
    const dt = 1 / PHYSICS_HZ;
    const viewHz = Math.max(10, Math.min(100, this.opts.viewHz ?? VIEW_HZ));
    const framePeriod = 1000 / viewHz;
    const perControl = Math.max(1, Math.round(PHYSICS_HZ / CONTROL_HZ));

    for (const half of [1, 2] as const) {
      if (match.isEnded) break;
      match.world.half = half;
      match.resetAgents();

      const until = match.world.clock + match.halfLength;
      let owed = 0;
      let last = Date.now();

      while (match.world.clock < until) {
        if (match.consumeHalfEndRequest() || match.isEnded) break;

        if (this.realtime) {
          await sleep(framePeriod);
          const now = Date.now();
          owed += (now - last) / 1000;
          last = now;
          // Same starvation guard as the self-running loop: never try to make
          // up more than a moment of missed wall-clock time at once.
          owed = Math.min(owed, 0.25);
        } else {
          await sleep(0);
          owed = dt * perControl;
        }

        if (match.world.running) {
          while (owed >= dt && match.world.clock < until) {
            match.step(dt);
            owed -= dt;
          }
        }
        this.broadcast({ type: 'frame', frame: match.snapshot() });
      }
      match.world.running = false;
      this.broadcast({ type: 'frame', frame: match.snapshot() });
      if (match.isEnded) break;
    }

    return match.result();
  }

  /** Serve the built viewer or referee console, or a push/referee action, if there is one. */
  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'POST' && url === '/submit') {
      await this.handleSubmit(req, res);
      return;
    }
    if (req.method === 'POST' && url.startsWith('/referee-api/')) {
      await this.handleRefereeAction(req, res, url.slice('/referee-api/'.length));
      return;
    }
    // A separate root and a separate path from the spectator bundle — never
    // one page with a referee panel bolted on. The static files themselves
    // need no auth (a login screen has to be fetchable to log in from); only
    // the actions under /referee-api do.
    if (url === '/referee' || url.startsWith('/referee/')) {
      const sub = url === '/referee' ? '/' : url.slice('/referee'.length);
      await this.serveStatic(res, this.refereeRoot, sub, 'no referee console built; run: npm run build:referee');
      return;
    }
    await this.serveStatic(res, this.viewerRoot, url, 'no viewer built; run: npm run build:viewer');
  }

  private async serveStatic(
    res: ServerResponse,
    root: string | null,
    url: string,
    missingMessage: string,
  ): Promise<void> {
    if (!root) {
      res.writeHead(404).end(missingMessage);
      return;
    }
    const wanted = url === '/' ? 'index.html' : url.slice(1);
    // Normalise before joining, so a path cannot climb out of the root.
    const file = join(root, normalize(wanted));
    if (!file.startsWith(root)) {
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

  /**
   * One referee action, over `POST /referee-api/<action>`.
   *
   * Same shape as `handleSubmit`: a hand-issued bearer token checked before
   * anything else, a small JSON body validated field-by-field, and a
   * `{ ok, reason }` response. Absent `refereeToken` (the default) makes this
   * whole surface 404 regardless of path or body — a server started without
   * `--referee` exposes nothing new at all.
   */
  private async handleRefereeAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    if (!this.refereeToken) {
      this.respondJson(res, 404, { ok: false, reason: 'referee mode is not enabled on this server' });
      return;
    }
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (presented !== this.refereeToken) {
      this.respondJson(res, 401, { ok: false, reason: 'invalid or missing referee token' });
      return;
    }
    const match = this.current;
    if (!match || !match.refereed) {
      this.respondJson(res, 409, { ok: false, reason: 'no refereed match in progress' });
      return;
    }

    const body = await this.readBody(req, 4096);
    if (body === null) {
      this.respondJson(res, 413, { ok: false, reason: 'request body too large' });
      return;
    }
    let payload: Record<string, unknown> = {};
    if (body.length > 0) {
      try {
        payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        this.respondJson(res, 400, { ok: false, reason: 'body is not valid JSON' });
        return;
      }
    }

    switch (action) {
      case 'kickoff': {
        const { team } = payload;
        if (team !== 'cyan' && team !== 'yellow') {
          this.respondJson(res, 400, { ok: false, reason: '"team" must be "cyan" or "yellow"' });
          return;
        }
        match.kickOff(team);
        break;
      }
      case 'award-kickoff':
        match.awardKickOffToOther();
        break;
      case 'pause':
        match.pause();
        break;
      case 'resume':
        match.resume();
        break;
      case 'end-half':
        match.endHalf();
        break;
      case 'end-match':
        match.endMatch();
        break;
      case 'abandon': {
        const { reason } = payload;
        if (typeof reason !== 'string' || reason.trim() === '') {
          this.respondJson(res, 400, { ok: false, reason: '"reason" is required' });
          return;
        }
        match.abandon(reason);
        break;
      }
      case 'remove-robot': {
        const { robotId, rule, reason } = payload;
        if (typeof robotId !== 'string' || typeof rule !== 'string' || typeof reason !== 'string') {
          this.respondJson(res, 400, {
            ok: false,
            reason: '"robotId", "rule" and "reason" are required strings',
          });
          return;
        }
        match.removeRobot(robotId, rule, reason);
        break;
      }
      case 'return-robot': {
        const { robotId } = payload;
        if (typeof robotId !== 'string') {
          this.respondJson(res, 400, { ok: false, reason: '"robotId" is required' });
          return;
        }
        if (!match.returnRobot(robotId)) {
          this.respondJson(res, 409, { ok: false, reason: 'robot is not ready to return yet' });
          return;
        }
        break;
      }
      case 'correct-score': {
        const { team, to, reason } = payload;
        if (team !== 'cyan' && team !== 'yellow') {
          this.respondJson(res, 400, { ok: false, reason: '"team" must be "cyan" or "yellow"' });
          return;
        }
        if (typeof to !== 'number' || typeof reason !== 'string' || reason.trim() === '') {
          this.respondJson(res, 400, { ok: false, reason: '"to" (number) and "reason" (string) are required' });
          return;
        }
        try {
          match.correctScore(team, to, reason);
        } catch (err) {
          this.respondJson(res, 400, { ok: false, reason: (err as Error).message });
          return;
        }
        break;
      }
      default:
        this.respondJson(res, 404, { ok: false, reason: `unknown referee action "${action}"` });
        return;
    }

    this.respondJson(res, 200, { ok: true });
  }

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  /**
   * Read the request body, or `null` if it is over `limit`.
   *
   * An oversized body is drained rather than the connection being cut: a
   * destroyed socket answers a client with a reset rather than the 413 this
   * is trying to send, which is a worse failure than the one being guarded
   * against.
   */
  private readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    return new Promise((resolveBody) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let over = false;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          over = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        resolveBody(over ? null : Buffer.concat(chunks));
      });
      req.on('error', () => {
        resolveBody(null);
      });
    });
  }

  /**
   * One robot's folder, pushed as `{ files: { path: base64 } }`.
   *
   * Written to a scratch directory and validated there first; only a pass
   * gets moved into the real submissions tree, so a rejected push can never
   * clobber a team's last-good one for that robot.
   */
  private async handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.pythonLibDir) {
      this.respondJson(res, 400, {
        ok: false,
        reason: 'this server has no python library configured; nothing can be validated',
      });
      return;
    }

    const body = await this.readBody(req, MAX_SUBMIT_BYTES);
    if (body === null) {
      this.respondJson(res, 413, { ok: false, reason: 'push too large' });
      return;
    }

    let payload: { files?: unknown };
    try {
      payload = JSON.parse(body.toString('utf8')) as { files?: unknown };
    } catch {
      this.respondJson(res, 400, { ok: false, reason: 'body is not valid JSON' });
      return;
    }

    const rawFiles = payload.files;
    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
      this.respondJson(res, 400, {
        ok: false,
        reason: '"files" must be an object of path -> base64 content',
      });
      return;
    }

    const entries = Object.entries(rawFiles as Record<string, unknown>);
    if (entries.length === 0) {
      this.respondJson(res, 400, { ok: false, reason: 'no files in the push' });
      return;
    }
    if (entries.length > MAX_SUBMIT_FILES) {
      this.respondJson(res, 400, {
        ok: false,
        reason: `too many files (${entries.length}, limit ${MAX_SUBMIT_FILES})`,
      });
      return;
    }

    const decoded = new Map<string, Buffer>();
    for (const [path, value] of entries) {
      if (!SAFE_SUBMIT_PATH.test(path)) {
        this.respondJson(res, 400, {
          ok: false,
          reason: `"${path}" is not a safe filename — no subdirectories, only letters, digits, ".", "_", "-"`,
        });
        return;
      }
      if (typeof value !== 'string') {
        this.respondJson(res, 400, { ok: false, reason: `"${path}" must be base64 text` });
        return;
      }
      decoded.set(path, Buffer.from(value, 'base64'));
    }

    const scratch = await mkdtemp(join(tmpdir(), 'rcja-submit-'));
    try {
      for (const [path, buf] of decoded) {
        await writeFile(join(scratch, path), buf);
      }

      const result = await validateSubmission(scratch, { pythonLibDir: this.pythonLibDir });
      if (!result.ok) {
        this.respondJson(res, 400, { ok: false, reason: result.reason });
        return;
      }

      const manifest = result.value;
      const teamDir = join(this.submissionsDir, slugifyTeam(manifest.team));
      const target = join(teamDir, String(manifest.robot));
      await mkdir(teamDir, { recursive: true });
      await rm(target, { recursive: true, force: true });
      try {
        await rename(scratch, target);
      } catch {
        // Scratch and the submissions tree can be on different filesystems
        // (a tmpfs /tmp is common), which a plain rename cannot cross.
        await cp(scratch, target, { recursive: true });
      }

      // Minted after the move, into the real submissions tree rather than
      // scratch — validation above never sees it, and never needs to: no
      // token exists yet at the point a push is only being checked, just
      // stored. A fresh token every successful push, whether or not the code
      // itself changed — it authenticates this validated copy, not a
      // standing account.
      const token = randomBytes(24).toString('base64url');
      await writeFile(join(target, TOKEN_FILENAME), token);

      this.respondJson(res, 200, { ok: true, team: manifest.team, robot: manifest.robot, token });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}
