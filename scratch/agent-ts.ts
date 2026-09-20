/**
 * A robot program that runs the TypeScript ChampionAgent over the wire.
 *
 * The paper shape of this is `python/examples/play.py` plus `board.py`'s loop:
 * it connects to a match server over the agent socket, joins a seat, and on
 * every sensor frame produces one actuator frame. What plays the seat is the
 * real in-process champion from `packages/server/src/champion`, driven exactly
 * the way a bench run drives it locally — only the transport is a socket
 * instead of a function call.
 *
 * Two call shapes:
 *
 *   bun scratch/agent-ts.ts --team lime --url ws://localhost:8080/agent
 *
 *       Team mode. Forks one seat program per robot, like
 *       `python3 python/examples/play.py --only lime`. This is the shape a
 *       bench `--spawn` command wants, because the bench starts the whole
 *       tested side with one command.
 *
 *   bun scratch/agent-ts.ts --team lime --number 1 --url ws://localhost:8080/agent
 *
 *       Seat mode. The one connection a real robot makes. Runs until the
 *       server goes away.
 *
 * The purpose of the file is a duel measurement: a changed champion side
 * (in-process, `--opponent champion`) measured against a fixed one (this
 * runner, from a git worktree), so "did that change help" is answered the
 * same way champion-vs-python is answered today.
 */

import { spawn } from 'node:child_process';
import { ChampionAgent } from '../packages/server/src/champion';
import { PROTOCOL_VERSION, type ActuatorFrame, type SensorFrame } from '../packages/server/src/match/protocol';

const SELF = import.meta.path;

interface Args {
  team: 'violet' | 'lime';
  number: number | null;
  name: string | null;
  url: string;
  format: 'json' | 'protobuf';
}

function parseArgs(argv: string[]): Args {
  const args: Args = { team: 'violet', number: null, name: null, url: 'ws://localhost:8080/agent', format: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${flag}`);
      return next;
    };
    switch (flag) {
      case '--team': {
        const team = value();
        if (team !== 'violet' && team !== 'lime') throw new Error(`--team must be violet or lime, not "${team}"`);
        args.team = team;
        break;
      }
      case '--number': {
        const number = Number(value());
        if (number !== 1 && number !== 2) throw new Error(`--number must be 1 or 2, not "${number}"`);
        args.number = number;
        break;
      }
      case '--name':
        args.name = value();
        break;
      case '--url':
        args.url = value();
        break;
      case '--format': {
        const format = value();
        if (format !== 'json' && format !== 'protobuf') throw new Error(`--format must be json or protobuf, not "${format}"`);
        args.format = format;
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

/** Wait for the socket to open, or fail loudly. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 15_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    // `onerror` alone does not reject: most WebSocket stacks report the error
    // and then close, and the close is the reliable signal. Resolving nothing
    // here means the open is what resolves; the close handler on the caller
    // side is what notices a failed join.
  });
}

/** Join the seat and wait for the welcome, the way `_backend.py` does. */
function join(
  ws: WebSocket,
  joiner: { team: 'violet' | 'lime'; robot: number; name: string | null; format: 'json' | 'protobuf' },
): Promise<{ motors: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no welcome within 10s')), 10_000);
    ws.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // Not JSON; wait for the real handshake.
      }
      if (typeof message !== 'object' || message === null) return;
      const type = (message as { type?: unknown }).type;
      if (type === 'reject') {
        clearTimeout(timer);
        reject(new Error(`server refused join: ${String((message as { reason?: unknown }).reason)}`));
        return;
      }
      if (type === 'welcome') {
        clearTimeout(timer);
        resolve({ motors: Number((message as { motors?: unknown }).motors) || 4 });
      }
    };
    ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, ...joiner }));
  });
}

/** Play one seat until the server goes away. */
async function playSeat(joiner: { team: 'violet' | 'lime'; robot: number; name: string | null; url: string; format: 'json' | 'protobuf' }) {
  const agent = new ChampionAgent({ team: joiner.team, number: joiner.robot, name: joiner.name ?? undefined });
  const socket = await connect(joiner.url);
  const { motors } = await join(socket, joiner);
  const label = `${joiner.team}-${joiner.robot}`;
  console.error(`[agent-ts] ${label} joined as ${agent.name}, ${motors} motors`);
  let last: ActuatorFrame | null = null;

  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if ((message as { type?: unknown }).type !== 'sensors') return; // `disabled` and friends get no reply.
    const frame = (message as { frame: SensorFrame }).frame;
    let command: ActuatorFrame | null | undefined;
    try {
      command = agent.tick(frame);
    } catch (err) {
      console.error(`[agent-ts] ${label}: tick threw: ${err instanceof Error ? err.message : String(err)}`);
      return; // Stand on the last command, like AgentSlot does for a throwing LocalAgent.
    }
    if (command == null) return;
    last = command;
    if (joiner.format === 'json') {
      socket.send(JSON.stringify({ type: 'command', frame: command }));
    }
  };

  socket.onclose = () => {
    console.error(`[agent-ts] ${label}: server closed the connection`);
    process.exit(0);
  };
  socket.onerror = () => {
    // The close event follows; that is where the exit happens.
  };
  return last;
}

/**
 * Team mode: supervisor for seat 1 and seat 2, which are two separate
 * processes the way they are two separate robots. Mirrors `play.py --only`.
 */
function supervise(team: 'violet' | 'lime', url: string, name: string | null, format: 'json' | 'protobuf') {
  const children = [1, 2].map((number) => {
    const args = [SELF, '--team', team, '--number', String(number), '--url', url];
    if (name) args.push('--name', name);
    if (format !== 'json') args.push('--format', format);
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    console.error(`[agent-ts] started ${team}-${number} via ${process.execPath}`);
    child.on('exit', (code, signal) => {
      console.error(`[agent-ts] ${team}-${number} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
      // A lost robot ends the side: nothing useful is being measured on a
      // dead seat, and the bench will report which seats never filled.
      process.exit(code ?? 1);
    });
    return child;
  });
  for (const child of children) {
    child.on('error', (err) => {
      console.error(`[agent-ts] failed to spawn a robot: ${err.message}`);
      process.exit(1);
    });
  }
  const stop = (): void => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.number === null) {
    supervise(args.team, args.url, args.name, args.format);
    return;
  }
  await playSeat({ team: args.team, robot: args.number, name: args.name, url: args.url, format: args.format });
}

main()
  .then(() => {
    // Seat mode resolves immediately after wiring the handlers; the loop
    // keeps the process alive on the socket. Supervisor mode never resolves.
  })
  .catch((err) => {
    console.error(`[agent-ts] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });