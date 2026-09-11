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

import type { WebSocket } from 'ws';
import { sanitise, type Transport } from './agent';
import { PROTOCOL_VERSION, type ActuatorFrame, type SensorFrame } from './protocol';

/** What a program says when it connects. */
export interface JoinMessage {
  type: 'join';
  protocol: number;
  team: 'cyan' | 'yellow';
  /** 1 or 2. */
  robot: number;
  /** The team's name, for the scoreboard. */
  name?: string;
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

export type AgentServerMessage = WelcomeMessage | RejectMessage | SensorMessage;
export type AgentClientMessage = JoinMessage | CommandMessage;

/** The path a program connects to, so viewers and agents share one port. */
export const AGENT_PATH = '/agent';

/**
 * One connected program.
 *
 * Holds only the newest command. If a program answers twice between polls the
 * older answer is already stale — it was a reply to a sensor frame the world
 * has moved past — and acting on it would be worse than dropping it.
 */
export class RemoteTransport implements Transport {
  private pending: ActuatorFrame | null = null;
  private closed = false;
  /** Commands that arrived and were superseded before the next poll. */
  overruns = 0;
  /** Commands rejected as malformed. */
  rejected = 0;

  constructor(
    readonly name: string,
    readonly robotId: string,
    private readonly socket: WebSocket,
    private readonly motorCount: number,
  ) {
    socket.on('message', (data) => this.receive(String(data)));
    socket.on('close', () => {
      this.closed = true;
    });
  }

  get connected(): boolean {
    return !this.closed;
  }

  private receive(text: string): void {
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

  send(frame: SensorFrame): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'sensors', frame } satisfies SensorMessage));
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
    this.socket.close();
  }
}

export interface Seat {
  transport: RemoteTransport;
  team: 'cyan' | 'yellow';
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
  private waiters: (() => void)[] = [];

  /** How many of the four seats are filled. */
  get filled(): number {
    return this.seats.size;
  }

  get ready(): boolean {
    return this.seats.size === 4;
  }

  /** Team names as claimed by whoever connected, for the scoreboard. */
  teamNames(): { cyan: string; yellow: string } {
    const name = (team: 'cyan' | 'yellow'): string => {
      for (const seat of this.seats.values()) {
        if (seat.team === team && seat.teamName) return seat.teamName;
      }
      return team === 'cyan' ? 'Cyan' : 'Yellow';
    };
    return { cyan: name('cyan'), yellow: name('yellow') };
  }

  transports(): Partial<Record<string, Transport>> {
    const out: Partial<Record<string, Transport>> = {};
    for (const [id, seat] of this.seats) out[id] = seat.transport;
    return out;
  }

  /** Handle a new connection on the agent path. */
  accept(socket: WebSocket, motorCount = 4): void {
    const reject = (reason: string): void => {
      socket.send(JSON.stringify({ type: 'reject', reason } satisfies RejectMessage));
      socket.close();
    };

    socket.once('message', (data) => {
      let join: JoinMessage;
      try {
        join = JSON.parse(String(data)) as JoinMessage;
      } catch {
        reject('first message must be JSON');
        return;
      }
      if (join.type !== 'join') {
        reject('first message must be a join');
        return;
      }
      // A mismatch here is a season boundary, not a typo: the frame shape
      // changed and the program was written against the old one. Say so,
      // rather than feeding it fields it will not understand.
      if (join.protocol !== PROTOCOL_VERSION) {
        reject(`protocol ${join.protocol}; this server speaks ${PROTOCOL_VERSION}`);
        return;
      }
      if (join.team !== 'cyan' && join.team !== 'yellow') {
        reject(`unknown team "${join.team}"`);
        return;
      }
      if (join.robot !== 1 && join.robot !== 2) {
        reject(`robot must be 1 or 2, not ${String(join.robot)}`);
        return;
      }

      const id = `${join.team}-${join.robot}`;
      if (this.seats.has(id)) {
        reject(`${id} is already connected`);
        return;
      }

      const teamName = join.name ?? (join.team === 'cyan' ? 'Cyan' : 'Yellow');
      const transport = new RemoteTransport(`${teamName}/${id}`, id, socket, motorCount);
      this.seats.set(id, { transport, team: join.team, number: join.robot, teamName });
      socket.on('close', () => {
        // Only drop the seat if it is still this connection's. A reconnect that
        // raced a close would otherwise unseat itself.
        if (this.seats.get(id)?.transport === transport) this.seats.delete(id);
      });

      socket.send(
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
    });
  }

  /** Resolves once all four robots have connected. */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((ok) => this.waiters.push(ok));
  }

  /** What went wrong for whom, for the match record. */
  report(): Record<string, { overruns: number; rejected: number; connected: boolean }> {
    const out: Record<string, { overruns: number; rejected: number; connected: boolean }> = {};
    for (const [id, seat] of this.seats) {
      out[id] = {
        overruns: seat.transport.overruns,
        rejected: seat.transport.rejected,
        connected: seat.transport.connected,
      };
    }
    return out;
  }

  closeAll(): void {
    for (const seat of this.seats.values()) seat.transport.close();
    this.seats.clear();
  }
}
