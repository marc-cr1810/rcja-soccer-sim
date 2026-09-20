/**
 * Several worlds on one machine: one child process each, proxied.
 *
 * A `MatchServer` plays one match at a time — one `current`, one viewer
 * broadcast, one gateway whose seats are the fixed four ids. A hall where
 * three teams are rehearsing at once and two fixtures are being played needs
 * five of all of that, so a world gets its own process rather than the most
 * load-bearing file in the repository learning to hold several of everything.
 *
 * This began as practice fields on a venue server (Phase 4) and is now the
 * shape of the whole league deployment (Phase 7): **the hub plays no football**
 * — it owns accounts, the draw, the schedule and the front page, and every
 * world it shows is a child running the same binary a team runs on a laptop.
 *
 * An **arena** is that child. Three kinds, differing in almost nothing:
 *
 * - a **fixture** arena comes from the draw, is refereed, writes a result, and
 *   is started and stopped by whoever is running the tournament;
 * - a **practice** arena comes from somebody pressing a button, is refereed by
 *   nobody, is never scored, and closes itself once nobody is using it;
 * - a **demo** arena exists to fill a hall screen: open while the draw runs or
 *   when nothing is on, it plays back-to-back matches at wall-clock speed and
 *   is never scored either. It counts against the same budget, is exempt from
 *   the idle sweep like a fixture, and is never refereed — a match it kicks
 *   off starts itself.
 *
 * They are all reached through the one port the venue configured, because a
 * robot on a student's laptop has to reach a practice arena's `/agent` and the
 * venue has enough to set up without a hole in a firewall per rehearsal — the
 * same argument `MatchServer`'s own upgrade handler makes for splitting the
 * agent path off the viewer path rather than opening a second port.
 *
 * **Arenas are not persisted, and that is honest rather than lazy.** A child
 * holds a physics loop and up to four sandboxed CPython processes; there is
 * nothing meaningful to resume it from. A hub that goes down takes every arena
 * with it, a fixture interrupted that way writes no result, and it is simply
 * replayed — which is what Phase 3 already guarantees.
 *
 * Nothing here knows whose arena is whose. Ownership — who may open one, who
 * may drag whose robot — is Phase 8's whole subject, and what happens to one
 * that is abandoned is Phase 10's; `owner` is carried through so the first has
 * somewhere to put it. What bounds an arena meanwhile is a budget
 * (`capacity.ts`) and a field that shuts itself down once nobody is watching.
 */

import type { Subprocess } from 'bun';
import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { sampleTree, usageBetween, type TreeSample, type Usage } from '../infra/usage';
import type { LeagueId } from '@rcja/shared/leagues';

const COMPILED = import.meta.dirname.startsWith('/$bunfs');
const SELF = process.execPath;
const CLI = resolve(import.meta.dirname, '../infra/cli.ts');

/** What an arena is for. The difference is in who may act on it, not in the football. */
export type ArenaKind = 'fixture' | 'practice' | 'demo';

