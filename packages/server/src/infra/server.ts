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

import type { ServerWebSocket, Server } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import {
  Match,
  CONTROL_HZ,
  KICKOFF_COUNTDOWN_SECONDS,
  PHYSICS_HZ,
  type MatchOptions,
  type MatchResult,
} from '../match/match';
import { VIEW_HZ, type ViewMessage } from '@rcja/shared/view';
import { SEAT_IDS, type SeatId } from '../match/match';
import type { SeedInput } from '../sim/rand';
import type { LeagueId } from '@rcja/shared/leagues';
import type { Agent } from '../match/agent';
import { defaultSpot } from '../sim/world';
import { AGENT_PATH, AgentGateway, type RemoteTransport } from './gateway';
import { handIssuedAuthority, type Authority } from '../accounts/authority';
import type { PracticeSession } from '../league/practice';
import { WorkspaceStore } from '../accounts/workspace';
import { TeamApi } from '../accounts/team-api';
import { ArenaSupervisor, type ArenaSupervisorOptions } from '../league/arenas';
import { FidelityMeter } from './usage';
import {
  AbandonBodySchema,
  CorrectScoreBodySchema,
  KickoffBodySchema,
  PlaceBodySchema,
  RemoveRobotBodySchema,
  ResolveBodySchema,
  ReturnRobotBodySchema,
  RosterBodySchema,
  SeatActionBodySchema,
  SeatBodySchema,
} from '../api/schemas';
import { readJsonBody, validateBody } from '../api/validate';

/**
 * Per-connection data attached to every WebSocket.
 *
 * Bun's native WebSocket model uses a single `websocket` handler object on the
 * server, so per-socket state is carried here instead of on event listeners.
 *
 * - `agent`: a robot program. `transport` is null until the first (join)
 *   message arrives and is accepted; after that it holds the RemoteTransport
 *   the match's agent loop polls.
 * - `viewer`: a spectator screen. No data beyond the discriminant is needed —
 *   the viewers set tracks the sockets themselves.
 * - `proxy`: a connection being relayed to a child arena process. `upstream` is
 *   the WebSocket client side of the relay; `release` decrements the arena's
 *   open-connection count when the socket closes.
 */
type AgentWsData = { type: 'agent'; transport: RemoteTransport | null };
type ViewerWsData = { type: 'viewer' };
type ProxyWsData = { type: 'proxy'; upstream: WebSocket; release: () => void };
type WsData = AgentWsData | ViewerWsData | ProxyWsData;

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
  /**
   * Seconds of placed-but-not-live countdown before each kick-off becomes
   * play. Defaults to `KICKOFF_COUNTDOWN_SECONDS` for realtime (spectated,
   * refereed) matches and 0 for headless ones; a referee can still tell the
   * server to skip a single wait, and `--kickoff-countdown 0` disables it
   * entirely for a match that must start instantly.
   */
  kickoffCountdown?: number;
  /**
   * Built practice console to serve, on its own path.
   *
   * Only meaningful on a server started as a practice field - `cli.ts
   * practice` - and like `refereeRoot`, nothing is served without one.
   */
  practiceRoot?: string;
  /**
   * Built team-workspace bundle to serve, on its own path.
   *
   * Like `refereeRoot` and `practiceRoot`, nothing is served without one — and
   * like them, absent is the default, so a server that was not told to host
   * workspaces has no workspace surface at all.
   */
  workspaceRoot?: string;
  /**
   * Where teams' working folders live. Defaults to ./workspaces.
   *
   * Deliberately not `submissionsDir`: a workspace is whatever the student
   * last typed, including code that does not parse, and a submission is
   * something that passed the validator. Keeping them in one tree would make
   * "what would play if the match started now" unanswerable.
   */
  workspacesDir?: string;
  /**
   * Hand-issued team credentials, token to team name — the same style as
   * `refereeToken`. Empty (the default) means `/workspace-api/*` answers 404
   * for everything.
   *
   * This is the arrangement a match server on a laptop still runs on. A league
   * server passes an `authority` instead and never sets this.
   */
  workspaceTokens?: ReadonlyMap<string, string>;
  /**
   * Who is making a request, when something above this server knows better.
   *
   * Absent — the default — builds `handIssuedAuthority` from `refereeToken`
   * and `workspaceTokens` above, which is exactly the three checks this file
   * used to make inline. A league server passes one backed by accounts, and
   * that is the whole of how accounts reach a match: a function, not a
   * database, and nothing here knows which it was handed.
   */
  authority?: Authority;
  /**
   * Interface to bind. Absent binds every interface, as it always has.
   *
   * A league server runs its world on loopback and reaches it through its own
   * port, so the world is not separately exposed on the venue's network.
   */
  host?: string;
  /**
   * Let anyone with the link open a practice field on this server.
   *
   * Off unless asked for. Each field is a child process running its own
   * `MatchServer`, reached back through this one's port — see `arenas.ts`.
   */
  practiceFields?: ArenaSupervisorOptions | boolean;
  /**
   * A directory this server may keep working files in, made by whoever started
   * it.
   *
   * An arena is stopped by having its process group killed and never gets to
   * tidy up, so anything it made under `/tmp` outlives it — one dead Unix
   * socket directory per arena, for the life of the machine. A supervisor hands
   * one of these in and removes it at the ending it already hears about.
   */
  scratchDir?: string;
  /**
   * One extra surface, mounted before anything else this server routes.
   *
   * There is exactly one caller: an arena's control API, which is how the hub
   * tells a child to play a fixture and asks how it is going (`arena.ts`).
   * It is a hook rather than another `if` in `serve()` because the thing on
   * the other side of it is not a match server's business at all — a laptop
   * running `serve` has no hub, mounts nothing here, and is unchanged.
   */
  control?: (req: Request, url: string) => Response | null | Promise<Response | null>;
}

/** The one page a venue server serves for practice: open a field, or rejoin one. */
function fieldsPage(fields: { id: string; url: string; createdAt: string }[]): string {
  const rows =
    fields.length === 0
      ? '<p class="dim">No practice fields are open.</p>'
      : `<ul>${fields
          .map((f) => `<li><a href="${f.url}">${f.id}</a> <span class="dim">opened ${f.createdAt}</span></li>`)
          .join('')}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RCJA Soccer Simulation — Practice</title>
<style>
 body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
        background:#0b120e; color:#f2f5f0; font-family:"Archivo","Helvetica Neue",Arial,sans-serif; }
 main { width:min(30rem,90vw); padding:1.5rem; background:#121a15;
        border:1px solid rgba(242,245,240,.14); border-radius:10px; }
 h1 { margin:0 0 .3rem; font-size:1.2rem; }
 p { margin:.3rem 0 1rem; font-size:.85rem; }
 .dim { color:#8a978f; }
 button { font:inherit; padding:.5rem .8rem; border-radius:6px; cursor:pointer;
          border:1px solid rgba(242,245,240,.2); background:rgba(242,245,240,.06); color:inherit; }
 ul { padding-left:1.1rem; font-size:.85rem; } a { color:#6fd39a; }
</style></head><body><main>
<h1>Practice</h1>
<p class="dim">A field is yours to arrange: put your pushed robots on it, move them and the ball
where you like, and watch. Nothing here is scored or recorded, and anyone with the link can join.</p>
<button id="open">Open a practice field</button>
<div id="open-error" class="dim"></div>
<h2 style="font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#8a978f;margin:1.2rem 0 .3rem">Already open</h2>
${rows}
<script>
document.getElementById('open').addEventListener('click', async () => {
  const res = await fetch('/practice', { method: 'POST', headers: { accept: 'application/json' } });
  const payload = await res.json().catch(() => ({}));
  if (payload && payload.ok) location.href = payload.field.url;
  else document.getElementById('open-error').textContent = (payload && payload.reason) || 'could not open a field';
});
</script>
</main></body></html>`;
}

/**
 * `/a/<id>/rest` split into the arena and what to ask it for.
 *
 * `/f/<id>/` is kept as an alias and always will be: it is in the docs, in
 * `python/submit.py`'s output and in students' browser history, and a link
 * that stops working is a person standing in a hall with a dead URL.
 */
