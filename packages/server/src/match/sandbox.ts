/**
 * Running an untrusted Python program with the venue machine held back from it.
 *
 * A submission is code a stranger wrote, about to run on the same machine
 * that owns the match. Two mechanisms, layered:
 *
 * `bwrap` (bubblewrap) gives it its own network namespace with nothing in it
 * and a filesystem where the only thing bound in is the platform's own
 * library and the submission's own folder — nothing else on the host is
 * visible, let alone writable. That is isolation: what the process can *see*.
 *
 * A `systemd-run --user --scope` cgroup around the whole thing is resource
 * *governance*: what the process can *take*. A CPU quota throttles a
 * runaway busy-loop to a share of one core rather than killing it once it
 * has spent some fixed budget — the right shape for a control loop that
 * legitimately runs for a whole match, unlike a `ulimit -t` cutoff, which
 * cannot distinguish "still playing" from "has been running a while." A
 * memory ceiling OOM-kills on real usage, not `ulimit -v`'s address-space
 * reservation, which a normal Python process can blow through long before
 * it is actually holding that much RAM.
 *
 * Requires a delegated user cgroup (true of an interactive login session on
 * any reasonably modern distro — a venue laptop, in other words) in addition
 * to `bwrap` itself; `sandboxAvailable()` checks both.
 */

import type { Subprocess } from 'bun';
import { existsSync } from 'node:fs';

/** Host directories a Python interpreter needs to exist at all. */
const HOST_LIB_ROOTS = ['/usr', '/lib', '/lib64', '/bin'];

/** Defaults sized for "prove it answers one tick" — see `SandboxOptions`. */
const DEFAULT_MEMORY_LIMIT_MB = 256;
const DEFAULT_CPU_QUOTA_PERCENT = 100;

let bwrapPresent: boolean | null = null;

/** Whether `bwrap` is on `PATH`. Checked once and cached. */
export function bwrapAvailable(): boolean {
  if (bwrapPresent === null) {
    const probe = Bun.spawnSync(['bwrap', '--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    bwrapPresent = probe.exitCode === 0;
  }
  return bwrapPresent;
}

let cgroupPresent: boolean | null = null;

/** Whether an unprivileged `systemd-run --user --scope` actually works here. Checked once and cached. */
export function cgroupAvailable(): boolean {
  if (cgroupPresent === null) {
    const probe = Bun.spawnSync(['systemd-run', '--user', '--scope', '--collect', '--', '/bin/true'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    cgroupPresent = probe.exitCode === 0;
  }
  return cgroupPresent;
}

/** Both prerequisites for `spawnSandboxed`. */
export function sandboxAvailable(): boolean {
  return bwrapAvailable() && cgroupAvailable();
}

/** `null` when the sandbox is ready; otherwise which prerequisite(s) are missing, for an operator to fix. */
export function sandboxUnavailableReason(): string | null {
  const missing: string[] = [];
  if (!bwrapAvailable()) missing.push('bubblewrap (bwrap)');
  if (!cgroupAvailable()) missing.push('a delegated user cgroup (systemd-run --user --scope)');
  return missing.length > 0 ? `${missing.join(' and ')} required but not available on this server` : null;
}

export interface SandboxOptions {
  /** Absolute path to the .py file to run. */
  entry: string;
  /** Absolute path to the folder the entry lives in — the only team code visible. */
  cwd: string;
  /** Absolute path to the repo's python/ directory, for `import rcja_soccer`. */
  pythonLibDir: string;
  args: string[];
  /**
   * A directory bound in read-write instead of read-only, for a Unix control
   * socket — the escape hatch the synthetic-tick check uses to reach a local
   * validation endpoint without opening a network hole to do it. Omit for a
   * plain run with nothing writable.
   */
  controlDir?: string;
  /** cgroup memory ceiling, MB. Defaults to the one-tick validation ceiling. */
  memoryLimitMb?: number;
  /**
   * cgroup CPU quota, as a percentage of one core (cgroup v2's own unit —
   * unaffected by how many cores the machine has). Defaults to a generous
   * ceiling sized for a one-tick validation run, which is short-lived enough
   * that throttling barely matters; a match-time spawn wants a tighter,
   * per-robot share instead — see `lineup.ts`.
   */
  cpuQuotaPercent?: number;
}

/**
 * Spawn a submission's entry point, sandboxed and resource-governed.
 *
 * Caller must check `sandboxAvailable()` first; this does not fall back to
 * running unsandboxed or ungoverned if either prerequisite is missing.
 */
export function spawnSandboxed(opts: SandboxOptions): Subprocess {
  const binds: string[] = [];
  for (const root of HOST_LIB_ROOTS) {
    if (existsSync(root)) binds.push('--ro-bind', root, root);
  }
  binds.push('--ro-bind', opts.pythonLibDir, opts.pythonLibDir);
  binds.push('--ro-bind', opts.cwd, opts.cwd);
  if (opts.controlDir) binds.push('--bind', opts.controlDir, opts.controlDir);

  const bwrapArgs = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'PYTHONPATH',
    opts.pythonLibDir,
    '--setenv',
    'PYTHONDONTWRITEBYTECODE',
    '1',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    // An empty /tmp first, so anything bound in below that happens to live
    // under the host's own /tmp (a common place for a scratch directory) is
    // bound in AFTER the tmpfs covers it, not hidden underneath it.
    '--tmpfs',
    '/tmp',
    ...binds,
    '--chdir',
    opts.cwd,
    '--',
    'python3',
    opts.entry,
    ...opts.args,
  ];

  const memoryLimitMb = opts.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const cpuQuotaPercent = opts.cpuQuotaPercent ?? DEFAULT_CPU_QUOTA_PERCENT;

  const args = [
    '--user',
    '--scope',
    // Garbage-collects the transient unit once it exits — a whole
    // tournament's worth of spawns would otherwise leave hundreds of dead
    // scope units behind.
    '--collect',
    // Otherwise "Running as unit: …" lands on the child's own stderr, which
    // is meant to carry the submission's own errors and nothing else.
    '--quiet',
    '-p',
    `CPUQuota=${cpuQuotaPercent}%`,
    '-p',
    `MemoryMax=${memoryLimitMb}M`,
    '-p',
    'MemorySwapMax=0',
    '--',
    'bwrap',
    ...bwrapArgs,
  ];

  return Bun.spawn(['systemd-run', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
