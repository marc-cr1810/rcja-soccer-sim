/**
 * The front door.
 *
 * A **match server** is what a team runs on a laptop: one process, one world,
 * no accounts, no front page, nothing to log into. A **league server** is the
 * tournament deployment — it owns accounts, the draw, the schedule and the
 * public pages, and the football happens in a `MatchServer` it holds rather
 * than in anything written here.
 *
 * Two properties are worth stating up front, because everything else follows
 * from them:
 *
 * **Watching is open.** The front page, the schedule, the table, a match's
 * record and the live viewer need no account at all. That is Phase 2's
 * position — the viewer stream is untrusted by design — and nothing here
 * weakens it. Only entering, refereeing or administering needs a login.
 *
 * **Accounts sit above the world, never inside it.** The `MatchServer` this
 * class holds is handed an `Authority` and nothing else; it has never heard of
 * a session or a database. Every privileged surface it already had — the
 * referee console, a team's workspace, a push — keeps working unchanged, with
 * the answer to "who is this?" coming from a login instead of a secret an
 * organiser typed.
 *
 * In Phase 6 the world is in this process. Phase 7 moves it into child
 * processes, several at once — which is why everything the front door says
 * about it already goes through a proxy and a single `live` accessor rather
 * than reaching into a `Match`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { MatchServer, type ServerOptions } from './server';
import { Accounts, type Account } from './accounts';
import { can, GUEST, type Actor, type Capability } from './capabilities';
import { bearer, type Authority, type Submitter } from './authority';
import { proxyRequest, proxyUpgrade, upstreamAgent } from './proxy';
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

const SESSION_COOKIE = 'rcja_session';
const MAX_BODY = 64 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface LeagueOptions {
  /** The venue's port. The world binds loopback and is reached through this. */
  port?: number;
  /** Where `league.db` lives. Nothing else is kept here. */
  dataDir: string;
  /** Where draws and results live. Files, and they stay files. */
  tournamentsDir: string;
  /** Which draw this server is running, if any. */
  tournamentId?: string | null;
  /** Built bundles. Absent means that surface answers with how to build it. */
  siteRoot?: string | null;
  /** Options passed straight through to the world this league runs. */
  world?: Omit<ServerOptions, 'port' | 'host' | 'authority'>;
  log?: (line: string) => void;
}

/** What the front page shows in its "now playing" band. */
export interface LiveFixture {
  fixtureId: string;
  home: string;
  away: string;
  score: { violet: number; lime: number };
  clock: number;
  half: 1 | 2;
  running: boolean;
}

export class LeagueServer {
  readonly accounts: Accounts;
  /** The world. Public because the draw runner plays matches on it. */
  readonly matches: MatchServer;

  private readonly http = createServer((req, res) => {
    void this.serve(req, res);
  });
  private readonly upstream = upstreamAgent();
  private readonly siteRoot: string | null;
  private readonly log: (line: string) => void;
  private worldPort = 0;
  /** Which fixture the world is playing, set by whoever is running the draw. */
  private liveFixture: Fixture | null = null;

  constructor(private readonly opts: LeagueOptions) {
    this.log = opts.log ?? (() => {});
    this.siteRoot = opts.siteRoot ? resolve(opts.siteRoot) : null;
    this.accounts = new Accounts({ file: join(resolve(opts.dataDir), 'league.db') });
    this.matches = new MatchServer({
      ...opts.world,
      port: 0,
      host: '127.0.0.1',
      authority: accountsAuthority(this.accounts),
    });

    this.http.on('upgrade', (req, socket, head) => {
      // Both of a world's doors — a spectator's viewer stream and a robot's
      // `/agent` — are passed straight through. Watching is open, and a join
      // is authenticated by the seat's own token, which is not an account
      // credential and never was.
      const url = (req.url ?? '/').split('?')[0]!;
      const path = url.startsWith('/live') ? url.slice('/live'.length) || '/' : url;
      proxyUpgrade({ port: this.worldPort }, path, req, socket, head);
    });
  }

