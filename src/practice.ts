/**
 * A practice field: a match somebody is arranging by hand.
 *
 * Everything a scored match has is here — the same `World`, the same sandboxed
 * submissions reached over the same gateway, the same rule detectors watching
 * — and the only differences are who decides where things start and that
 * nothing is written down at the end. That is deliberate, and it is the whole
 * point of the phase: a team watching their robot in the corner of the field
 * has to be watching the code that will play the match, under the constraints
 * it will play under, or the rehearsal is a different sport.
 *
 * What is new is that the arrangement, the roster and the programs can all
 * change while it is running. A match settles those before the whistle; a
 * practice field is somebody dragging a robot across the field with one hand
 * and restarting its program with the other.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Match, SEAT_IDS, type SeatId } from './match';
import { resolveLineup, spawnSeat, type LineupEntry, type SeatProcess } from './lineup';
import { WorkspaceStore } from './workspace';
import { ReferenceAgent } from './reference';
import type { SeedInput } from './rand';
import type { Transport } from './agent';
import type { LeagueId } from './leagues';
import type { MatchServer } from './server';
import { defaultSpot, type Arrangement, type PlacedRobot, type TeamId } from './world';

/** What is driving a seat, or that nothing is. */
export type SeatFill =
  | { kind: 'empty' }
  | { kind: 'built-in' }
  | {
      kind: 'laptop';
      /**
       * Whose robot this is. A league server fills it in; a laptop leaves it
       * out, because there is nobody there to be.
       */
      team?: string;
      /**
       * What a join claiming this seat must present.
       *
       * Minted per seat by whatever is supervising this field and handed to
       * the student the way `submit.py` hands them a push key. Without one
       * the seat is back to a self-declared join, which is exactly right on a
       * laptop with no accounts and exactly wrong on a league server, where a
       * seat nobody can attribute is a seat no ledger can count.
       */
      token?: string;
    }
  | { kind: 'submission'; team: string }
  | {
      /**
       * Whatever this team last typed in the browser, run as it stands.
       *
       * The difference from `submission` is not how it runs — same sandbox,
       * same grants, same gateway — but what it is: unpushed, unvalidated,
       * possibly not even parseable. That is the point. A push is the code
       * that plays matches and is held to the whole validator; this is the
       * code somebody is still writing, and refusing to run it until it was
       * good enough to compete would be refusing to run it when it is needed.
       *
       * Which of the team's two robots is not carried here: the seat says.
       * `violet-2` is that team's robot 2, exactly as it is for a submission,
       * so one-robot-one-place needs nothing new to count this.
       */
      kind: 'workspace';
      team: string;
    };

/**
 * What happens when the situation resolves itself — a goal, a ball out of
 * play, a lack of progress.
 *
 * A referee's console has the same shape of control for the same reason: the
 * person watching is the one who knows what they are trying to see, and the
 * answer changes between one look and the next.
 */
export type ResolveMode =
  /** Put the arrangement back out and play it again. */
  | 'restage'
  /** Carry on as an ordinary match would, from a kick-off. */
  | 'play-on'
  /** Stop and hold the field exactly as it is. */
  | 'freeze';

export interface SeatState {
  fill: SeatFill;
  /** Whether this robot is part of the situation at all. */
  onField: boolean;
  /**
   * Whether it is off the field right now despite being in the situation -
   * rule 5.7, which on a practice field mostly means its program is not
   * answering. It comes back by itself when the program does.
   */
  removed: boolean;
  /** Whether a program is in the seat. */
  filled: boolean;
  /** Whether that program is answering. */
  connected: boolean;
  /** Why the seat is not what was asked for, when it is not. */
  detail?: string;
  /**
   * How many lines this seat's program has said, ever.
   *
   * The number rather than the text: state is polled once a second by everybody
   * on the field, and a traceback is read by one person on one seat. A console
   * watching this move knows to go and fetch the rest.
   */
  outputSeq: number;
}

