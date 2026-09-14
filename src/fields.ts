/**
 * Practice fields on a venue server: one child process each, proxied.
 *
 * A `MatchServer` plays one match at a time — one `current`, one viewer
 * broadcast, one gateway whose seats are the fixed four ids. A hall where
 * three teams are rehearsing at once and a fixture is being played needs four
 * of all of that, so a field gets its own process rather than the server
 * learning to hold several of everything.
 *
 * They are still reached through the one port the venue configured, because a
 * robot on a student's laptop has to reach a field's `/agent` and the venue
 * has enough to set up without a hole in a firewall per rehearsal — the same
 * argument `MatchServer`'s own upgrade handler makes for splitting the agent
 * path off the viewer path rather than opening a second port.
 *
 * Nothing here is authenticated. A practice field is open to whoever has the
 * link: that is Phase 4's deliberate position, and Phase 6 is where it gets
 * accounts. What bounds it instead is a cap on how many can run at once and a
 * field that shuts itself down once nobody is watching.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { Agent, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Same way `bin/rcja-soccer-sim.js` starts the CLI: there is no compiled build of it. */
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

export interface FieldSupervisorOptions {
  /**
   * How many fields may run at once.
   *
   * Each is up to four sandboxed robots and a physics loop, so this is a
   * machine's CPU rather than an arbitrary number — and a venue that hits it
   * should be told so, not quietly slowed to a crawl.
   */
  maxFields?: number;
  /** Minutes with nobody watching before a field shuts itself down. */
  idleMinutes?: number;
  /** Where the venue keeps pushed submissions, so a field can load them. */
  submissionsDir?: string;
  log?: (line: string) => void;
}

export interface FieldInfo {
  id: string;
  /** Where to open it, relative to the venue server's own root. */
  url: string;
  createdAt: string;
}

interface Field {
  id: string;
  port: number;
  child: ChildProcess;
  createdAt: number;
  /** Sockets currently proxied to it — viewers and robots both. */
  open: number;
  idleSince: number | null;
}

const DEFAULT_MAX_FIELDS = 4;
const DEFAULT_IDLE_MINUTES = 20;
/** How often idle fields are swept up. */
const SWEEP_MS = 30_000;

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

export class FieldSupervisor {
  private readonly fields = new Map<string, Field>();
  private readonly sweep: NodeJS.Timeout;
  private readonly log: (line: string) => void;
  /**
   * Its own agent, with no connection pool.
   *
   * Node's global agent keeps connections alive between requests, which is
   * exactly wrong for a child this process may kill at any moment: a pooled
   * socket to a field that has been stopped is a handle nothing will ever
   * close, and a process holding one never exits. It cost a whole test run
   * hanging after every test in it had passed.
   */
  private readonly upstream = new Agent({ keepAlive: false });

  constructor(private readonly opts: FieldSupervisorOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.sweep = setInterval(() => this.closeIdle(), SWEEP_MS);
    // Sweeping is housekeeping, not work: a server with nothing else to do
    // should still be allowed to exit.
    this.sweep.unref?.();
  }

  get count(): number {
    return this.fields.size;
  }

  list(): FieldInfo[] {
    return [...this.fields.values()].map((field) => ({
      id: field.id,
      url: `/f/${field.id}/practice/`,
      createdAt: new Date(field.createdAt).toISOString(),
    }));
  }