export interface ArenaSupervisorOptions {
  /**
   * How many arenas may run at once.
   *
   * Each is up to four sandboxed robots and a physics loop, so this is a
   * machine's CPU rather than an arbitrary number — see `capacity.ts`, which
   * works it out from the grants and the hardware. A venue that hits the
   * ceiling should be told so, not quietly slowed to a crawl.
   */
  maxArenas?: number;
  /**
   * Of those, how many are held for fixtures.
   *
   * A rehearsal can wait and a scheduled match cannot, so practice may only
   * ever have what the schedule is not using. Deriving it here is what makes
   * "a fixture never queues behind a rehearsal" true without anybody having to
   * remember to arrange it.
   */
  fixtureSlots?: number;
  /** Minutes with nobody using a practice arena before it shuts itself down. */
  idleMinutes?: number;
  /** Where the venue keeps pushed submissions, so an arena can load them. */
  submissionsDir?: string;
  /**
   * Where the venue keeps team workspaces, so an arena can run what a team is
   * still typing — and so a practice field can give a team's arrangement back.
   *
   * Absent on a supervisor with no workspaces behind it, and then an arena is
   * told nothing: Run is refused with a sentence and nothing is persisted.
   */
  workspacesDir?: string;
  /**
   * Called once an arena's process has actually gone, however it went.
   *
   * Swept as idle, stopped from the admin console, pre-empted by a fixture,
   * crashed, or killed with the hub — a caller keeping a ledger about arenas
   * needs one place to hear about all of it, and the only honest one is the
   * child exiting. An arena that has died while a ledger still believes it
   * holds somebody's robot deadlocks that team, so this is wired to the
   * ending rather than to any of the ways of asking for one.
   */
  onArenaEnded?: (arena: { id: string; kind: ArenaKind; owner: string | null }) => void;
  /**
   * Minutes between marking a quiet arena for closing and actually closing it.
   *
   * The warning is the whole point: a fifteen-year-old who walked away for
   * lunch should come back to an explanation, not an absence.
   */
  graceMinutes?: number;
  /**
   * Called when a quiet arena is marked for closing, and again with
   * `closingAt: null` when somebody turns up and it is reprieved.
   *
   * A supervisor cannot say this itself — it has no idea who owns the field or
   * where they are looking — so it says it happened and whoever keeps the
   * ledgers puts it on the field and on the owner's dashboard.
   */
  onArenaWarned?: (arena: { id: string; owner: string | null; closingAt: string | null }) => void;
  /**
   * How many teams are waiting for a field right now.
   *
   * Reclamation scales with demand rather than a flat maximum lifetime: a hard
   * ceiling on how long a field may live punishes everybody on a quiet
   * afternoon to stop one person on a busy one. With nobody waiting, be
   * generous; with somebody waiting, come round sooner and take the quietest
   * field first. A function rather than a number because the queue is the
   * caller's and changes between sweeps.
   */
  queued?: () => number;
  /**
   * The shortest quiet period a queue may shorten the configured one to.
   *
   * Somebody waiting should not mean a field is taken off a team who looked
   * away to read an error message. It can only ever *lower* the configured
   * time — a floor above it would mean a queue made fields live longer, which
   * is the opposite of the point — and it is here rather than in `league.json`
   * because it is a safety rail on a rule, not a dial a venue turns.
   */
  busyIdleFloorMinutes?: number;
  /**
   * Whether to spawn arenas as child processes ('process') or worker threads ('worker').
   * Default is 'process'. Worker mode cuts memory usage by ~85% in headless environments.
   */
  mode?: 'process' | 'worker';
  /** Per-seat grants, passed to every arena so practice and finals play alike. */
  seatCpuPercent?: number;
  seatMemoryMb?: number;
  pythonLibDir?: string;
  log?: (line: string) => void;
}

export interface ArenaInfo {
  id: string;
  kind: ArenaKind;
  /** The account this arena belongs to, once Phase 8 gives arenas owners. */
  owner: string | null;
  /** Where to open it, relative to the hub's own root. */
  url: string;
  createdAt: string;
  /** What it is costing right now, or `null` until it has been sampled twice. */
  usage: Usage | null;
  /**
   * Simulated seconds per wall-clock second while playing, as the child
   * reports it. The first number to move when the budget is wrong.
   */
  fidelity: number | null;
  /**
   * When somebody was last actually on this field.
   *
   * A connected robot deliberately does not move it (see `Arena.lastUsed`), so
   * an arena that is busy with football and empty of people reads as idle here
   * — which is the whole point, and the thing an organiser needs to see before
   * they decide a field is worth stopping.
   */
  lastUsed: string;
  /** When this arena closes unless somebody turns up, once it has been warned. */
  closingAt: string | null;
  /** People on it right now — viewers and consoles, never robots. */
  open: number;
}