export interface PracticeState {
  running: boolean;
  resolve: ResolveMode;
  clock: number;
  score: Record<TeamId, number>;
  arrangement: Arrangement;
  seats: Record<string, SeatState>;
}

export interface PracticeOptions {
  /** Where validated pushes live, for a seat filled by a submission. */
  submissionsDir: string;
  /**
   * Where team folders live, for a seat running what somebody is still typing.
   *
   * Absent on a field with no workspaces behind it — a `bun run serve practice`
   * on a laptop — and then a workspace seat is refused with a sentence rather
   * than quietly falling back to something else.
   */
  workspacesDir?: string | null;
  /**
   * Where to keep this field's arrangement, so closing costs a process and not
   * an afternoon.
   *
   * A supervisor hands this in — `workspaces/<owner>/field.json` — and the file
   * is written here, by the arena itself, whenever the situation changes. Not
   * written by whoever closes the field: an arena dies by having its process
   * group killed, so a crash, a pre-emption and a hub restart all lose a
   * save-on-close, and those are exactly the endings this exists for.
   */
  fieldStatePath?: string | null;
  /**
   * Somewhere to keep the copies a Run seat is running out of.
   *
   * A supervisor hands this in and removes it when the arena ends, which is
   * the only thing that can: an arena is killed rather than asked to stop.
   * Without one — a practice field started by hand — the system temp directory
   * does, and ctrl-c cleans up on the way out.
   */
  runRoot?: string | null;
  /** The repo's python/ directory. Without one, no submission can be spawned. */
  pythonLibDir?: string | null;
  league?: LeagueId;
  idealSensors?: boolean;
  seed?: SeedInput;
  /**
   * Per-seat grants, and deliberately the same ones a fixture plays under.
   *
   * The tempting lever at a venue is to shrink practice seats to fit more
   * fields in, and it is not available: a rehearsal under different conditions
   * is a rehearsal of a different sport — the argument that rejected running
   * the simulator in the browser. A venue may turn how many arenas run at
   * once, and not what a robot is given inside one.
   */
  seatCpuPercent?: number;
  seatMemoryMb?: number;
  log?: (line: string) => void;
}

/**
 * Long enough that nothing about a rehearsal is measured against it.
 *
 * The practice loop never ends a half, but the world reads the half length
 * for one thing: how long rule 5.7.2 stands a robot down for. Five minutes
 * keeps that at thirty seconds rather than a minute.
 */
const PRACTICE_HALF_SECONDS = 300;

/**
 * How much of a seat's output is kept, and it is a deliberately small amount.
 *
 * What a student needs is the last traceback, not a session log: a program that
 * prints every tick would otherwise push the one thing worth reading off the
 * end anyway, and four of these live in an arena that is also holding a physics
 * loop. Whichever limit is hit first wins.
 */
const OUTPUT_MAX_LINES = 200;
const OUTPUT_MAX_BYTES = 32 * 1024;

/**
 * How long a drag settles before the arrangement is written down.
 *
 * Dragging a robot across the field is a stream of these; the file only has to
 * be right shortly after somebody stops moving things, and the whole point is
 * that it survives an ending nobody got to prepare for.
 */
const FIELD_SAVE_DEBOUNCE_MS = 2_000;

/** One seat's output, oldest first, with a number that only ever goes up. */
interface SeatOutput {
  lines: { seq: number; text: string }[];
  seq: number;
  bytes: number;
}

function teamOf(id: string): TeamId {
  return id.startsWith('violet') ? 'violet' : 'lime';
}

function numberOf(id: string): 1 | 2 {
  return id.endsWith('-2') ? 2 : 1;
}

export class PracticeSession {
  readonly match: Match;
  /** Where a restart puts everything back to. Changed by dragging, and by hand. */
  private arrangement: Arrangement;
  private readonly seats = new Map<SeatId, { fill: SeatFill; detail?: string }>();
  private readonly processes = new Map<SeatId, SeatProcess>();
  /** The transport currently wired into each seat, so a reconnect can be spotted. */
  private readonly wired = new Map<SeatId, Transport>();
  /** What each seat's program has said, for the student who has to read it. */
  private readonly output = new Map<SeatId, SeatOutput>();
  /** The snapshot directory a workspace seat is running out of, to be removed. */
  private readonly runDirs = new Map<SeatId, string>();
  private readonly workspaces: WorkspaceStore | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: ResolveMode = 'restage';

