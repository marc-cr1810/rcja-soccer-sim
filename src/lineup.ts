/**
 * Turning a team name into the robots actually playing.
 *
 * `--home`/`--away` have always been just scoreboard labels. Here they are
 * also a lookup key: if a team by that name has a validated submission on
 * disk, that submission plays; if it does not — for either or both of its
 * robots — the built-in agent fills the gap, the same as it always has. A
 * match is never all-or-nothing between "real teams" and "the reference
 * agent"; the four seats are resolved independently, because that is what a
 * team with one robot pushed and one still being written actually looks
 * like, and because it is what lets a submission scrimmage the reference
 * agent through the same path a real match uses.
 */

import type { Subprocess } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Transport } from './agent';
import { waitForSeats } from './bench';
import { parseManifest, slugifyTeam, TOKEN_FILENAME, type Manifest } from './manifest';
import { spawnSandboxed } from './sandbox';
import type { MatchServer } from './server';

export interface LineupEntry {
  manifest: Manifest;
  /** The robot's own folder under the submissions tree. */
  dir: string;
  /** Server-issued at submit time; what proves this spawn's join to the gateway. */
  token: string;
}

/** Which of the four seats have a validated submission to load, and where it lives. */
export async function resolveLineup(
  submissionsDir: string,
  teams: { violet: string; lime: string },
): Promise<Partial<Record<string, LineupEntry>>> {
  const out: Partial<Record<string, LineupEntry>> = {};

  for (const side of ['violet', 'lime'] as const) {
    for (const robot of [1, 2] as const) {
      const dir = join(submissionsDir, slugifyTeam(teams[side]), String(robot));
      let raw: Buffer;
      try {
        raw = await readFile(join(dir, 'manifest.json'));
      } catch {
        continue;
      }
      let names: Set<string>;
      try {
        names = new Set(await readdir(dir));
      } catch {
        continue;
      }

      const result = parseManifest(raw, names);
      // The robot number is part of the folder path already; a manifest that
      // disagrees with the slot it was found in is not trusted rather than
      // guessed at.
      if (!result.ok || result.value.robot !== robot) continue;

      // No token file means this folder pre-dates server-issued tokens, or
      // was tampered with outside a real push — skipped for this seat the
      // same way a bad manifest already is, and the built-in agent fills it.
      let token: string;
      try {
        token = (await readFile(join(dir, TOKEN_FILENAME), 'utf8')).trim();
      } catch {
        continue;
      }
      if (!token) continue;

      out[`${side}-${robot}`] = { manifest: result.value, dir, token };
    }
  }

  return out;
}

export interface LineupOptions {
  pythonLibDir: string;
  /** How long to wait for every spawned seat to connect. */
  connectTimeoutSeconds?: number;
  memoryLimitMb?: number;
  cpuQuotaPercent?: number;
  maxRespawns?: number;
}