  /**
   * Start a field and wait until it is actually listening.
   *
   * Waiting matters: the answer to this call is a URL somebody is about to
   * open, and handing back a URL that 502s for the next second is worse than
   * taking the second here.
   */
  async create(): Promise<FieldInfo> {
    const max = this.opts.maxFields ?? DEFAULT_MAX_FIELDS;
    if (this.fields.size >= max) {
      throw new Error(`this server is already running ${max} practice fields`);
    }

    const id = randomBytes(6).toString('base64url');
    const port = await freePort();
    const args = [CLI, 'practice', '--port', String(port), '--die-with-parent'];
    if (this.opts.submissionsDir) args.push('--submissions', this.opts.submissionsDir);

    // stdin is a pipe and nothing is ever written to it: the child watches it
    // for end-of-file and exits when it comes. That is what makes
    // `--die-with-parent` true even when this process is killed outright and
    // never gets to run its own cleanup - the same guarantee bwrap gives a
    // sandboxed robot, by the same trick. Without it a venue restarting its
    // match server leaves every field it was hosting running, holding ports
    // and CPU nobody can see any more.
    // Its own process group, because `tsx` is itself a node process that
    // spawns the one actually running the field: killing the handle we hold
    // leaves the field running, still holding this process's pipes, and a
    // parent that can never fully let go of a field it has already stopped
    // is a parent that can never exit. Stopping a field kills the group.
    const child = spawn(TSX, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const field: Field = { id, port, child, createdAt: Date.now(), open: 0, idleSince: Date.now() };
    this.fields.set(id, field);

    child.stdout?.on('data', (d: Buffer) => this.log(`[field ${id}] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => this.log(`[field ${id}] ${d.toString().trimEnd()}`));
    child.on('exit', (code) => {
      this.fields.delete(id);
      this.log(`[field ${id}] ended (code ${code})`);
    });

    try {
      await waitForListening(port);
    } catch (err) {
      stop(field);
      this.fields.delete(id);
      throw err;
    }

    this.log(`[field ${id}] open on port ${port}`);
    return { id, url: `/f/${id}/practice/`, createdAt: new Date(field.createdAt).toISOString() };
  }

  /** Forward one HTTP request to a field. `rest` is the path inside it. */
  proxy(id: string, rest: string, req: IncomingMessage, res: ServerResponse): boolean {
    const field = this.fields.get(id);
    if (!field) return false;
    this.hold(field);

    const upstream = request(
      {
        host: '127.0.0.1',
        port: field.port,
        path: rest,
        method: req.method,
        headers: req.headers,
        agent: this.upstream,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('practice field is not answering');
      this.release(field);
    });
    res.on('close', () => this.release(field));
    req.pipe(upstream);
    return true;
  }

  /**
   * Forward a WebSocket upgrade to a field, socket to socket.
   *
   * Both doors a field has go through here: the viewer stream the console
   * watches, and `/agent`, which is how a program on a laptop reaches a
   * rehearsal at all.
   */
  proxyUpgrade(id: string, rest: string, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const field = this.fields.get(id);
    if (!field) return false;
    this.hold(field);

    const upstream = connect(field.port, '127.0.0.1', () => {
      const headers = [`GET ${rest} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const one of value) headers.push(`${name}: ${one}`);
        else if (value !== undefined) headers.push(`${name}: ${value}`);
      }
      upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const done = (): void => {
      this.release(field);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', done);
    socket.on('error', done);
    socket.on('close', done);
    return true;
  }

  /** Stop one field now. */
  close(id: string): boolean {
    const field = this.fields.get(id);
    if (!field) return false;
    stop(field);
    this.fields.delete(id);
    return true;
  }

  closeAll(): void {
    clearInterval(this.sweep);
    for (const field of this.fields.values()) stop(field);
    this.fields.clear();
    this.upstream.destroy();
  }

  private hold(field: Field): void {
    field.open += 1;
    field.idleSince = null;
  }

  private release(field: Field): void {
    field.open = Math.max(0, field.open - 1);
    if (field.open === 0 && field.idleSince === null) field.idleSince = Date.now();
  }

  private closeIdle(): void {
    const idleFor = (this.opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    const now = Date.now();
    for (const field of [...this.fields.values()]) {
      if (field.idleSince === null || now - field.idleSince < idleFor) continue;
      this.log(`[field ${field.id}] nobody watching; closing`);
      this.close(field.id);
    }
  }
}

/** Kill a field's whole process group, and let go of its pipes. */
function stop(field: Field): void {
  const { child } = field;
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
  // Nothing is going to read these again, and a pipe still referenced keeps
  // the event loop alive long after the field it belonged to has ended.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref();
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
    if (Date.now() > until) throw new Error('the practice field did not start in time');
    await new Promise((r) => setTimeout(r, 150));
  }
}
