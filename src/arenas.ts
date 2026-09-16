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
 * An **arena** is that child. Two kinds, differing in almost nothing:
 *
 * - a **fixture** arena comes from the draw, is refereed, writes a result, and
 *   is started and stopped by whoever is running the tournament;
 * - a **practice** arena comes from somebody pressing a button, is refereed by
 *   nobody, is never scored, and closes itself once nobody is using it.
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
 * that is abandoned is Phase 9's; `owner` is carried through so the first has
 * somewhere to put it. What bounds an arena meanwhile is a budget
 * (`capacity.ts`) and a field that shuts itself down once nobody is watching.
 */

import type { Subprocess } from 'bun';
import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';

import { sampleTree, usageBetween, type TreeSample, type Usage } from './usage';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The CLI entry, as a file path — only meaningful when running from source.
 *
 * A compiled binary (`bun build --compile`) is already the CLI; its
 * `import.meta.dirname` is the Bun virtual filesystem (`/$bunfs/…`), so it is
 * both a compile-time constant and unknown at runtime. Two shapes of spawn:
 *
 * - from source:     `bun src/cli.ts arena …`
 * - compiled:        `./rcja-soccer-sim arena …`
 */
const COMPILED = import.meta.dirname.startsWith('/$bunfs');
const SELF = process.execPath;
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

/** What an arena is for. The difference is in who may act on it, not in the football. */
export type ArenaKind = 'fixture' | 'practice';

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
  /** Per-seat grants, passed to every arena so practice and finals play alike. */
  seatCpuPercent?: number;
  seatMemoryMb?: number;
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
}

interface Arena {
  id: string;
  kind: ArenaKind;
  owner: string | null;
  port: number;
  child: Subprocess;
  createdAt: number;
  /** Sockets currently proxied to it — viewers and robots both. */
  open: number;
  idleSince: number | null;
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
  private readonly sweep: NodeJS.Timeout;
  private readonly sampler: NodeJS.Timeout;
  private readonly log: (line: string) => void;

  constructor(private opts: ArenaSupervisorOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.sweep = setInterval(() => this.closeIdle(), SWEEP_MS);
    this.sampler = setInterval(() => this.sample(), SAMPLE_MS);
    // Housekeeping, not work: a server with nothing else to do should still be
    // allowed to exit.
    this.sweep.unref?.();
    this.sampler.unref?.();
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
    return this.arenas.get(id)?.child.pid ?? null;
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
  async create(options: { kind: ArenaKind; owner?: string | null } = { kind: 'practice' }): Promise<ArenaInfo> {
    const { kind } = options;
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
    const refereeToken = randomBytes(24).toString('base64url');
    const args = COMPILED ? [] : [CLI];
    args.push('arena', '--kind', kind, '--port', String(port), '--die-with-parent');
    if (kind === 'fixture') args.push('--referee-token', refereeToken);
    if (this.opts.submissionsDir) args.push('--submissions', this.opts.submissionsDir);
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
      createdAt: Date.now(),
      open: 0,
      idleSince: Date.now(),
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
      throw err;
    }

    this.log(`[arena ${id}] ${kind} open on port ${port}`);
    return this.describe(arena);
  }


  /**
   * Mark an arena as having one open connection, returning a release function.
   *
   * Idle-timeout is gated on `open === 0`. This increments it so the arena is
   * not swept while a request is in flight. The caller must call the returned
   * function when the connection closes. Returns `null` if the arena is gone.
   */
  trackConnection(id: string): (() => void) | null {
    const arena = this.arenas.get(id);
    if (!arena) return null;
    this.hold(arena);
    return () => this.release(arena);
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
    clearInterval(this.sweep);
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
    };
  }

  private hold(arena: Arena): void {
    arena.open += 1;
    arena.idleSince = null;
  }

  private release(arena: Arena): void {
    arena.open = Math.max(0, arena.open - 1);
    if (arena.open === 0 && arena.idleSince === null) arena.idleSince = Date.now();
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
      const pid = arena.child.pid;
      if (pid === undefined) continue;
      const now = sampleTree(pid);
      if (arena.lastSample) arena.usage = usageBetween(arena.lastSample, now);
      arena.lastSample = now;
    }
  }

  /**
   * Close practice arenas nobody is using.
   *
   * Fixture arenas are exempt: one is spawned and stopped by whoever is
   * running the draw, and a fixture with nobody watching is still a fixture.
   */
  private closeIdle(): void {
    const idleFor = (this.opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    const now = Date.now();
    for (const arena of [...this.arenas.values()]) {
      if (arena.kind !== 'practice') continue;
      if (arena.idleSince === null || now - arena.idleSince < idleFor) continue;
      this.log(`[arena ${arena.id}] nobody watching; closing`);
      this.close(arena.id);
    }
  }
}

/** Kill an arena's whole process group, and let go of its pipes. */
function stop(arena: Arena): void {
  const { child } = arena;
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