  constructor(
    private readonly server: MatchServer,
    private readonly opts: PracticeOptions,
  ) {
    // Opens as an ordinary kick-off with the built-in agent in all four
    // seats. A field that starts as a real match is easier to take apart
    // than an empty one is to fill, and it means something is always moving
    // on the screen the moment the page loads.
    this.match = new Match({
      agents: {
        'violet-1': new ReferenceAgent({ team: 'violet', number: 1, role: 'striker' }),
        'violet-2': new ReferenceAgent({ team: 'violet', number: 2, role: 'goalie' }),
        'lime-1': new ReferenceAgent({ team: 'lime', number: 1, role: 'striker' }),
        'lime-2': new ReferenceAgent({ team: 'lime', number: 2, role: 'goalie' }),
      },
      teams: { violet: 'Violet', lime: 'Lime' },
      league: opts.league,
      halfSeconds: PRACTICE_HALF_SECONDS,
      seed: opts.seed ?? 1,
      idealSensors: opts.idealSensors ?? false,
      // The one caller that opts out of the mercy rule. A field is a rehearsal
      // with no result to shorten, and ending one because the reference agent
      // ran away with it would be taking the field off the team using it.
      mercyMargin: null,
    });
    this.workspaces = opts.workspacesDir ? new WorkspaceStore({ dir: opts.workspacesDir }) : null;
    // What somebody spent twenty minutes dragging into place, if this field has
    // been open before. Read here rather than awaited later so the first thing
    // staged is already the right thing: a field that opens on the defaults and
    // jumps a moment afterwards looks like it lost the arrangement and found it
    // again.
    this.arrangement = readArrangement(opts.fieldStatePath) ?? this.capture();
    // `stage` sets what a restart goes back to as well as putting it out now.
    this.match.stage(this.arrangement);
    for (const id of SEAT_IDS) this.seats.set(id, { fill: { kind: 'built-in' } });
  }

  // --------------------------------------------------------------- the output

