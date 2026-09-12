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

import type { ChildProcess } from 'node:child_process';
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
  teams: { cyan: string; yellow: string },
): Promise<Partial<Record<string, LineupEntry>>> {
  const out: Partial<Record<string, LineupEntry>> = {};

  for (const side of ['cyan', 'yellow'] as const) {
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
  /** cgroup memory ceiling, MB. Bigger than validation's — a match runs for minutes. */
  memoryLimitMb?: number;
  /**
   * cgroup CPU quota per robot, as a percentage of one core. A generous
   * default (four robots can, worst case, total 200% — bounded but not
   * stingy for a 50 Hz control loop) rather than a cutoff: a busy-loop is
   * throttled, not killed, so it stops crowding out the other three robots
   * and the physics loop without ending the match for whichever team wrote
   * it.
   */
  cpuQuotaPercent?: number;
  /** How many times a crashed slot is respawned before it is left off for good. */
  maxRespawns?: number;
}

export interface SpawnedLineup {
  /** Ready to merge into `MatchOptions.transports`. */
  transports: Partial<Record<string, Transport>>;
  /** Stops every spawned child. Mostly belt-and-braces — see `spawnSandboxed`. */
  stop: () => void;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_RESPAWNS = 5;
/** A match runs for minutes, not the few seconds a validation tick does. */
const MATCH_MEMORY_LIMIT_MB = 512;
/** Half a core each; four robots worst-case total 200%, not the whole machine. */
const MATCH_CPU_QUOTA_PERCENT = 50;

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
  const maxRespawns = opts.maxRespawns ?? DEFAULT_MAX_RESPAWNS;
  const children = new Map<string, ChildProcess>();
  let stopped = false;

  const spawnOne = (id: string, entry: LineupEntry, attempt: number): void => {
    if (stopped) return;
    const [side, robotText] = id.split('-') as [string, string];

    // Registered before the child can possibly connect (spawning below is
    // the earliest anything could reach the gateway), and re-registered
    // identically on every respawn — harmless, since it's always the same
    // token for this resolved seat.
    server.agents.expectToken(id, entry.token);

    const child = spawnSandboxed({
      entry: join(entry.dir, entry.manifest.entry),
      cwd: entry.dir,
      pythonLibDir: opts.pythonLibDir,
      memoryLimitMb: opts.memoryLimitMb ?? MATCH_MEMORY_LIMIT_MB,
      cpuQuotaPercent: opts.cpuQuotaPercent ?? MATCH_CPU_QUOTA_PERCENT,
      // The agent socket the child needs to reach lives outside its own
      // folder, so its directory has to be bound in explicitly — the same
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
    children.set(id, child);

    child.stdout?.on('data', (d: Buffer) => log(`[${id}] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => log(`[${id}] ${d.toString().trimEnd()}`));

    child.on('exit', (code) => {
      children.delete(id);
      if (stopped) return;
      if (attempt >= maxRespawns) {
        log(`[${id}] exited (code ${code}) after ${attempt} attempts; not respawning again`);
        return;
      }
      log(`[${id}] exited (code ${code}); respawning (attempt ${attempt + 1} of ${maxRespawns})`);
      spawnOne(id, entry, attempt + 1);
    });
  };

  for (const [id, entry] of Object.entries(resolved)) {
    if (entry) spawnOne(id, entry, 1);
  }

  if (ids.length > 0) {
    await waitForSeats(server, ids, opts.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS);
  }

  const live = server.agents.transports();
  const transports = Object.fromEntries(ids.filter((id) => live[id]).map((id) => [id, live[id]!]));

  return {
    transports,
    stop: () => {
      stopped = true;
      for (const child of children.values()) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    },
  };
}
