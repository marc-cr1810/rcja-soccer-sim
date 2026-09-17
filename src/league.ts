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
import { AGENT_PATH } from './gateway';
import { Occupancy, numberOfSeat, type Placement } from './occupancy';
import { Tenancy } from './tenancy';
import { randomBytes } from 'node:crypto';
import { TeamApi } from './team-api';
import { WorkspaceStore } from './workspace';
import type { PlayRequest, PlayedMatch, ArenaState } from './arena';
import { mergeSettings, type LeagueSettings, type SettingSource } from './settings';
import { readMachine, resolveBudget, type Budget, type Machine } from './capacity';
import { totalUsage } from './usage';
import { Accounts, type Account } from './accounts';
import { can, capabilitiesOf, fixtureTarget, GUEST, type Actor, type Capability } from './capabilities';
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
import type { Confirmation } from './tournament-run';
import { handleDocs } from './api/docs';
import {
  CreateInviteBodySchema,
  CreateKeyBodySchema,
  LoginBodySchema,
  RegisterBodySchema,
  InviteTeamBodySchema,
  ResetPasswordBodySchema,
  RunBodySchema,
  SeatActionBodySchema,
  SeatBodySchema,
  SetDisabledBodySchema,
} from './api/schemas';
import { badBody, readJsonBody, validateBody } from './api/validate';

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
  settings?: Partial<LeagueSettings>;
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
  /** `true` for a demo attraction — it has no fixture behind it. */
  demo?: boolean;
}

/** A fixture in progress: which arena holds it, and what it last said. */
interface LiveArena {
  fixture: Fixture;
  /** The draw it came from — a fixture id is unique only within one. */
  drawId: string;
  arenaId: string;
  state: ArenaState | null;
}

/**
 * A fixture played out, held back from disk until a referee agrees the score.
 *
 * The result is already in hand and complete; the only thing missing is a
 * person saying so. Holding the unresolved promise here rather than in the draw
 * runner is what lets an HTTP request finish it.
 */
interface AwaitingConfirmation {
  fixture: Fixture;
  drawId: string;
  result: FixtureResult;
  /** When full time was, for a page that wants to say how long it has waited. */
  since: string;
  settle: (verdict: Confirmation) => void;
  fail: (why: Error) => void;
}

/**
 * A fixture whose turn has come, waiting for a referee to open it.
 *
 * The mirror of `AwaitingConfirmation` at the other end of the match, and held
 * for the same reason: the draw runner cannot be the thing an HTTP request
 * finishes, so the unresolved promise lives here.
 */
interface AwaitingPregame {
  fixture: Fixture;
  drawId: string;
  /** When it became due, for a page that wants to say how long it has waited. */
  since: string;
  settle: () => void;
  fail: (why: Error) => void;
}

/** What a fixture is, in one word, everywhere it is asked. */
export type FixtureState =
  | 'played'
  | 'confirming'
  | 'playing'
  | 'opening'
  | 'due'
  | 'upcoming';

interface LeagueWsData {
  type: 'relay';
  upstream: WebSocket;
  queue?: (string | Buffer)[];
  /** Let go of the arena this socket was holding open. */
  release?: () => void;
}

export class LeagueServer {
  readonly accounts: Accounts;
  /** Every world this venue is running. The hub itself runs none. */
  readonly arenas: ArenaSupervisor;
  /**
   * Whose field is whose: ownership, invitations, the per-team cap, the queue.
   */
  readonly tenancy: Tenancy;
  /**
   * One robot, one place — the invariant, held server-wide.
   *
   * It has to live up here. A child arena can only ever see its own world, so
   * a rule about *every* world is one the children cannot keep between them;
   * left to them, every field would look correct on its own while a team's
   * robot played in two of them. That is why the hub stops being a transparent
   * proxy for exactly one action, in `toPracticeArena` below.
   */
  readonly occupancy: Occupancy;

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
  /**
   * Fixtures played out and waiting for a referee to agree the score.
   *
   * Deliberately not keyed off the arena. The result is already in hand, so an
   * admin stopping a finished arena from `/admin/arenas` must not lose it, and
   * `/referee/m/<id>` is an address that works whether or not a child process
   * is still alive behind it.
   */
  private readonly confirming = new Map<string, AwaitingConfirmation>();
  /**
   * Fixtures whose turn has come, waiting for a referee to open them.
   *
   * Nothing has been spawned for any of these: no arena, no child process, no
   * sandboxed interpreters. That is the whole point of the slice — a pitch
   * comes up when somebody is standing at it.
   */
  private readonly due = new Map<string, AwaitingPregame>();
  /**
   * Opened, but not up yet.
   *
   * The gap between a referee pressing the button and an arena existing: the
   * draw runner may still be queueing for one of the venue's pitches. Small
   * enough to miss and long enough to matter — without it this window reads as
   * "not started", to somebody who has just started it.
   */
  private readonly opening = new Set<string>();
  /**
   * Something a field needs to be told, by arena id.
   *
   * Only one thing goes in here so far — *your robots have been taken back for
   * your match* — and it matters that it is said on the field rather than only
   * on a dashboard: the person watching a seat go empty is the person owed the
   * explanation, and they are looking at the field.
   */
  private readonly fieldNotices = new Map<string, string>();
  /** Fields with a closing time on them, for the owner's dashboard. */
  private readonly closing = new Map<string, string>();
  /** A demo arena, if one has been opened to fill a hall screen. */
  private demoArena: { arenaId: string; state: ArenaState | null } | null = null;
  private demoPoll: ReturnType<typeof setInterval> | null = null;
  /** True once `close()` has been called, to avoid reopening a demo on shutdown. */
  private closingLeague = false;

  constructor(private readonly opts: LeagueOptions) {
    this.log = opts.log ?? (() => {});
    this.siteRoot = opts.siteRoot ? resolve(opts.siteRoot) : null;
    this.workspaceRoot = opts.world.workspaceRoot ? resolve(opts.world.workspaceRoot) : null;
    this.accounts = new Accounts({ file: join(resolve(opts.dataDir), 'league.db') });
    this.authority = accountsAuthority(this.accounts);
    this.settings = mergeSettings(opts.settings);
    this.machine = readMachine();
    this.budget = resolveBudget(this.settings, this.machine);
    this.teams = new TeamApi({
      authority: this.authority,
      workspaces: new WorkspaceStore({ dir: resolve(opts.world.workspacesDir ?? 'workspaces') }),
      submissionsDir: resolve(opts.world.submissionsDir ?? 'submissions'),
      pythonLibDir: opts.world.pythonLibDir ? resolve(opts.world.pythonLibDir) : null,
    });
    this.tenancy = new Tenancy({
      perTeam: this.settings.practice.perTeam,
      claimSeconds: this.settings.practice.claimSecs,
    });
    this.occupancy = new Occupancy();
    this.arenas = new ArenaSupervisor({
      submissionsDir: resolve(opts.world.submissionsDir ?? 'submissions'),
      workspacesDir: resolve(opts.world.workspacesDir ?? 'workspaces'),
      maxArenas: this.budget.max,
      fixtureSlots: this.budget.fixtures,
      seatCpuPercent: this.settings.arenas.seatCpuPercent,
      seatMemoryMb: this.settings.arenas.seatMemoryMb,
      idleMinutes: this.settings.practice.idleMins,
      graceMinutes: this.settings.practice.graceMins,
      // Reclamation scales with demand rather than a flat lifetime, and the
      // queue is the hub's. A function rather than a number so the supervisor
      // reads it fresh on every sweep and knows nothing about tenancy.
      queued: () => this.tenancy.waiting().length,
      log: (line) => this.log(line),
      onArenaEnded: (arena) => this.arenaEnded(arena),
      onArenaWarned: (arena) => this.arenaWarned(arena),
    });
  }

