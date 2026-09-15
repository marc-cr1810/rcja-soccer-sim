/**
 * The front door.
 *
 * A **match server** is what a team runs on a laptop: one process, one world,
 * no accounts, no front page, nothing to log into. A **league server** is the
 * tournament deployment — it owns accounts, the draw, the schedule and the
 * public pages, and **it plays no football at all**.
 *
 * That last part is this phase's whole subject. One `MatchServer` is one world,
 * one viewer broadcast, one gateway over four fixed seat ids, so a hub that
 * held its own could only ever play one fixture at a time. Every world is now
 * a child process — an **arena** — supervised here and proxied under
 * `/a/<id>/`, which is the same answer `arenas.ts` has given for practice
 * fields since Phase 4, applied to fixtures.
 *
 * Two properties are worth stating up front, because everything else follows
 * from them:
 *
 * **Watching is open.** The front page, the schedule, the table, a match's
 * record and the live viewer need no account at all. That is Phase 2's
 * position — the viewer stream is untrusted by design — and nothing here
 * weakens it. Only entering, refereeing or administering needs a login.
 *
 * **Accounts sit above the world, never inside it.** An arena is handed an
 * `Authority` and nothing else; it has never heard of a session or a database.
 * A referee's console is the ordinary Phase 2 one, and the hub is what decides
 * — from a session and a capability — that this person may control this match,
 * replacing their browser's credential with the arena's own on the way
 * through. That is the one place the hub stops being a transparent proxy, and
 * it is deliberate: the capability check has to live above the children,
 * because a child can only ever see its own world.
 *
 * **A team's two doors are not football.** Pushing code and editing it in a
 * browser are mounted here directly (`team-api.ts`) — the same handlers a
 * match server mounts, so a workspace push and a `python/submit.py` push stay
 * one way in rather than two.
 */

import type { Server } from 'bun';
import { extname, join, normalize, resolve } from 'node:path';

import { splitArenaPath, type ServerOptions } from './server';
import { ArenaSupervisor } from './arenas';
import { TeamApi } from './team-api';
import { WorkspaceStore } from './workspace';
import type { PlayRequest, PlayedMatch, ArenaState } from './arena';
import { defaultSettings, type LeagueSettings, type SettingSource } from './settings';
import { readMachine, resolveBudget, type Budget, type Machine } from './capacity';
import { totalUsage } from './usage';
import { Accounts, type Account } from './accounts';
import { can, GUEST, type Actor, type Capability } from './capabilities';
import { bearer, type Authority, type AuthRequest, type Submitter } from './authority';
import { slugifyTeam } from './manifest';
import {
  deriveTable,
  fixtureOutcome,
  nextFixture,
  type Draw,
  type Fixture,
  type FixtureResult,
} from './tournament';
import { loadDraw, loadResults } from './tournament-store';
import { handleDocs } from './api/docs';
import {
  CreateInviteBodySchema,
  CreateKeyBodySchema,
  LoginBodySchema,
  RegisterBodySchema,
  ResetPasswordBodySchema,
  SetDisabledBodySchema,
} from './api/schemas';
import { readJsonBody, validateBody } from './api/validate';

const SESSION_COOKIE = 'rcja_session';

/**
 * How often the hub asks an arena how its match is going.
 *
 * A second is slow for a scoreboard and fast for a poll; the viewer a
 * spectator actually watches is a 30 Hz socket straight to the arena, and this
 * only feeds the front page's cards and the "has it finished" question.
 */
const POLL_MS = 1_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

export interface LeagueOptions {
  port?: number;
  host?: string;
  dataDir: string;
  tournamentsDir?: string;
  tournamentId?: string | null;
  siteRoot?: string | null;
  /**
   * What an arena is started with. The hub keeps the team-facing pieces of
   * this — workspaces, submissions, the python library — and never opens a
   * world of its own.
   */
  world: Omit<ServerOptions, 'port' | 'host' | 'authority'>;
  /**
   * What the venue has turned: the arena ceiling, the seat grants, the
   * practice caps. Defaults when absent, which is what a test wants.
   *
   * The *budget* is not passed in, only the settings — this server resolves it
   * against its own hardware, so there is one answer to "how many arenas may
   * run here" rather than one per caller.
   */
  settings?: LeagueSettings;
  /** Where each setting came from, for a console that has to explain itself. */
  settingSources?: Record<string, SettingSource>;
  log?: (line: string) => void;
}

/**
 * What the front page shows in its "now playing" band — one per live fixture.
 *
 * There can be several now, which is the point of the phase. Each carries the
 * arena playing it, because "watch this" is a link to a child process and the
 * front page has no other way to know which.
 */
export interface LiveFixture {
  fixtureId: string;
  /** The child process playing it. */
  arenaId: string;
  /** Where a spectator watches it, relative to the hub's root. */
  url: string;
  home: string;
  away: string;
  score: { violet: number; lime: number };
  clock: number;
  half: 1 | 2;
  running: boolean;
  /** Simulated seconds per wall second, or `null` before a window closed. */
  fidelity: number | null;
}

/** A fixture in progress: which arena holds it, and what it last said. */
interface LiveArena {
  fixture: Fixture;
  arenaId: string;
  state: ArenaState | null;
}

