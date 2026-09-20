/**
 * A fixture or demo arena, from the inside.
 *
 * The hub plays no football. It owns accounts, the draw, the schedule and the
 * front page, and when a fixture is due it starts one of these — a child
 * process running the same `MatchServer` a team runs on a laptop — tells it
 * what to play, and asks how it is going. This file is the surface it tells
 * and asks through.
 *
 * A **demo arena** is a third kind of child: it plays back-to-back matches at
 * wall-clock speed, never records a result, and fills a hall screen while the
 * draw is running or when nothing is on. The hub opens one if `demo.on` is
 * set, and the child plays itself — the hub never tells it what to play.
 *
 * **The child resolves and spawns its own lineup.** That is what "the hub
 * plays no football" has to mean in practice: if the hub still reached into
 * `submissions/`, spawned four sandboxed CPython processes and held their
 * transports, the child would be a viewer rather than a world and every
 * runaway robot would still be in the hub's process tree. `resolveLineup` and
 * `spawnLineup` moved here out of the draw runner for exactly that reason.
 *
 * **Starting is a request and finishing is a poll.** A match takes ten minutes
 * of wall-clock; an HTTP request held open across it is a socket that has to
 * survive a hall's network, a proxy's idea of a timeout and a laptop's sleep.
 * So `play` answers immediately and the hub asks `state` at a lazy interval —
 * which it wants anyway, because the score on the front page comes from the
 * same answer.
 *
 * **Nothing here is authenticated.** A fixture arena binds loopback and is
 * reached only through the hub, which has already decided who is asking. The
 * referee surface the child also serves is the ordinary one from Phase 2, held
 * to a token the supervisor minted and only the hub knows.
 */

import type { MatchResult } from '../match/match';
import type { HalfTime } from '@rcja/shared/view';
import type { LeagueId } from '@rcja/shared/leagues';
import type { SeedInput } from '../sim/rand';
import { agentsFor, referenceTeam } from '../infra/reference';
import { botRoster } from '../match/bots';
import { matchSeed } from '../sim/rand';
import {
  resolveLineup,
  spawnLineup,
  spawnSeat,
  type LineupEntry,
  type SeatProcess,
  type SpawnedLineup,
} from '../accounts/lineup';
import { hashSubmission } from '../accounts/submission';
import type { MatchServer } from '../infra/server';
import type { Transport } from '../match/agent';
import { waitForSeats } from './bench';
import type { Subprocess } from 'bun';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { slugifyTeam } from '../infra/manifest';
import type { DemoTeamConfig, DemoTeamSpec } from '../infra/settings';

export type { DemoTeamConfig, DemoTeamSpec };

export interface FixtureArenaOptions {
  pythonLibDir: string | null;
  /**
   * Somewhere this arena may keep its locked copies of the four submissions.
   *
   * A supervisor hands this in and removes it when the arena ends, which is
   * the only thing that can: an arena is killed rather than asked to stop.
   * Without one — a fixture arena started by hand — the system temp directory
   * does. The same arrangement `PracticeSession.runRoot` already has, and for
   * the same reason: a program is spawned from a copy under here rather than
   * from the submissions tree itself.
   */
  runRoot?: string | null;
  /** Per-seat grants, one number for practice and finals alike. */
  seatCpuPercent?: number;
  seatMemoryMb?: number;
  log?: (line: string) => void;
}

/**
 * What one seat's program is doing, as a checklist reads it.
 *
 * Four states rather than a boolean because they are four different things to
 * do about it: nothing was ever pushed, it is coming up, it is here, or it is
 * not going to be. Only the last one is somebody's problem to fix, and saying
 * so while there is still time to fix it is the whole point of starting these
 * in pre-game rather than at the whistle.
 */
export type SeatStatus = 'no-push' | 'starting' | 'on-field' | 'would-not-start';

/** One seat of a pre-game lineup, as the hub relays it to a checklist. */
export interface LineupSeat {
  id: string;
  status: SeatStatus;
  /**
   * The code this seat is actually running, or `null` if it is running none.
   *
   * Of the arena's own copy rather than of the submissions tree, which is the
   * only reason it can be trusted: the copy cannot be replaced by a push, so
   * this is a fact about the program in front of the referee rather than about
   * a folder that may have changed since it started.
   */
  hash: string | null;
}

/** The hub saying a team has arrived: start that side's robots. */
export interface LineupRequest {
  teams: { violet: string; lime: string };
  seed: SeedInput;
  league?: LeagueId;
  /** Which side turned up. Only that side's folders are read. */
  side: 'violet' | 'lime';
}

/** The hub saying: this is the code that plays, whatever anybody pushes now. */
export interface LockRequest {
  teams: { violet: string; lime: string };
  seed: SeedInput;
  league?: LeagueId;
}

/** One seat's program, and the copy of the code it is running. */
interface ArenaSeat {
  /**
   * The snapshot this seat runs from — `null` if nothing was ever pushed.
   *
   * `entry.dir` is **this arena's own copy** of the folder, not the folder in
   * the submissions tree. That is what the lock is: a read-only bind stops the
   * child writing to its own folder and does nothing at all about the parent
   * replacing that folder underneath it, which is exactly what a push does
   * (`TeamApi.keep` removes the target and renames a new one into its place).
   * Every respawn is a fresh sandbox binding the path again, so a seat spawned
   * from the tree would silently pick up a push the moment its program
   * crashed once.
   */
  entry: LineupEntry | null;
  process: SeatProcess | null;
  /**
   * Hashed from the copy, when the copy was taken.
   *
   * A robot started in pre-game is running the code that was on disk *then*,
   * and a team who push a fix afterwards leave a newer folder behind it. Hash
   * at kick-off and the match record would carry the new hash beside football
   * the old code played, which is a lie in the one place that exists to be
   * trusted. Hashing the copy makes it a fact rather than a habit.
   */
  hash: string | null;
  /** Its program stopped being retried — see `spawnSeat`'s `onGaveUp`. */
  gaveUp: boolean;
}