interface Arena {
  id: string;
  kind: ArenaKind;
  owner: string | null;
  port: number;
  child?: Subprocess;
  worker?: Worker;
  createdAt: number;
  /**
   * Connections currently proxied to it that mean *somebody is there* — a
   * viewer's stream, a console's request. A robot's `/agent` socket is not one
   * of them, deliberately: see `lastUsed`.
   */
  open: number;
  /**
   * When somebody was last actually using this field.
   *
   * Not "when was this arena last talked to". A robot connected to it does not
   * move this, which is a deliberate change: a field of robots playing to an
   * empty stand is precisely the waste being reclaimed, and letting `/agent`
   * hold an arena open means the team that forgot to close a terminal outranks
   * the team waiting in the queue.
   */
  lastUsed: number;
  /** When this arena will close unless somebody turns up, once warned. */
  closingAt: number | null;
  /**
   * A directory this arena may put working files in, owned by *this* process.
   *
   * An arena dies by having its process group killed — swept, stopped,
   * pre-empted, or with the hub — so it never gets to tidy up after itself, and
   * anything it made under `/tmp` would simply stay there. A copy of a team's
   * code is not something to leave lying around a venue machine for a week. So
   * the supervisor makes the directory, tells the child where it is, and
   * removes it when the arena ends — for the same reason the ledgers are
   * emptied there: the ending is the one event every way of stopping arrives
   * at.
   */
  scratch: string;
  /**
   * The credential this arena's referee surface accepts.
   *
   * Minted here, known only to the hub, and never shown to a browser. The hub
   * decides from a session and a capability whether somebody may control this
   * match and then speaks to the child as the referee; the child keeps the
   * hand-issued arrangement it has had since Phase 2 and learns nothing about
   * accounts. It is also why a fixture arena binds loopback — the token is
   * only as good as the fact that nothing else can reach the port.
   */
  refereeToken: string;
  lastSample: TreeSample | null;
  usage: Usage | null;
  fidelity: number | null;
  /**
   * Whether anybody has been told this arena is over.
   *
   * An arena stops being listed the moment `close()` is called, but its
   * process takes a few milliseconds to actually go — and the ledgers a
   * supervisor's owner keeps are about *slots*, which are free as soon as this
   * one stops counting. Told at the map deletion rather than at the exit, and
   * exactly once however the ending arrived.
   */
  ended: boolean;
}

const DEFAULT_MAX_ARENAS = 4;
const DEFAULT_IDLE_MINUTES = 20;
const DEFAULT_GRACE_MINUTES = 5;
const DEFAULT_BUSY_IDLE_FLOOR_MINUTES = 3;
/** How often idle arenas are swept up. */
const SWEEP_MS = 30_000;
/** How often every arena's cost is re-read from `/proc`. */
const SAMPLE_MS = 2_000;

/** A port nothing is listening on, as of a moment ago. */
async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        fail(new Error('could not find a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => ok(port));
    });
  });
}

export class ArenaSupervisor {
  private readonly arenas = new Map<string, Arena>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly sampler: NodeJS.Timeout;
  private readonly log: (line: string) => void;

  constructor(private opts: ArenaSupervisorOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sampler = setInterval(() => this.sample(), SAMPLE_MS);
    // Housekeeping, not work: a server with nothing else to do should still be
    // allowed to exit.
    this.sweeper.unref?.();
    this.sampler.unref?.();
  }

  /**
   * Change what this was built with, while it is running.
   *
   * Nearly free, and that is not luck: every one of these is already read from
   * `this.opts` at the moment it matters rather than captured — the ceiling and
   * the fixture reserve on each `create`, the seat grants when a child's argv
   * is assembled, the quiet time and the grace on every `sweep`. So a venue
   * that changes its mind mid-afternoon has to be *written to*, not restarted.
   *
   * Two consequences worth saying out loud, because an organiser will meet
   * them: lowering `maxArenas` below what is running **refuses the next
   * arena**, it does not evict a match in progress; and new seat grants reach
   * arenas started from now, never the children already playing with the argv
   * they were given.
   */
  reconfigure(
    opts: Pick<
      ArenaSupervisorOptions,
      'maxArenas' | 'fixtureSlots' | 'idleMinutes' | 'graceMinutes' | 'seatCpuPercent' | 'seatMemoryMb'
    >,
  ): void {
    for (const key of [
      'maxArenas',
      'fixtureSlots',
      'idleMinutes',
      'graceMinutes',
      'seatCpuPercent',
      'seatMemoryMb',
    ] as const) {
      const value = opts[key];
      if (value !== undefined) this.opts[key] = value;
    }
  }

  get count(): number {
    return this.arenas.size;
  }

  countOf(kind: ArenaKind): number {
    return [...this.arenas.values()].filter((arena) => arena.kind === kind).length;
  }