interface LeagueWsData {
  type: 'relay';
  upstream: WebSocket;
  queue?: (string | Buffer)[];
}

export class LeagueServer {
  readonly accounts: Accounts;
  /** Every world this venue is running. The hub itself runs none. */
  readonly arenas: ArenaSupervisor;

  private bunServer: Server<LeagueWsData> | null = null;
  private readonly siteRoot: string | null;
  private readonly workspaceRoot: string | null;
  private readonly log: (line: string) => void;
  private readonly authority: Authority;
  private readonly teams: TeamApi;
  private readonly settings: LeagueSettings;
  private readonly machine: Machine;
  /** What this machine can hold, resolved once from the settings and the hardware. */
  readonly budget: Budget;
  /** Fixtures in progress, by fixture id. Set by whoever is running the draw. */
  private readonly liveFixtures = new Map<string, LiveArena>();

  constructor(private readonly opts: LeagueOptions) {
    this.log = opts.log ?? (() => {});
    this.siteRoot = opts.siteRoot ? resolve(opts.siteRoot) : null;
    this.workspaceRoot = opts.world.workspaceRoot ? resolve(opts.world.workspaceRoot) : null;
    this.accounts = new Accounts({ file: join(resolve(opts.dataDir), 'league.db') });
    this.authority = accountsAuthority(this.accounts);
    this.settings = opts.settings ?? defaultSettings();
    this.machine = readMachine();
    this.budget = resolveBudget(this.settings, this.machine);
    this.teams = new TeamApi({
      authority: this.authority,
      workspaces: new WorkspaceStore({ dir: resolve(opts.world.workspacesDir ?? 'workspaces') }),
      submissionsDir: resolve(opts.world.submissionsDir ?? 'submissions'),
      pythonLibDir: opts.world.pythonLibDir ? resolve(opts.world.pythonLibDir) : null,
    });
    this.arenas = new ArenaSupervisor({
      submissionsDir: resolve(opts.world.submissionsDir ?? 'submissions'),
      maxArenas: this.budget.max,
      fixtureSlots: this.budget.fixtures,
      seatCpuPercent: this.settings.arenas.seatCpuPercent,
      seatMemoryMb: this.settings.arenas.seatMemoryMb,
      idleMinutes: this.settings.practice.idleMins,
      log: (line) => this.log(line),
    });
  }

  async listen(): Promise<number> {
    this.bunServer = Bun.serve<LeagueWsData>({
      port: this.opts.port ?? 8080,
      hostname: this.opts.host,
      fetch: (req, srv) => this.fetch(req, srv),
      websocket: {
        open: (ws) => {
          const { upstream, queue } = ws.data;
          upstream.onmessage = (e) => {
            try { ws.send(e.data as string | Uint8Array); } catch {}
          };
          upstream.onclose = () => {
            try { ws.close(); } catch {}
          };
          upstream.onerror = () => {
            try { ws.close(); } catch {}
          };
          for (const msg of (queue ?? []).splice(0)) {
            try { ws.send(msg as string | Uint8Array); } catch {}
          }
        },
        message: (ws, data) => {
          try { ws.data.upstream.send(data as string); } catch {}
        },
        close: (ws) => {
          try { ws.data.upstream.close(); } catch {}
        },
      },
    });

    if (this.bunServer.port === undefined) {
      throw new Error('league server did not bind to a port');
    }
    return this.bunServer.port;
  }

  async close(): Promise<void> {
    this.bunServer?.stop(true);
    // Every arena dies with the hub, which is the honest thing: a child holds a
    // physics loop and four sandboxed interpreters, and there is nothing to
    // resume it from. A fixture interrupted this way wrote no result and simply
    // replays.
    this.arenas.closeAll();
    this.accounts.close();
  }

  // ------------------------------------------------------------------ fixtures

  /**
   * Start an arena for a fixture and remember that it is the one playing it.
   *
   * The draw runner calls this, because it is the only thing that knows what is
   * due. Nothing about it is persisted, deliberately: an arena dies with the
   * process that holds it, and a fixture interrupted that way writes no result
   * and is simply replayed — which is what Phase 3 already guarantees.
   */
  async openFixture(fixture: Fixture): Promise<string> {
    const arena = await this.arenas.create({ kind: 'fixture' });
    this.liveFixtures.set(fixture.id, { fixture, arenaId: arena.id, state: null });
    this.log(`[fixture ${fixture.id}] ${fixture.home} v ${fixture.away} in arena ${arena.id}`);
    return arena.id;
  }

  /** Stop a fixture's arena and take it off the front page. */
  closeFixture(fixtureId: string): void {
    const live = this.liveFixtures.get(fixtureId);
    if (!live) return;
    this.arenas.close(live.arenaId);
    this.liveFixtures.delete(fixtureId);
  }