/** What the hub asks for: one leg of one fixture. */
export interface PlayRequest {
  teams: { violet: string; lime: string };
  seed: SeedInput;
  halfSeconds?: number;
  league?: LeagueId;
  refereed?: boolean;
  /**
   * Goal difference that ends the match, or `null` for no limit.
   *
   * Sent by the hub from `rules.mercyMargin` rather than left to the child's
   * own default, so every fixture at a venue plays the same rule whatever a
   * particular arena was started with.
   */
  mercyMargin?: number | null;
  /**
   * Seconds of half-time between the halves, or 0 for none.
   *
   * Sent by the hub from `rules.halfTimeSeconds` for the same reason
   * `mercyMargin` is: a venue plays one game, not one per child process.
   */
  halfTimeSeconds?: number;
  /**
   * Seconds one robot may sit on a motionless ball before rule 5.6 takes it
   * off them, or 0 for never.
   *
   * Sent by the hub from `rules.heldBallSeconds`, again so that two arenas at
   * the same venue cannot disagree about what the game is. A team that lost
   * the ball to this in one fixture and kept it in the next would have no way
   * to tell which of the two was the real rule.
   */
  heldBallSeconds?: number;
  /**
   * Goals the pre-game penalty clock awarded before a ball was kicked.
   *
   * Applied as score corrections at clock 0, so a match that kicks off 3-0
   * carries the reason in its own record rather than starting at a scoreline
   * nobody can account for.
   */
  penalties?: { violet: number; lime: number; reason: string };
  /** For the arena's own log lines — "round-1:f2 leg 1 of 2". */
  label?: string;
}

/** What played, once it has. */
export interface PlayedMatch {
  result: MatchResult;
  /** sha256 per seat id, for whichever seats a real submission filled. */
  submissions: Record<string, string>;
  /**
   * The same again for the second half, and only when half-time changed it.
   *
   * Absent from almost every match ever played, which is the point: a fixture
   * nobody pushed to at half-time writes exactly the record it always did.
   * When it is here, `submissions` is what played the first half and this is
   * what played the second.
   */
  secondHalf?: Record<string, string>;
}

export interface ArenaState {
  playing: boolean;
  label: string | null;
  /** The scoreboard, small enough to poll at a lazy interval. */
  score: { violet: number; lime: number } | null;
  clock: number;
  half: 1 | 2;
  running: boolean;
  /** Simulated seconds per wall second, or `null` until a window has closed. */
  fidelity: number | null;
  /** Teams playing the current match. */
  teams?: { violet: string; lime: string } | null;
  /** The finished match, held until the hub collects it. */
  finished: PlayedMatch | null;
  /**
   * Every seat a team's arrival has started, or `null` while nobody has.
   *
   * `null` rather than four empty seats on purpose: an arena nobody has
   * arrived at has nothing to say about anybody's robot, and a checklist
   * should not read that as four robots missing.
   */
  lineup: LineupSeat[] | null;
  /**
   * When this lineup was locked, or `null` while a push can still change it.
   *
   * After it, the four seats run copies this arena holds and nothing in the
   * submissions tree reaches the match — until a referee locks again, which
   * takes in whatever has been pushed since. The whistle locks it if nobody
   * has.
   */
  lockedAt: string | null;
  /**
   * The break between the halves, while there is one.
   *
   * The one moment during a match when a team has something to do and the hub
   * has something to say about it, so it rides up with everything else the hub
   * already polls.
   */
  halfTime: HalfTime | null;
  /** Why the last request could not be played, if it could not. */
  error: string | null;
}

export class FixtureArena {
  private playing: PlayRequest | null = null;
  private finished: PlayedMatch | null = null;
  private error: string | null = null;
  private stopped = false;
  /**
   * One entry per seat this arena has started, and it outlives a leg.
   *
   * Cleared by `stop()` and by nothing else. The second leg of a tie plays the
   * same code as the first because the copies are still here — before this it
   * resolved the tree again between the legs, so a push in the interval
   * changed the second leg of a fixture the first leg had already been played
   * for.
   */
  private readonly seats = new Map<string, ArenaSeat>();
  /** See `ArenaState.lockedAt`. */
  private lockedAt: string | null = null;
  /** What to stand a lobby up with, once somebody has arrived to stand in it. */
  private pregame: { teams: { violet: string; lime: string }; seed: SeedInput; league?: LeagueId } | null =
    null;
  /** The pre-game field's own loop, held so kick-off can wait for it to let go. */
  private lobby: Promise<void> | null = null;
  private readonly log: (line: string) => void;

  constructor(
    private readonly server: MatchServer,
    private readonly opts: FixtureArenaOptions,
  ) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * The control surface, mounted ahead of everything else the server routes.
   *
   * Returns a `Response` if it handled the request, or `null` to pass through.
   * This is the shape `MatchServer`'s own routing already uses since moving to
   * `Bun.serve()`.
   */
  handle = async (req: Request, url: string): Promise<Response | null> => {
    if (!url.startsWith('/arena-api/')) return null;
    const action = url.slice('/arena-api/'.length);

    if (action === 'state' && req.method === 'GET') {
      return this.json(200, { ok: true, state: this.state() });
    }

    if (action === 'lineup' && req.method === 'POST') {
      // Nothing to arrive for once the football has started. Not an error
      // either — a team pressing "we're here" during their own match is late,
      // not wrong, and the hub has already recorded the arrival.
      if (this.playing) return this.json(200, { ok: true, lineup: this.lineupState() });
      let request: LineupRequest;
      try {
        request = (await req.json()) as unknown as LineupRequest;
      } catch (err) {
        return this.json(400, { ok: false, reason: (err as Error).message });
      }
      await this.arrive(request);
      return this.json(200, { ok: true, lineup: this.lineupState() });
    }

    if (action === 'lock' && req.method === 'POST') {
      // Mid-match, there is exactly one moment at which this means anything,
      // and it is the one the sport gives a team to fix their code in. Any
      // other moment is a silent no-op, and saying which nothing is better
      // than doing it: the hub asked because a referee pressed a button.
      if (this.playing) {
        const playing = this.playing;
        if (this.server.currentMatch?.halfTime() == null) {
          return this.json(409, { ok: false, reason: 'this match has already started' });
        }
        // The same call the button makes before kick-off, and everything that
        // makes it work is already built: the changed seats are stopped,
        // re-copied and started again, and each program rejoins the match in
        // progress through the transport the gateway is already holding for
        // its seat. No lobby — there is a field, with a match on it.
        await this.lockLineup(playing.teams, true);
        return this.json(200, { ok: true, lineup: this.lineupState(), lockedAt: this.lockedAt });
      }
      let request: LockRequest;
      try {
        request = (await req.json()) as unknown as LockRequest;
      } catch (err) {
        return this.json(400, { ok: false, reason: (err as Error).message });
      }
      this.pregame = { teams: request.teams, seed: request.seed, league: request.league };
      await this.lockLineup(request.teams, true);
      this.startLobby();
      return this.json(200, { ok: true, lineup: this.lineupState(), lockedAt: this.lockedAt });
    }

    // A team saying they are ready to play the second half. Their act, not a
    // referee's, so it arrives here rather than through the console's token —
    // the hub has already decided this is that team, which is a thing a child
    // watching one world has no way to know.
    if (action === 'ready' && req.method === 'POST') {
      const match = this.server.currentMatch;
      if (!match || match.halfTime() === null) {
        return this.json(409, { ok: false, reason: 'this match is not at half-time' });
      }
      let side: unknown;
      try {
        side = ((await req.json()) as { side?: unknown }).side;
      } catch (err) {
        return this.json(400, { ok: false, reason: (err as Error).message });
      }
      if (side !== 'violet' && side !== 'lime') {
        return this.json(400, { ok: false, reason: '"side" must be "violet" or "lime"' });
      }
      match.sayReady(side);
      return this.json(200, { ok: true, halfTime: match.halfTime() });
    }

    if (action === 'play' && req.method === 'POST') {
      if (this.playing) {
        return this.json(409, { ok: false, reason: 'this arena is already playing' });
      }
      let request: PlayRequest;
      try {
        request = (await req.json()) as unknown as PlayRequest;
      } catch (err) {
        return this.json(400, { ok: false, reason: (err as Error).message });
      }
      // Cleared here rather than when the last result was collected: a new
      // match starting is the only moment at which the previous one stops
      // being the answer to "what happened".
      this.finished = null;
      this.error = null;
      this.playing = request;
      void this.run(request);
      return this.json(202, { ok: true });
    }

    return this.json(404, { ok: false, reason: 'no such arena action' });
  };

  state(): ArenaState {
    const match = this.server.currentMatch;
    const frame = this.playing && match ? match.snapshot() : null;
    return {
      playing: this.playing !== null,
      label: this.playing?.label ?? null,
      score: frame?.score ?? null,
      clock: frame?.clock ?? 0,
      half: frame?.half ?? 1,
      running: frame?.running ?? false,
      fidelity: this.server.realtimeFidelity,
      finished: this.finished,
      lineup: this.lineupState(),
      lockedAt: this.lockedAt,
      halfTime: (this.playing && match?.halfTime()) || null,
      error: this.error,
    };
  }

  /**
   * What each started seat's program is doing, asked fresh every time.
   *
   * Derived from the gateway rather than stored, for the reason the hub's own
   * `pregameSeats` re-reads disk every time it is asked: this is polled by a
   * referee standing at a pitch while a team restarts a program at the next
   * table, and a cached answer is the one thing it must not give.
   */
  private lineupState(): LineupSeat[] | null {
    if (this.seats.size === 0) return null;
    const live = this.server.agents.transports();
    return [...this.seats.entries()]
      .map(([id, seat]) => ({ id, status: statusOf(seat, live[id]), hash: seat.hash }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * A team has arrived: start their robots now, rather than at the whistle.
   *
   * Only the arriving side's folders are read — the other team's name is
   * passed blank, the way `PracticeSession.setSeat` resolves one seat without
   * reaching into the rest of the field.
   *
   * Idempotent per seat, and that is where the retry lives. A seat with a
   * program actually on the field is left strictly alone, so pressing "we're
   * here" a second time cannot restart a working robot — and cannot swap the
   * code under a seat whose hash is already recorded. Anything else is stopped
   * and started again, which is how a team who pushed a fix gets it loaded
   * without anybody closing the fixture.
   */
  private async arrive(request: LineupRequest): Promise<void> {
    this.pregame = { teams: request.teams, seed: request.seed, league: request.league };
    const libDir = this.opts.pythonLibDir;
    // An arena that cannot run submissions still gets a field to wait on; it
    // just has nothing to say about anybody's robot, which `lineupState`
    // reports as nothing rather than as four missing ones.
    if (libDir) {
      const side = request.side;
      // Nothing on disk is read once the lineup is locked. A team may still
      // turn up after the lock — arriving is a human act and always was — and
      // pressing the button again still restarts a robot that is not on the
      // field. What it restarts is the copy that was locked, which is the rule
      // in one sentence: a push reaches a locked match only when a referee
      // decides it does.
      const resolved = this.lockedAt
        ? {}
        : await resolveLineup(this.server.submissionsDirectory, {
            violet: side === 'violet' ? request.teams.violet : '',
            lime: side === 'lime' ? request.teams.lime : '',
          });
      const live = this.server.agents.transports();
      for (const number of [1, 2] as const) {
        const id = `${side}-${number}`;
        const seat = this.seats.get(id);
        if (seat && isLive(live[id])) continue;
        seat?.process?.stop();
        if (this.lockedAt !== null) {
          if (seat?.entry) this.startSeat(id, seat.entry, seat.hash, libDir);
          continue;
        }
        const entry = resolved[id] ?? null;
        if (!entry) {
          this.seats.set(id, { entry: null, process: null, hash: null, gaveUp: false });
          continue;
        }
        await this.snapshotSeat(id, entry, libDir);
      }
    }
    this.startLobby();
  }

  /**
   * This is the code that plays.
   *
   * Every seat is copied out of the submissions tree into this arena and
   * started from the copy, so from here nothing a team pushes can reach the
   * match. A seat already on the field running exactly what is on disk is left
   * strictly alone; anything else — never started, dead, gave up, or **running
   * an older push than its team has since made** — is stopped and started
   * again on the newest code. That last case is what makes locking a decision
   * rather than a formality: the referee is the one who takes a new push in,
   * and they take in every team's at once.
   *
   * Callable again, and meant to be. Before kick-off a referee may lock as
   * often as they like and each press takes in whatever has landed since;
   * afterwards nothing does.
   *
   * `takeNewPushes` is the difference between the button and the whistle. A
   * referee pressing Lock is deciding to take everybody's newest code in. The
   * whistle is not deciding anything of the sort — it locks **what is on the
   * field**, because the referee pressed Start on a checklist showing those
   * robots running, and restarting one under them would be a ten-second wait
   * they did not ask for on a robot that was working. Either way the seats
   * nobody has started yet are resolved and copied here.
   */
  private async lockLineup(
    teams: { violet: string; lime: string },
    takeNewPushes: boolean,
  ): Promise<void> {
    const libDir = this.opts.pythonLibDir;
    if (libDir) {
      const resolved = await resolveLineup(this.server.submissionsDirectory, teams);
      for (const side of ['violet', 'lime'] as const) {
        for (const number of [1, 2] as const) {
          const id = `${side}-${number}`;
          const seat = this.seats.get(id);
          const entry = resolved[id] ?? null;
          if (!entry) {
            // Nothing pushed for this robot, so there is nothing to lock and
            // the built-in agent fills the seat the way it always has.
            if (!seat) this.seats.set(id, { entry: null, process: null, hash: null, gaveUp: false });
            continue;
          }
          const latest = await hashSubmission(entry.dir);
          // Unchanged code is already locked, whatever its program is doing,
          // and that includes a seat that gave up. Restarting one of those
          // would only fail again — and at the whistle, where this runs if no
          // referee pressed anything, it would also overrule the decision the
          // referee did make: they were shown "would not start" and started
          // the match anyway, and this must not turn that seat back into one
          // worth holding the fixture up ten seconds for.
          if (seat && seat.hash === latest) continue;
          if (seat && seat.hash !== null) {
            if (!takeNewPushes) continue;
            this.log(`${id} is being restarted on the code pushed since it started`);
          }
          seat?.process?.stop();
          await this.snapshotSeat(id, entry, libDir);
        }
      }
    }
    this.lockedAt = new Date().toISOString();
  }

  /**
   * Copy one seat's folder into this arena, and start the copy.
   *
   * The copy is the lock. A push replaces the folder in the submissions tree
   * (`TeamApi.keep` removes it and renames a new one into its place), and
   * every respawn is a fresh sandbox binding that path again — so a seat
   * spawned from the tree changes code the first time its program crashes.
   * Copied here, it cannot.
   */
  private async snapshotSeat(id: string, from: LineupEntry, libDir: string): Promise<void> {
    const previous = this.seats.get(id)?.entry?.dir ?? null;
    const dir = await mkdtemp(join(this.opts.runRoot ?? tmpdir(), `seat-${id}-`));
    await cp(from.dir, dir, { recursive: true });
    // The token comes with the copy, which is what makes the copy
    // self-contained: `spawnSeat` hands it to the gateway and nothing ever has
    // to read the tree again for this seat.
    this.startSeat(id, { manifest: from.manifest, dir, token: from.token }, await hashSubmission(dir), libDir);
    // Only once the replacement is running, and never fatally: a stale copy
    // left behind goes with the arena's own scratch directory anyway.
    if (previous) void rm(previous, { recursive: true, force: true }).catch(() => {});
  }

  /** Start one seat's program from a copy this arena holds. */
  private startSeat(id: string, entry: LineupEntry, hash: string | null, libDir: string): void {
    const seat: ArenaSeat = { entry, process: null, hash, gaveUp: false };
    this.seats.set(id, seat);
    seat.process = spawnSeat(
      this.server,
      id,
      entry,
      {
        pythonLibDir: libDir,
        cpuQuotaPercent: this.opts.seatCpuPercent,
        memoryLimitMb: this.opts.seatMemoryMb,
      },
      this.log,
      () => {},
      () => {
        // Only if nothing has happened to the seat since — a team who pushed a
        // fix and restarted should not have the dead program's last word land
        // on the one that replaced it.
        if (this.seats.get(id) === seat) seat.gaveUp = true;
      },
    );
  }

  /**
   * Stand up a field for the robots that are arriving to stand on.
   *
   * Not decoration. A program that hears nothing for ten seconds decides the
   * server has gone, so robots started before kick-off need something polling
   * them for the whole of pre-game or every arrival spends it reconnecting.
   * `lobby` is exactly that loop and already puts each robot on its mark as it
   * joins; it lets go the moment there is a match to play.
   */
  private startLobby(): void {
    if (this.lobby || this.playing || this.stopped || !this.pregame) return;
    const { teams, seed, league } = this.pregame;
    this.lobby = this.server
      .lobby({ teams, seed, league, until: () => this.playing !== null || this.stopped })
      .catch((err) => {
        this.log(`the pre-game field stopped: ${(err as Error).message}`);
      });
  }

  /** Stop whatever is running. The hub kills the whole process after this. */
  stop(): void {
    this.stopped = true;
    for (const seat of this.seats.values()) {
      seat.process?.stop();
      // The supervisor removes this arena's whole scratch directory when it
      // hears the process end, so this is tidiness rather than the guarantee —
      // an arena killed outright never reaches here at all.
      if (seat.entry) void rm(seat.entry.dir, { recursive: true, force: true }).catch(() => {});
    }
    this.seats.clear();
    this.lockedAt = null;
    this.pregame = null;
  }

  /**
   * Play one leg, then hold the result until it is collected.
   *
   * The result is not written anywhere here. A fixture's result is written by
   * the hub, whole, once every leg has been played — the same all-or-nothing
   * write `tournament-store.ts` has always made, and what makes an interrupted
   * fixture leave nothing behind and simply replay.
   */
  private async run(request: PlayRequest): Promise<void> {
    const submissions: Record<string, string> = {};
    try {
      // Pre-game is over. `this.playing` is already set, so the lobby's own
      // `until` has closed it — this just waits for the loop to let go of the
      // world before `play` builds the one that counts.
      this.pregame = null;
      if (this.lobby) {
        await this.lobby;
        this.lobby = null;
      }

      // The whistle locks the lineup if no referee has. From here the seats
      // are copies this arena holds and the submissions tree is not read
      // again — at kick-off there is nothing left to decide, which is what the
      // lock is for. A second leg finds it already locked and plays the same
      // code the first leg did.
      if (this.lockedAt === null) await this.lockLineup(request.teams, false);

      const libDir = this.opts.pythonLibDir;
      if (libDir) {
        // Whatever arrived early is already running and is not started again:
        // a robot that has been on the field for ten minutes is the robot that
        // plays, on the code it was started with.
        for (const [id, seat] of this.seats) {
          if (!seat.entry || seat.process) continue;
          this.startSeat(id, seat.entry, seat.hash, libDir);
        }

        // Waited on: everything that might still be coming up. Not waited on:
        // a seat pre-game already gave up for. The referee was shown that seat
        // as "would not start" and pressed start anyway, and turning their
        // decision into a fixture that refuses to play would be overruling it.
        const live = this.server.agents.transports();
        const coming = [...this.seats.entries()]
          .filter(([id, seat]) => seat.entry && !seat.gaveUp && !isLive(live[id]))
          .map(([id]) => id);
        if (coming.length > 0) {
          await waitForSeats(this.server, coming, CONNECT_TIMEOUT_SECONDS);
        }

        const absent = [...this.seats.entries()].filter(([, seat]) => seat.entry && seat.gaveUp);
        if (absent.length > 0) {
          this.log(
            `playing without ${absent.map(([id]) => id).join(', ')} — their programs would not start`,
          );
        }
      }

      const playing = this.seatTransports();
      Object.assign(submissions, this.seatSubmissions());

      const result = await this.server.play({
        agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as never,
        transports: playing,
        teams: request.teams,
        league: request.league,
        halfSeconds: request.halfSeconds,
        seed: request.seed,
        refereed: request.refereed ?? false,
        mercyMargin: request.mercyMargin,
        halfTimeSeconds: request.halfTimeSeconds,
        heldBallSeconds: request.heldBallSeconds,
        penalties: request.penalties,
      });

      // Half-time is the one thing that can change a seat's code inside a
      // match, so the record has to be asked again afterwards rather than
      // assumed. Recorded only when it actually differs: a fixture nobody
      // pushed to at half-time writes exactly the record it always did.
      //
      // Laid over the kick-off map rather than taken on its own, so a program
      // that dropped out during the second half is still recorded against the
      // code it was playing. It never changed code; it stopped, and the match
      // record already says that in its own words.
      const after = { ...submissions, ...this.seatSubmissions() };
      const changed = Object.keys(after).some((id) => after[id] !== submissions[id]);

      this.finished = { result, submissions, ...(changed ? { secondHalf: after } : {}) };
      this.log(`played ${request.label ?? 'a match'}: ${result.score.violet}-${result.score.lime}`);
    } catch (err) {
      // The hub is polling and has to be told, because a match that silently
      // never finishes is a fixture that never gets replayed either.
      this.error = (err as Error).message;
      this.log(`could not play ${request.label ?? 'a match'}: ${this.error}`);
    } finally {
      // Every program this arena started, whether it was started at the
      // whistle or an hour earlier by a team turning up. The copies stay: the
      // second leg of a tie starts its own processes from the same locked code
      // rather than reading the tree again, so a push between the legs cannot
      // change the half of the fixture that has not been played yet.
      for (const seat of this.seats.values()) {
        seat.process?.stop();
        seat.process = null;
      }
      this.server.agents.closeAll();
      this.playing = null;
    }
  }

  /**
   * The code in each seat, right now, for the seats a program is driving.
   *
   * Only those. `FixtureResult` says what this means and it has to stay true:
   * *a seat missing from here was filled by the built-in agent*. A robot that
   * would not start is filled by the built-in agent, so recording its hash
   * would put a team's name and their code against football neither of them
   * played.
   */
  private seatSubmissions(): Record<string, string> {
    const playing = this.seatTransports();
    const out: Record<string, string> = {};
    for (const [id, seat] of this.seats) {
      if (seat.hash !== null && playing[id]) out[id] = seat.hash;
    }
    return out;
  }

  /** The live transport for every seat this arena started, and only those. */
  private seatTransports(): Partial<Record<string, Transport>> {
    const live = this.server.agents.transports();
    const out: Partial<Record<string, Transport>> = {};
    for (const id of this.seats.keys()) {
      if (isLive(live[id])) out[id] = live[id]!;
    }
    return out;
  }

  private json(status: number, body: unknown): Response {
    return Response.json(body, { status });
  }
}

/** A seat with something actually on the end of it — `waitForSeats`'s test. */
function isLive(transport: Transport | undefined): boolean {
  return transport !== undefined && transport.connected !== false;
}

function statusOf(seat: ArenaSeat, transport: Transport | undefined): SeatStatus {
  if (!seat.entry) return 'no-push';
  if (isLive(transport)) return 'on-field';
  if (seat.gaveUp) return 'would-not-start';
  return 'starting';
}

/**
 * A demo arena, from the inside: football for a hall screen, forever.
 *
 * The hub plays no football, and so does the demo arena's own hub — this
 * child runs a real `MatchServer` and plays itself, one match after another,
 * so the screen never sits still. Nothing it plays is ever scored or written;
 * a demo is an attraction, not a record.
 *
 * Who fills the seats is the `bots` switch:
 *
 * - `reference` (the default) plays the built-in reference agent against
 *   itself — nothing to spawn;
 * - a bot-roster name plays reference against that deliberately poor bot;
 * - `examples` spawns the repo's own `python/examples/play.py` (both sides,
 *   striker and keeper) pointing at this arena's own `/agent`, and they join
 *   as remote seats exactly the way four laptops do.
 *
 * "The screen never sits still" is the rule that shapes everything here. The
 * demo kicks off itself (`refereed: false` always), and if the Python example
 * robots cannot join — python3 missing, a script crashing — the match plays
 * with the built-in reference agent instead of not playing at all, and the
 * spawn is tried again on the next gap. A miss is a fallback, never a pause.
 */
export interface DemoOptions {
  teams?: { violet: string; lime: string } | DemoTeamConfig[];
  teamList?: DemoTeamConfig[];
  /** `reference`, `examples`, or a bot-roster name. Default `reference`. */
  bots?: string;
  homeBots?: string;
  awayBots?: string;
  submissionsDir?: string;
  pythonLibDir?: string | null;
  seatCpuPercent?: number;
  seatMemoryMb?: number;
  halfSeconds?: number;
  league?: LeagueId;
  /** Wall-clock pause between matches, so the hall can read the table. */
  gapSeconds?: number;
  /** Whether to randomly swap home and away sides at the start of each match. */
  randomSides?: boolean;
  log?: (line: string) => void;
}

/** How long kick-off waits for a program that has not connected yet. */
const CONNECT_TIMEOUT_SECONDS = 10;

const PYTHON_SEAT_TIMEOUT_MS = 15_000;

export class DemoArena {
  private stopping = false;
  private producers = new Map<string, Subprocess>();
  /** The seats the running example robots hold, so stopping them frees those seats. */
  private producerSeats: string[] = [];
  private lineup: SpawnedLineup | null = null;
  private currentTeams: { violet: string; lime: string } | null = null;
  private readonly log: (line: string) => void;
  private readonly teamPool: DemoTeamConfig[] | null = null;

  constructor(
    private readonly server: MatchServer,
    private readonly opts: DemoOptions,
  ) {
    this.log = opts.log ?? (() => {});
    if (opts.teamList && opts.teamList.length > 0) {
      this.teamPool = opts.teamList;
    } else if (Array.isArray(opts.teams) && opts.teams.length > 0) {
      this.teamPool = opts.teams;
    } else {
      this.teamPool = null;
    }

    if (this.teamPool) {
      const submissionsDir = opts.submissionsDir ?? server.submissionsDirectory;
      const t0 = this.normalizeTeam(this.teamPool[0], submissionsDir);
      const t1 = this.teamPool.length > 1 ? this.normalizeTeam(this.teamPool[1], submissionsDir) : t0;
      this.currentTeams = {
        violet: t0.name ?? 'Violet',
        lime: t1.name ?? (this.teamPool.length > 1 ? 'Lime' : (t0.name ?? 'Violet')),
      };
    } else if (opts.teams && !Array.isArray(opts.teams)) {
      this.currentTeams = { ...opts.teams };
    } else {
      this.currentTeams = { violet: 'Violet', lime: 'Lime' };
    }
  }

  /** The control surface, mounted on `MatchServer` like `FixtureArena`'s. */
  handle = async (req: Request, url: string): Promise<Response | null> => {
    if (!url.startsWith('/arena-api/')) return null;
    const action = url.slice('/arena-api/'.length);
    if (action === 'state' && req.method === 'GET') {
      return this.json(200, { ok: true, state: this.state() });
    }
    return this.json(404, { ok: false, reason: 'no such arena action' });
  };

  /** The front page's view: the current match, and it is always a match. */
  state(): ArenaState {
    const match = this.server.currentMatch;
    const frame = match ? match.snapshot() : null;
    return {
      playing: true,
      label: null,
      score: frame?.score ?? null,
      clock: frame?.clock ?? 0,
      half: frame?.half ?? 1,
      running: frame?.running ?? false,
      fidelity: this.server.realtimeFidelity,
      teams: this.currentTeams,
      // A demo never finishes and never refuses: there is nothing to collect.
      finished: null,
      // Nor does anybody arrive for one. A demo's robots are whoever the
      // venue's `demo.bots` switch says, and no team is standing at it.
      lineup: null,
      // And so nothing is ever locked: a demo is an attraction, not a record,
      // and picks up whatever a team has pushed the next time it plays them.
      lockedAt: null,
      // And it never waits for anybody either, so there is no break for
      // anybody to wait in: a demo kicks itself off, both halves.
      halfTime: null,
      error: null,
    };
  }

  /** Kick off the forever loop. */
  start(_port?: number): void {
    void this.run();
  }

  stop(): void {
    this.stopping = true;
    this.stopProducers();
    this.lineup?.stop();
    this.lineup = null;
  }

  private normalizeTeam(
    t: DemoTeamConfig,
    submissionsDir?: string,
  ): { name?: string; bots: string } {
    const defaultBots = this.opts.bots ?? 'reference';
    if (typeof t === 'object' && t !== null) {
      return {
        name: t.name,
        bots: t.bots ?? defaultBots,
      };
    }
    const str = String(t).trim();
    if (str === 'reference' || str === 'example' || str === 'examples' || botRoster().some((b) => b.name === str)) {
      return { name: str, bots: str };
    }
    if (submissionsDir) {
      try {
        const slug = slugifyTeam(str);
        if (existsSync(join(submissionsDir, slug))) {
          return { name: str, bots: str };
        }
      } catch {}
    }
    return { name: str, bots: defaultBots };
  }

  private resolveSideBot(side: 'violet' | 'lime', swapped = false): string {
    const effectiveSide = swapped ? (side === 'violet' ? 'lime' : 'violet') : side;
    if (effectiveSide === 'violet' && this.opts.homeBots) return this.opts.homeBots;
    if (effectiveSide === 'lime' && this.opts.awayBots) return this.opts.awayBots;
    const bots = this.opts.bots ?? 'reference';
    if (bots === 'reference' || bots === 'examples' || bots === 'example') {
      return bots === 'examples' ? 'example' : bots;
    }
    if (bots.includes(',')) {
      const [h, a] = bots.split(',').map((s) => s.trim());
      return effectiveSide === 'violet' ? (h || 'reference') : (a || 'reference');
    }
    if (bots.includes(':')) {
      const [h, a] = bots.split(':').map((s) => s.trim());
      return effectiveSide === 'violet' ? (h || 'reference') : (a || 'reference');
    }
    return effectiveSide === 'violet' ? 'reference' : bots;
  }

  private isSubmission(bot: string): boolean {
    if (bot === 'reference' || bot === 'example' || bot === 'examples') return false;
    if (botRoster().some((b) => b.name === bot)) return false;
    return true;
  }

  private resolveTeamNames(
    resolvedLineup: Partial<Record<string, LineupEntry>>,
    violetBot: string,
    limeBot: string,
    configuredVioletName?: string,
    configuredLimeName?: string,
  ): { violet: string; lime: string } {
    const isDefaultName = (name?: string) =>
      !name ||
      name === 'Violet' ||
      name === 'Lime' ||
      name === 'reference' ||
      name === 'example' ||
      name === 'examples' ||
      botRoster().some((b) => b.name === name);

    const defaultHome = isDefaultName(configuredVioletName);
    const defaultAway = isDefaultName(configuredLimeName);

    const nameForSide = (
      side: 'violet' | 'lime',
      isDefault: boolean,
      configuredName: string | undefined,
      bot: string,
    ): string => {
      if (!isDefault && configuredName) return configuredName;

      const entry = resolvedLineup[`${side}-1`] ?? resolvedLineup[`${side}-2`];
      if (entry?.manifest.team) return entry.manifest.team;

      if (bot !== 'reference' && bot !== 'example' && bot !== 'examples') {
        return bot
          .split(/[-_]+/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
      }

      if (bot === 'example' || bot === 'examples') {
        return 'Examples';
      }

      if (violetBot === 'reference' && (limeBot === 'reference' || !limeBot)) {
        if (this.teamPool && this.teamPool.length === 1 && configuredName && configuredName !== 'Violet' && configuredName !== 'Lime') {
          return configuredName;
        }
        return side === 'violet' ? 'Violet' : 'Lime';
      }
      return 'Reference';
    };

    return {
      violet: nameForSide('violet', defaultHome, configuredVioletName, violetBot),
      lime: nameForSide('lime', defaultAway, configuredLimeName, limeBot),
    };
  }

  private buildAgents(violetBot: string, limeBot: string): ReturnType<typeof agentsFor> {
    const agentForSide = (side: 'violet' | 'lime', botName: string) => {
      const rosterBot = botRoster().find((b) => b.name === botName);
      if (rosterBot) {
        const [r1, r2] = rosterBot.make(side);
        return { [`${side}-1`]: r1, [`${side}-2`]: r2 };
      }
      return referenceTeam(side);
    };
    return {
      ...agentForSide('violet', violetBot),
      ...agentForSide('lime', limeBot),
    } as ReturnType<typeof agentsFor>;
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.stopping) return;

      const submissionsDir = this.opts.submissionsDir ?? this.server.submissionsDirectory;
      let violetBot: string;
      let limeBot: string;
      let configuredVioletName: string | undefined;
      let configuredLimeName: string | undefined;

      if (this.teamPool && this.teamPool.length > 0) {
        let teamViolet: { name?: string; bots: string };
        let teamLime: { name?: string; bots: string };

        if (this.teamPool.length === 1) {
          // If it's just one team it would just vs itself
          const only = this.normalizeTeam(this.teamPool[0], submissionsDir);
          teamViolet = only;
          teamLime = only;
        } else {
          // Any number of > 1 teams in the list then we have them get randomly selected
          const i = Math.floor(Math.random() * this.teamPool.length);
          let j = Math.floor(Math.random() * (this.teamPool.length - 1));
          if (j >= i) j++;
          teamViolet = this.normalizeTeam(this.teamPool[i], submissionsDir);
          teamLime = this.normalizeTeam(this.teamPool[j], submissionsDir);
        }

        if (this.opts.randomSides && Math.random() < 0.5) {
          const tmp = teamViolet;
          teamViolet = teamLime;
          teamLime = tmp;
        }

        violetBot = teamViolet.bots;
        limeBot = teamLime.bots;
        configuredVioletName = teamViolet.name;
        configuredLimeName = teamLime.name;
      } else {
        const swapSides = Boolean(this.opts.randomSides && Math.random() < 0.5);
        violetBot = this.resolveSideBot('violet', swapSides);
        limeBot = this.resolveSideBot('lime', swapSides);
        const legacyTeams = this.opts.teams && !Array.isArray(this.opts.teams)
          ? this.opts.teams
          : { violet: 'Violet', lime: 'Lime' };
        configuredVioletName = swapSides ? legacyTeams.lime : legacyTeams.violet;
        configuredLimeName = swapSides ? legacyTeams.violet : legacyTeams.lime;
      }

      // 1. Resolve submissions if either side uses a submitted team
      let resolvedLineup: Partial<Record<string, LineupEntry>> = {};
      if (submissionsDir && (this.isSubmission(violetBot) || this.isSubmission(limeBot))) {
        try {
          resolvedLineup = await resolveLineup(submissionsDir, {
            violet: this.isSubmission(violetBot) ? violetBot : '__none__',
            lime: this.isSubmission(limeBot) ? limeBot : '__none__',
          });
        } catch (err) {
          this.log(`could not resolve submission lineup: ${(err as Error).message}`);
        }
      }

      // 2. Resolve display team names
      const matchTeams = this.resolveTeamNames(
        resolvedLineup,
        violetBot,
        limeBot,
        configuredVioletName,
        configuredLimeName,
      );
      this.currentTeams = matchTeams;

      // 3. Spawn submission processes if any resolved
      let submissionTransports: Partial<Record<string, Transport>> = {};
      if (Object.keys(resolvedLineup).length > 0) {
        try {
          this.lineup = await spawnLineup(
            this.server,
            resolvedLineup,
            {
              pythonLibDir: this.opts.pythonLibDir ?? resolve(REPO_ROOT, 'python'),
              cpuQuotaPercent: this.opts.seatCpuPercent,
              memoryLimitMb: this.opts.seatMemoryMb,
              connectTimeoutSeconds: 10,
            },
            this.log,
          );
          submissionTransports = this.lineup.transports;
        } catch (err) {
          this.log(`could not seat submission lineup: ${(err as Error).message}; playing built-in instead`);
          this.lineup?.stop();
          this.lineup = null;
        }
      }

      // 4. Spawn / seat example robots if needed
      const violetExample = violetBot === 'example' || violetBot === 'examples';
      const limeExample = limeBot === 'example' || limeBot === 'examples';
      let exampleTransports: Partial<Record<string, Transport>> = {};

      if (violetExample && limeExample) {
        exampleTransports = await this.seatExamples(
          ['violet-1', 'violet-2', 'lime-1', 'lime-2'],
          'both',
          matchTeams,
        );
      } else if (violetExample) {
        exampleTransports = await this.seatExamples(['violet-1', 'violet-2'], 'violet', matchTeams);
      } else if (limeExample) {
        exampleTransports = await this.seatExamples(['lime-1', 'lime-2'], 'lime', matchTeams);
      } else {
        this.stopProducers();
      }

      if (this.stopping) {
        this.lineup?.stop();
        this.lineup = null;
        return;
      }

      // 5. In-process agents as fallbacks for all seats
      const agents = this.buildAgents(violetBot, limeBot);
      const transports = { ...exampleTransports, ...submissionTransports };

      try {
        await this.playOne(agents, transports, matchTeams);
      } finally {
        this.lineup?.stop();
        this.lineup = null;
        for (const id of Object.keys(resolvedLineup)) {
          this.server.agents.clearToken(id);
        }
      }
    }
  }

  /**
   * Try to get the python example robots seated, and report who is actually
   * there. A failed spawn or a timeout is not an error: the caller plays
   * whatever is missing with the built-in reference agent, and tries again
   * next time.
   */
  private async seatExamples(
    neededSeats: string[],
    mode: 'both' | 'violet' | 'lime',
    teams: { violet: string; lime: string },
  ): Promise<Partial<Record<string, Transport>>> {
    if (neededSeats.length === 0) {
      this.stopProducers();
      return {};
    }

    const live = this.server.agents.transports();
    const allConnected = neededSeats.every((id) => live[id]?.connected);
    if (allConnected && this.producers.has(mode)) {
      return this.seatsOf(neededSeats);
    }

    this.stopProducers();
    this.spawnProducer(mode, teams, neededSeats);

    try {
      await waitForSeats(this.server, neededSeats, PYTHON_SEAT_TIMEOUT_MS / 1000);
    } catch {
      this.log(`example robots for ${mode} did not join in time; playing built-in instead`);
    }
    return this.seatsOf(neededSeats);
  }

  /**
   * The transports for exactly these seats, and only while somebody is behind
   * them.
   *
   * Not `agents.transports()`, which is every seat the gateway has ever held.
   * A seat is deliberately not released when its socket closes — during a
   * match that is rule 5.7's business, not a withdrawal — so a seat the
   * example robots vacated when they changed sides stays in that map for
   * good. Hand the whole map to `play` and the dead transport wins the seat,
   * because a transport beats the built-in agent for the same id: the demo
   * swaps sides once and the champion spends every match afterwards standing
   * still, answering nothing, with the match record recording every control
   * cycle of it as missed.
   *
   * The `connected` test is the same promise the caller already logs — a
   * program that never joined plays as the built-in agent rather than as a
   * socket with nothing on the end of it.
   */
  private seatsOf(ids: string[]): Partial<Record<string, Transport>> {
    const all = this.server.agents.transports();
    const out: Partial<Record<string, Transport>> = {};
    for (const id of ids) {
      const transport = all[id];
      if (transport && transport.connected !== false) out[id] = transport;
    }
    return out;
  }

  private spawnProducer(
    mode: 'both' | 'violet' | 'lime',
    teams: { violet: string; lime: string },
    seats: string[],
  ): void {
    const script = join(REPO_ROOT, 'python', 'examples', 'play.py');
    const args = [
      'python3',
      script,
      '--url',
      this.server.agentSocketUrl,
      '--violet',
      teams.violet,
      '--lime',
      teams.lime,
    ];
    if (mode === 'violet' || mode === 'lime') {
      args.push('--only', mode);
    }
    try {
      const producer = Bun.spawn(args, {
        cwd: process.cwd(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      this.producers.set(mode, producer);
      this.producerSeats = [...seats];
      this.log(`spawned example robots (${mode}): python3 ${script}`);
      this.drain(producer);
    } catch (err) {
      this.log(`could not start example robots (${(err as Error).message}); playing built-in instead`);
    }
  }

  private drain(producer: Subprocess): void {
    for (const stream of [producer.stdout, producer.stderr]) {
      if (!stream || typeof stream === 'number') continue;
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).trimEnd().split('\n')) {
              if (line) this.log(`[example robots] ${line}`);
            }
          }
        } catch {}
      })();
    }
    producer.exited.then((code) => {
      this.log(`example robots exited (code ${code})`);
      for (const [key, p] of this.producers.entries()) {
        if (p === producer) this.producers.delete(key);
      }
    });
  }

  private stopProducers(): void {
    for (const producer of this.producers.values()) {
      try {
        producer.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    this.producers.clear();
    // Killing the program does not vacate its seat, so say so: the gateway
    // holds a seat until somebody closes it, and a seat nobody is coming back
    // to is a transport the next match would be handed instead of the agent
    // that belongs there. It also means the robots that take these seats next
    // arrive as newcomers rather than as a reconnection, which is what they
    // are — no stand-down left over from a match that has already finished.
    for (const id of this.producerSeats) this.server.agents.close(id);
    this.producerSeats = [];
  }

  private async playOne(
    agents: ReturnType<typeof agentsFor>,
    transports: Partial<Record<string, Transport>> | undefined,
    teams: { violet: string; lime: string },
  ): Promise<void> {
    const gap = this.opts.gapSeconds !== undefined ? this.opts.gapSeconds : 10;
    try {
      const result = await this.server.play({
        agents,
        transports,
        teams,
        league: this.opts.league,
        halfSeconds: this.opts.halfSeconds ?? 300,
        seed: matchSeed(),
        refereed: false,
        nextMatchIn: gap,
      });
      this.log(`full time: ${teams.violet} ${result.score.violet} — ${result.score.lime} ${teams.lime}`);
    } catch (err) {
      // A match that refuses to play must not stop the loop — the screen never
      // sits still, so log it and carry on to the next one.
      this.log(`could not play a demo match: ${(err as Error).message}`);
    }
    // Nobody is standing down between matches. Rule 5.7.2 is measured in the
    // match that imposed it and that match is over, so the number the gateway
    // would ask for is frozen wherever the final whistle left it — and a robot
    // taken off in the dying seconds would be refused its seat for ever when
    // its program reconnects during the gap. `lobby` makes the same point for
    // the same reason.
    this.server.agents.standDown = () => 0;
    await this.pause(gap * 1000);
  }

  private async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    await sleep(ms);
  }

  private json(status: number, body: unknown): Response {
    return Response.json(body, { status });
  }
}

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