  async listen(): Promise<number> {
    this.worldPort = await this.matches.listen();
    await new Promise<void>((ok) => this.http.listen(this.opts.port ?? 8080, ok));
    const address = this.http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('league server is not listening on a TCP port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((ok) => this.http.close(() => ok()));
    await this.matches.close();
    this.upstream.destroy();
    this.accounts.close();
  }

  /**
   * Say which fixture the world is playing, or that it is playing none.
   *
   * The draw runner calls this, because it is the only thing that knows. It is
   * not persisted and deliberately so: an arena dies with the process that
   * holds it, and a fixture interrupted that way writes no result and is simply
   * replayed — which is what Phase 3 already guarantees.
   */
  setLive(fixture: Fixture | null): void {
    this.liveFixture = fixture;
  }

  /** What is happening right now, as the front page wants it. */
  get live(): LiveFixture | null {
    const match = this.matches.currentMatch;
    if (!match || !this.liveFixture) return null;
    const frame = match.snapshot();
    return {
      fixtureId: this.liveFixture.id,
      home: this.liveFixture.home,
      away: this.liveFixture.away,
      score: frame.score,
      clock: frame.clock,
      half: frame.half,
      running: frame.running,
    };
  }

  // ------------------------------------------------------------------ routing

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0]!;
    const actor = await this.actorFor(req);