  /** Keep a line this seat's program said, trimming the oldest away. */
  private append(id: SeatId, text: string): void {
    const buffer = this.output.get(id) ?? { lines: [], seq: 0, bytes: 0 };
    for (const line of text.split('\n')) {
      buffer.seq += 1;
      buffer.lines.push({ seq: buffer.seq, text: line });
      buffer.bytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    while (buffer.lines.length > OUTPUT_MAX_LINES || buffer.bytes > OUTPUT_MAX_BYTES) {
      const dropped = buffer.lines.shift();
      if (!dropped) break;
      buffer.bytes -= Buffer.byteLength(dropped.text, 'utf8') + 1;
    }
    this.output.set(id, buffer);
  }

  /**
   * What this seat has said since line `since`.
   *
   * `seq` comes back whether or not anything did, because a console that has
   * fallen behind the ring buffer needs to know it has rather than waiting for
   * a line that was dropped.
   */
  outputOf(id: SeatId, since = 0): { seq: number; lines: { seq: number; text: string }[] } {
    const buffer = this.output.get(id);
    if (!buffer) return { seq: 0, lines: [] };
    return { seq: buffer.seq, lines: buffer.lines.filter((line) => line.seq > since) };
  }

  /** The field as it stands right now, as an arrangement. */
  private capture(): Arrangement {
    return {
      robots: this.match.world.robots.map((r) => ({
        id: r.id,
        x: r.x,
        z: r.z,
        heading: r.heading,
        isGoalie: r.isGoalie,
      })),
      ball: { x: this.match.world.ball.x, z: this.match.world.ball.z },
    };
  }

  state(): PracticeState {
    const seats: Record<string, SeatState> = {};
    for (const id of SEAT_IDS) {
      const seat = this.seats.get(id)!;
      seats[id] = {
        // Redacted, not omitted: state is read by everybody on the field, and
        // a join token is for one student's terminal. The console is told the
        // token once, in the answer to the request that minted it.
        fill: seat.fill.kind === 'laptop' ? { ...seat.fill, token: undefined } : seat.fill,
        onField: this.match.world.robots.some((r) => r.id === id),
        removed: this.match.world.robots.some((r) => r.id === id && r.removed),
        filled: this.match.hasSeat(id),
        // A built-in agent is a function call and cannot go away. Anything
        // else has to have actually joined, and still be there: a seat whose
        // program was killed a moment ago is not connected just because
        // nothing has asked it a question yet.
        connected:
          seat.fill.kind === 'built-in'
            ? this.match.hasSeat(id)
            : (this.wired.get(id)?.connected ?? false),
        detail: seat.detail,
        outputSeq: this.output.get(id)?.seq ?? 0,
      };
    }
    return {
      running: this.match.world.running,
      resolve: this.mode,
      clock: this.match.world.clock,
      score: { ...this.match.world.score },
      arrangement: this.arrangement,
      seats,
    };
  }

  start(): void {
    this.match.world.running = true;
    this.match.world.paused = false;
  }

  stop(): void {
    this.match.world.running = false;
  }

  /**
   * Move a robot or the ball, now, and remember it as part of the situation.
   *
   * One meaning rather than two: a drag both moves the thing and changes where
   * a re-stage will put it back. Anything else and the field a team arranges
   * and the field it replays stop being the same field, which is exactly the
   * confusion a rehearsal cannot afford.
   */
  place(target: 'ball' | SeatId, at: { x: number; z: number; heading?: number; vx?: number; vz?: number }): void {
    if (target === 'ball') {
      this.match.world.ball.x = at.x;
      this.match.world.ball.z = at.z;
      this.match.world.ball.vx = at.vx ?? 0;
      this.match.world.ball.vz = at.vz ?? 0;
      this.arrangement = { ...this.arrangement, ball: { x: at.x, z: at.z, vx: at.vx, vz: at.vz } };
      this.remember();
      return;
    }

    const existing = this.arrangement.robots.find((r) => r.id === target);
    const spec: PlacedRobot = {
      id: target,
      x: at.x,
      z: at.z,
      heading: at.heading ?? existing?.heading ?? 0,
      isGoalie: existing?.isGoalie ?? numberOf(target) === 2,
    };
    this.match.world.place(spec);
    this.arrangement = {
      ...this.arrangement,
      robots: [...this.arrangement.robots.filter((r) => r.id !== target), spec],
    };
    this.remember();
  }

  /**
   * Tell the match what a restart goes back to, without putting it out now.
   *
   * Dragging one thing must not move everything else, so nothing here applies
   * the arrangement - `restage` is the button that does that, deliberately and
   * on purpose.
   */
  private remember(): void {
    this.saveField();
    if (this.mode === 'play-on') return;
    this.match.setArrangement(this.arrangement);
  }

  /**
   * Write the arrangement down, shortly.
   *
   * Debounced rather than immediate because a drag arrives as a stream of
   * these, and the file only has to be right once somebody has stopped moving
   * things. The first change in a window schedules the write; whatever the
   * situation is when it fires is what gets saved.
   */
  private saveField(): void {
    const path = this.opts.fieldStatePath;
    if (!path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeField(path);
    }, FIELD_SAVE_DEBOUNCE_MS);
    // Housekeeping, not work: a pending save should not hold the process open.
    this.saveTimer.unref?.();
  }