export function splitArenaPath(url: string): { id: string; rest: string } | null {
  const prefix = url.startsWith('/a/') ? '/a/' : url.startsWith('/f/') ? '/f/' : null;
  if (!prefix) return null;
  const after = url.slice(prefix.length);
  const slash = after.indexOf('/');
  if (slash <= 0) return null;
  return { id: after.slice(0, slash), rest: after.slice(slash) };
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
  private bunServer: Server<WsData> | null = null;
  private agentBunServer: Server<AgentWsData> | null = null;
  private agentSocketPath: string | null = null;
  private agentScratchDir: string | null = null;

  /** Spectator screens watching the current match. */
  private readonly viewers = new Set<ServerWebSocket<WsData>>();
  /** Where robot programs connect, on the same port as the viewers. */
  readonly agents = new AgentGateway();

  private current: Match | null = null;
  private lastResult: MatchResult | null = null;
  private lastNextMatchIn?: number;
  private readonly viewerRoot: string | null;
  private readonly refereeRoot: string | null;
  private readonly practiceRoot: string | null;
  /** The practice field this server is running, if it is one. */
  private practice: PracticeSession | null = null;
  /** The practice fields this server is hosting for other people, if it does that. */
  private readonly arenas: ArenaSupervisor | null;
  private stopped = false;
  /**
   * How much of real time this server is managing to play, lately.
   *
   * Only ever moves in the realtime loops — a headless match plays as fast as
   * it can on purpose, and measuring it against the wall would be measuring
   * the wrong thing.
   */
  private readonly fidelity = new FidelityMeter();
  private readonly authority: Authority;
  private readonly realtime: boolean;
  private readonly pythonLibDir: string | null;
  private readonly submissionsDir: string;
  private readonly workspaceRoot: string | null;
  private readonly workspaces: WorkspaceStore;
  /** A team's push and workspace doors, the same two a league server mounts. */
  private readonly teams: TeamApi;

  constructor(private readonly opts: ServerOptions = {}) {
    this.viewerRoot = opts.viewerRoot ? resolve(opts.viewerRoot) : null;
    this.refereeRoot = opts.refereeRoot ? resolve(opts.refereeRoot) : null;
    this.practiceRoot = opts.practiceRoot ? resolve(opts.practiceRoot) : null;
    this.arenas = opts.practiceFields
      ? new ArenaSupervisor({
          submissionsDir: resolve(opts.submissionsDir ?? 'submissions'),
          ...(opts.practiceFields === true ? {} : opts.practiceFields),
        })
      : null;
    this.authority =
      opts.authority ??
      handIssuedAuthority({
        refereeToken: opts.refereeToken ?? null,
        workspaceTokens: opts.workspaceTokens,
      });
    this.realtime = opts.realtime ?? true;
    this.pythonLibDir = opts.pythonLibDir ? resolve(opts.pythonLibDir) : null;
    this.submissionsDir = resolve(opts.submissionsDir ?? 'submissions');
    this.workspaceRoot = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null;
    this.workspaces = new WorkspaceStore({ dir: resolve(opts.workspacesDir ?? 'workspaces') });
    this.teams = new TeamApi({
      authority: this.authority,
      workspaces: this.workspaces,
      submissionsDir: this.submissionsDir,
      pythonLibDir: this.pythonLibDir,
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
    // Under a supervisor, inside the directory it made for this arena — so the
    // one process that outlives a killed arena is the one that removes it. On
    // its own, the system temp directory, cleaned by `close()`.
    this.agentScratchDir = await mkdtemp(join(this.opts.scratchDir ?? tmpdir(), 'rcja-agent-socket-'));
    this.agentSocketPath = join(this.agentScratchDir, 'agents.sock');

    // The agent Unix socket: same gateway, no path routing — this door only
    // ever speaks the agent protocol, so every connection is accepted as an
    // agent directly.
    this.agentBunServer = Bun.serve<AgentWsData>({
      unix: this.agentSocketPath,
      fetch(req, srv) {
        srv.upgrade(req, { data: { type: 'agent', transport: null } });
      },
      websocket: {
        message: (ws, data) => this.agentWsMessage(ws, data),
        close: (ws) => this.agentWsClose(ws),
      },
    });

    // The public TCP server: viewers, agents on /agent, and arena proxy WS.
    this.bunServer = Bun.serve<WsData>({
      port: this.opts.port ?? 8080,
      hostname: this.opts.host,
      fetch: (req, srv) => this.fetch(req, srv),
      websocket: {
        open: (ws) => this.wsOpen(ws),
        message: (ws, data) => this.wsMessage(ws, data),
        close: (ws) => this.wsClose(ws),
      },
    });

    if (this.bunServer.port === undefined) {
      throw new Error('server did not bind to a port');
    }
    return this.bunServer.port;
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
    this.stopped = true;
    this.practice?.close();
    this.arenas?.closeAll();
    this.agents.closeAll();
    for (const ws of this.viewers) { try { ws.close(); } catch {} }
    this.viewers.clear();
    this.bunServer?.stop(true);
    this.agentBunServer?.stop(true);
    if (this.agentScratchDir) await rm(this.agentScratchDir, { recursive: true, force: true }).catch(() => {});
  }

  /** Stop every practice field this server is hosting, now. */
  closeFields(): void {
    this.arenas?.closeAll();
  }

  /** How many screens are watching. */
  get watching(): number {
    return this.viewers.size;
  }

  /** Simulated seconds per wall second, or `null` until a window has closed. */
  get realtimeFidelity(): number | null {
    return this.fidelity.value;
  }

  get currentMatch(): Match | null {
    return this.current;
  }

  /** Where a validated push lands, as `<slugified team>/<robot>`. */
  get submissionsDirectory(): string {
    return this.submissionsDir;
  }

  // ── WebSocket handlers ────────────────────────────────────────────────────

  private wsOpen(ws: ServerWebSocket<WsData>): void {
    if (ws.data.type === 'viewer') {
      this.joinViewer(ws);
    } else if (ws.data.type === 'proxy') {
      // Set up the upstream→client relay. Messages that arrived before open()
      // fired are drained immediately.
      const { upstream, queue } = ws.data as ProxyWsData & { queue?: (string | Buffer)[] };
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.onmessage = (e) => { try { ws.send(e.data as string | Uint8Array); } catch {} };
        upstream.onclose = () => { try { ws.close(); } catch {} };
        upstream.onerror = () => { try { ws.close(); } catch {} };
        for (const msg of (queue ?? []).splice(0)) { try { ws.send(msg as string | Uint8Array); } catch {} }
      }
    }
  }

  private wsMessage(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
    const { type } = ws.data;
    if (type === 'proxy') {
      try { (ws.data as ProxyWsData).upstream.send(data as string); } catch {}
      return;
    }
    if (type === 'agent') {
      const d = ws.data as AgentWsData;
      if (!d.transport) {
        d.transport = this.agents.accept(ws as ServerWebSocket<unknown>, String(data));
      } else {
        d.transport.onMessage(typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    }
    // viewers never send messages
  }

  private wsClose(ws: ServerWebSocket<WsData>): void {
    const { type } = ws.data;
    if (type === 'proxy') {
      const d = ws.data as ProxyWsData;
      d.upstream.close();
      d.release();
    } else if (type === 'viewer') {
      this.viewers.delete(ws);
    } else if (type === 'agent') {
      (ws.data as AgentWsData).transport?.onClose();
    }
  }

  /** Called from the agent Unix socket server — only agent connections arrive there. */
  private agentWsMessage(ws: ServerWebSocket<AgentWsData>, data: string | Buffer): void {
    if (!ws.data.transport) {
      ws.data.transport = this.agents.accept(ws as ServerWebSocket<unknown>, String(data));
    } else {
      d_msg: {
        ws.data.transport.onMessage(typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    }
  }

  private agentWsClose(ws: ServerWebSocket<AgentWsData>): void {
    ws.data.transport?.onClose();
  }

  private joinViewer(ws: ServerWebSocket<WsData>): void {
    this.viewers.add(ws);
    // A viewer that joins at half time should see the field immediately rather
    // than a blank screen until the next frame, so bring it up to date at once.
    if (this.current) {
      this.sendToViewer(ws, {
        type: 'hello',
        league: this.current.league,
        teams: this.current.teams,
        halfSeconds: this.current.halfLength,
      });
      this.sendToViewer(ws, { type: 'frame', frame: this.current.snapshot() });
      if (this.lastResult) {
        this.sendToViewer(ws, { type: 'summary', result: this.lastResult, nextMatchIn: this.lastNextMatchIn });
      }
    }
  }

  private sendToViewer(ws: ServerWebSocket<WsData>, message: ViewMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.viewers.delete(ws);
    }
  }

  private broadcast(message: ViewMessage): void {
    if (this.viewers.size === 0) return;
    const text = JSON.stringify(message);
    for (const ws of this.viewers) {
      try {
        ws.send(text);
      } catch {
        this.viewers.delete(ws);
      }
    }
  }

  private broadcastFrame(match: Match): void {
    if (this.viewers.size === 0) return;
    this.broadcast({ type: 'frame', frame: match.snapshot() });
  }

  // ── HTTP / WebSocket fetch handler ────────────────────────────────────────

  /**
   * Bun's fetch handler — replaces the node:http request listener.
   *
   * WebSocket upgrades are handled here too, by calling `server.upgrade()`.
   * For arena proxy connections, a relay WebSocket client is opened to the
   * child process and the two sockets are bridged at the message level.
   */
  private async fetch(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url).pathname;

    // Control hook first — the only caller is arena.ts's FixtureArena.
    if (this.opts.control) {
      const controlled = await this.opts.control(req, url);
      if (controlled) return controlled;
    }

    const isWs = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

    // A practice field hosted by this server: proxy everything under its prefix.
    const arenaPath = splitArenaPath(url);
    if (arenaPath && this.arenas) {
      const port = this.arenas.portOf(arenaPath.id);
      if (port === null) return Response.json({ ok: false, reason: 'no practice field by that name' }, { status: 404 });

      if (isWs) {
        // A robot's socket holds the arena open while it is connected but is
        // not somebody *using* the field. A viewer's is: there is a person
        // watching at the other end of it.
        const presence = arenaPath.rest.split('?')[0] !== AGENT_PATH;
        const release = this.arenas.trackConnection(arenaPath.id, { presence });
        if (!release) return Response.json({ ok: false, reason: 'no practice field by that name' }, { status: 404 });
        try {
          // Application-level WebSocket relay: connect to the arena's own WS
          // server as a client and bridge messages between the two sockets.
          // A queue catches upstream messages that arrive before wsOpen fires.
          const queue: (string | Buffer)[] = [];
          const upstream = new WebSocket(`ws://127.0.0.1:${port}${arenaPath.rest}`);
          await new Promise<void>((ok, fail) => {
            upstream.onopen = () => {
              upstream.onmessage = (e) => queue.push(e.data as string);
              ok();
            };
            upstream.onerror = () => fail(new Error('upstream failed'));
          });
          const data: ProxyWsData & { queue: typeof queue } = { type: 'proxy', upstream, release, queue };
          server.upgrade(req, { data });
        } catch {
          release();
          return new Response('arena is not answering', { status: 502 });
        }
        return; // undefined = upgrade handled
      }

      // HTTP proxy: forward directly with fetch(). A console polling from a tab
      // nobody is looking at says so, and does not count as somebody being
      // here — otherwise one forgotten browser tab simply replaces the
      // forgotten laptop program this rule exists to stop.
      const release = this.arenas.trackConnection(arenaPath.id, {
        presence: new URL(req.url).searchParams.get('active') !== '0',
      });
      if (!release) return Response.json({ ok: false, reason: 'no practice field by that name' }, { status: 404 });
      try {
        const upstream = await fetch(`http://127.0.0.1:${port}${arenaPath.rest}`, {
          method: req.method,
          headers: req.headers,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        });
        release();
        return upstream;
      } catch {
        release();
        return new Response('arena is not answering', { status: 502 });
      }
    }

    // A team's own doors — pushing code and editing it — are not football and
    // are mounted rather than implemented here, so a league server with no
    // world can serve exactly the same two. See `team-api.ts`.
    const team = await this.teams.handle(req, url);
    if (team) return team;

    if (url === '/practice' && this.arenas) {
      // Opening a field is a POST; a GET here lists what is already running,
      // so a venue can see what it is hosting without a console for it.
      if (req.method === 'POST') {
        try {
          const field = await this.arenas.create({ kind: 'practice' });
          return Response.json({ ok: true, field }, { status: 201 });
        } catch (err) {
          return Response.json({ ok: false, reason: (err as Error).message }, { status: 503 });
        }
      }
      // A browser gets somewhere to click; anything else gets the list.
      // Deliberately one small inline page rather than a fourth built bundle:
      // it has one button on it, and a venue should not have to run a build
      // step before a team can open a field.
      if ((req.headers.get('accept') ?? '').includes('text/html')) {
        return new Response(fieldsPage(this.arenas.list()), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return Response.json({ ok: true, fields: this.arenas.list() });
    }

    if (url === '/practice-api/state' && req.method === 'GET') {
      if (!this.practice) {
        return Response.json({ ok: false, reason: 'this server is not a practice field' }, { status: 404 });
      }
      return Response.json({ ok: true, state: this.practice.state() });
    }
    // What one seat's program has said. Its own request rather than part of the
    // state everybody polls: a traceback is read by one person on one seat, and
    // the state is read once a second by everybody on the field.
    if (url === '/practice-api/output' && req.method === 'GET') {
      if (!this.practice) {
        return Response.json({ ok: false, reason: 'this server is not a practice field' }, { status: 404 });
      }
      const query = new URL(req.url).searchParams;
      const seat = query.get('seat');
      if (!seat || !SEAT_IDS.includes(seat as SeatId)) {
        return Response.json({ ok: false, reason: '"seat" must be a seat id' }, { status: 400 });
      }
      const since = Number(query.get('since') ?? 0);
      const output = this.practice.outputOf(seat as SeatId, Number.isFinite(since) ? since : 0);
      return Response.json({ ok: true, seat, ...output });
    }
    if (req.method === 'POST' && url.startsWith('/practice-api/')) {
      return this.handlePracticeAction(req, url.slice('/practice-api/'.length));
    }
    // The practice console, on its own path like the referee's. No token:
    // a practice field is open to whoever has the link, which is Phase 4's
    // deliberate position. Accounts exist now, but a field that *belongs* to
    // a team is Phase 8's subject - see PHASES.md.
    if (url === '/practice' || url.startsWith('/practice/')) {
      // `/practice` has to become `/practice/` before anything is served from
      // it: the console's assets are relative, so that a field reached at
      // `/a/<id>/practice/` through a hub finds them at the same place a
      // standalone one does. Without the trailing slash the browser resolves
      // them a directory too high — and behind a hub that is not a 404 but the
      // *viewer's* assets, so the page arrives looking broken rather than
      // missing. The location is relative for the same reason: an absolute
      // `/practice/` relayed through a hub sends the browser to the hub's own
      // front door instead of back to this arena.
      if (url === '/practice') {
        return new Response(null, { status: 302, headers: { location: 'practice/' } });
      }
      const sub = url.slice('/practice'.length);
      return this.serveStatic(this.practiceRoot, sub, 'no practice console built; run: bun run build:practice');
    }
    // "Does this server already know who I am?" — the one referee route that
    // reads rather than acts. A league server authenticates the console with
    // the session the person already has, so the bundle has to be able to ask
    // whether it needs to show a login at all rather than demanding a token
    // that no longer exists.
    if (url === '/referee-api/session' && req.method === 'GET') {
      if (!this.authority.refereed) {
        return Response.json({ ok: false, reason: 'referee mode is not enabled on this server' }, { status: 404 });
      }
      const allowed = await this.authority.referee(req);
      return Response.json({ ok: allowed }, { status: allowed ? 200 : 401 });
    }
    if (req.method === 'POST' && url.startsWith('/referee-api/')) {
      return this.handleRefereeAction(req, url.slice('/referee-api/'.length));
    }
    // A separate root and a separate path from the spectator bundle — never
    // one page with a referee panel bolted on. The static files themselves
    // need no auth (a login screen has to be fetchable to log in from); only
    // the actions under /referee-api do.
    // The team workspace, on its own path like the referee console's. Every
    // request under /workspace-api/ carries the team's own token; the bundle
    // itself is served to anyone, because it is a login screen until one is
    // presented.
    if (url === '/workspace' || url.startsWith('/workspace/')) {
      // Same redirect the practice console needs, for the same reason: the
      // bundle's assets are relative, so without the trailing slash the
      // browser resolves them a directory too high and the page arrives
      // unstyled and inert.
      if (url === '/workspace') {
        return new Response(null, { status: 302, headers: { location: 'workspace/' } });
      }
      const sub = url.slice('/workspace'.length);
      return this.serveStatic(
        this.workspaceRoot,
        sub,
        'no team workspace built; run: bun run build:workspace',
      );
    }
    if (url === '/referee' || url.startsWith('/referee/')) {
      // Same redirect the practice and workspace consoles need, for the same
      // reason: the console works out where its API and its socket are from
      // where it was served, and without the trailing slash that resolves a
      // directory too high — to the hub's front door rather than to the match.
      if (url === '/referee') {
        return new Response(null, { status: 302, headers: { location: 'referee/' } });
      }
      const sub = url.slice('/referee'.length);
      return this.serveStatic(this.refereeRoot, sub, 'no referee console built; run: bun run build:referee');
    }

    // WebSocket upgrades for this server's own viewers and agents.
    if (isWs) {
      const asAgent = url.split('?')[0] === AGENT_PATH;
      server.upgrade(req, { data: asAgent ? { type: 'agent', transport: null } : { type: 'viewer' } });
      return; // undefined = upgrade handled
    }

    return this.serveStatic(this.viewerRoot, url, 'no viewer built; run: bun run build:viewer');
  }

  private async serveStatic(
    root: string | null,
    url: string,
    missingMessage: string,
  ): Promise<Response> {
    if (!root) {
      return new Response(missingMessage, { status: 404 });
    }
    const wanted = url === '/' ? 'index.html' : url.slice(1);
    // Normalise before joining, so a path cannot climb out of the root.
    const file = join(root, normalize(wanted));
    if (!file.startsWith(root)) {
      return new Response('no', { status: 403 });
    }
    const f = Bun.file(file);
    if (!(await f.exists())) {
      return new Response('not found', { status: 404 });
    }
    const ct = MIME[extname(file)] ?? 'application/octet-stream';
    return new Response(f, { headers: { 'content-type': ct } });
  }

  // ── Match logic ────────────────────────────────────────────────────────────

  /**
   * Play one match, streaming it as it goes.
   *
   * The physics still steps at its own fixed rate; what changes is that the
   * loop waits for wall-clock time to catch up. Stepping in a chunk per timer
   * tick rather than one step per tick keeps the physics exact and the timer
   * cheap — a 100 Hz setInterval is not something to rely on.
   */
  async play(options: MatchOptions): Promise<MatchResult> {
    if (options.refereed && !this.authority.refereed) {
      throw new Error(
        'a refereed match needs a refereeToken configured on the server — otherwise nothing could ever kick it off',
      );
    }
    const match = new Match({
      idealSensors: this.opts.idealSensors ?? false,
      ...options,
      kickoffCountdown:
        options.kickoffCountdown ?? this.opts.kickoffCountdown ?? (this.realtime ? KICKOFF_COUNTDOWN_SECONDS : 0),
    });
    this.current = match;
    this.lastResult = null;
    this.lastNextMatchIn = undefined;
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
      this.broadcastFrame(match);
      return result;
    }

    // Programs over a socket need the event loop, and `match.run()` never
    // gives it up. See playFast.
    const remote = Object.keys(options.transports ?? {}).length > 0;

    if (!this.realtime) {
      const result = remote ? await this.playFast(match) : match.run();
      this.broadcastFrame(match);
      this.lastResult = result;
      this.lastNextMatchIn = options.nextMatchIn;
      this.broadcast({ type: 'summary', result, nextMatchIn: options.nextMatchIn });
      return result;
    }

    const dt = 1 / PHYSICS_HZ;
    const viewHz = Math.max(10, Math.min(100, this.opts.viewHz ?? VIEW_HZ));
    const framePeriod = 1000 / viewHz;

    for (const half of [1, 2] as const) {
      // A match can now end itself — the mercy rule — so this loop has to ask
      // the same question `playRefereed` always has. It never did, because
      // until now only a referee could end one early and a referee only ever
      // drove the refereed loop.
      if (match.isEnded) break;
      match.world.half = half;
      match.world.kickOff(half === 1 ? 'violet' : 'lime');
      match.resetAgents();
      // The kick-off is placed but not live while its countdown runs: the
      // whistle inside `step` starts the clock. Headless matches (no
      // countdown) start exactly as before.
      if (!match.world.countdownActive) match.world.running = true;

      const until = match.world.clock + match.halfLength;
      let owed = 0;
      let last = Date.now();

      while (match.world.clock < until && !match.isEnded) {
        await sleep(framePeriod);
        const now = Date.now();
        const wall = (now - last) / 1000;
        owed += wall;
        last = now;
        // Never try to make up more than a moment: if the process was starved,
        // catching up by simulating a second of football at once would be worse
        // than dropping it.
        owed = Math.min(owed, 0.25);
        const was = match.world.clock;
        while (owed >= dt && match.world.clock < until) {
          match.step(dt);
          owed -= dt;
        }
        // Wall-clock spent against football played. Only while the world is
        // actually running: a kick-off countdown is time a spectator expects
        // to stand still, and counting it would read as the machine falling
        // behind when it is doing exactly what it was told.
        if (match.world.running) this.fidelity.advance(match.world.clock - was, wall);
        this.broadcastFrame(match);
      }
      match.world.running = false;
      this.broadcastFrame(match);
    }

    const res = match.result();
    this.lastResult = res;
    this.lastNextMatchIn = options.nextMatchIn;
    this.broadcast({ type: 'summary', result: res, nextMatchIn: options.nextMatchIn });
    return res;
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
      if (match.isEnded) break;
      match.world.half = half;
      match.world.kickOff(half === 1 ? 'violet' : 'lime');
      match.resetAgents();
      if (!match.world.countdownActive) match.world.running = true;
      const until = match.world.clock + match.halfLength;
      while (match.world.clock < until && !match.isEnded) {
        for (let i = 0; i < perControl && match.world.clock < until && !match.isEnded; i++) {
          match.step(dt);
        }
        await sleep(0);
      }
      match.world.running = false;
    }
    const res = match.result();
    this.lastResult = res;
    this.broadcast({ type: 'summary', result: res });
    return res;
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

        let refereedWall = 0;
        if (this.realtime) {
          await sleep(framePeriod);
          const now = Date.now();
          refereedWall = (now - last) / 1000;
          owed += refereedWall;
          last = now;
          // Same starvation guard as the self-running loop: never try to make
          // up more than a moment of missed wall-clock time at once.
          owed = Math.min(owed, 0.25);
        } else {
          await sleep(0);
          owed = dt * perControl;
        }

        // Stepping while a kick-off counts down is what makes the whistle
        // audible: the countdown advances inside `step`. A pause freezes it
        // (paused = countdown stopped, clock stopped), so the gate has to
        // let an UNpaused countdown step even though play has not started.
        const was = match.world.clock;
        if (match.world.running || (match.world.countdownActive && !match.world.paused)) {
          while (owed >= dt && match.world.clock < until) {
            match.step(dt);
            owed -= dt;
          }
        } else {
          // Stopped, but not silent. The seats are still polled so a program
          // waiting for a referee keeps hearing from the server — ten seconds
          // of nothing is what a client reads as a dead server, and a referee
          // reaching the console takes longer than that. Nothing moves: the
          // clock, the ball and every rule detector stay exactly where the
          // whistle left them, and the commands that come back are discarded.
          match.poll(Math.min(owed, dt * perControl));
          owed = 0;
        }
        // Only live play counts: a referee who has paused for two minutes to
        // talk to a team has not made this machine slow.
        if (this.realtime && match.world.running) {
          this.fidelity.advance(match.world.clock - was, refereedWall);
        }
        this.broadcastFrame(match);
      }
      match.world.running = false;
      this.broadcastFrame(match);
      if (match.isEnded) break;
      // The break between the halves, which this loop has always left and
      // never named. Only after the first, and only for a match that did not
      // end in it: `endMatch`, `abandon` and the mercy rule all come through
      // `isEnded` above, and none of them has a second half to wait for.
      if (half === 1) {
        match.beginHalfTime();
        this.broadcastFrame(match);
      }
    }

    const res = match.result();
    this.lastResult = res;
    this.broadcast({ type: 'summary', result: res });
    return res;
  }

  /**
   * A field to look at, and to wait on, while nothing is being played.
   *
   * A match server used to do nothing at all between matches: `play()` built a
   * world, and until it was called there was none — so `--agents` sat on
   * `whenReady()` with the viewer showing an empty page, and a team starting
   * their four programs had no way to tell which had arrived. Worse, a program
   * that *had* connected heard nothing, and a program that hears nothing for
   * ten seconds decides the server has gone.
   *
   * So there is always a world. It is staged at the kick-off marks and never
   * stepped — no clock, no ball, no rules — and a seat with no program simply
   * has no robot on the field. Robots appear at their marks as their programs
   * connect, which is the one thing somebody standing at a laptop wants to
   * know, and every seat that is connected is polled, which is what keeps it
   * connected.
   *
   * Returns when `until` says so; the caller then plays a real match.
   */
  async lobby(opts: {
    teams: { violet: string; lime: string };
    seed: SeedInput;
    /**
     * The league whose field this is.
     *
     * A lobby is a field somebody stands their robot on and looks at, so it
     * has to be the field the match will be played on — a fixture arena waits
     * in one before kicking off, and a pre-game pitch of the wrong size is a
     * rehearsal in the wrong sport.
     */
    league?: LeagueId;
    until: () => boolean;
  }): Promise<void> {
    if (opts.until()) return;

    // A seat has to have *something* in it or the constructor objects — a
    // robot on the field with no program is an error there, and rightly. These
    // stand in until the real programs arrive, and they are never acted on:
    // the lobby only ever polls, and a poll discards what it collects.
    const waiting: Record<string, Agent> = {};
    for (const id of SEAT_IDS) waiting[id] = { name: id, tick: () => null };

    const match = new Match({
      agents: waiting,
      teams: opts.teams,
      league: opts.league,
      halfSeconds: 300,
      seed: opts.seed,
      idealSensors: this.opts.idealSensors ?? false,
    });
    this.current = match;
    this.lastResult = null;
    // Nobody is serving a sanction in a lobby; there is no match to be sent
    // off from. A program that reconnects simply takes its seat again.
    this.agents.standDown = () => 0;
    this.broadcast({
      type: 'hello',
      league: match.league,
      teams: match.teams,
      halfSeconds: match.halfLength,
    });

    const dt = 1 / PHYSICS_HZ;
    const perControl = Math.max(1, Math.round(PHYSICS_HZ / CONTROL_HZ));
    const framePeriod = 1000 / Math.max(10, Math.min(100, this.opts.viewHz ?? VIEW_HZ));
    // Not '' — that is what "nobody is here" looks like, and the first pass
    // has to stage even when the answer is nobody: a `Match` is born with all
    // four robots on their marks, and until they are taken off the field shows
    // four robots that have not arrived.
    let seated = '\u0000';

    while (!opts.until()) {
      await sleep(framePeriod);

      // Re-stage only when the answer to "who is here" changes. `kickOff` puts
      // all four back on their marks, and whoever has no program is taken off
      // again — so the field always shows exactly the robots that have arrived.
      const live = this.agents.transports();
      const here = SEAT_IDS.filter((id) => live[id]?.connected !== false && live[id]);
      const key = here.join(',');
      if (key !== seated) {
        seated = key;
        // Staged rather than taken off one at a time: `stage` sets the roster
        // to exactly these ids and puts a robot back on the field for any that
        // is missing, which `takeOff` on its own cannot do — it shrinks the
        // roster, so a robot taken off never comes back.
        for (const id of here) match.setSeat(id, live[id]!);
        match.world.stage({
          robots: here.map((id) => ({ ...defaultSpot(id), id, isGoalie: id.endsWith('-2') })),
          ball: { x: 0, z: 0 },
        });
        match.world.running = false;
      }

      match.poll(dt * perControl);
      this.broadcastFrame(match);
    }
  }

  /**
   * Run a practice field for as long as the server is up.
   *
   * Every other loop in this file is playing a match towards an end: two
   * halves, a time budget, a result. This one has no end at all, because a
   * practice field is a room rather than a fixture - it steps when whoever is
   * in it says to, holds still when they stop it, and the arrangement, the
   * roster and the programs all change underneath it while it runs. Nothing
   * is returned because nothing is recorded: no fixture, no table, no match
   * record. That is the phase's own rule, not an omission.
   */
  async practise(session: PracticeSession): Promise<void> {
    this.practice = session;
    this.current = session.match;
    // No stand-down on a practice field: a team restarting their own program
    // is not serving a sanction, and a seat that refused the reconnect would
    // just look broken. `PracticeSession.syncSeats` puts the robot back on.
    this.agents.standDown = () => 0;
    this.broadcast({
      type: 'hello',
      league: session.match.league,
      teams: session.match.teams,
      halfSeconds: session.match.halfLength,
    });

    const dt = 1 / PHYSICS_HZ;
    const viewHz = Math.max(10, Math.min(100, this.opts.viewHz ?? VIEW_HZ));
    const framePeriod = 1000 / viewHz;
    let owed = 0;
    let last = Date.now();

    while (!this.stopped) {
      await sleep(framePeriod);
      const now = Date.now();
      const wall = (now - last) / 1000;
      owed += wall;
      last = now;
      // Same starvation guard as the match loops: never make up more than a
      // moment at once.
      owed = Math.min(owed, 0.25);

      session.syncSeats();

      if (session.match.world.running) {
        const was = session.match.world.clock;
        while (owed >= dt) {
          session.match.step(dt);
          owed -= dt;
        }
        this.fidelity.advance(session.match.world.clock - was, wall);
      } else {
        // Stopped is stopped: a field held still for a minute while somebody
        // arranges it must not then play that minute in one frame. But it is
        // not silent either — a practice field spends most of its life stopped
        // while somebody drags robots around, and a seat that hears nothing
        // for ten seconds drops and reconnects for as long as that lasts.
        session.match.poll(Math.min(owed, wall));
        owed = 0;
      }
      this.broadcastFrame(session.match);
    }
  }

  // ── HTTP action handlers ─────────────────────────────────────────────────

  /**
   * One action on the practice field, from whoever has the link.
   *
   * Unauthenticated on purpose, and only reachable at all on a server that is
   * a practice field: `this.practice` is null on a match server, so every one
   * of these answers 404 there. Nothing a match does grows a new door.
   */
  private async handlePracticeAction(req: Request, action: string): Promise<Response> {
    const session = this.practice;
    if (!session) {
      return Response.json({ ok: false, reason: 'this server is not a practice field' }, { status: 404 });
    }

    const body = await readJsonBody(req, 4096);
    if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });

    switch (action) {
      case 'start':
        session.start();
        break;
      case 'stop':
        session.stop();
        break;
      case 'restage':
        session.restage();
        break;
      case 'keep':
        session.keepAsArranged();
        break;
      case 'place': {
        const validated = validateBody(
          body.payload,
          PlaceBodySchema,
          '"target" must be "ball" or a seat id, with numeric "x" and "z"',
        );
        if (!validated.ok) return validated.response;
        const { target, x, z, heading, vx, vz } = validated.value;
        session.place(target, { x, z, heading, vx, vz });
        break;
      }
      case 'roster': {
        const validated = validateBody(
          body.payload,
          RosterBodySchema,
          '"seat" and boolean "onField" are required',
        );
        if (!validated.ok) return validated.response;
        session.setRoster(validated.value.seat, validated.value.onField);
        break;
      }
      case 'resolve': {
        const validated = validateBody(
          body.payload,
          ResolveBodySchema,
          '"mode" must be "restage", "play-on" or "freeze"',
        );
        if (!validated.ok) return validated.response;
        session.setResolve(validated.value.mode);
        break;
      }
      case 'seat': {
        const validated = validateBody(
          body.payload,
          SeatBodySchema,
          (path) =>
            path === 'seat'
              ? '"seat" must be a seat id'
              : path.startsWith('fill.')
                ? '"team" is required for a submission'
                : '"fill" must be "empty", "built-in", "laptop" or "submission"',
        );
        if (!validated.ok) return validated.response;
        await session.setSeat(validated.value.seat, validated.value.fill);
        break;
      }
      case 'seat-restart': {
        const validated = validateBody(body.payload, SeatActionBodySchema, '"seat" must be a seat id');
        if (!validated.ok) return validated.response;
        await session.restartSeat(validated.value.seat);
        break;
      }
      case 'seat-stop': {
        const validated = validateBody(body.payload, SeatActionBodySchema, '"seat" must be a seat id');
        if (!validated.ok) return validated.response;
        session.stopSeat(validated.value.seat);
        break;
      }
      default:
        return Response.json({ ok: false, reason: `unknown practice action "${action}"` }, { status: 404 });
    }

    return Response.json({ ok: true, state: session.state() });
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
  private async handleRefereeAction(req: Request, action: string): Promise<Response> {
    if (!this.authority.refereed) {
      return Response.json({ ok: false, reason: 'referee mode is not enabled on this server' }, { status: 404 });
    }
    if (!(await this.authority.referee(req))) {
      return Response.json({ ok: false, reason: 'invalid or missing referee token' }, { status: 401 });
    }
    const match = this.current;
    if (!match || !match.refereed) {
      return Response.json({ ok: false, reason: 'no refereed match in progress' }, { status: 409 });
    }

    const body = await readJsonBody(req, 4096);
    if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });

    switch (action) {
      case 'kickoff': {
        const validated = validateBody(body.payload, KickoffBodySchema, '"team" must be "violet" or "lime"');
        if (!validated.ok) return validated.response;
        // Half-time holds the second half's whistle until both teams say they
        // are ready, and lets go by itself when the clock runs out — so this
        // can refuse a referee, but only for as long as half-time lasts. The
        // gate is here rather than inside `Match.kickOff` so that the
        // self-driving loops and every restart after a goal are untouched.
        const holds = match.halfTimeHolds();
        if (holds) return Response.json({ ok: false, reason: holds }, { status: 409 });
        match.kickOff(validated.value.team);
        // Whatever half-time was left is spent: the football has restarted.
        match.endHalfTime();
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
      case 'skip-kickoff-countdown':
        match.skipKickoffCountdown();
        break;
      case 'end-half':
        match.endHalf();
        break;
      case 'end-match':
        match.endMatch();
        break;
      case 'abandon': {
        const validated = validateBody(body.payload, AbandonBodySchema, '"reason" is required');
        if (!validated.ok) return validated.response;
        match.abandon(validated.value.reason);
        break;
      }
      case 'remove-robot': {
        const validated = validateBody(
          body.payload,
          RemoveRobotBodySchema,
          '"robotId", "rule" and "reason" are required strings',
        );
        if (!validated.ok) return validated.response;
        match.removeRobot(validated.value.robotId, validated.value.rule, validated.value.reason);
        break;
      }
      case 'return-robot': {
        const validated = validateBody(body.payload, ReturnRobotBodySchema, '"robotId" is required');
        if (!validated.ok) return validated.response;
        if (!match.returnRobot(validated.value.robotId)) {
          return Response.json({ ok: false, reason: 'robot is not ready to return yet' }, { status: 409 });
        }
        break;
      }
      case 'correct-score': {
        const validated = validateBody(
          body.payload,
          CorrectScoreBodySchema,
          (path) =>
            path === 'team'
              ? '"team" must be "violet" or "lime"'
              : '"to" (number) and "reason" (string) are required',
        );
        if (!validated.ok) return validated.response;
        try {
          match.correctScore(validated.value.team, validated.value.to, validated.value.reason);
        } catch (err) {
          return Response.json({ ok: false, reason: (err as Error).message }, { status: 400 });
        }
        break;
      }
      default:
        return Response.json({ ok: false, reason: `unknown referee action "${action}"` }, { status: 404 });
    }

    return Response.json({ ok: true });
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}