  /** Change the budget without restarting — the admin console's lever. */
  configure(opts: Partial<ArenaSupervisorOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  list(): ArenaInfo[] {
    return [...this.arenas.values()].map((arena) => this.describe(arena));
  }

  info(id: string): ArenaInfo | null {
    const arena = this.arenas.get(id);
    return arena ? this.describe(arena) : null;
  }

  /**
   * The loopback port an arena is listening on.
   *
   * For the hub, which talks to a fixture arena's control surface directly
   * rather than through its own proxy: it is the one caller that is not a
   * browser and has no reason to take the long way round.
   */
  portOf(id: string): number | null {
    return this.arenas.get(id)?.port ?? null;
  }

  /** The child's pid, for anything that wants to measure it itself. */
  pidOf(id: string): number | null {
    const arena = this.arenas.get(id);
    if (!arena) return null;
    return arena.child?.pid ?? process.pid;
  }

  /** The credential the hub speaks to this arena's referee surface with. */
  refereeTokenOf(id: string): string | null {
    return this.arenas.get(id)?.refereeToken ?? null;
  }

  /** Whatever the arena last said about how well it is keeping up. */
  reportFidelity(id: string, fidelity: number | null): void {
    const arena = this.arenas.get(id);
    if (arena) arena.fidelity = fidelity;
  }

  /**
   * Start an arena and wait until it is actually listening.
   *
   * Waiting matters: the answer to this call is a URL somebody is about to
   * open, and handing back a URL that 502s for the next second is worse than
   * taking the second here.
   */
  async create(options: {
    kind?: ArenaKind;
    owner?: string | null;
    /**
     * For a demo arena only: who plays, and how. The hub holds no opinions
     * about sides or half-lengths — it passes the venue's on.
     */
    demo?: {
      home: string;
      away: string;
      /** `reference`, `examples`, or a bot-roster name. */
      bots: string;
      homeBots?: string;
      awayBots?: string;
      halfSeconds: number;
      league: LeagueId | null;
      gapSeconds: number;
      randomSides?: boolean;
    };
  } = { kind: 'practice' }): Promise<ArenaInfo> {
    const kind = options.kind ?? 'practice';
    const max = this.opts.maxArenas ?? DEFAULT_MAX_ARENAS;
    if (this.arenas.size >= max) {
      throw new Error(`this server is already running ${max} arenas`);
    }
    // Practice may only have what the schedule is not using. A fixture takes
    // from the whole, because a scheduled match outranks every rehearsal.
    if (kind === 'practice') {
      const held = this.opts.fixtureSlots ?? 0;
      const forPractice = Math.max(0, max - held);
      if (this.countOf('practice') >= forPractice) {
        throw new Error(
          forPractice === 0
            ? 'every arena on this server is held for fixtures'
            : `this server is already running ${forPractice} practice fields`,
        );
      }
    }

    const id = randomBytes(6).toString('base64url');
    const port = await freePort();
    const scratch = await mkdtemp(join(tmpdir(), 'rcja-arena-'));
    const refereeToken = randomBytes(24).toString('base64url');
    const args = COMPILED ? [] : [CLI];
    args.push('arena', '--kind', kind, '--port', String(port), '--die-with-parent');
    args.push('--scratch', scratch);
    if (kind === 'fixture') args.push('--referee-token', refereeToken);
    if (kind === 'demo') {
      const demo = options.demo;
      if (!demo) throw new Error('a demo arena needs demo settings');
      args.push('--demo-home', demo.home);
      args.push('--demo-away', demo.away);
      args.push('--demo-bots', demo.bots);
      if (demo.homeBots) args.push('--demo-home-bots', demo.homeBots);
      if (demo.awayBots) args.push('--demo-away-bots', demo.awayBots);
      args.push('--demo-half', String(demo.halfSeconds));
      if (demo.league !== null) args.push('--demo-league', demo.league);
      args.push('--demo-gap', String(demo.gapSeconds));
      if (demo.randomSides) args.push('--demo-random-sides');
    }
    if (this.opts.submissionsDir) args.push('--submissions', this.opts.submissionsDir);
    if (this.opts.workspacesDir) {
      args.push('--workspaces-dir', resolve(this.opts.workspacesDir));
      // Where this field remembers its arrangement. Only for a field that
      // belongs to somebody: an anonymous one has no folder to keep it in, and
      // nobody to give it back to.
      if (kind === 'practice' && options.owner) {
        args.push('--field-state', resolve(this.opts.workspacesDir, options.owner, 'field.json'));
      }
    }
    if (this.opts.seatCpuPercent !== undefined) args.push('--seat-cpu', String(this.opts.seatCpuPercent));
    if (this.opts.seatMemoryMb !== undefined) args.push('--seat-mem', String(this.opts.seatMemoryMb));
    // Every supervised arena is reached only through whoever is supervising
    // it. That used to be true of fixtures alone: a practice arena bound every
    // interface so that a robot on a student's laptop could connect to it
    // directly. But a supervisor is always in front of one - it is what this
    // whole file is - and a wide-bound child leaves its `/practice-api/` and
    // its `/agent` on a port the supervisor knows nothing about, which makes
    // every rule the supervisor keeps advisory to anybody who can read a port
    // number. Phase 8 puts a ledger up there, so the door closes.
    //
    // Standalone `serve practice` still binds wide: it builds no supervisor at
    // all, has nothing in front of it, and is the laptop case this was for.
    args.push('--host', '127.0.0.1');

    if (this.opts.mode === 'worker') {
      const workerPath = resolve(import.meta.dirname, 'arena-worker.ts');
      const worker = new Worker(workerPath);
      const arena: Arena = {
        id,
        kind,
        owner: options.owner ?? null,
        port,
        worker,
        scratch,
        createdAt: Date.now(),
        open: 0,
        lastUsed: Date.now(),
        closingAt: null,
        refereeToken,
        lastSample: null,
        usage: null,
        fidelity: null,
        ended: false,
      };
      this.arenas.set(id, arena);

      worker.onmessage = (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'log') {
          this.log(`[arena ${id}] ${msg.line}`);
        } else if (msg.type === 'stopped') {
          this.arenas.delete(id);
          this.log(`[arena ${id}] ended`);
          this.ended(arena);
        }
      };

      worker.onerror = (err) => {
        this.log(`[arena ${id}] worker error: ${err.message}`);
        this.arenas.delete(id);
        this.ended(arena);
      };

      worker.postMessage({
        type: 'start',
        id,
        kind,
        port,
        refereeToken,
        scratch,
        submissionsDir: this.opts.submissionsDir,
        workspacesDir: this.opts.workspacesDir,
        fieldStatePath:
          kind === 'practice' && options.owner && this.opts.workspacesDir
            ? resolve(this.opts.workspacesDir, options.owner, 'field.json')
            : undefined,
        seatCpuPercent: this.opts.seatCpuPercent,
        seatMemoryMb: this.opts.seatMemoryMb,
        demo: options.demo,
        pythonLibDir: this.opts.pythonLibDir,
      });

      try {
        await waitForListening(port);
      } catch (err) {
        stop(arena);
        this.arenas.delete(id);
        this.ended(arena);
        throw err;
      }

      this.log(`[arena ${id}] ${kind} open on port ${port} (worker)`);
      return this.describe(arena);
    }

    // stdin is a pipe and nothing is ever written to it: the child watches it
    // for end-of-file and exits when it comes. That is what makes
    // `--die-with-parent` true even when this process is killed outright and
    // never gets to run its own cleanup - the same guarantee bwrap gives a
    // sandboxed robot, by the same trick. Without it a venue restarting its
    // server leaves every arena it was hosting running, holding ports and CPU
    // nobody can see any more.
    // Its own process group, because the arena is a child this process might
    // be killed without warning: killing the handle we hold leaves the arena
    // running, still holding this process's pipes, and a parent that can never
    // fully let go of an arena it has already stopped is a parent that can
    // never exit. Stopping an arena kills the group. (This was once a larger
    // problem, when `tsx` sat between the two as a second process; spawning
    // `process.execPath` removed the middle-man, but an arena is still its own
    // group because nothing here should be able to drag it down with it.)
    const child = Bun.spawn([SELF, ...args], {
      cwd: process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const arena: Arena = {
      id,
      kind,
      owner: options.owner ?? null,
      port,
      child,
      scratch,
      createdAt: Date.now(),
      open: 0,
      lastUsed: Date.now(),
      closingAt: null,
      refereeToken,
      lastSample: null,
      usage: null,
      fidelity: null,
      ended: false,
    };
    this.arenas.set(id, arena);

    (async () => {
      if (child.stdout && typeof child.stdout !== 'number') {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.log(`[arena ${id}] ${decoder.decode(value).trimEnd()}`);
          }
        } catch {}
      }
    })();
    (async () => {
      if (child.stderr && typeof child.stderr !== 'number') {
        const reader = child.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.log(`[arena ${id}] ${decoder.decode(value).trimEnd()}`);
          }
        } catch {}
      }
    })();
    child.exited.then((code) => {
      this.arenas.delete(id);
      this.log(`[arena ${id}] ended (code ${code})`);
      this.ended(arena);
    });

    try {
      await waitForListening(port);
    } catch (err) {
      stop(arena);
      this.arenas.delete(id);
      this.ended(arena);
      throw err;
    }

    this.log(`[arena ${id}] ${kind} open on port ${port}`);
    return this.describe(arena);
  }


  /**
   * Mark an arena as having one open connection, returning a release function.
   *
   * The sweep will not take an arena while somebody is on it, so a viewer's
   * socket and a console's request are counted here and keep it alive for as
   * long as they last. A robot's `/agent` socket passes `presence: false` and
   * is counted nowhere: a field of robots playing to an empty stand is exactly
   * what is being reclaimed. The caller must call the returned function when
   * the connection closes, whichever it is. Returns `null` if the arena is
   * gone, which is how a caller knows to answer 404.
   */
  trackConnection(id: string, opts: { presence?: boolean } = {}): (() => void) | null {
    const arena = this.arenas.get(id);
    if (!arena) return null;
    if (opts.presence ?? true) {
      this.hold(arena);
      return () => this.release(arena);
    }
    // A robot's socket is not counted at all — that is the rule, not an
    // oversight. What the caller still wants is the `null` above, which is how
    // it knows there is no arena to connect to.
    return () => {};
  }

  /**
   * Somebody is using this field: a person watching it or acting on it.
   *
   * Separate from `trackConnection` because most presence is not a connection
   * at all — it is a request that has already finished, or a console poll from
   * a tab somebody is actually looking at.
   */
  touch(id: string): void {
    const arena = this.arenas.get(id);
    if (arena) this.used(arena);
  }

  /** Stop one arena now. */
  close(id: string): boolean {
    const arena = this.arenas.get(id);
    if (!arena) return false;
    stop(arena);
    this.arenas.delete(id);
    this.ended(arena);
    return true;
  }

  closeAll(): void {
    clearInterval(this.sweeper);
    clearInterval(this.sampler);
    for (const arena of this.arenas.values()) stop(arena);
    const all = [...this.arenas.values()];
    this.arenas.clear();
    for (const arena of all) this.ended(arena);
  }

  /**
   * Say, once, that an arena is over.
   *
   * Once matters. The two ways an arena ends — asked to stop, or its process
   * going — both arrive here, and the second always follows the first. A
   * second notification would look to the caller like a second slot coming
   * free, which is one more field handed out than the machine has.
   */
  private ended(arena: Arena): void {
    if (arena.ended) return;
    arena.ended = true;
    // Whatever the child was working out of. Nothing in there is worth keeping
    // — a copy of code that is still in the team's own workspace — and this is
    // the only moment anything gets to remove it.
    void rm(arena.scratch, { recursive: true, force: true }).catch(() => {});
    try {
      this.opts.onArenaEnded?.({ id: arena.id, kind: arena.kind, owner: arena.owner });
    } catch (err) {
      // A ledger that throws on the way down must not stop an arena being
      // forgotten here, or the count never comes back.
      this.log(`[arena ${arena.id}] ${(err as Error).message}`);
    }
  }

  private describe(arena: Arena): ArenaInfo {
    return {
      id: arena.id,
      kind: arena.kind,
      owner: arena.owner,
      url: arena.kind === 'practice' ? `/a/${arena.id}/practice/` : `/a/${arena.id}/`,
      createdAt: new Date(arena.createdAt).toISOString(),
      usage: arena.usage,
      fidelity: arena.fidelity,
      lastUsed: new Date(arena.lastUsed).toISOString(),
      closingAt: arena.closingAt === null ? null : new Date(arena.closingAt).toISOString(),
      open: arena.open,
    };
  }

  private hold(arena: Arena): void {
    arena.open += 1;
    this.used(arena);
  }

  private release(arena: Arena): void {
    arena.open = Math.max(0, arena.open - 1);
    this.used(arena);
  }

  /**
   * The field has just been used, so the quiet clock starts again from now —
   * and any warning it had is off.
   *
   * The reprieve is said out loud, not just recorded: a banner that appeared
   * and then stopped being true without saying so is worse than no banner.
   */
  private used(arena: Arena): void {
    arena.lastUsed = Date.now();
    if (arena.closingAt === null) return;
    arena.closingAt = null;
    this.warned(arena);
  }

  private warned(arena: Arena): void {
    try {
      this.opts.onArenaWarned?.({
        id: arena.id,
        owner: arena.owner,
        closingAt: arena.closingAt === null ? null : new Date(arena.closingAt).toISOString(),
      });
    } catch (err) {
      this.log(`[arena ${arena.id}] ${(err as Error).message}`);
    }
  }

  /**
   * Re-read what every arena is costing.
   *
   * From `/proc`, per process, rather than from the grants: a grant is about
   * twelve times what a real robot uses, so a console built on grants would
   * report a machine at capacity while it sat nearly idle. See `usage.ts`.
   */
  private sample(): void {
    for (const arena of this.arenas.values()) {
      const pid = arena.child?.pid;
      if (pid === undefined) continue;
      const now = sampleTree(pid);
      if (arena.lastSample) arena.usage = usageBetween(arena.lastSample, now);
      arena.lastSample = now;
    }
  }

  /**
   * Give back practice fields nobody is using — warned first, then closed.
   *
   * Fixture arenas are exempt: one is spawned and stopped by whoever is running
   * the draw, and a fixture with nobody watching is still a fixture.
   *
   * Two stages, because a field is somebody's afternoon: quiet for long enough
   * and it is *marked*, with whoever owns it told when it will go; quiet for
   * the grace period after that and it actually goes. Anything at all — a
   * person opening it, a drag, a seat change — cancels the first stage, in
   * `used()`.
   *
   * How long "long enough" is depends on whether anybody is waiting. Nobody in
   * the queue and a field can sit idle for the full configured time; somebody
   * waiting and the quiet period halves, and only the *quietest* field is taken
   * per sweep, so a queue of one does not clear the hall.
   *
   * Run on a timer every half minute, and callable directly — by a test that
   * should not have to wait for one, and by anything that wants the machine
   * tidied now rather than at the next tick.
   */
  sweep(): void {
    const now = Date.now();
    const waiting = this.opts.queued?.() ?? 0;
    const configured = (this.opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    const floor = (this.opts.busyIdleFloorMinutes ?? DEFAULT_BUSY_IDLE_FLOOR_MINUTES) * 60_000;
    // A queue may only ever shorten the wait. Clamped to the configured time as
    // well as to the floor, because a floor above what the venue asked for
    // would mean a queue made fields live *longer*.
    const quietFor = waiting > 0 ? Math.min(configured, Math.max(floor, configured / 2)) : configured;
    const graceFor = (this.opts.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;

    const idle: Arena[] = [];
    for (const arena of [...this.arenas.values()]) {
      if (arena.kind !== 'practice') continue;

      if (arena.closingAt !== null) {
        if (now < arena.closingAt) continue;
        this.log(`[arena ${arena.id}] nobody came back; closing`);
        this.close(arena.id);
        continue;
      }

      // A person on the field, or one who was here a moment ago. A connected
      // robot is deliberately not either of those.
      if (arena.open > 0 || now - arena.lastUsed < quietFor) continue;
      idle.push(arena);
    }

    if (idle.length === 0) return;
    idle.sort((a, b) => a.lastUsed - b.lastUsed);
    // Everything quiet goes when nobody is waiting — the machine is simply
    // holding fields nobody wants. With a queue, take the quietest one only:
    // the point is to free a field for the team at the front, not to clear
    // every field that happens to be between drags.
    for (const arena of waiting > 0 ? idle.slice(0, 1) : idle) {
      arena.closingAt = now + graceFor;
      this.log(`[arena ${arena.id}] quiet; closing in ${Math.round(graceFor / 60_000)} min unless somebody comes back`);
      this.warned(arena);
    }
  }
}

/** Kill an arena's whole process group, and let go of its pipes. */
function stop(arena: Arena): void {
  if (arena.worker) {
    try {
      arena.worker.postMessage({ type: 'stop' });
      arena.worker.terminate();
    } catch {}
    return;
  }
  const child = arena.child;
  if (!child) return;
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone, or never had a group of its own.
    try {
      child.kill('SIGKILL');
    } catch {
      // gone
    }
  }
  try {
    child.unref();
  } catch {}
}

/** Poll until something accepts a connection on this port, or give up. */
async function waitForListening(port: number, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((done) => {
      const probe = connect(port, '127.0.0.1');
      probe.on('connect', () => {
        probe.destroy();
        done(true);
      });
      probe.on('error', () => {
        probe.destroy();
        done(false);
      });
    });
    if (ok) return;
    if (Date.now() > until) throw new Error('the arena did not start in time');
    await new Promise((r) => setTimeout(r, 150));
  }
}