  private async writeField(path: string): Promise<void> {
    try {
      // The team folder may not exist yet: a team can be given a field before
      // they have ever opened the editor.
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, `${JSON.stringify({ arrangement: this.arrangement }, null, 2)}\n`);
    } catch (err) {
      // A field that cannot save its arrangement is still a field. Said once,
      // to the venue's log, rather than thrown at the person dragging a robot.
      this.opts.log?.(`could not save the arrangement: ${(err as Error).message}`);
    }
  }

  /** Put a robot into the situation, or take it out of it entirely. */
  setRoster(id: SeatId, onField: boolean): void {
    if (!onField) {
      this.match.world.takeOff(id);
      this.arrangement = {
        ...this.arrangement,
        robots: this.arrangement.robots.filter((r) => r.id !== id),
      };
      this.remember();
      return;
    }
    const known = this.arrangement.robots.find((r) => r.id === id);
    this.place(id, known ?? defaultSpot(id));
  }

  /** Put the situation back out as it was arranged. */
  restage(): void {
    this.match.stage(this.arrangement);
  }

  /** Take the field as it stands to be the situation from now on. */
  keepAsArranged(): void {
    this.arrangement = this.capture();
    this.match.stage(this.arrangement);
  }

  setResolve(mode: ResolveMode): void {
    this.mode = mode;
    const config = this.match.world.config;
    // Read fresh on every detector, so these take effect on the next step
    // rather than at the next restart.
    config.autoResolve = mode !== 'freeze';
    config.autoDamaged = mode !== 'freeze';
    if (mode === 'play-on') this.match.world.unstage();
    else this.match.setArrangement(this.arrangement);
  }

  /**
   * What drives this seat from now on. Spawns or kills programs as needed.
   *
   * Changing what a seat is *for* clears what the last thing in it said: a
   * traceback belongs to a program, and reading the previous occupant's crash
   * under a different robot's name is worse than reading nothing.
   */
  async setSeat(id: SeatId, fill: SeatFill, keepOutput = false): Promise<void> {
    this.stopSeat(id);
    if (!keepOutput) this.output.delete(id);
    this.seats.set(id, { fill });

    if (fill.kind === 'empty') {
      this.match.clearSeat(id);
      this.setRoster(id, false);
      return;
    }

    // A seat with something in it belongs on the field.
    if (!this.match.world.robots.some((r) => r.id === id)) this.setRoster(id, true);

    if (fill.kind === 'built-in') {
      const robot = this.match.world.robots.find((r) => r.id === id);
      this.match.setSeat(
        id,
        new ReferenceAgent({
          team: teamOf(id),
          number: numberOf(id),
          // The built-in agent has roles; the simulator does not. Which one
          // this seat gets follows rule 5.8's nomination on the robot itself,
          // not its number.
          role: robot?.isGoalie ? 'goalie' : 'striker',
        }),
      );
      return;
    }

    if (fill.kind === 'laptop') {
      // With a token, this seat is somebody in particular: Phase 1's rule —
      // identity comes from the credential, never from the client's say-so —
      // arriving where Phase 4 deliberately skipped it. Without one, a
      // self-declared join, which is what a match server on a classroom
      // laptop has always wanted and still gets.
      if (fill.token) this.server.agents.expectToken(id, fill.token);
      else this.server.agents.clearToken(id);
      this.match.clearSeat(id);
      this.seats.set(id, { fill, detail: 'waiting for a program to connect' });
      return;
    }

    const libDir = this.opts.pythonLibDir;
    if (!libDir) {
      this.fault(id, fill, 'this server cannot run submissions');
      return;
    }

    if (fill.kind === 'workspace') {
      await this.runWorkspace(id, fill.team, libDir);
      return;
    }

    const side = teamOf(id);
    const resolved = await resolveLineup(this.opts.submissionsDir, {
      violet: side === 'violet' ? fill.team : '',
      lime: side === 'lime' ? fill.team : '',
    });
    const entry = resolved[id];
    if (!entry) {
      this.fault(id, fill, `no pushed robot ${numberOf(id)} for "${fill.team}"`);
      return;
    }
    this.startProgram(id, fill, entry, libDir);
  }

  /**
   * Run what a team has typed, as it stands.
   *
   * A copy of the folder rather than the folder itself — see
   * `WorkspaceStore.snapshot` — and a token minted right here, because nothing
   * outside this arena ever needs it: the program is started by us, joins our
   * own gateway over our own socket, and dies with the seat. A pushed
   * submission carries a token issued at submit time for the same job; this one
   * has no push to have been issued by.
   */
  private async runWorkspace(id: SeatId, team: string, libDir: string): Promise<void> {
    const fill = this.seats.get(id)!.fill;
    if (!this.workspaces) {
      this.fault(id, fill, 'this server is not hosting team workspaces');
      return;
    }

    let dir: string;
    try {
      dir = await mkdtemp(join(this.opts.runRoot ?? tmpdir(), `run-${id}-`));
    } catch (err) {
      this.fault(id, fill, `could not make somewhere to run it: ${(err as Error).message}`);
      return;
    }
    this.runDirs.set(id, dir);

    const snapshot = await this.workspaces.snapshot(team, numberOf(id), dir);
    if (!snapshot.ok) {
      // The one failure a student actually hits, so it is said in both places
      // they might look: under the seat, and in the seat's own output.
      this.fault(id, fill, snapshot.reason);
      return;
    }

    this.startProgram(id, fill, { ...snapshot.value, token: randomBytes(18).toString('base64url') }, libDir);
  }

  /** This seat is not going to run, and this is why — said where it is read. */
  private fault(id: SeatId, fill: SeatFill, reason: string): void {
    this.seats.set(id, { fill, detail: reason });
    this.append(id, reason);
    this.match.clearSeat(id);
  }

  /** Start a resolved program in a seat, keeping what it says. */
  private startProgram(id: SeatId, fill: SeatFill, entry: LineupEntry, libDir: string): void {
    this.match.clearSeat(id);
    this.seats.set(id, { fill, detail: 'starting' });
    this.processes.set(
      id,
      spawnSeat(
        this.server,
        id,
        entry,
        {
          pythonLibDir: libDir,
          cpuQuotaPercent: this.opts.seatCpuPercent,
          memoryLimitMb: this.opts.seatMemoryMb,
        },
        this.opts.log,
        (text) => this.append(id, scrub(text, entry.dir, this.server.agentSocketUrl)),
        () => {
          // Only if nothing else has happened to the seat in the meantime: a
          // team who changed their mind mid-crash-loop should not have the
          // dead program's last word land on whatever they chose instead.
          const seat = this.seats.get(id);
          if (seat?.fill === fill) {
            this.seats.set(id, { fill, detail: 'its program would not start — see Output' });
          }
        },
      ),
    );
  }

  /**
   * Restart whatever is in this seat. The situation is left alone.
   *
   * The output is kept, with a line to say a restart happened: what a student
   * is doing when they press this is comparing the crash with what happens
   * next, and clearing the panel takes away the half of that they already had.
   */
  async restartSeat(id: SeatId): Promise<void> {
    this.append(id, '— restarted —');
    await this.setSeat(id, this.seats.get(id)!.fill, true);
  }

  /** Kill this seat's program without forgetting what was in it. */
  stopSeat(id: SeatId): void {
    this.processes.get(id)?.stop();
    this.processes.delete(id);
    const runDir = this.runDirs.get(id);
    if (runDir) {
      this.runDirs.delete(id);
      // The copy this seat was running out of. Removed after the process is
      // stopped, and failing to remove it is not worth telling anybody about:
      // it is a temporary directory and the machine will have it back.
      void rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
    this.wired.delete(id);
    this.server.agents.close(id);
    // Nothing is driving it now, so nothing should be pretending to: the seat
    // keeps what it is *for*, and `syncSeats` takes its robot off the field
    // on the next frame the way any other disconnection does.
    if (this.seats.get(id)?.fill.kind !== 'built-in') this.match.clearSeat(id);
  }

  /**
   * Wire up whatever has connected since the last frame, and take off robots
   * whose programs have gone away.
   *
   * Polled from the run loop rather than pushed from the gateway, because the
   * question is not "did somebody connect" but "is this seat being driven right
   * now", and that has exactly one honest answer per frame. Four map lookups a
   * frame is not a cost worth an event system.
   */
  syncSeats(): void {
    const live = this.server.agents.transports();
    for (const id of SEAT_IDS) {
      const seat = this.seats.get(id)!;
      if (seat.fill.kind === 'empty' || seat.fill.kind === 'built-in') continue;

      const transport = live[id];
      if (transport && this.wired.get(id) !== transport) {
        this.wired.set(id, transport);
        this.match.setSeat(id, transport);
        this.seats.set(id, { fill: seat.fill });
      }

      const robot = this.match.world.robots.find((r) => r.id === id);
      if (!robot) continue;
      const connected = this.wired.get(id)?.connected ?? false;

      if (!connected && !robot.removed) {
        // Off the field rather than standing there as an obstacle nobody is
        // driving — the same call `Match.control` makes during play, made here
        // as well so it holds while the field is stopped, which is most of the
        // time on a practice field.
        this.match.world.removeRobot(id, '5.7.1', 'Its program is not connected.');
        continue;
      }
      if (connected && robot.removed && robot.removalRule === '5.7.1') {
        // Straight back on, where the situation says it stands. A stand-down
        // is a match sanction; a team restarting their own program in practice
        // has not been sanctioned for anything.
        robot.penaltyRemaining = 0;
        if (this.match.world.returnRobot(id)) {
          const spec = this.arrangement.robots.find((r) => r.id === id);
          if (spec) this.match.world.place(spec);
        }
      }
    }
  }

  /** Stop every program this field started. */
  close(): void {
    for (const id of SEAT_IDS) this.stopSeat(id);
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // A drag in the last couple of seconds is still part of the situation
    // somebody arranged. Written on the spot rather than scheduled, because the
    // process this is running in is usually about to exit.
    const path = this.opts.fieldStatePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ arrangement: this.arrangement }, null, 2)}\n`);
    } catch {
      // Same as the debounced write: a field that cannot save its arrangement
      // is still a field, and this one is on its way out anyway.
    }
  }
}

/**
 * Take the server's own plumbing out of what a student reads.
 *
 * Two things leak into it. A traceback names the file it failed in by its full
 * path, and under a Run that path is a scratch directory with a random name in
 * it — they wrote `robot.py`, so it should say `robot.py`. And the client
 * library announces the address it joined, which on a laptop is the URL the
 * student typed and here is a Unix socket nobody has ever seen or could use.
 */
export function scrub(text: string, dir: string, socketUrl: string): string {
  return text.split(`${dir}/`).join('').split(socketUrl).join('this field');
}

/**
 * The arrangement a field was left in, if it was left in one.
 *
 * Hand-written is a case, not an accident: this file sits in the team's own
 * folder beside their code, and the promise the whole workspace makes is that
 * an admin can fix any of it in a text editor at eleven at night. So anything
 * unreadable, half-written or nonsense is *ignored* and the field opens on the
 * defaults — never thrown, because a broken scratch file must not be the reason
 * a team cannot open a field.
 */
function readArrangement(path: string | null | undefined): Arrangement | null {
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { arrangement?: unknown };
    const raw = data.arrangement as Arrangement | undefined;
    if (!raw || !Array.isArray(raw.robots) || !raw.ball) return null;

    const robots: PlacedRobot[] = [];
    for (const robot of raw.robots) {
      if (!SEAT_IDS.includes(robot?.id as SeatId)) continue;
      if (![robot.x, robot.z, robot.heading].every((n) => Number.isFinite(n))) continue;
      robots.push({
        id: robot.id,
        x: robot.x,
        z: robot.z,
        heading: robot.heading,
        isGoalie: robot.isGoalie === true,
      });
    }
    if (!Number.isFinite(raw.ball.x) || !Number.isFinite(raw.ball.z)) return null;

    // A saved field with nobody on it is a saved field: a team that took all
    // four robots off to look at one thing meant that.
    return { robots, ball: { x: raw.ball.x, z: raw.ball.z } };
  } catch {
    return null;
  }
}