export interface SpawnedLineup {
  /** Ready to merge into `MatchOptions.transports`. */
  transports: Partial<Record<string, Transport>>;
  /** Stops every spawned child. Mostly belt-and-braces — see `spawnSandboxed`. */
  stop: () => void;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MATCH_MEMORY_LIMIT_MB = 512;
const MATCH_CPU_QUOTA_PERCENT = 100;
const DEFAULT_MAX_RESPAWNS = 5;

export interface SeatProcess {
  stop(): void;
}

/**
 * Spawn one seat's program, sandboxed and cgroup-governed, respawning it if
 * it dies.
 *
 * A seat at a time rather than four, because a practice field starts and
 * stops them one at a time - a team re-pushes one robot and restarts it
 * without disturbing the situation the other three are standing in.
 * `spawnLineup` is four of these plus the wait for them all to join.
 */
export function spawnSeat(
  server: MatchServer,
  id: string,
  entry: LineupEntry,
  opts: LineupOptions,
  log: (line: string) => void = () => {},
  /**
   * The same output again, unprefixed, for somebody keeping it per seat.
   *
   * `log` goes to a venue's terminal, where a line has to say which seat it
   * came from and nobody is watching anyway. A student whose code does not
   * parse needs the traceback itself, in the browser, under their own seat —
   * so the text is offered raw as well and `practice.ts` keeps it.
   */
  onOutput: (text: string) => void = () => {},
  /**
   * Called once this seat has stopped being retried.
   *
   * A seat whose program dies at import is respawned a few times and then left
   * alone, and until somebody says so the seat goes on claiming it is starting.
   * "Starting" that never ends is the least useful thing a console can say to
   * the person whose code did not compile.
   */
  onGaveUp: () => void = () => {},
): SeatProcess {
  const maxRespawns = opts.maxRespawns ?? DEFAULT_MAX_RESPAWNS;
  let child: Subprocess | null = null;
  let stopped = false;

  const spawnOne = (attempt: number): void => {
    if (stopped) return;
    const [side, robotText] = id.split('-') as [string, string];

    // Registered before the child can possibly connect (spawning below is
    // the earliest anything could reach the gateway), and re-registered
    // identically on every respawn - harmless, since it's always the same
    // token for this resolved seat.
    server.agents.expectToken(id, entry.token);

    const spawned = spawnSandboxed({
      entry: join(entry.dir, entry.manifest.entry),
      cwd: entry.dir,
      pythonLibDir: opts.pythonLibDir,
      memoryLimitMb: opts.memoryLimitMb ?? MATCH_MEMORY_LIMIT_MB,
      cpuQuotaPercent: opts.cpuQuotaPercent ?? MATCH_CPU_QUOTA_PERCENT,
      // The agent socket the child needs to reach lives outside its own
      // folder, so its directory has to be bound in explicitly - the same
      // reason `submission.ts`'s validation check binds in its own control
      // directory for the exact same kind of connection.
      controlDir: server.agentSocketDir,
      args: [
        '--team',
        side,
        '--number',
        robotText,
        '--name',
        entry.manifest.team,
        '--url',
        server.agentSocketUrl,
        '--token',
        entry.token,
      ],
    });
    child = spawned;

    (async () => {
      if (spawned.stdout && typeof spawned.stdout !== 'number') {
        const reader = spawned.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value).trimEnd();
            log(`[${id}] ${text}`);
            onOutput(text);
          }
        } catch {}
      }
    })();
    (async () => {
      if (spawned.stderr && typeof spawned.stderr !== 'number') {
        const reader = spawned.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value).trimEnd();
            log(`[${id}] ${text}`);
            onOutput(text);
          }
        } catch {}
      }
    })();

    spawned.exited.then((code) => {
      if (child === spawned) child = null;
      if (stopped) return;
      // The frame around a traceback, and worth as much as the traceback: a
      // student reading "exited (code 1)" five times knows their program is
      // dying at import rather than sitting there not answering.
      if (attempt >= maxRespawns) {
        const line = `exited (code ${code}) after ${attempt} attempts; not respawning again`;
        log(`[${id}] ${line}`);
        onOutput(line);
        onGaveUp();
        return;
      }
      const line = `exited (code ${code}); respawning (attempt ${attempt + 1} of ${maxRespawns})`;
      log(`[${id}] ${line}`);
      onOutput(line);
      spawnOne(attempt + 1);
    });
  };

  spawnOne(1);

  return {
    stop: () => {
      stopped = true;
      try {
        child?.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
  };
}

/**
 * Spawn every resolved seat, sandboxed and cgroup-governed, and wait for it
 * to join.
 *
 * A spawned process has no network, so it reaches the match the same way the
 * one-tick validation check does: `server.agentSocketUrl`, a Unix socket
 * bound into its sandbox rather than a TCP port.
 */
export async function spawnLineup(
  server: MatchServer,
  resolved: Partial<Record<string, LineupEntry>>,
  opts: LineupOptions,
  log: (line: string) => void = () => {},
): Promise<SpawnedLineup> {
  const ids = Object.keys(resolved);
  const seats = new Map<string, SeatProcess>();

  for (const [id, entry] of Object.entries(resolved)) {
    if (entry) seats.set(id, spawnSeat(server, id, entry, opts, log));
  }

  if (ids.length > 0) {
    await waitForSeats(server, ids, opts.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS);
  }

  const live = server.agents.transports();
  const transports = Object.fromEntries(ids.filter((id) => live[id]).map((id) => [id, live[id]!]));

  return {
    transports,
    stop: () => {
      for (const seat of seats.values()) seat.stop();
    },
  };
}