  /**
   * Take one team's robots back, because they are due on the pitch.
   *
   * A field they *own* closes outright: it frees a slot at exactly the moment
   * the hall wants one, and there is nobody left to rehearse with anyway —
   * both their robots are about to be seated in the match. A field they are
   * merely a guest on lives on, because it is somebody else's rehearsal and
   * losing it would punish the team who did the inviting; only the seat goes.
   */
  private async preempt(slug: string, fixture: string): Promise<void> {
    for (const arenaId of this.tenancy.fieldsOwnedBy(slug)) {
      this.log(`[practice] closing ${arenaId}: ${slug} is due to play ${fixture}`);
      this.arenas.close(arenaId);
    }
    for (const { at } of this.occupancy.forTeam(slug)) {
      if (at === null) continue;
      const port = this.arenas.portOf(at.arenaId);
      if (port !== null) {
        try {
          await fetch(`http://127.0.0.1:${port}/practice-api/seat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seat: at.seatId, fill: { kind: 'empty' } }),
          });
        } catch {
          // The field is gone or not answering, which is the same outcome: the
          // robot is free. Releasing it below is what actually matters.
        }
        this.fieldNotices.set(
          at.arenaId,
          `${slug} has been called away to play ${fixture}; their robot ${at.number} has left the ${at.seatId} seat.`,
        );
      }
      this.occupancy.release(at.arenaId, at.seatId);
      this.tenancy.removeGuest(at.arenaId, slug);
    }
  }

  /**
   * A quiet field is about to be given back, or has just been reprieved.
   *
   * Said in both places the owner might be looking: on the field itself, where
   * Phase 8's notice banner already exists for exactly this kind of sentence,
   * and on their dashboard, which is where they are if they are not on the
   * field. Cleared the moment somebody turns up, because a warning that stopped
   * being true without saying so is worse than no warning at all.
   */
  private arenaWarned(arena: { id: string; owner: string | null; closingAt: string | null }): void {
    if (arena.closingAt === null) {
      this.fieldNotices.delete(arena.id);
      this.closing.delete(arena.id);
      return;
    }
    const at = new Date(arena.closingAt);
    // Written out rather than localised: this string is composed on the server
    // and read in a hall, and the server's idea of a locale is whatever the
    // machine was installed with rather than anything about the people looking.
    const when = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    this.closing.set(arena.id, arena.closingAt);
    this.fieldNotices.set(
      arena.id,
      `Nobody has used this field for a while, so it will close at ${when} and go to whoever is waiting. Move something, or press anything, to keep it.`,
    );
  }

  /**
   * An arena's process has gone — swept, stopped, pre-empted or crashed.
   *
   * Both ledgers are emptied of it here rather than at each of the places that
   * can end one, because the ways an arena ends are not a closed set and a
   * ledger still holding a robot in a field that no longer exists deadlocks
   * the team that owns that robot. Only then is the freed slot offered on.
   */
  private arenaEnded(arena: { id: string; kind: string; owner: string | null }): void {
    this.occupancy.releaseArena(arena.id);
    this.tenancy.forget(arena.id);
    this.fieldNotices.delete(arena.id);
    this.closing.delete(arena.id);
    if (arena.kind === 'demo') {
      this.stopDemoPoll();
      this.demoArena = null;
      // Reopen after a brief pause if still configured — the screen never sits
      // still, and a crash is a miss, never a pause.
      if (!this.closingLeague && this.settings.demo.on) {
        setTimeout(() => void this.openDemo(), 5_000).unref?.();
      }
      return;
    }
    if (arena.kind !== 'practice') return;
    const offer = this.tenancy.slotFreed();
    if (offer) {
      this.log(`[practice] a field is held for ${offer.offeredTo} until ${offer.until}`);
    }
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
          ws.data.release?.();
        },
      },
    });

    if (this.bunServer.port === undefined) {
      throw new Error('league server did not bind to a port');
    }
    return this.bunServer.port;
  }

  async close(): Promise<void> {
    this.closingLeague = true;
    this.stopDemoPoll();
    // A hub going down with a fixture unconfirmed writes nothing, which is the
    // same answer as a hub killed mid-match: the fixture replays as itself. It
    // has to be said out loud rather than left to the process exiting, or a
    // `runDraw` awaiting an answer never returns.
    for (const [id, waiting] of [...this.confirming]) {
      this.confirming.delete(id);
      waiting.fail(new Error('the league server stopped before the result was confirmed'));
    }
    // And the same at the other end: a fixture nobody had opened yet is simply
    // a fixture that has not been played, and saying so is what lets its
    // `runDraw` return instead of waiting for a referee who has gone home.
    for (const [id, waiting] of [...this.due]) {
      this.due.delete(id);
      waiting.fail(new Error('the league server stopped before the match was opened'));
    }
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
  async openFixture(fixture: Fixture, drawId: string): Promise<string> {
    // A fixture pre-empts practice, and it has to: without an explicit winner
    // the one-robot-one-place invariant deadlocks at the worst moment of the
    // day, when a team whose robot is still held by a field they walked away
    // from an hour ago cannot be seated in their own match.
    for (const team of [fixture.home, fixture.away]) {
      await this.preempt(slugifyTeam(team), `${fixture.home} v ${fixture.away}`);
    }
    const arena = await this.arenas.create({ kind: 'fixture' });
    this.opening.delete(fixture.id);
    this.liveFixtures.set(fixture.id, { fixture, drawId, arenaId: arena.id, state: null });
    this.log(`[fixture ${fixture.id}] ${fixture.home} v ${fixture.away} in arena ${arena.id}`);
    return arena.id;
  }

  /** Stop a fixture's arena and take it off the front page. */
  closeFixture(fixtureId: string): void {
    // Whatever else happens, it is no longer on its way up — a fixture that
    // failed or was sent back to be played again never reached an arena, and
    // this is the only place that hears about it.
    this.opening.delete(fixtureId);
    const live = this.liveFixtures.get(fixtureId);
    if (!live) return;
    this.arenas.close(live.arenaId);
    this.liveFixtures.delete(fixtureId);
  }

  /**
   * Hold a fixture, unspawned, until a referee opens it.
   *
   * The draw runner awaits this before anything exists, so an arena comes up
   * when somebody is standing at that pitch rather than when the schedule gets
   * round to it. It never times out, for the same reason the confirmation at
   * the other end does not: a match nobody is refereeing should not start. An
   * admin holds `match.control` over everything and can open any fixture from
   * the same page if the assigned referee has not arrived.
   *
   * Costs the venue nothing while it waits — that is the difference between
   * this gate and the one at full time.
   */
  awaitPregame(fixture: Fixture, drawId: string): Promise<void> {
    return new Promise<void>((settle, fail) => {
      this.due.set(fixture.id, {
        fixture,
        drawId,
        since: new Date().toISOString(),
        settle,
        fail,
      });
      this.log(`[fixture ${fixture.id}] ready — waiting for a referee to open it`);
    });
  }

  /**
   * Hold a played fixture until a referee agrees the score.
   *
   * The draw runner awaits this between the last leg and the write, so nothing
   * reaches disk — or the table — until somebody says so. It never times out:
   * a result no referee ever looked at must not be able to reach a table, and
   * an admin holds `match.control` over everything if the assigned referee has
   * walked away. The cost is that the fixture keeps its arena and its slot
   * while it waits, which is also what lets the referee go back and look.
   */
  awaitConfirmation(fixture: Fixture, drawId: string, result: FixtureResult): Promise<Confirmation> {
    return new Promise<Confirmation>((settle, fail) => {
      this.confirming.set(fixture.id, {
        fixture,
        drawId,
        result,
        since: new Date().toISOString(),
        settle,
        fail,
      });
      this.log(`[fixture ${fixture.id}] full time — waiting for a referee to confirm`);
    });
  }

  /**
   * What a fixture is, in one word, asked the same way by every page.
   *
   * `confirming` has to be tested before `playing`: a fixture waiting to be
   * confirmed is still in `liveFixtures`, because its arena is deliberately
   * left up for the referee to look at.
   *
   * The three before a match exists are the same question asked of three
   * registries and they are genuinely different things to somebody in a hall:
   * `due` is "your turn, open it when you are ready", `opening` is "somebody
   * pressed it and the pitch is coming up", and `upcoming` is "not yet".
   */
  private stateOf(fixtureId: string, played: boolean): FixtureState {
    if (played) return 'played';
    if (this.confirming.has(fixtureId)) return 'confirming';
    if (this.liveFixtures.has(fixtureId)) return 'playing';
    if (this.opening.has(fixtureId)) return 'opening';
    if (this.due.has(fixtureId)) return 'due';
    return 'upcoming';
  }

  /** Which fixture an arena is playing, if it is playing one at all. */
  private fixtureForArena(arenaId: string): LiveArena | null {
    for (const live of this.liveFixtures.values()) {
      if (live.arenaId === arenaId) return live;
    }
    return null;
  }

  /**
   * The name a capability check knows an arena's match by.
   *
   * `undefined` for an arena playing no fixture — the demo, most of all. A
   * targeted capability cannot be held over a match that is not in any draw,
   * which leaves the demo to whoever holds `any`.
   */
  private targetForArena(arenaId: string): string | undefined {
    const live = this.fixtureForArena(arenaId);
    return live ? fixtureTarget(live.drawId, live.fixture.id) : undefined;
  }

  /**
   * Is refereeing this person's job?
   *
   * Deliberately not "have they been given a match". This gates the referee's
   * own pages, and a referee who has been assigned nothing yet needs to reach
   * the page that tells them so — sending them to a team dashboard instead
   * looks, at a venue, exactly like an account that does not work. It leaks
   * nothing, because the page can only ever show them their own assignments,
   * and every capability over an actual match stays named one fixture at a
   * time.
   *
   * Asked of the capability table rather than of `actor.role`, so a role that
   * is given `match.control` later is a referee here too without this being
   * remembered.
   */
  private mayReferee(actor: Actor): boolean {
    return capabilitiesOf(actor.role).includes('match.control');
  }

  // ------------------------------------------------------------------- demo

  /**
   * Open a demo arena, if the venue wants one.
   *
   * A demo never records a result, so there is no `playLeg` or `closeFixture`
   * — the child plays itself, and the hub just keeps the front page's "now
   * playing" band up to date with a poll. Answers with the arena's relative
   * URL, or `null` when no demo is configured or it could not open.
   */
  async openDemo(): Promise<string | null> {
    if (!this.settings.demo.on || this.closingLeague) return null;
    const demo = this.settings.demo;
    try {
      const arena = await this.arenas.create({
        kind: 'demo',
        demo: {
          home: demo.home,
          away: demo.away,
          bots: demo.bots,
          homeBots: demo.homeBots,
          awayBots: demo.awayBots,
          halfSeconds: demo.halfSeconds,
          league: demo.league,
          gapSeconds: demo.gapSeconds,
        },
      });
      this.demoArena = { arenaId: arena.id, state: null };
      this.log(`demo arena ${arena.id} playing ${demo.home} v ${demo.away} forever`);
      this.demoPoll = setInterval(() => void this.pollDemo(), POLL_MS);
      this.demoPoll.unref?.();
      return `/a/${arena.id}/`;
    } catch (err) {
      this.log(`could not open the demo arena: ${(err as Error).message}`);
      return null;
    }
  }

  private async pollDemo(): Promise<void> {
    if (!this.demoArena) return;
    const port = this.arenas.portOf(this.demoArena.arenaId);
    if (port === null) {
      this.stopDemoPoll();
      return;
    }
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/arena-api/state`);
      const payload = (await answer.json()) as { state: ArenaState };
      this.demoArena.state = payload.state;
      this.arenas.reportFidelity(this.demoArena.arenaId, payload.state.fidelity);
    } catch {
      // A missed poll is not a failed match — and a demo is never a match.
    }
  }

  private stopDemoPoll(): void {
    if (this.demoPoll === null) return;
    clearInterval(this.demoPoll);
    this.demoPoll = null;
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
    const fixtures: LiveFixture[] = [...this.liveFixtures.values()].map(({ fixture, arenaId, state }) => ({
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
    if (this.demoArena) {
      const { state } = this.demoArena;
      fixtures.push({
        fixtureId: '',
        arenaId: this.demoArena.arenaId,
        url: `/a/${this.demoArena.arenaId}/`,
        home: state?.teams?.violet ?? this.settings.demo.home,
        away: state?.teams?.lime ?? this.settings.demo.away,
        score: state?.score ?? { violet: 0, lime: 0 },
        clock: state?.clock ?? 0,
        half: state?.half ?? 1,
        running: state?.running ?? false,
        fidelity: state?.fidelity ?? null,
        demo: true,
      });
    }
    return fixtures;
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
      // Both doors are relayed, but they do not mean the same thing to a field
      // that is deciding whether anybody still wants it: a viewer's socket is a
      // person watching, and a robot's `/agent` is a program that may well have
      // been left running by somebody who went home. Until now neither was
      // tracked here at all, so a hub-supervised field was kept alive only by
      // its console polling.
      const presence = path.split('?')[0] !== AGENT_PATH;
      const release = this.arenas.trackConnection(forArena.id, { presence });
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
        const upgraded = server.upgrade(req, {
          data: { type: 'relay', upstream, queue, release: release ?? undefined },
        });
        if (!upgraded) {
          // Nothing will ever call `close` for this socket, so the hold has to
          // be let go here or the arena is held open by a connection that was
          // never made — and a held arena is never swept.
          release?.();
          try { upstream.close(); } catch {}
          return new Response('could not open the stream', { status: 400 });
        }
        return;
      } catch {
        release?.();
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

      // A practice field, for whoever may open one — and, since Phase 8, one
      // that belongs to the team that opened it.
      if (
        url === '/practice' ||
        url === '/practice/claim' ||
        url === '/practice/leave' ||
        url === '/practice/run'
      ) {
        if (!can(actor, 'field.open')) return this.refuse(req, actor, '/practice');
        if (req.method !== 'POST') {
          // `run` is how the browser editor discovers that this server has
          // fields to give. A match server on a laptop hosts workspaces but has
          // no accounts and no ownership, so it has no Run to offer and says
          // nothing of the kind — and the button is simply not there.
          return Response.json({ ok: true, run: true, fields: this.practiceFieldsFor(actor) }, { status: 200 });
        }
        if (url === '/practice/leave') {
          if (actor.slug) this.tenancy.leaveQueue(actor.slug);
          return Response.json({ ok: true }, { status: 200 });
        }
        if (url === '/practice/run') return await this.runFromWorkspace(req, actor);
        return await this.openPracticeField(actor, url === '/practice/claim');
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
      // single one any more. What is here is the person's own assignments, so
      // the door opens for anybody holding one and for an admin.
      if (url === '/referee' || url.startsWith('/referee/')) {
        if (!this.mayReferee(actor)) return this.refuse(req, actor, '/referee/');
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

    if (this.arenas.info(id)?.kind === 'practice') {
      return await this.toPracticeArena(req, id, rest, actor, port);
    }

    const headers = new Headers(req.headers);
    if (rest === '/referee' || rest.startsWith('/referee/') || rest.startsWith('/referee-api/')) {
      // Named, not blanket: this is the one place that knows which match the
      // arena is playing, so it is the one place the assignment can be checked.
      if (!can(actor, 'match.control', this.targetForArena(id))) {
        return this.refuse(req, actor, `/a/${id}/referee/`);
      }
      const token = this.arenas.refereeTokenOf(id);
      if (token) headers.set('authorization', `Bearer ${token}`);
    }

    return await this.forward(id, port, rest, req, headers);
  }

  /**
   * One request, handed to an arena.
   *
   * `redirect: 'manual'` is not a detail. A child's redirect is advice to the
   * *browser* about where it is; following it here would leave the browser on
   * the address it asked for, and a console served at `/a/<id>/referee`
   * resolves its relative assets one directory too high, arriving with the
   * viewer's stylesheet and no explanation.
   */
  private async forward(
    id: string,
    port: number,
    rest: string,
    req: Request,
    headers: Headers,
    body?: string,
  ): Promise<Response> {
    // A console polling from a tab nobody is looking at says `active=0`, and a
    // poll like that keeps the arena alive for the length of the request
    // without counting as somebody being here. Without that, one forgotten
    // browser tab would simply take over from the forgotten laptop program
    // this phase stops holding fields open.
    const release = this.arenas.trackConnection(id, {
      presence: new URL(req.url).searchParams.get('active') !== '0',
    });
    try {
      const sending = body !== undefined ? body : req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined;
      return await fetch(`http://127.0.0.1:${port}${rest}`, {
        method: req.method,
        headers,
        body: sending,
        redirect: 'manual',
      });
    } catch {
      return new Response('the arena is not answering', { status: 502 });
    } finally {
      release?.();
    }
  }

  // ------------------------------------------------------------ practice fields

  /** Every practice field this person may actually be on. */
  private practiceFieldsFor(actor: Actor): unknown[] {
    return this.arenas
      .list()
      .filter((one) => one.kind === 'practice')
      .filter((one) => this.mayBeOnField(actor, one.id))
      .map((one) => ({
        ...one,
        guests: this.tenancy.guestsOf(one.id),
        robots: this.occupancy.all().filter((r) => r.arenaId === one.id),
      }));
  }

  /** May this person open the console on this field — see it, read its state? */
  private mayBeOnField(actor: Actor, arenaId: string): boolean {
    const owner = this.tenancy.ownerOf(arenaId) ?? undefined;
    if (can(actor, 'field.join', owner)) return true;
    return this.tenancy.mayBeOnField(actor.slug, arenaId);
  }

  /** May this person run the field — drag, start, stop, re-stage, invite, close? */
  private mayRunField(actor: Actor, arenaId: string): boolean {
    return can(actor, 'field.control', this.tenancy.ownerOf(arenaId) ?? undefined);
  }

  /**
   * Open a practice field for this team, or tell them where they are in line.
   *
   * Three different refusals, and they are different on purpose: *practice is
   * closed* is the organiser's decision, *you already have one* is the team's
   * own doing and fixable in one click, and *the machine is full* is nobody's
   * fault and turns into a place in a queue rather than an error.
   */
  private async openPracticeField(actor: Actor, claiming: boolean): Promise<Response> {
    const slug = actor.slug;
    if (slug === null) {
      return Response.json({ ok: false, reason: 'only a team can open a practice field' }, { status: 403 });
    }
    if (!this.settings.practice.open) {
      return Response.json({ ok: false, reason: 'practice is closed on this server' }, { status: 503 });
    }

    const mine = this.tenancy.perTeamRefusal(slug);
    if (mine) return Response.json({ ok: false, reason: mine }, { status: 409 });

    // A held field belongs to whoever it is held for, and to nobody else while
    // the hold stands — otherwise the hold means nothing and the queue is a
    // list of teams watching other people take their turn.
    const held = this.tenancy.offeredTo(slug) ? 0 : this.tenancy.reserved();
    const running = this.arenas.countOf('practice');
    if (running + held >= this.budget.practice) {
      if (claiming) {
        return Response.json(
          { ok: false, reason: 'the field you were offered has already gone; you are back in the queue' },
          { status: 409 },
        );
      }
      const place = this.tenancy.enqueue(slug);
      return Response.json(
        {
          ok: false,
          queued: true,
          place,
          reason:
            place.ahead === 0
              ? 'every practice field is in use; you are next'
              : `every practice field is in use; there ${place.ahead === 1 ? 'is 1 team' : `are ${place.ahead} teams`} ahead of you`,
        },
        { status: 202 },
      );
    }

    try {
      const field = await this.arenas.create({ kind: 'practice', owner: slug });
      this.tenancy.own(field.id, slug);
      // Only now: a field that failed to start must not consume anybody's turn.
      this.tenancy.claimed(slug);
      this.log(`[practice] ${slug} opened ${field.id}`);
      return Response.json({ ok: true, field }, { status: 201 });
    } catch (err) {
      return Response.json({ ok: false, reason: (err as Error).message }, { status: 503 });
    }
  }

  /**
   * Run what this team is typing, in one press.
   *
   * Everything here is something a team could already do by hand — open a
   * field, then put their workspace in a seat — and the whole value is that
   * they do not have to, because the loop this makes possible is measured in
   * seconds and every step between typing and watching is spent out of it.
   *
   * Their own field, so their robots take the violet side, and the seat that
   * matches the robot: `violet-2` is robot 2 everywhere else on this server and
   * changing that here would break the one answer one-robot-one-place gives.
   * A refusal from opening a field — the queue, the per-team cap, practice
   * being closed — is passed back exactly as `/practice` would have said it,
   * because those are the same three answers and they are already phrased.
   */
  private async runFromWorkspace(req: Request, actor: Actor): Promise<Response> {
    const slug = actor.slug;
    if (slug === null) {
      return Response.json({ ok: false, reason: 'only a team can run its own code' }, { status: 403 });
    }
    const body = await readJsonBody(req, 1024);
    if (!body.ok) return badBody(body.reason, body.status);
    const validated = validateBody(body.payload, RunBodySchema, '"robot" must be 1 or 2');
    if (!validated.ok) return validated.response;
    const { robot } = validated.value;

    let arenaId = this.tenancy.fieldsOwnedBy(slug)[0] ?? null;
    if (arenaId === null) {
      const opened = await this.openPracticeField(actor, false);
      // Queued, capped, or practice closed: the answer is already written for a
      // person to read, and a second wording of it here would be a worse one.
      if (!opened.ok) return opened;
      arenaId = ((await opened.json()) as { field?: { id?: string } }).field?.id ?? null;
      if (arenaId === null) {
        return Response.json({ ok: false, reason: 'the field did not start' }, { status: 503 });
      }
    }

    const seat = `violet-${robot}`;
    const held = this.occupancy.inSeat(arenaId, seat);
    if (held && held.slug !== slug) {
      return Response.json(
        { ok: false, reason: `${held.slug}'s robot is in the ${seat} seat; take it out first` },
        { status: 409 },
      );
    }

    const port = this.arenas.portOf(arenaId);
    if (port === null) {
      return Response.json({ ok: false, reason: 'the field is no longer there' }, { status: 503 });
    }
    const claim = this.occupancy.claim(slug, robot, arenaId, seat);
    if (!claim.ok) {
      return Response.json({ ok: false, reason: this.whereItIs(claim.held, actor) }, { status: 409 });
    }

    const seated = await fetch(`http://127.0.0.1:${port}/practice-api/seat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat, fill: { kind: 'workspace', team: slug } }),
    }).catch(() => null);
    if (!seated || !seated.ok) {
      // The child would not take it, so the ledger must not claim it did.
      this.occupancy.release(arenaId, seat);
      return Response.json({ ok: false, reason: 'the field is not answering' }, { status: 502 });
    }

    this.log(`[practice] ${slug} ran robot ${robot} on ${arenaId}`);
    return Response.json(
      { ok: true, field: { id: arenaId, url: `/a/${arenaId}/practice/` }, seat },
      { status: 200 },
    );
  }

  /**
   * A request for a practice arena, which the hub no longer simply forwards.
   *
   * Watching stays open — the viewer and its socket pass through untouched,
   * because a practice match is football and Phase 4's position on watching has
   * not changed. What is gated is the *console*: the thing that drags robots
   * around and decides what is in a seat. And one action is more than gated,
   * because the answer to it depends on every other field on this server.
   */
  private async toPracticeArena(
    req: Request,
    id: string,
    rest: string,
    actor: Actor,
    port: number,
  ): Promise<Response> {
    const isConsole = rest === '/practice' || rest.startsWith('/practice/');
    const isApi = rest.startsWith('/practice-api/');
    if (!isConsole && !isApi) return await this.forward(id, port, rest, req, new Headers(req.headers));

    if (!this.mayBeOnField(actor, id)) return this.refuse(req, actor, `/a/${id}/practice/`);

    // Who the console is talking to, answered here and never forwarded: a
    // child arena has never heard of an account and never will. A standalone
    // practice field answers 404 to this, which is how the same console knows
    // it is on a laptop and shows every seat to whoever opened the page.
    if (rest === '/practice-api/who') {
      const owner = this.tenancy.ownerOf(id);
      return Response.json(
        {
          ok: true,
          you: actor.slug,
          owner,
          guests: this.tenancy.guestsOf(id),
          invited: this.tenancy.invitedTo(id),
          mayRun: this.mayRunField(actor, id),
          anyTeam: can(actor, 'match.join'),
          seats: Object.fromEntries(
            this.occupancy
              .all()
              .filter((r) => r.arenaId === id)
              .map((r) => [r.seatId, { team: r.slug, number: r.number }]),
          ),
        },
        { status: 200 },
      );
    }

    // A seat's output is the one GET that is not simply passed on. Everything
    // else a field says is said to everybody on it; a traceback is one team's
    // half-written code failing, and it belongs to them and to whoever owns the
    // field they are sitting on.
    if (rest.startsWith('/practice-api/output')) {
      const asked = new URL(req.url);
      const refusal = this.mayTouchSeat(actor, id, asked.searchParams.get('seat') ?? '');
      if (refusal) return refusal;
      // `rest` is a path and nothing else — `splitArenaPath` works on
      // `pathname` — so the query has to be put back on. This is the first
      // thing forwarded to an arena that has one.
      return await this.forward(id, port, `${rest}${asked.search}`, req, new Headers(req.headers));
    }

    if (isConsole || req.method !== 'POST') {
      const answer = await this.forward(id, port, rest, req, new Headers(req.headers));
      return rest === '/practice-api/state' ? await this.withNotice(id, answer) : answer;
    }

    const action = rest.slice('/practice-api/'.length);
    if (action === 'seat' || action === 'seat-restart' || action === 'seat-stop') {
      return await this.practiceSeat(req, id, rest, action, actor, port);
    }
    // Everything else on a field — dragging a robot, starting, stopping,
    // re-staging — belongs to whoever opened it.
    if (!this.mayRunField(actor, id)) {
      return Response.json(
        { ok: false, reason: 'this field belongs to another team; you can fill your own seats on it' },
        { status: 403 },
      );
    }
    return await this.forward(id, port, rest, req, new Headers(req.headers));
  }

  /**
   * The one action the hub answers for itself before forwarding.
   *
   * Reading the body consumes it, so the request is re-issued with the text
   * that was read — and for a laptop seat the fill that goes on to the child is
   * not quite the one the browser sent, because the hub adds a token to it.
   */
  private async practiceSeat(
    req: Request,
    id: string,
    rest: string,
    action: string,
    actor: Actor,
    port: number,
  ): Promise<Response> {
    const body = await readJsonBody(req, 4096);
    if (!body.ok) return badBody(body.reason, body.status);

    const headers = new Headers(req.headers);
    headers.delete('content-length');

    if (action !== 'seat') {
      const validated = validateBody(body.payload, SeatActionBodySchema, '"seat" must be a seat id');
      if (!validated.ok) return validated.response;
      // Restarting or stopping a seat's program does not change what is in the
      // seat, so it changes no occupancy either: the seat still names that
      // robot and pressing Start brings it back. Occupancy follows the fill,
      // not the process.
      const refusal = this.mayTouchSeat(actor, id, validated.value.seat);
      if (refusal) return refusal;
      return await this.forward(id, port, rest, req, headers, JSON.stringify(validated.value));
    }

    const validated = validateBody(body.payload, SeatBodySchema, (path) =>
      path === 'seat'
        ? '"seat" must be a seat id'
        : path.startsWith('fill.')
          ? '"team" is required for a submission'
          : '"fill" must be "empty", "built-in", "laptop" or "submission"',
    );
    if (!validated.ok) return validated.response;

    const { seat, fill } = validated.value;
    const number = numberOfSeat(seat);
    let sending = fill;

    if (fill.kind === 'submission' || fill.kind === 'laptop' || fill.kind === 'workspace') {
      if (!fill.team) {
        return badBody('say which team\'s robot is taking this seat', 400);
      }
      const team = slugifyTeam(fill.team);
      // The team comes from the credential, never from the body — Phase 1's
      // rule, and the reason a person cannot seat somebody else's robot here.
      if (!can(actor, 'match.join', team)) {
        return Response.json(
          { ok: false, reason: 'you can only put your own robots in a seat' },
          { status: 403 },
        );
      }
      // Running a workspace reads code that was never pushed, so it is a
      // workspace act as well as a seating one. An organiser who may seat
      // anybody's robot still may not run what a team has not submitted
      // unless they may open that team's editor.
      if (fill.kind === 'workspace' && !can(actor, 'team.workspace.write', team)) {
        return Response.json(
          { ok: false, reason: 'only the team itself can run its unpushed code' },
          { status: 403 },
        );
      }
      const claim = this.occupancy.claim(team, number, id, seat);
      if (!claim.ok) {
        return Response.json({ ok: false, reason: this.whereItIs(claim.held, actor) }, { status: 409 });
      }
      if (fill.kind === 'laptop') {
        // Short-lived, this seat only, and never shown in the field's state:
        // the console is told it once, in the answer to this request.
        sending = { ...fill, team, token: randomBytes(18).toString('base64url') };
      } else {
        sending = { ...fill, team };
      }
    } else {
      const refusal = this.mayTouchSeat(actor, id, seat);
      if (refusal) return refusal;
      this.occupancy.release(id, seat);
    }

    const forwarded = await this.forward(
      id,
      port,
      rest,
      req,
      headers,
      JSON.stringify({ seat, fill: sending }),
    );
    if (!forwarded.ok) {
      // The child would not take it, so the ledger must not claim it did.
      if (sending.kind !== 'empty' && sending.kind !== 'built-in') this.occupancy.release(id, seat);
      return forwarded;
    }
    if (sending.kind !== 'laptop') return forwarded;

    // The one thing the hub adds to an arena's answer: how to actually join.
    const state = await forwarded.json().catch(() => ({}));
    return Response.json(
      {
        ...(state as object),
        join: {
          seat,
          token: sending.token,
          url: this.agentUrl(req, id),
          command: `python3 python/join.py --token ${sending.token} --url ${this.agentUrl(req, id)} my_robot.py`,
        },
      },
      { status: forwarded.status },
    );
  }

  /**
   * Whether this person may empty, restart or stop this seat.
   *
   * A seat holding somebody's robot is that team's seat while it does — but the
   * field's owner may always clear one, because a guest who has gone home
   * otherwise holds a seat on a field that is not theirs until it closes.
   */
  private mayTouchSeat(actor: Actor, arenaId: string, seatId: string): Response | null {
    if (this.mayRunField(actor, arenaId)) return null;
    const held = this.occupancy.inSeat(arenaId, seatId);
    if (held === null || can(actor, 'match.join', held.slug)) return null;
    return Response.json(
      { ok: false, reason: 'that seat has another team\'s robot in it' },
      { status: 403 },
    );
  }

  /** Where a robot already is, said so a fifteen-year-old can act on it. */
  private whereItIs(held: Placement, actor: Actor): string {
    const owner = this.tenancy.ownerOf(held.arenaId);
    const whose =
      owner === null
        ? 'another field'
        : owner === actor.slug
          ? 'your own practice field'
          : `${owner}'s practice field`;
    return (
      `robot ${held.number} is already in the ${held.seatId} seat on ${whose}. ` +
      `Take it out of that seat first — each of your two robots can only be in one place at a time.`
    );
  }

  /**
   * Add whatever the hub has to say to the state the console is polling.
   *
   * A child arena knows nothing about fixtures or about the team whose robots
   * just left it, so the explanation can only come from up here — and it has to
   * ride along with something the console already asks for, or it is a line
   * nobody ever sees.
   */
  private async withNotice(id: string, answer: Response): Promise<Response> {
    const notice = this.fieldNotices.get(id);
    if (!notice || !answer.ok) return answer;
    const state = await answer.json().catch(() => null);
    if (state === null || typeof state !== 'object') return answer;
    return Response.json({ ...(state as object), notice }, { status: answer.status });
  }

  /** Where a robot on somebody's laptop connects to reach this arena. */
  private agentUrl(req: Request, id: string): string {
    const url = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host = req.headers.get('host') ?? url.host;
    return `${proto === 'https' ? 'wss' : 'ws'}://${host}/a/${id}/agent`;
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
        const validated = validateBody(
          body.payload,
          RegisterBodySchema,
          (path) =>
            path === 'email'
              ? 'email is not a valid address'
              : path === 'password'
                ? 'a password of at least 10 characters is required'
                : 'a valid invitation code and a password are required',
        );
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
      return Response.json(await this.teamPage(path.slice('/team/'.length), actor), { status: 200 });
    }

    // A team's field: who is on it, who has been asked, and giving it back.
    // Under the hub's own namespace rather than under `/a/<id>/`, because none
    // of it is anything a child arena has ever heard of.
    if (path.startsWith('/fields/') && req.method === 'POST') {
      const [, , id, verb] = path.split('/');
      if (!id || !verb) return badBody('no field at that address', 404);
      return await this.handleField(req, id, verb, actor);
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
      const playing = this.fixtureForArena(id);
      if (playing) this.liveFixtures.delete(playing.fixture.id);
      const stopped = this.arenas.close(id);
      const account = this.accountFor(req);
      if (stopped && account) this.accounts.record(account.id, 'arena.kill', id, 'stopped an arena');
      return Response.json({ ok: stopped }, { status: stopped ? 200 : 404 });
    }

    if (path === '/referee/fixtures' && req.method === 'GET') {
      if (!this.mayReferee(actor)) return this.refuse(req, actor, '/referee');
      return Response.json(await this.refereeFixtures(actor), { status: 200 });
    }

    if (path.startsWith('/referee/match/') && req.method === 'GET') {
      if (!this.mayReferee(actor)) return this.refuse(req, actor, '/referee');
      const answer = await this.refereeMatch(path.slice('/referee/match/'.length), actor);
      return Response.json(answer.payload, { status: answer.status });
    }

    // Opening pre-game: the one request in this server that causes a child
    // process to exist. Beside the GET above rather than under it — the GET is
    // method-guarded, so nothing collides.
    if (path.startsWith('/referee/match/') && path.endsWith('/open') && req.method === 'POST') {
      if (!this.mayReferee(actor)) return this.refuse(req, actor, '/referee');
      const fixtureId = path.slice('/referee/match/'.length, -'/open'.length);
      return this.openPregame(req, fixtureId, actor);
    }

    // The two answers a referee can give at full time. Beside the GET above
    // rather than under it: the GET is method-guarded, so nothing collides.
    for (const [verb, verdict] of [
      ['confirm', 'confirmed'],
      ['replay', 'replay'],
    ] as const) {
      const suffix = `/${verb}`;
      if (path.startsWith('/referee/match/') && path.endsWith(suffix) && req.method === 'POST') {
        if (!this.mayReferee(actor)) return this.refuse(req, actor, '/referee');
        const fixtureId = path.slice('/referee/match/'.length, -suffix.length);
        return this.settleConfirmation(req, fixtureId, verdict, actor);
      }
    }

    if (path === '/me' && req.method === 'GET') {
      const account = this.accountFor(req);
      return Response.json(
        {
          ok: true,
          account: account && publicAccount(account),
          can: {
            workspace: can(actor, 'team.workspace.write', actor.slug ?? undefined),
            referee: this.mayReferee(actor),
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
   * Phase 12 is the real admin area — arenas, team files, draw amendments, the
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
      // With its state, because "up next" and "up next, and the referee has not
      // opened it yet" are different things to a hall watching a screen.
      .map((f) => ({ id: f.id, home: f.home, away: f.away, state: this.stateOf(f.id, false) }));
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

  /**
   * A referee's day: every fixture in this draw they may take.
   *
   * Folded from the draw rather than read off the live arenas, because the
   * question a referee has twenty minutes early — "which one is mine?" — is
   * about a match that has not started, and `live` cannot answer it.
   *
   * The narrowing needs no role branching: an admin holds `match.control` over
   * everything and keeps every fixture, a referee keeps the ones assigned to
   * them. Two things fall out of asking it this way. An assignment naming some
   * other draw never appears, because only this draw's fixtures are offered to
   * the check; and the demo arena is not in any draw, so it stops being
   * something a referee is invited to referee.
   */
  private async refereeFixtures(actor: Actor): Promise<unknown> {
    const loaded = await this.tournament();
    if (!loaded) return { ok: true, tournament: null, fixtures: [] };
    const { draw, results } = loaded;
    const byId = new Map(results.map((r) => [r.fixtureId, r]));

    const mine = draw.fixtures.filter((f) => can(actor, 'match.control', fixtureTarget(draw.id, f.id)));
    const cards = mine.map((f) => {
      const live = this.liveFor(f.id);
      const result = byId.get(f.id);
      return {
        id: f.id,
        home: f.home,
        away: f.away,
        state: this.stateOf(f.id, result !== undefined),
        ...(live ? { live, console: `/a/${live.arenaId}/referee/` } : {}),
        ...(result ? resultCard(result) : {}),
      };
    });

    // What wants them now, then what is on, then what is coming, then what is
    // done — a referee in a hall reads the top of this list and walks
    // somewhere. Every state has to be in here: a missing one sorts as `NaN`,
    // which is not an ordering at all, and Slice E's `confirming` spent its
    // first afternoon quietly unsorted for exactly that reason.
    const order: Record<FixtureState, number> = {
      confirming: 0,
      playing: 1,
      opening: 2,
      due: 3,
      upcoming: 4,
      played: 5,
    };
    cards.sort((a, b) => order[a.state] - order[b.state]);
    return { ok: true, tournament: summary(draw), fixtures: cards };
  }

  /**
   * One fixture, at a name that does not move.
   *
   * An arena id is born with the match and is gone after it, so it is no use
   * to a referee who wants to look at this before it starts, bookmark it, or
   * be sent it. A fixture id is in the draw and outlives every process.
   */
  private async refereeMatch(fixtureId: string, actor: Actor): Promise<{ payload: unknown; status: number }> {
    const loaded = await this.tournament();
    if (!loaded) return { payload: { ok: false, reason: 'this server is not running a tournament' }, status: 200 };
    const fixture = loaded.draw.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) return { payload: { ok: false, reason: 'no such fixture' }, status: 200 };
    if (!can(actor, 'match.control', fixtureTarget(loaded.draw.id, fixture.id))) {
      return { payload: { ok: false, reason: 'this match is not yours to referee' }, status: 403 };
    }

    const result = loaded.results.find((r) => r.fixtureId === fixtureId);
    const live = this.liveFor(fixtureId);
    const waiting = this.confirming.get(fixtureId);
    return {
      payload: {
        ok: true,
        tournament: summary(loaded.draw),
        fixture: { id: fixture.id, home: fixture.home, away: fixture.away },
        state: this.stateOf(fixtureId, result !== undefined),
        live,
        console: live ? `/a/${live.arenaId}/referee/` : null,
        // The score being asked about, carried rather than read off the arena:
        // an admin may have stopped the child process after full time, and the
        // referee is still owed the number they are agreeing to.
        final: waiting ? { ...resultCard(waiting.result), since: waiting.since } : null,
      },
      status: 200,
    };
  }

  /**
   * Open a fixture's pre-game, which is what spawns its arena.
   *
   * Narrowed by the same targeted check as everything else about a match, with
   * the draw taken from the waiting fixture itself. Two shapes of answer that
   * are not the obvious ones:
   *
   * - **Idempotent.** A referee who presses a button and sees nothing happen
   *   presses it again, and a child process takes a moment to come up. A second
   *   press on a match already opening or already open is a 200, not an error.
   * - **404 for a fixture that is not due**, which reveals nothing the public
   *   schedule does not already say.
   */
  private openPregame(req: Request, fixtureId: string, actor: Actor): Response {
    if (this.opening.has(fixtureId) || this.liveFixtures.has(fixtureId)) {
      return Response.json({ ok: true, already: true }, { status: 200 });
    }
    const waiting = this.due.get(fixtureId);
    if (!waiting) {
      return Response.json(
        { ok: false, reason: 'that match is not ready to be opened yet' },
        { status: 404 },
      );
    }
    if (!can(actor, 'match.control', fixtureTarget(waiting.drawId, fixtureId))) {
      return Response.json({ ok: false, reason: 'this match is not yours to referee' }, { status: 403 });
    }

    this.due.delete(fixtureId);
    this.opening.add(fixtureId);
    waiting.settle();

    const account = this.accountFor(req);
    if (account) {
      this.accounts.record(
        account.id,
        'match.control',
        fixtureTarget(waiting.drawId, fixtureId),
        'opened pre-game',
      );
    }
    this.log(`[fixture ${fixtureId}] opened by ${account?.slug ?? 'nobody in particular'}`);
    return Response.json({ ok: true }, { status: 200 });
  }

  /**
   * A referee's answer at full time: write this down, or play it again.
   *
   * Narrowed by the same targeted check as everything else about a match — the
   * draw is taken from the waiting fixture itself, so a referee holding the
   * same fixture id in a different division cannot answer for this one. A
   * fixture nothing is waiting on is a 404 whoever asks, which reveals nothing
   * the public schedule does not already say.
   */
  private settleConfirmation(
    req: Request,
    fixtureId: string,
    verdict: Confirmation,
    actor: Actor,
  ): Response {
    const waiting = this.confirming.get(fixtureId);
    if (!waiting) {
      return Response.json(
        { ok: false, reason: 'nothing is waiting to be confirmed for that match' },
        { status: 404 },
      );
    }
    if (!can(actor, 'match.control', fixtureTarget(waiting.drawId, fixtureId))) {
      return Response.json({ ok: false, reason: 'this match is not yours to referee' }, { status: 403 });
    }

    this.confirming.delete(fixtureId);
    waiting.settle(verdict);

    const account = this.accountFor(req);
    if (account) {
      this.accounts.record(
        account.id,
        'match.control',
        fixtureTarget(waiting.drawId, fixtureId),
        verdict === 'confirmed' ? 'confirmed the result' : 'sent the match back to be played again',
      );
    }
    this.log(
      `[fixture ${fixtureId}] ${verdict === 'confirmed' ? 'confirmed' : 'to be played again'}` +
        ` by ${account?.slug ?? 'nobody in particular'}`,
    );
    return Response.json({ ok: true, verdict }, { status: 200 });
  }

  private async schedule(): Promise<unknown> {
    const loaded = await this.tournament();
    if (!loaded) return { ok: true, tournament: null, fixtures: [] };
    const { draw, results } = loaded;
    const byId = new Map(results.map((r) => [r.fixtureId, r]));
    return {
      ok: true,
      tournament: summary(draw),
      fixtures: draw.fixtures.map((f) => {
        const result = byId.get(f.id);
        return {
          id: f.id,
          home: f.home,
          away: f.away,
          state: this.stateOf(f.id, result !== undefined),
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
      state: this.stateOf(fixtureId, result !== undefined),
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
              robotStats: leg.result.robotStats,
            })),
          }
        : null,
    };
  }

  /**
   * One field, acted on by name: invite, accept, decline, close.
   *
   * Every one of these is a sentence about people rather than about football,
   * which is why none of them is forwarded to the arena. The arena is told
   * only the consequences, and mostly there are none — a guest list is not
   * something a physics loop can act on.
   */
  private async handleField(req: Request, id: string, verb: string, actor: Actor): Promise<Response> {
    const owner = this.tenancy.ownerOf(id);
    if (owner === null && this.arenas.info(id)?.kind !== 'practice') {
      return Response.json({ ok: false, reason: 'no practice field at that address' }, { status: 404 });
    }

    if (verb === 'invite') {
      if (!can(actor, 'field.invite', owner ?? undefined)) return this.refuse(req, actor, '/team');
      const body = await readJsonBody(req, 4096);
      if (!body.ok) return badBody(body.reason, body.status);
      const validated = validateBody(body.payload, InviteTeamBodySchema, '"team" must be a team name');
      if (!validated.ok) return validated.response;
      const to = slugifyTeam(validated.value.team);
      // A team that does not exist can never accept, and the owner would sit
      // waiting for somebody who was never asked.
      if (!this.accounts.bySlug(to)) {
        return Response.json({ ok: false, reason: `no team here called "${validated.value.team}"` }, { status: 404 });
      }
      const invited = this.tenancy.invite(id, to);
      if (!invited.ok) return Response.json(invited, { status: 409 });
      this.log(`[practice] ${owner ?? 'somebody'} invited ${to} onto ${id}`);
      return Response.json({ ok: true, invited: to }, { status: 200 });
    }

    if (verb === 'accept' || verb === 'decline') {
      const slug = actor.slug;
      if (slug === null) return this.refuse(req, actor, '/team');
      if (verb === 'decline') {
        this.tenancy.decline(id, slug);
        return Response.json({ ok: true }, { status: 200 });
      }
      const accepted = this.tenancy.accept(id, slug);
      if (!accepted.ok) return Response.json(accepted, { status: 403 });
      return Response.json({ ok: true, field: `/a/${id}/practice/` }, { status: 200 });
    }

    if (verb === 'close') {
      if (!this.mayRunField(actor, id)) return this.refuse(req, actor, '/team');
      this.arenas.close(id);
      return Response.json({ ok: true }, { status: 200 });
    }

    if (verb === 'leave') {
      // A guest giving a field back, which frees their robots without
      // troubling the team who invited them.
      const slug = actor.slug;
      if (slug === null) return this.refuse(req, actor, '/team');
      for (const { at } of this.occupancy.forTeam(slug)) {
        if (at?.arenaId === id) this.occupancy.release(id, at.seatId);
      }
      this.tenancy.removeGuest(id, slug);
      return Response.json({ ok: true }, { status: 200 });
    }

    return Response.json({ ok: false, reason: 'no such action on a field' }, { status: 404 });
  }

  /**
   * What this team's own dashboard needs that the public page must not show.
   *
   * Where their field is, where each of their two robots is, who they have
   * invited and who has invited them, and their place in the queue. It is
   * gated on `field.control` at the team's own slug, so a visitor reading the
   * public team page gets none of it.
   */
  private yoursOnly(slug: string): unknown {
    const fields = this.tenancy.fieldsOwnedBy(slug).map((id) => ({
      id,
      url: `/a/${id}/practice/`,
      guests: this.tenancy.guestsOf(id),
      invited: this.tenancy.invitedTo(id),
      // A field about to be given back. Here as well as on the field itself,
      // because a team who has walked away from it is by definition not
      // looking at it.
      closingAt: this.closing.get(id) ?? null,
    }));
    const guestOf = this.tenancy
      .fieldsOpenTo(slug)
      .filter((id) => this.tenancy.ownerOf(id) !== slug)
      .map((id) => ({ id, url: `/a/${id}/practice/`, owner: this.tenancy.ownerOf(id) }));
    return {
      fields,
      guestOf,
      invitations: this.tenancy.invitationsFor(slug),
      robots: this.occupancy.forTeam(slug).map(({ number, at }) => ({
        number,
        at: at && {
          ...at,
          owner: this.tenancy.ownerOf(at.arenaId),
          url: `/a/${at.arenaId}/practice/`,
        },
      })),
      queue: this.tenancy.placeOf(slug),
      perTeam: this.settings.practice.perTeam,
    };
  }

  private async teamPage(slug: string, actor: Actor = GUEST): Promise<unknown> {
    const loaded = await this.tournament();
    const account = this.accounts.bySlug(slug);
    if (!loaded) {
      return {
        ok: true,
        team: account && publicAccount(account),
        fixtures: [],
        table: null,
        ...(can(actor, 'field.control', slug) ? { yours: this.yoursOnly(slug) } : {}),
      };
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
      ...(can(actor, 'field.control', slug) ? { yours: this.yoursOnly(slug) } : {}),
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
      // A world asks only whether this person referees at all — it is holding
      // one match and has no draw to name it by. Which match they may take is
      // decided by the hub, before the request is forwarded here.
      const found = actorOf(req);
      if (found === null) return false;
      return can(found.actor, 'match.control') || accounts.hasAssignment(found.account.id);
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
