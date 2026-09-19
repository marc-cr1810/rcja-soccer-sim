/**
 * Running a robot program without letting it run the match.
 *
 * A program is whatever produces an ActuatorFrame from a SensorFrame. It might
 * be TypeScript in this process, Python in a container, or a laptop on the
 * venue network; the match does not care and must not, because the fairness
 * argument depends on the same code behaving the same way wherever it runs.
 *
 * The rule that makes this safe is the one a real robot already obeys: if a
 * command does not arrive, the last one stands. A motor controller between loop
 * iterations does exactly that. So a program that hangs, crashes or disconnects
 * does not stall the world, does not forfeit, and does not take its opponent
 * down with it — it drives on with whatever it last asked for, which is both
 * the honest simulation of a hung robot and the safe thing for the tournament.
 */

import { COAST, type ActuatorFrame, type DisabledMessage, type SensorFrame } from './protocol';
import { type SlotReport } from '@rcja/shared/view';

// Re-export so existing callers of agent.SlotReport keep working.
export type { SlotReport };

/** The simplest kind of program: a function, in this process. */
export interface Agent {
  readonly name: string;
  tick(frame: SensorFrame): ActuatorFrame | null | undefined;
  /** Called at kick-off, so a program can drop state it should not carry over. */
  reset?(): void;
}

/**
 * How a program is reached.
 *
 * `send` hands over a frame and `take` collects whatever has come back since
 * the last call. They are separate because a remote program answers whenever it
 * answers, and the match cannot wait: it polls, and takes what is there.
 */
export interface Transport {
  readonly name: string;
  send(frame: SensorFrame): void;
  /** The newest command since the last take, or null if none arrived. */
  take(): ActuatorFrame | null;
  reset(): void;
  close(): void;
  /**
   * Whether the program is still reachable.
   *
   * Optional, and absent for an in-process program, which cannot go away. A
   * program at the other end of a socket can, and the difference matters: a
   * robot whose brain has stopped answering is not a robot playing badly, it
   * is a robot that has stopped, and rule 5.7 has a word for that.
   */
  readonly connected?: boolean;

  /**
   * Whether an answer to the last frame is already in hand.
   *
   * Optional, and only meaningful for a program that answers when it answers.
   * A match does not consult this - the rule that the last command stands is
   * what makes the simulation honest about a hung robot, and waiting would
   * break it. It exists so a HARNESS can choose to wait: a run that steps only
   * once every program has answered is reproducible, and an irreproducible
   * match cannot be bisected, only counted. See `playLockstep`.
   */
  readonly answered?: boolean;

  /**
   * Tell this program it is off the field, and that it should wait.
   *
   * Optional, and a no-op for an in-process program: a local agent is a
   * function call with no socket to keep alive and no timeout to outlast. For
   * a program on a socket this is the whole of what it hears while it is off,
   * and the thing that stops a stand-down being mistaken for a dead server.
   */
  disabled?(state: DisabledMessage): void;
}

/**
 * Clean a frame a program handed back, before it reaches the physics.
 *
 * A NaN motor power would poison a robot's velocity and then, through a
 * collision, the ball and every other robot — one bad program corrupting a
 * match for four. Clamp and substitute instead of trusting, and treat a short
 * array as zeros rather than an error: a program with a bug should play badly,
 * not crash the server.
 */
export function sanitise(frame: unknown, motorCount: number): ActuatorFrame | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Partial<ActuatorFrame>;

  const motors: number[] = [];
  const raw = Array.isArray(f.motors) ? f.motors : [];
  for (let i = 0; i < motorCount; i++) {
    const v = Number(raw[i]);
    motors.push(Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  }

  const dribbler = Number(f.dribbler);
  const out: ActuatorFrame = {
    motors,
    dribbler: Number.isFinite(dribbler) ? Math.max(0, Math.min(1, dribbler)) : 0,
    kicker: f.kicker === true,
  };
  if (f.say !== undefined) out.say = f.say;
  return out;
}

/** A local program, called directly. Errors are caught, not propagated. */
export class LocalTransport implements Transport {
  readonly name: string;
  private pending: ActuatorFrame | null = null;
  private readonly motorCount: number;
  /** Errors the program threw. Reported with the match, never hidden. */
  errors = 0;
  lastError: string | null = null;

  constructor(
    private readonly agent: Agent,
    motorCount: number,
  ) {
    this.name = agent.name;
    this.motorCount = motorCount;
  }

  send(frame: SensorFrame): void {
    try {
      this.pending = sanitise(this.agent.tick(frame), this.motorCount);
    } catch (err) {
      this.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.pending = null;
    }
  }

  take(): ActuatorFrame | null {
    const out = this.pending;
    this.pending = null;
    return out;
  }

  reset(): void {
    this.pending = null;
    this.agent.reset?.();
  }

  close(): void {
    /* nothing to release for an in-process program */
  }
}

// SlotReport is now defined in @rcja/shared/view and re-exported from the top of this file.

/**
 * One robot's connection to its program.
 *
 * Counts what went wrong without ever letting it change the outcome, so a team
 * can see their own timing problems in the match record long before a final —
 * which is the point of publishing missed cycles alongside the score.
 */
export class AgentSlot {
  private last: ActuatorFrame = COAST;
  private missed = 0;
  private run = 0;
  private worstRun = 0;

  constructor(readonly transport: Transport) {}

  /**
   * Hand over a frame and return the command to act on.
   *
   * Order matters: take first, then send. The command collected now is the
   * answer to the frame sent last cycle, which is the one-tick latency every
   * real control loop has between reading a sensor and driving a motor.
   */
  poll(frame: SensorFrame): ActuatorFrame {
    const fresh = this.transport.take();
    if (fresh) {
      this.last = fresh;
      this.run = 0;
    } else {
      this.missed++;
      this.run++;
      if (this.run > this.worstRun) this.worstRun = this.run;
    }
    this.transport.send(frame);
    return this.last;
  }

  /**
   * Tell this seat's program it is off the field.
   *
   * Not a poll: nothing is read back, nothing is remembered, and the standing
   * command is left where it is. A robot that comes back should resume from
   * what it was last told to do, not from a command it never gave.
   */
  disable(state: DisabledMessage): void {
    this.transport.disabled?.(state);
  }

  /** The command standing right now, without polling. */
  current(): ActuatorFrame {
    return this.last;
  }

  reset(): void {
    this.last = COAST;
    this.run = 0;
    this.transport.reset();
  }

  report(): SlotReport {
    const local = this.transport as Partial<LocalTransport>;
    return {
      name: this.transport.name,
      missed: this.missed,
      errors: local.errors ?? 0,
      lastError: local.lastError ?? null,
      worstRun: this.worstRun,
    };
  }
}
