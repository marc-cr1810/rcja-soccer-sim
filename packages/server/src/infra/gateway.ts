/**
 * Where robot programs connect.
 *
 * A program is not a function here. It is a process somewhere — on a team's
 * laptop at a scrimmage, or in a container beside the simulator for a scored
 * match — and it reaches the world through exactly the same narrow opening a
 * local one does: a sensor frame out, an actuator frame back.
 *
 * The match never waits for a program. It polls, and takes whatever has arrived
 * since the last cycle; if nothing has, the last command stands, which is what
 * a motor controller does between loop iterations and what a real robot does
 * when its loop hangs. A program that is slow plays badly. It does not stall
 * the world, and it cannot take its opponent down with it.
 */

import type { ServerWebSocket } from 'bun';
import { sanitise, type Transport } from '../match/agent';
import {
  PROTOCOL_VERSION,
  type ActuatorFrame,
  type DisabledMessage,
  type SensorFrame,
} from '../match/protocol';

/** What a program says when it connects. */
export interface JoinMessage {
  type: 'join';
  protocol: number;
  team: 'violet' | 'lime';
  /** 1 or 2. */
  robot: number;
  /** The team's name, for the scoreboard. */
  name?: string;
  /** Server-issued at submit time. Required only for a seat that has one registered — see `expectToken`. */
  token?: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  robot: string;
  motors: number;
  protocol: number;
}

export interface RejectMessage {
  type: 'reject';
  reason: string;
}

/** Sent every control cycle. */
export interface SensorMessage {
  type: 'sensors';
  frame: SensorFrame;
}

/** What a program sends back. */
export interface CommandMessage {
  type: 'command';
  frame: ActuatorFrame;
}

export type AgentServerMessage = WelcomeMessage | RejectMessage | SensorMessage | DisabledMessage;
export type AgentClientMessage = JoinMessage | CommandMessage;

/** The path a program connects to, so viewers and agents share one port. */
export const AGENT_PATH = '/agent';

/**
 * How often a robot that is off the field is told so.
 *
 * Comfortably inside the ten seconds a client waits before deciding the server
 * has gone, and far enough apart to be nothing beside a sensor frame every
 * twentieth of a second.
 */
const DISABLED_EVERY_MS = 1_000;

/**
 * One connected program.
 *
 * Holds only the newest command. If a program answers twice between polls the
 * older answer is already stale — it was a reply to a sensor frame the world
 * has moved past — and acting on it would be worse than dropping it.
 *
 * Bun's native WebSocket model uses a central dispatch rather than per-socket
 * event listeners, so this transport exposes `onMessage`, `onClose`, and
 * `onError` methods that `server.ts`'s websocket handler calls directly.
 */
export class RemoteTransport implements Transport {
  private pending: ActuatorFrame | null = null;

  /** Whether the reply to the last frame has arrived. See `Transport.answered`. */
  get answered(): boolean {
    return this.pending !== null;
  }

  private closed = false;
  private socket: ServerWebSocket<unknown>;
  /** Commands that arrived and were superseded before the next poll. */
  overruns = 0;
  /** Commands rejected as malformed. */
  rejected = 0;
  /** How many times this seat's program has come back after dropping out. */
  reconnects = 0;
  /** When this seat was last told it is off the field. See `disabled`. */
  private lastDisabled = 0;

  constructor(
    readonly name: string,
    readonly robotId: string,
    socket: ServerWebSocket<unknown>,
    private readonly motorCount: number,
  ) {
    this.socket = socket;
  }

  /**
   * Point this seat at a new connection.
   *
   * The seat survives the program behind it dying, because the match is
   * holding this object: swapping the socket underneath keeps a reconnecting
   * team in the same seat instead of handing them a new one, and keeps the
   * record of what they did before they dropped.
   *
   * Whatever the old connection had queued is dropped. It was an answer to a
   * sensor frame the world has long since moved past.
   */
  reattach(socket: ServerWebSocket<unknown>): void {
    try {
      if (this.socket !== socket) this.socket.close();
    } catch {
      // Already gone, which is usually why we are here.
    }
    this.socket = socket;
    this.pending = null;
    this.closed = false;
    this.lastDisabled = 0;
    this.reconnects++;
  }

  get connected(): boolean {
    return !this.closed;
  }

  /** Called by the central websocket.message handler for every message on this socket. */
  onMessage(text: string): void {
    let message: AgentClientMessage;
    try {
      message = JSON.parse(text) as AgentClientMessage;
    } catch {
      this.rejected++;
      return;
    }
    if (message.type !== 'command') return;
    const clean = sanitise(message.frame, this.motorCount);
    if (!clean) {
      this.rejected++;
      return;
    }
    if (this.pending) this.overruns++;
    this.pending = clean;
  }