  /**
   * Play one leg in a fixture's arena, and answer when it has finished.
   *
   * Starting is a request and finishing is a poll — an HTTP request held open
   * across a ten-minute match is a socket that has to survive a hall's network
   * and a proxy's idea of a timeout. The poll is wanted anyway: the score on
   * the front page is the same answer, which is why it is kept here rather than
   * fetched again by whoever is watching.
   */
  async playLeg(fixtureId: string, request: PlayRequest): Promise<PlayedMatch> {
    const live = this.liveFixtures.get(fixtureId);
    if (!live) throw new Error(`no arena is open for fixture ${fixtureId}`);
    const port = this.arenas.portOf(live.arenaId);
    if (port === null) throw new Error(`arena ${live.arenaId} is not running`);

    const started = await fetch(`http://127.0.0.1:${port}/arena-api/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!started.ok) {
      throw new Error(`the arena would not start the match (${started.status})`);
    }

    for (;;) {
      await new Promise((done) => setTimeout(done, POLL_MS));
      // An arena that has gone is a fixture that did not finish. Saying so is
      // what lets the draw runner leave it unwritten and replay it, rather than
      // waiting for a process that is never going to answer.
      if (this.arenas.portOf(live.arenaId) === null) {
        throw new Error('the arena stopped before the match finished');
      }

      let state: ArenaState;
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
        const payload = (await answer.json()) as { state: ArenaState };
        state = payload.state;
      } catch {
        continue; // A missed poll is not a failed match.
      }

      live.state = state;
      this.arenas.reportFidelity(live.arenaId, state.fidelity);
      if (state.error) throw new Error(state.error);
      if (state.finished) return state.finished;
    }
  }

  /** Everything in progress right now, as the front page wants it. */
  get live(): LiveFixture[] {
    return [...this.liveFixtures.values()].map(({ fixture, arenaId, state }) => ({
      fixtureId: fixture.id,
      arenaId,
      url: `/a/${arenaId}/`,
      home: fixture.home,
      away: fixture.away,
      score: state?.score ?? { violet: 0, lime: 0 },
      clock: state?.clock ?? 0,
      half: state?.half ?? 1,
      running: state?.running ?? false,
      fidelity: state?.fidelity ?? null,
    }));
  }

  /** The one playing this fixture, if one is. */
  liveFor(fixtureId: string): LiveFixture | null {
    return this.live.find((one) => one.fixtureId === fixtureId) ?? null;
  }

  // ------------------------------------------------------------------ routing

  private async fetch(req: Request, server: Server<LeagueWsData>): Promise<Response | undefined> {
    const url = new URL(req.url).pathname;
    const isWs = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

    if (isWs) {
      // Both of an arena's doors — a spectator's viewer stream and a robot's
      // `/agent` — are passed straight through. Watching is open, and a join
      // is authenticated by the seat's own token, which is not an account
      // credential and never was.
      const forArena = splitArenaPath(url);
      if (!forArena) return new Response('no world at that address', { status: 404 });
      const port = this.arenas.portOf(forArena.id);
      if (port === null) return new Response('no arena by that name', { status: 404 });
      const path = forArena.rest;
      try {
        const queue: (string | Buffer)[] = [];
        const upstream = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        await new Promise<void>((ok, fail) => {
          upstream.onopen = () => {
            upstream.onmessage = (e) => queue.push(e.data as string);
            ok();
          };
          upstream.onerror = () => fail(new Error('upstream failed'));
        });
        server.upgrade(req, { data: { type: 'relay', upstream, queue } });
        return;
      } catch {
        return new Response('the match server is not answering', { status: 502 });
      }
    }

    const actor = await this.actorFor(req);

    try {
      if (url.startsWith('/auth/')) return await this.handleAuth(req, url.slice('/auth/'.length));
      if (url.startsWith('/api/')) return await this.handleApi(req, url, actor);

      // An arena: a world running in a child process. Watching is open, so
      // the viewer and its stream pass straight through; the referee's console
      // is the one thing gated, below.
      const forArena = splitArenaPath(url);
      if (forArena) return this.toArena(req, forArena.id, forArena.rest, actor);

      // A practice field, for whoever may open one.
      //
      // Who a field *belongs* to — who may drag whose robot, what a second Run
      // does, what happens to one that is abandoned — is Phase 8's whole
      // subject. What is settled here is only the capability that already
      // exists: a guest may not open one, and everybody with an account may.
      if (url === '/practice') {
        if (!can(actor, 'field.open')) return this.refuse(req, actor, '/practice');
        if (req.method === 'POST') {
          if (!this.settings.practice.open) {
            return Response.json(
              { ok: false, reason: 'practice is closed on this server' },
              { status: 503 },
            );
          }
          try {
            const field = await this.arenas.create({ kind: 'practice', owner: actor.slug });
            return Response.json({ ok: true, field }, { status: 201 });
          } catch (err) {
            // A venue at its ceiling says so rather than quietly slowing to a
            // crawl. Phase 8 turns this into a queue position.
            return Response.json({ ok: false, reason: (err as Error).message }, { status: 503 });
          }
        }
        return Response.json(
          { ok: true, fields: this.arenas.list().filter((one) => one.kind === 'practice') },
          { status: 200 },
        );
      }

      // `/live` used to be the one world's viewer. There can be several now,
      // so it is a page listing them — and when exactly one is playing it goes
      // straight there, because that is what a bookmark meant.
      if (url === '/live' || url === '/live/') {
        const live = this.live;
        if (live.length === 1) return Response.redirect(live[0]!.url, 302);
      }

      // A team's own doors, served here rather than proxied: pushing code and
      // editing it are not football, and the hub holds no world to forward
      // them to. Same handlers a match server mounts — one way in, not two.
      if (url === '/submit' || url.startsWith('/workspace-api/')) {
        if (url.startsWith('/workspace-api/') && !can(actor, 'team.workspace.write', actor.slug ?? undefined)) {
          return this.refuse(req, actor, '/workspace/');
        }
        const handled = await this.teams.handle(req, url);
        if (handled) return handled;
      }
      // Gating the *static files* too: on a match server the bundle has to be
      // fetchable because it is a login screen, and on a league server the
      // login screen is the site's, so a spectator never downloads
      // match-control code at all. Phase 2's rule, kept as a server rule.
      if (url === '/workspace' || url.startsWith('/workspace/')) {
        if (!can(actor, 'team.workspace.write', actor.slug ?? undefined)) {
          return this.refuse(req, actor, '/workspace/');
        }
        if (url === '/workspace') return Response.redirect('/workspace/', 302);
        return this.serveBundle(this.workspaceRoot, url.slice('/workspace'.length), 'workspace');
      }
      // The console itself lives on the arena playing the match — there is no
      // single one any more. What is here is the list of matches this person
      // may take, which Phase 9 replaces with their actual assignments.
      if (url === '/referee' || url.startsWith('/referee/')) {
        if (!can(actor, 'match.control')) return this.refuse(req, actor, '/referee/');
      }
      if (url === '/admin' || url.startsWith('/admin/')) {
        if (!can(actor, 'account.manage')) return this.refuse(req, actor, '/admin');
      }
      if (url === '/team' || url.startsWith('/team/')) {
        if (actor.role === 'guest') return this.refuse(req, actor, '/team');
      }

      return await this.site(url);
    } catch (error) {
      this.log(`[league] ${(error as Error).message}`);
      return Response.json({ ok: false, reason: 'something went wrong' }, { status: 500 });
    }
  }

  /**
   * A refusal a person can act on.
   *
   * A browser asking for a page is sent to the login screen with where it was
   * going, because "403" on a blank page twenty minutes before a match is not
   * information. Anything else — a fetch, a script, a bundle — gets the status
   * code, because a redirect to HTML would arrive as a parse error.
   */
  private refuse(req: Request, actor: Actor, wanted: string): Response {
    const wantsPage = (req.headers.get('accept') ?? '').includes('text/html');
    if (wantsPage && actor.role === 'guest') {
      return Response.redirect(`/login?next=${encodeURIComponent(wanted)}`, 302);
    }
    if (wantsPage) {
      return Response.redirect('/?denied=1', 302);
    }
    return Response.json(
      {
        ok: false,
        reason: actor.role === 'guest' ? 'log in first' : 'your account may not do that',
      },
      { status: actor.role === 'guest' ? 401 : 403 },
    );
  }

  /**
   * Forward one request to an arena.
   *
   * Transparent for everything a spectator does, and deliberately not for one
   * thing: a referee's actions. The hub has already decided, from a session and
   * a capability, that this person may control this match; the child has never
   * heard of either and holds its console to a token only the hub knows. So the
   * browser's credential is replaced on the way through. The check has to live
   * here because a child can only see its own world — get it wrong and every
   * arena looks correct on its own.
   */
  private async toArena(req: Request, id: string, rest: string, actor: Actor): Promise<Response> {
    const port = this.arenas.portOf(id);
    if (port === null) return new Response('no arena by that name', { status: 404 });

    const headers = new Headers(req.headers);
    if (rest === '/referee' || rest.startsWith('/referee/') || rest.startsWith('/referee-api/')) {
      if (!can(actor, 'match.control')) return this.refuse(req, actor, `/a/${id}/referee/`);
      const token = this.arenas.refereeTokenOf(id);
      if (token) headers.set('authorization', `Bearer ${token}`);
    }

    const release = this.arenas.trackConnection(id);
    try {
      return await fetch(`http://127.0.0.1:${port}${rest}`, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        // Relayed, not followed. A child's redirect is advice to the *browser*
        // about where it is — following it here would leave the browser on the
        // address it asked for, and a console served at `/a/<id>/referee`
        // resolves its relative assets one directory too high, arriving with
        // the viewer's stylesheet and no explanation.
        redirect: 'manual',
      });
    } catch {
      return new Response('the arena is not answering', { status: 502 });
    } finally {
      release?.();
    }
  }

  /** One of the built bundles this hub serves itself. */
  private async serveBundle(root: string | null, sub: string, name: string): Promise<Response> {
    if (!root) {
      return new Response(`no ${name} built; run: bun run build:${name}`, { status: 503 });
    }
    const wanted = normalize(sub === '' || sub === '/' ? '/index.html' : sub);
    if (wanted.includes('..')) return new Response('no', { status: 403 });
    const file = Bun.file(join(root, wanted));
    if (!(await file.exists())) {
      // A built bundle is client-routed: anything it does not have a file for
      // is one of its own pages, and index.html is what answers.
      return new Response(Bun.file(join(root, 'index.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(file, {
      headers: { 'content-type': MIME[extname(wanted)] ?? 'application/octet-stream' },
    });
  }

  // --------------------------------------------------------------------- auth

  private async actorFor(req: Request): Promise<Actor> {
    const account = this.accountFor(req);
    return account ? this.accounts.actorFor(account) : GUEST;
  }

  private accountFor(req: Request): Account | null {
    const token = cookie(req, SESSION_COOKIE);
    if (token) {
      const bySession = this.accounts.accountForSession(token);
      if (bySession) return bySession;
    }
    // An API key works anywhere a session does, so that a script can do what a
    // person can. It is the same account either way.
    const presented = bearer(req);
    if (presented.startsWith('rcja_')) return this.accounts.accountForKey(presented);
    return null;
  }

  private async handleAuth(req: Request, action: string): Promise<Response> {
    if (req.method !== 'POST') return Response.json({ ok: false, reason: 'POST only' }, { status: 405 });
    const body = await readJsonBody(req);
    if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });

    switch (action) {
      case 'register': {
        const validated = validateBody(body.payload, RegisterBodySchema, 'an invitation code and a password are required');
        if (!validated.ok) return validated.response;
        const { code, password, name, email } = validated.value;
        const made = this.accounts.redeem(code, {
          displayName: name,
          password,
          email: email ?? null,
        });
        if (!made.ok) return Response.json(made, { status: 400 });
        this.accounts.record(made.value.id, 'account.manage', made.value.slug, 'registered from an invitation');
        return Response.json(
          { ok: true, account: publicAccount(made.value) },
          { headers: { 'set-cookie': this.sessionCookie(made.value) } },
        );
      }

      case 'login': {
        const validated = validateBody(body.payload, LoginBodySchema, 'a name and a password are required');
        if (!validated.ok) return validated.response;
        const { name, password } = validated.value;
        const account = this.accounts.authenticate(name, password);
        if (!account) {
          // One message for both halves. Which of the two was wrong is not a
          // thing a login screen should be willing to say.
          return Response.json(
            { ok: false, reason: 'that name and password do not match an account' },
            { status: 401 },
          );
        }
        return Response.json(
          { ok: true, account: publicAccount(account) },
          { headers: { 'set-cookie': this.sessionCookie(account) } },
        );
      }

      case 'logout': {
        const token = cookie(req, SESSION_COOKIE);
        if (token) this.accounts.closeSession(token);
        return Response.json(
          { ok: true },
          { headers: { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` } },
        );
      }

      default:
        return Response.json({ ok: false, reason: `unknown action "${action}"` }, { status: 404 });
    }
  }

  private sessionCookie(account: Account): string {
    const { token } = this.accounts.openSession(account.id);
    // No `Secure`: a venue server is routinely plain http on a hall's own
    // network, and a cookie a browser refuses to send is a login that silently
    // does not work. `HttpOnly` and `SameSite=Lax` are the two that matter here.
    return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`;
  }

  // ---------------------------------------------------------------------- api

  private async handleApi(req: Request, url: string, actor: Actor): Promise<Response> {
    const path = url.slice('/api'.length);

    // API docs — public, no auth required.
    if (path === '/docs' || path.startsWith('/docs/')) {
      const docs = handleDocs(path, this.bunServer?.port);
      if (docs) return docs;
    }

    // Open to anybody: watching and reading results need no account.
    if (path === '/front' && req.method === 'GET') return Response.json(await this.front(), { status: 200 });
    if (path === '/schedule' && req.method === 'GET') return Response.json(await this.schedule(), { status: 200 });
    if (path === '/standings' && req.method === 'GET') {
      const loaded = await this.tournament();
      const table = loaded ? deriveTable(loaded.draw, loaded.results) : [];
      return Response.json({ ok: true, tournament: loaded && summary(loaded.draw), table }, { status: 200 });
    }
    if (path.startsWith('/match/') && req.method === 'GET') {
      return Response.json(await this.matchRecord(path.slice('/match/'.length)), { status: 200 });
    }
    if (path.startsWith('/team/') && req.method === 'GET') {
      return Response.json(await this.teamPage(path.slice('/team/'.length)), { status: 200 });
    }

    /**
     * What is running, and what it is costing — three numbers, never one.
     *
     * What you set, what this machine guarantees, and what is in use right
     * now. Any one of them alone is misleading in a different direction: a
     * grant is about twelve times what a real robot uses, so a console built
     * on grants reports a machine at capacity while it sits nearly idle, and
     * one built on live usage bets on teams staying bad at this.
     */
    if (path === '/admin/arenas' && req.method === 'GET') {
      if (!can(actor, 'arena.list')) return this.refuse(req, actor, '/admin');
      const arenas = this.arenas.list();
      return Response.json(
        {
          ok: true,
          machine: {
            cores: this.machine.cores,
            memoryMb: Math.round(this.machine.memoryMb),
            sandboxUnavailable: this.machine.sandboxUnavailable,
          },
          budget: {
            max: this.budget.max,
            set: this.budget.set,
            guaranteed: this.budget.guaranteed,
            limitedBy: this.budget.limitedBy,
            fixtures: this.budget.fixtures,
            practice: this.budget.practice,
            enforced: this.budget.enforced,
            warnings: this.budget.warnings,
            seatCpuPercent: this.budget.grant.seatCpuPercent,
            seatMemoryMb: this.budget.grant.seatMemoryMb,
          },
          sources: this.opts.settingSources ?? {},
          inUse: totalUsage(arenas.map((a) => a.usage).filter((u) => u !== null)),
          running: arenas.length,
          arenas,
        },
        { status: 200 },
      );
    }
    if (path.startsWith('/admin/arenas/') && path.endsWith('/stop') && req.method === 'POST') {
      if (!can(actor, 'arena.kill')) return this.refuse(req, actor, '/admin');
      const id = path.slice('/admin/arenas/'.length, -'/stop'.length);
      // A fixture's arena is also its place on the front page, so stopping one
      // has to take it off — otherwise the hall watches a card whose match is
      // no longer being played anywhere.
      for (const [fixtureId, live] of this.liveFixtures) {
        if (live.arenaId === id) this.liveFixtures.delete(fixtureId);
      }
      const stopped = this.arenas.close(id);
      const account = this.accountFor(req);
      if (stopped && account) this.accounts.record(account.id, 'arena.kill', id, 'stopped an arena');
      return Response.json({ ok: stopped }, { status: stopped ? 200 : 404 });
    }

    /**
     * The matches a referee may take right now.
     *
     * Phase 9 replaces this with their actual assignments; until then it is
     * every fixture in progress, which is the same list a referee at a venue
     * with two pitches is looking at anyway.
     */
    if (path === '/referee/fixtures' && req.method === 'GET') {
      if (!can(actor, 'match.control')) return this.refuse(req, actor, '/referee');
      return Response.json(
        { ok: true, fixtures: this.live.map((one) => ({ ...one, console: `/a/${one.arenaId}/referee/` })) },
        { status: 200 },
      );
    }

    if (path === '/me' && req.method === 'GET') {
      const account = this.accountFor(req);
      return Response.json(
        {
          ok: true,
          account: account && publicAccount(account),
          can: {
            workspace: can(actor, 'team.workspace.write', actor.slug ?? undefined),
            referee: can(actor, 'match.control'),
            admin: can(actor, 'account.manage'),
          },
        },
        { status: 200 },
      );
    }

    // A team's own push keys.
    if (path === '/keys') {
      const account = this.accountFor(req);
      if (!account || !can(actor, 'team.submit', actor.slug ?? undefined)) {
        return this.refuse(req, actor, '/team/settings');
      }
      if (req.method === 'GET') return Response.json({ ok: true, keys: this.accounts.listKeys(account.id) }, { status: 200 });
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });
        const validated = validateBody(body.payload, CreateKeyBodySchema, 'a body is required');
        if (!validated.ok) return validated.response;
        const made = this.accounts.createKey(account.id, validated.value.label ?? 'push key');
        this.accounts.record(account.id, 'team.submit', account.slug, `minted key "${made.info.label}"`);
        // The only time the key itself is ever returned. The table holds a
        // digest, exactly as the referee token is printed once and not stored.
        return Response.json({ ok: true, key: made.key, info: made.info }, { status: 200 });
      }
      return Response.json({ ok: false, reason: 'GET or POST' }, { status: 405 });
    }
    if (path.startsWith('/keys/') && path.endsWith('/revoke') && req.method === 'POST') {
      const account = this.accountFor(req);
      if (!account) return this.refuse(req, actor, '/team/settings');
      const keyId = path.slice('/keys/'.length, -'/revoke'.length);
      const revoked = this.accounts.revokeKey(account.id, keyId);
      if (revoked) this.accounts.record(account.id, 'team.submit', account.slug, `revoked key ${keyId}`);
      return Response.json({ ok: revoked }, { status: revoked ? 200 : 404 });
    }

    if (path.startsWith('/admin/')) return await this.handleAdmin(req, path.slice('/admin/'.length), actor);

    return Response.json({ ok: false, reason: `nothing at ${url}` }, { status: 404 });
  }

  /**
   * Enough administration to run a venue without an ssh session.
   *
   * Phase 10 is the real admin area — arenas, team files, draw amendments, the
   * audit screen. What is here is what Phase 6 itself creates and therefore
   * has to be able to undo: accounts, invitations, and a password reset for
   * the failure most likely to happen under pressure.
   */
  private async handleAdmin(req: Request, path: string, actor: Actor): Promise<Response> {
    if (!can(actor, 'account.manage')) return this.refuse(req, actor, '/admin');
    const admin = actor.id;

    if (path === 'accounts' && req.method === 'GET') {
      return Response.json({ ok: true, accounts: this.accounts.list().map(publicAccount) });
    }
    if (path === 'invites' && req.method === 'GET') {
      return Response.json({ ok: true, invites: this.accounts.listInvites() });
    }
    if (path === 'invites' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });
      const validated = validateBody(body.payload, CreateInviteBodySchema, 'role must be team, referee or admin');
      if (!validated.ok) return validated.response;
      const made = this.accounts.createInvite({
        role: validated.value.role,
        team: validated.value.team ?? null,
        createdBy: admin,
      });
      if (!made.ok) return Response.json(made, { status: 400 });
      this.accounts.record(admin, 'account.manage', made.value.team ?? validated.value.role, 'issued an invitation');
      return Response.json({ ok: true, invite: made.value });
    }
    if (path === 'audit' && req.method === 'GET') {
      return Response.json({ ok: true, audit: this.accounts.audit() });
    }
    if (path.startsWith('accounts/') && req.method === 'POST') {
      const [, accountId, what] = path.split('/');
      if (!accountId || !what) return Response.json({ ok: false, reason: 'no such account action' }, { status: 404 });
      const target = this.accounts.byId(accountId);
      if (!target) return Response.json({ ok: false, reason: 'no such account' }, { status: 404 });
      const body = await readJsonBody(req);
      if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });

      if (what === 'password') {
        const validated = validateBody(body.payload, ResetPasswordBodySchema, 'a password is required');
        if (!validated.ok) return validated.response;
        const done = this.accounts.setPassword(target.slug, validated.value.password);
        if (!done.ok) return Response.json(done, { status: 400 });
        this.accounts.record(admin, 'account.manage', target.slug, 'reset the password');
        return Response.json({ ok: true });
      }
      if (what === 'disabled') {
        const validated = validateBody(body.payload, SetDisabledBodySchema, '"disabled" must be true or false');
        if (!validated.ok) return validated.response;
        const disabled = validated.value.disabled === true;
        this.accounts.setDisabled(target.id, disabled);
        this.accounts.record(admin, 'account.manage', target.slug, disabled ? 'disabled' : 'enabled');
        return Response.json({ ok: true });
      }
    }

    return Response.json({ ok: false, reason: 'no such admin action' }, { status: 404 });
  }

  // ------------------------------------------------------------- reading disk

  /**
   * The draw and its results, folded fresh on every read.
   *
   * Nothing is cached, which is not an oversight: the table is derived from
   * whatever results exist, so a page loaded a second after a fixture finished
   * shows it. That property is the whole reason `deriveTable` can never be
   * stale, and a cache here would be the thing that broke it.
   */
  private async tournament(): Promise<{ draw: Draw; results: FixtureResult[] } | null> {
    if (!this.opts.tournamentsDir || !this.opts.tournamentId) return null;
    try {
      const draw = await loadDraw(this.opts.tournamentsDir, this.opts.tournamentId);
      return { draw, results: await loadResults(this.opts.tournamentsDir, draw) };
    } catch {
      return null;
    }
  }

  private async front(): Promise<unknown> {
    const loaded = await this.tournament();
    if (!loaded) {
      return { ok: true, tournament: null, live: this.live, upcoming: [], recent: [], table: [] };
    }
    const { draw, results } = loaded;
    const played = new Set(results.map((r) => r.fixtureId));
    const live = this.live;
    const playing = new Set(live.map((one) => one.fixtureId));
    const upcoming = draw.fixtures
      .filter((f) => !played.has(f.id) && !playing.has(f.id))
      .slice(0, 6)
      .map((f) => ({ id: f.id, home: f.home, away: f.away }));
    const recent = [...results]
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .slice(0, 6)
      .map(resultCard);

    return {
      ok: true,
      tournament: summary(draw),
      live,
      // What the schedule will reach for next, once a slot frees up. Absent
      // while every slot is busy, because "next" and "being played" are
      // different things to somebody standing in the hall.
      next: live.length > 0 ? null : (nextFixture(draw, results) ?? null),
      upcoming,
      recent,
      table: deriveTable(draw, results),
    };
  }

  private async schedule(): Promise<unknown> {
    const loaded = await this.tournament();
    if (!loaded) return { ok: true, tournament: null, fixtures: [] };
    const { draw, results } = loaded;
    const byId = new Map(results.map((r) => [r.fixtureId, r]));
    const playing = new Set(this.live.map((one) => one.fixtureId));
    return {
      ok: true,
      tournament: summary(draw),
      fixtures: draw.fixtures.map((f) => {
        const result = byId.get(f.id);
        return {
          id: f.id,
          home: f.home,
          away: f.away,
          state: result ? 'played' : playing.has(f.id) ? 'playing' : 'upcoming',
          ...(result ? resultCard(result) : {}),
        };
      }),
    };
  }

  /**
   * One fixture's page.
   *
   * Everything on it was already being written by Phase 3 — the seed each leg
   * played on, the sha256 of the code in each seat, and the referee event log
   * kept whole rather than the 60-entry ring buffer the console's banner uses.
   * A timeline of a match is that log, for free, with nothing new recorded.
   */
  private async matchRecord(fixtureId: string): Promise<unknown> {
    const loaded = await this.tournament();
    if (!loaded) return { ok: false, reason: 'this server is not running a tournament' };
    const fixture = loaded.draw.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) return { ok: false, reason: 'no such fixture' };
    const result = loaded.results.find((r) => r.fixtureId === fixtureId);
    const live = this.liveFor(fixtureId);

    return {
      ok: true,
      tournament: summary(loaded.draw),
      fixture: { id: fixture.id, home: fixture.home, away: fixture.away, seeds: fixture.seeds },
      state: result ? 'played' : live ? 'playing' : 'upcoming',
      live,
      record: result
        ? {
            completedAt: result.completedAt,
            submissions: result.submissions,
            verdict: fixtureOutcome(result),
            legs: result.legs.map((leg) => ({
              seed: leg.seed,
              score: leg.result.score,
              clock: leg.result.clock,
              goals: leg.result.goals,
              calls: leg.result.calls,
              events: leg.result.events,
              refereeActions: leg.result.refereeActions,
            })),
          }
        : null,
    };
  }

  private async teamPage(slug: string): Promise<unknown> {
    const loaded = await this.tournament();
    const account = this.accounts.bySlug(slug);
    if (!loaded) {
      return { ok: true, team: account && publicAccount(account), fixtures: [], table: null };
    }
    const { draw, results } = loaded;
    const name = draw.entrants.find((e) => slugifyTeam(e) === slug);
    const played = new Map(results.map((r) => [r.fixtureId, r]));
    // The same three states the schedule uses. A team's own page calling the
    // match they are playing right now "upcoming" is the kind of small lie
    // that makes a person stop trusting the rest of the page.
    const playing = new Set(this.live.map((one) => one.fixtureId));
    const fixtures = draw.fixtures
      .filter((f) => f.home === name || f.away === name)
      .map((f) => {
        const result = played.get(f.id);
        return {
          id: f.id,
          home: f.home,
          away: f.away,
          state: result ? 'played' : playing.has(f.id) ? 'playing' : 'upcoming',
          ...(result ? resultCard(result) : {}),
        };
      });
    return {
      ok: true,
      team: account ? publicAccount(account) : name ? { slug, displayName: name } : null,
      tournament: summary(draw),
      fixtures,
      table: deriveTable(draw, results).find((row) => slugifyTeam(row.name) === slug) ?? null,
    };
  }

  // ------------------------------------------------------------------- static

  /**
   * The site bundle, with every unknown path falling back to its index.
   *
   * The pages are client-routed, so `/standings` typed into a browser has to
   * arrive as the same document `/` does. A path that looks like a file — it
   * has an extension — gets a 404 instead, because a missing script silently
   * answered with HTML is a debugging afternoon.
   */
  private async site(url: string): Promise<Response> {
    if (!this.siteRoot) {
      return new Response('no site built; run: bun run build:site', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const wanted = url === '/' ? 'index.html' : url.slice(1);
    const file = join(this.siteRoot, normalize(wanted));
    if (!file.startsWith(this.siteRoot)) {
      return new Response('no', { status: 403 });
    }
    const f = Bun.file(file);
    if (await f.exists()) {
      return new Response(f, {
        headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
      });
    }
    if (extname(file)) {
      return new Response('not found', { status: 404 });
    }
    const index = Bun.file(join(this.siteRoot, 'index.html'));
    if (await index.exists()) {
      return new Response(index, { headers: { 'content-type': MIME['.html']! } });
    }
    return new Response('not found', { status: 404 });
  }
}

/**
 * The authority a league server hands its world.
 *
 * This is the whole of how accounts reach a match: three questions, answered
 * from a session cookie or an API key. The world is handed this object and
 * learns nothing else — it does not know what a role is, and it cannot be made
 * to care.
 *
 * The rule every branch here keeps is the one from Phase 1: the team comes
 * from the credential. A push whose manifest names somebody else is refused by
 * the server, using the name this function returned.
 */
export function accountsAuthority(accounts: Accounts): Authority {
  const actorOf = (req: AuthRequest): { account: Account; actor: Actor } | null => {
    const token = cookie(req, SESSION_COOKIE);
    const account =
      (token ? accounts.accountForSession(token) : null) ??
      (bearer(req).startsWith('rcja_') ? accounts.accountForKey(bearer(req)) : null);
    return account ? { account, actor: accounts.actorFor(account) } : null;
  };

  const allowed = (req: AuthRequest, capability: Capability): Account | null => {
    const found = actorOf(req);
    if (!found) return null;
    return can(found.actor, capability, found.account.slug) ? found.account : null;
  };

  return {
    // A league server always has both surfaces: whether a particular request
    // may reach them is a capability check, not a server-wide switch.
    refereed: true,
    workspaces: true,

    async referee(req) {
      const found = actorOf(req);
      return found !== null && can(found.actor, 'match.control');
    },

    async team(req) {
      return allowed(req, 'team.workspace.write')?.displayName ?? null;
    },

    async submitter(req): Promise<Submitter> {
      const account = allowed(req, 'team.submit');
      if (!account) return null;
      return { open: false, team: account.displayName };
    },
  };
}

/** One cookie out of the header, or the empty string. */
function cookie(req: AuthRequest, name: string): string {
  const h = req.headers as { get?: (name: string) => string | null; cookie?: string };
  const header = typeof h.get === 'function' ? h.get('cookie') : h.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

/** An account as anybody may see it: never the hash, never the email. */
function publicAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    slug: account.slug,
    displayName: account.displayName,
    role: account.role,
    kind: account.kind,
    createdAt: account.createdAt,
    disabledAt: account.disabledAt,
  };
}

function summary(draw: Draw) {
  return {
    id: draw.id,
    name: draw.name,
    entrants: draw.entrants,
    fixturesTotal: draw.fixtures.length,
  };
}

function resultCard(r: FixtureResult) {
  return {
    fixtureId: r.fixtureId,
    home: r.home,
    away: r.away,
    homeScore: r.legs.reduce((acc, l) => acc + l.result.score.violet, 0),
    awayScore: r.legs.reduce((acc, l) => acc + l.result.score.lime, 0),
    verdict: fixtureOutcome(r),
    completedAt: r.completedAt,
  };
}