    try {
      if (url.startsWith('/auth/')) return await this.handleAuth(req, res, url.slice('/auth/'.length));
      if (url.startsWith('/api/')) return await this.handleApi(req, res, url, actor);

      // The world, reached through the one port the venue configured.
      if (url === '/live' ) return this.redirect(res, '/live/');
      if (url.startsWith('/live/')) return this.toWorld(req, res, url.slice('/live'.length) || '/');
      if (url === '/submit' || url.startsWith('/agent')) return this.toWorld(req, res, url);

      // A team's workspace and a referee's console are the world's own
      // surfaces, gated here before they are forwarded. Gating the *static
      // files* too is new: on a match server the bundle has to be fetchable
      // because it is a login screen, and on a league server the login screen
      // is the site's, so a spectator never downloads match-control code at
      // all. That is Phase 2's rule finally kept as a server rule.
      if (url === '/workspace' || url.startsWith('/workspace/') || url.startsWith('/workspace-api/')) {
        if (!can(actor, 'team.workspace.write', actor.slug ?? undefined)) {
          return this.refuse(req, res, actor, '/workspace/');
        }
        return this.toWorld(req, res, url);
      }
      if (url === '/referee' || url.startsWith('/referee/') || url.startsWith('/referee-api/')) {
        if (!can(actor, 'match.control')) return this.refuse(req, res, actor, '/referee/');
        return this.toWorld(req, res, url);
      }
      if (url === '/admin' || url.startsWith('/admin/')) {
        if (!can(actor, 'account.manage')) return this.refuse(req, res, actor, '/admin');
      }
      if (url === '/team' || url.startsWith('/team/')) {
        if (actor.role === 'guest') return this.refuse(req, res, actor, '/team');
      }

      return await this.site(res, url);
    } catch (error) {
      this.log(`[league] ${(error as Error).message}`);
      if (!res.headersSent) this.json(res, 500, { ok: false, reason: 'something went wrong' });
      else res.end();
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
  private refuse(req: IncomingMessage, res: ServerResponse, actor: Actor, wanted: string): void {
    const wantsPage = (req.headers.accept ?? '').includes('text/html');
    if (wantsPage && actor.role === 'guest') {
      return this.redirect(res, `/login?next=${encodeURIComponent(wanted)}`);
    }
    if (wantsPage) {
      return this.redirect(res, '/?denied=1');
    }
    this.json(res, actor.role === 'guest' ? 401 : 403, {
      ok: false,
      reason: actor.role === 'guest' ? 'log in first' : 'your account may not do that',
    });
  }

  private toWorld(req: IncomingMessage, res: ServerResponse, path: string): void {
    proxyRequest({ port: this.worldPort }, path, req, res, {
      agent: this.upstream,
      unreachable: 'the match server is not answering',
    });
  }

  // --------------------------------------------------------------------- auth

  private async actorFor(req: IncomingMessage): Promise<Actor> {
    const account = this.accountFor(req);
    return account ? this.accounts.actorFor(account) : GUEST;
  }

  private accountFor(req: IncomingMessage): Account | null {
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

  private async handleAuth(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    if (req.method !== 'POST') return this.json(res, 405, { ok: false, reason: 'POST only' });
    const body = await this.body(req);
    if (body === null) return this.json(res, 400, { ok: false, reason: 'body is not valid JSON' });

    switch (action) {
      case 'register': {
        const { code, password, name, email } = body as Record<string, unknown>;
        if (typeof code !== 'string' || typeof password !== 'string') {
          return this.json(res, 400, { ok: false, reason: 'an invitation code and a password are required' });
        }
        const made = this.accounts.redeem(code, {
          displayName: typeof name === 'string' ? name : undefined,
          password,
          email: typeof email === 'string' ? email : null,
        });
        if (!made.ok) return this.json(res, 400, made);
        this.accounts.record(made.value.id, 'account.manage', made.value.slug, 'registered from an invitation');
        this.openSession(res, made.value);
        return this.json(res, 200, { ok: true, account: publicAccount(made.value) });
      }

      case 'login': {
        const { name, password } = body as Record<string, unknown>;
        if (typeof name !== 'string' || typeof password !== 'string') {
          return this.json(res, 400, { ok: false, reason: 'a name and a password are required' });
        }
        const account = this.accounts.authenticate(name, password);
        if (!account) {
          // One message for both halves. Which of the two was wrong is not a
          // thing a login screen should be willing to say.
          return this.json(res, 401, { ok: false, reason: 'that name and password do not match an account' });
        }
        this.openSession(res, account);
        return this.json(res, 200, { ok: true, account: publicAccount(account) });
      }

      case 'logout': {
        const token = cookie(req, SESSION_COOKIE);
        if (token) this.accounts.closeSession(token);
        res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
        return this.json(res, 200, { ok: true });
      }

      default:
        return this.json(res, 404, { ok: false, reason: `unknown action "${action}"` });
    }
  }

  private openSession(res: ServerResponse, account: Account): void {
    const { token } = this.accounts.openSession(account.id);
    // No `Secure`: a venue server is routinely plain http on a hall's own
    // network, and a cookie a browser refuses to send is a login that silently
    // does not work. `HttpOnly` and `SameSite=Lax` are the two that matter here.
    res.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`,
    );
  }

  // ---------------------------------------------------------------------- api

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    actor: Actor,
  ): Promise<void> {
    const path = url.slice('/api'.length);

    // Open to anybody: watching and reading results need no account.
    if (path === '/front' && req.method === 'GET') return this.json(res, 200, await this.front());
    if (path === '/schedule' && req.method === 'GET') return this.json(res, 200, await this.schedule());
    if (path === '/standings' && req.method === 'GET') {
      const loaded = await this.tournament();
      const table = loaded ? deriveTable(loaded.draw, loaded.results) : [];
      return this.json(res, 200, { ok: true, tournament: loaded && summary(loaded.draw), table });
    }
    if (path.startsWith('/match/') && req.method === 'GET') {
      return this.json(res, 200, await this.matchRecord(path.slice('/match/'.length)));
    }
    if (path.startsWith('/team/') && req.method === 'GET') {
      return this.json(res, 200, await this.teamPage(path.slice('/team/'.length)));
    }

    if (path === '/me' && req.method === 'GET') {
      const account = this.accountFor(req);
      return this.json(res, 200, {
        ok: true,
        account: account && publicAccount(account),
        can: {
          workspace: can(actor, 'team.workspace.write', actor.slug ?? undefined),
          referee: can(actor, 'match.control'),
          admin: can(actor, 'account.manage'),
        },
      });
    }

    // A team's own push keys.
    if (path === '/keys') {
      const account = this.accountFor(req);
      if (!account || !can(actor, 'team.submit', actor.slug ?? undefined)) {
        return this.refuse(req, res, actor, '/team/settings');
      }
      if (req.method === 'GET') return this.json(res, 200, { ok: true, keys: this.accounts.listKeys(account.id) });
      if (req.method === 'POST') {
        const body = (await this.body(req)) ?? {};
        const label = typeof (body as Record<string, unknown>).label === 'string'
          ? ((body as Record<string, unknown>).label as string)
          : 'push key';
        const made = this.accounts.createKey(account.id, label);
        this.accounts.record(account.id, 'team.submit', account.slug, `minted key "${made.info.label}"`);
        // The only time the key itself is ever returned. The table holds a
        // digest, exactly as the referee token is printed once and not stored.
        return this.json(res, 200, { ok: true, key: made.key, info: made.info });
      }
      return this.json(res, 405, { ok: false, reason: 'GET or POST' });
    }
    if (path.startsWith('/keys/') && path.endsWith('/revoke') && req.method === 'POST') {
      const account = this.accountFor(req);
      if (!account) return this.refuse(req, res, actor, '/team/settings');
      const keyId = path.slice('/keys/'.length, -'/revoke'.length);
      const revoked = this.accounts.revokeKey(account.id, keyId);
      if (revoked) this.accounts.record(account.id, 'team.submit', account.slug, `revoked key ${keyId}`);
      return this.json(res, revoked ? 200 : 404, { ok: revoked });
    }

    if (path.startsWith('/admin/')) return await this.handleAdmin(req, res, path.slice('/admin/'.length), actor);

    return this.json(res, 404, { ok: false, reason: `nothing at ${url}` });
  }

  /**
   * Enough administration to run a venue without an ssh session.
   *
   * Phase 10 is the real admin area — arenas, team files, draw amendments, the
   * audit screen. What is here is what Phase 6 itself creates and therefore
   * has to be able to undo: accounts, invitations, and a password reset for
   * the failure most likely to happen under pressure.
   */
  private async handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    actor: Actor,
  ): Promise<void> {
    if (!can(actor, 'account.manage')) return this.refuse(req, res, actor, '/admin');
    const admin = actor.id;

    if (path === 'accounts' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, accounts: this.accounts.list().map(publicAccount) });
    }
    if (path === 'invites' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, invites: this.accounts.listInvites() });
    }
    if (path === 'invites' && req.method === 'POST') {
      const body = ((await this.body(req)) ?? {}) as Record<string, unknown>;
      const role = body.role;
      if (role !== 'team' && role !== 'referee' && role !== 'admin') {
        return this.json(res, 400, { ok: false, reason: 'role must be team, referee or admin' });
      }
      const made = this.accounts.createInvite({
        role,
        team: typeof body.team === 'string' ? body.team : null,
        createdBy: admin,
      });
      if (!made.ok) return this.json(res, 400, made);
      this.accounts.record(admin, 'account.manage', made.value.team ?? role, 'issued an invitation');
      return this.json(res, 200, { ok: true, invite: made.value });
    }
    if (path === 'audit' && req.method === 'GET') {
      return this.json(res, 200, { ok: true, audit: this.accounts.audit() });
    }
    if (path.startsWith('accounts/') && req.method === 'POST') {
      const [, accountId, what] = path.split('/');
      if (!accountId || !what) return this.json(res, 404, { ok: false, reason: 'no such account action' });
      const target = this.accounts.byId(accountId);
      if (!target) return this.json(res, 404, { ok: false, reason: 'no such account' });
      const body = ((await this.body(req)) ?? {}) as Record<string, unknown>;

      if (what === 'password') {
        if (typeof body.password !== 'string') {
          return this.json(res, 400, { ok: false, reason: 'a password is required' });
        }
        const done = this.accounts.setPassword(target.slug, body.password);
        if (!done.ok) return this.json(res, 400, done);
        this.accounts.record(admin, 'account.manage', target.slug, 'reset the password');
        return this.json(res, 200, { ok: true });
      }
      if (what === 'disabled') {
        const disabled = body.disabled === true;
        this.accounts.setDisabled(target.id, disabled);
        this.accounts.record(admin, 'account.manage', target.slug, disabled ? 'disabled' : 'enabled');
        return this.json(res, 200, { ok: true });
      }
    }

    return this.json(res, 404, { ok: false, reason: 'no such admin action' });
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
    if (!this.opts.tournamentId) return null;
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
    const upcoming = draw.fixtures
      .filter((f) => !played.has(f.id) && f.id !== live?.fixtureId)
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
      // What is next when nothing is playing: the same fixture the draw runner
      // will pick up, because both ask `nextFixture`.
      next: live ? null : (nextFixture(draw, results) ?? null),
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
    const live = this.live;
    return {
      ok: true,
      tournament: summary(draw),
      fixtures: draw.fixtures.map((f) => {
        const result = byId.get(f.id);
        return {
          id: f.id,
          home: f.home,
          away: f.away,
          state: result ? 'played' : f.id === live?.fixtureId ? 'playing' : 'upcoming',
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
    const live = this.live;

    return {
      ok: true,
      tournament: summary(loaded.draw),
      fixture: { id: fixture.id, home: fixture.home, away: fixture.away, seeds: fixture.seeds },
      state: result ? 'played' : fixture.id === live?.fixtureId ? 'playing' : 'upcoming',
      live: fixture.id === live?.fixtureId ? live : null,
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
    const live = this.live;
    const fixtures = draw.fixtures
      .filter((f) => f.home === name || f.away === name)
      .map((f) => {
        const result = played.get(f.id);
        return {
          id: f.id,
          home: f.home,
          away: f.away,
          state: result ? 'played' : f.id === live?.fixtureId ? 'playing' : 'upcoming',
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
  private async site(res: ServerResponse, url: string): Promise<void> {
    if (!this.siteRoot) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('no site built; run: npm run build:site');
      return;
    }
    const wanted = url === '/' ? 'index.html' : url.slice(1);
    const file = join(this.siteRoot, normalize(wanted));
    if (!file.startsWith(this.siteRoot)) {
      res.writeHead(403).end('no');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
      return;
    } catch {
      if (extname(file)) {
        res.writeHead(404).end('not found');
        return;
      }
    }
    try {
      const index = await readFile(join(this.siteRoot, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(index);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  // ------------------------------------------------------------------ plumbing

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private redirect(res: ServerResponse, to: string): void {
    res.writeHead(302, { location: to });
    res.end();
  }

  private body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((done) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let over = false;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY) over = true;
        else chunks.push(chunk);
      });
      req.on('end', () => {
        if (over) return done(null);
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return done({});
        try {
          const parsed: unknown = JSON.parse(text);
          done(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
        } catch {
          done(null);
        }
      });
      req.on('error', () => done(null));
    });
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
  const actorOf = (req: IncomingMessage): { account: Account; actor: Actor } | null => {
    const token = cookie(req, SESSION_COOKIE);
    const account =
      (token ? accounts.accountForSession(token) : null) ??
      (bearer(req).startsWith('rcja_') ? accounts.accountForKey(bearer(req)) : null);
    return account ? { account, actor: accounts.actorFor(account) } : null;
  };

  const allowed = (req: IncomingMessage, capability: Capability): Account | null => {
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
function cookie(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie;
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
    disabled: account.disabledAt !== null,
  };
}

function summary(draw: Draw): Record<string, unknown> {
  return { id: draw.id, name: draw.name, legs: draw.legs, fixtures: draw.fixtures.length };
}

function resultCard(result: FixtureResult): Record<string, unknown> {
  const verdict = fixtureOutcome(result);
  return {
    id: result.fixtureId,
    home: result.home,
    away: result.away,
    homeGoals: verdict.homeGoals,
    awayGoals: verdict.awayGoals,
    outcome: verdict.outcome,
    legs: result.legs.map((leg) => leg.result.score),
    completedAt: result.completedAt,
  };
}