  /** Called by the central websocket.close handler. */
  onClose(): void {
    this.closed = true;
  }

  /** Called by the central websocket.error handler. */
  onError(): void {
    this.closed = true;
  }

  send(frame: SensorFrame): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify({ type: 'sensors', frame } satisfies SensorMessage));
    } catch {
      this.closed = true;
    }
  }

  /**
   * Tell the program it is off the field. Throttled to about once a second.
   *
   * Throttled against the *wall* clock rather than the match clock, because
   * what this has to outlast is a socket read timeout, and a socket does not
   * know the referee has paused. Once a second is far inside the ten seconds a
   * client waits, and is nothing next to a sensor frame every twentieth.
   */
  disabled(state: DisabledMessage): void {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastDisabled < DISABLED_EVERY_MS) return;
    this.lastDisabled = now;
    try {
      this.socket.send(JSON.stringify(state satisfies DisabledMessage));
    } catch {
      this.closed = true;
    }
  }

  take(): ActuatorFrame | null {
    const out = this.pending;
    this.pending = null;
    return out;
  }

  reset(): void {
    this.pending = null;
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // Socket already closed
    }
  }
}

export interface SeatReport {
  overruns: number;
  rejected: number;
  connected: boolean;
  reconnects: number;
}

export interface Seat {
  transport: RemoteTransport;
  team: 'violet' | 'lime';
  number: number;
  teamName: string;
}

/**
 * The four seats at a match, and who is sitting in them.
 *
 * A seat is claimed by robot rather than by team, because the two robots on a
 * side are separate programs on separate connections — the same arrangement as
 * two robots on a real field, each with its own brain and no shared memory
 * beyond what rule 4.2.5 lets them say to each other.
 */
export class AgentGateway {
  private readonly seats = new Map<string, Seat>();
  /**
   * Seats a validated submission was issued a token for — set by whoever
   * spawns it (`lineup.ts`), checked at join. A seat absent from this map
   * requires no token at all, which is what keeps `--agents` mode, `bun run
   * bench`, and local dev working exactly as they did before this existed.
   */
  private readonly expectedTokens = new Map<string, string>();
  private waiters: (() => void)[] = [];
  /**
   * Asked whether a seat is still serving a penalty, and for how long.
   *
   * The gateway does not own that fact - the match does, because it is
   * measured in match seconds and paused with the clock - so it asks. Absent
   * outside a match, when a seat can always be claimed.
   */
  standDown: ((robotId: string) => number) | null = null;

  /** How many of the four seats are filled. */
  get filled(): number {
    return this.seats.size;
  }

  get ready(): boolean {
    if (this.seats.size !== 4) return false;
    return [...this.seats.values()].every((seat) => seat.transport.connected);
  }

  /** Team names as claimed by whoever connected, for the scoreboard. */
  teamNames(): { violet: string; lime: string } {
    const name = (team: 'violet' | 'lime'): string => {
      for (const seat of this.seats.values()) {
        if (seat.team === team && seat.teamName) return seat.teamName;
      }
      return team === 'violet' ? 'Violet' : 'Lime';
    };
    return { violet: name('violet'), lime: name('lime') };
  }

  transports(): Partial<Record<string, Transport>> {
    const out: Partial<Record<string, Transport>> = {};
    for (const [id, seat] of this.seats) out[id] = seat.transport;
    return out;
  }

  /** From here on, a join claiming this seat must present exactly this token. */
  expectToken(seatId: string, token: string): void {
    this.expectedTokens.set(seatId, token);
  }

  /** This seat no longer requires a token — back to self-declared joins. */
  clearToken(seatId: string): void {
    this.expectedTokens.delete(seatId);
  }

