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

import { Match, SEAT_IDS, type SeatId } from './match';
import { resolveLineup, spawnSeat, type SeatProcess } from './lineup';
import { ReferenceAgent } from './reference';
import type { SeedInput } from './rand';
import type { Transport } from './agent';
import type { LeagueId } from './leagues';
import type { MatchServer } from './server';
import type { Arrangement, PlacedRobot, TeamId } from './world';

/** What is driving a seat, or that nothing is. */
export type SeatFill =
  | { kind: 'empty' }
  | { kind: 'built-in' }
  | { kind: 'laptop' }
  | { kind: 'submission'; team: string };

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
  /** The repo's python/ directory. Without one, no submission can be spawned. */
  pythonLibDir?: string | null;
  league?: LeagueId;
  idealSensors?: boolean;
  seed?: SeedInput;
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
    });
    this.arrangement = this.capture();
    this.match.stage(this.arrangement);
    for (const id of SEAT_IDS) this.seats.set(id, { fill: { kind: 'built-in' } });
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
        fill: seat.fill,
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
    if (this.mode === 'play-on') return;
    this.match.setArrangement(this.arrangement);
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
    this.place(id, known ?? defaultSpotFor(id));
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

  /** What drives this seat from now on. Spawns or kills programs as needed. */
  async setSeat(id: SeatId, fill: SeatFill): Promise<void> {
    this.stopSeat(id);
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
      // Back to a self-declared join: a student's laptop has no server-issued
      // token, and a practice field is not where identity is being proved.
      this.server.agents.clearToken(id);
      this.match.clearSeat(id);
      this.seats.set(id, { fill, detail: 'waiting for a program to connect' });
      return;
    }

    const libDir = this.opts.pythonLibDir;
    if (!libDir) {
      this.seats.set(id, { fill, detail: 'this server cannot run submissions' });
      this.match.clearSeat(id);
      return;
    }
    const side = teamOf(id);
    const resolved = await resolveLineup(this.opts.submissionsDir, {
      violet: side === 'violet' ? fill.team : '',
      lime: side === 'lime' ? fill.team : '',
    });
    const entry = resolved[id];
    if (!entry) {
      this.seats.set(id, { fill, detail: `no pushed robot ${numberOf(id)} for "${fill.team}"` });
      this.match.clearSeat(id);
      return;
    }
    this.match.clearSeat(id);
    this.seats.set(id, { fill, detail: 'starting' });
    this.processes.set(id, spawnSeat(this.server, id, entry, { pythonLibDir: libDir }, this.opts.log));
  }

  /** Restart whatever is in this seat. The situation is left alone. */
  async restartSeat(id: SeatId): Promise<void> {
    await this.setSeat(id, this.seats.get(id)!.fill);
  }

  /** Kill this seat's program without forgetting what was in it. */
  stopSeat(id: SeatId): void {
    this.processes.get(id)?.stop();
    this.processes.delete(id);
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
  }
}

/** Somewhere sensible for a robot being put onto the field with no history. */
function defaultSpotFor(id: SeatId): { x: number; z: number; heading: number } {
  const side = teamOf(id) === 'violet' ? -1 : 1;
  return {
    x: side * (numberOf(id) === 2 ? 1500 : 600),
    z: 0,
    heading: side < 0 ? 0 : Math.PI,
  };
}