  /**
   * Handle the first (join) message on an agent connection.
   *
   * Returns the transport if accepted, or `null` if the connection was
   * rejected (the socket has already been sent a reject message and closed).
   * Called by server.ts's central websocket.message handler.
   */
  accept(ws: ServerWebSocket<unknown>, firstMessage: string, motorCount = 4): RemoteTransport | null {
    const reject = (reason: string): null => {
      try {
        ws.send(JSON.stringify({ type: 'reject', reason } satisfies RejectMessage));
        ws.close();
      } catch {
        // Already closed
      }
      return null;
    };

    let join: JoinMessage;
    try {
      join = JSON.parse(firstMessage) as JoinMessage;
    } catch {
      return reject('first message must be JSON');
    }
    if (join.type !== 'join') {
      return reject('first message must be a join');
    }
    // A mismatch here is a season boundary, not a typo: the frame shape
    // changed and the program was written against the old one. Say so,
    // rather than feeding it fields it will not understand.
    if (join.protocol !== PROTOCOL_VERSION) {
      return reject(`protocol ${join.protocol}; this server speaks ${PROTOCOL_VERSION}`);
    }
    if (join.team !== 'violet' && join.team !== 'lime') {
      return reject(`unknown team "${join.team}"`);
    }
    if (join.robot !== 1 && join.robot !== 2) {
      return reject(`robot must be 1 or 2, not ${String(join.robot)}`);
    }

    const id = `${join.team}-${join.robot}`;

    // Checked before any seat-state branching below, so a connection with
    // the wrong (or no) token learns nothing about that seat beyond "you
    // don't have what it takes" — not whether it's held, standing down, or
    // free. A seat nobody ever called `expectToken` for (no submission
    // spawned it) skips this entirely: self-declared joins, same as ever.
    const expectedToken = this.expectedTokens.get(id);
    if (expectedToken !== undefined && join.token !== expectedToken) {
      return reject(`${id} requires a valid token`);
    }

    const held = this.seats.get(id);

    if (held?.transport.connected) {
      return reject(`${id} is already connected`);
    }

    /*
     * Rule 5.7: a robot that stops is a damaged robot, and it comes off.
     *
     * A program that loses its connection mid-match has stopped, whatever
     * the reason - the laptop slept, the process crashed, someone kicked the
     * cable - and it is not different in kind from a robot whose battery
     * came loose. The referee takes it off for thirty seconds (5.7.2) and it
     * comes back at a corner of its own penalty box (5.7.4). Letting the
     * program reconnect and resume instantly would make a crash cost nothing
     * and make a crash-loop a tactic: the robot would be immune to shoving
     * for as long as it kept dying.
     *
     * So the seat is held, not freed, and the reconnect is refused until the
     * stand-down is served. The team keeps the seat - nobody else can take
     * it - and their match record keeps the disconnection in it.
     */
    const remaining = held ? (this.standDown?.(id) ?? 0) : 0;
    if (held && remaining > 0) {
      return reject(
        `${id} was disconnected during play and is standing down under rule 5.7.2; ` +
          `${remaining.toFixed(0)} s remaining`,
      );
    }

    if (held) {
      // Same seat, same transport object, new socket underneath, so the
      // match keeps talking to the thing it is already holding.
      held.transport.reattach(ws);
      ws.send(
        JSON.stringify({
          type: 'welcome',
          robot: id,
          motors: motorCount,
          protocol: PROTOCOL_VERSION,
        } satisfies WelcomeMessage),
      );
      if (this.ready) {
        for (const wake of this.waiters.splice(0)) wake();
      }
      return held.transport;
    }

    const teamName = join.name ?? (join.team === 'violet' ? 'Violet' : 'Lime');
    const transport = new RemoteTransport(`${teamName}/${id}`, id, ws, motorCount);
    this.seats.set(id, { transport, team: join.team, number: join.robot, teamName });
    // The seat is deliberately NOT freed when the socket closes. A seat is a
    // team's place in the match, and losing a connection is a robot fault,
    // not a withdrawal - see the stand-down above. `closeAll` clears them
    // between matches.

    ws.send(
      JSON.stringify({
        type: 'welcome',
        robot: id,
        motors: motorCount,
        protocol: PROTOCOL_VERSION,
      } satisfies WelcomeMessage),
    );

    if (this.ready) {
      for (const wake of this.waiters.splice(0)) wake();
    }
    return transport;
  }

  /** Resolves once all four robots have connected. */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((ok) => this.waiters.push(ok));
  }

  /** What went wrong for whom, for the match record. */
  report(): Record<string, SeatReport> {
    const out: Record<string, SeatReport> = {};
    for (const [id, seat] of this.seats) {
      out[id] = {
        overruns: seat.transport.overruns,
        rejected: seat.transport.rejected,
        connected: seat.transport.connected,
        reconnects: seat.transport.reconnects,
      };
    }
    return out;
  }

  /**
   * Close one seat's connection and forget it.
   *
   * A practice field stops and restarts a single seat's program constantly,
   * and the seat has to be genuinely free afterwards: a socket left open is a
   * program still holding a place the replacement is about to claim. Nothing
   * in a match does this - there, a seat going quiet is rule 5.7's business,
   * not a withdrawal.
   */
  close(seatId: string): void {
    const seat = this.seats.get(seatId);
    if (!seat) return;
    seat.transport.close();
    this.seats.delete(seatId);
  }

  closeAll(): void {
    for (const seat of this.seats.values()) seat.transport.close();
    this.seats.clear();
    this.expectedTokens.clear();
  }
}
