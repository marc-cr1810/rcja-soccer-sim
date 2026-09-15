/**
 * What a process and everything under it is actually costing, right now.
 *
 * The admin console's whole job in Phase 7 is to say honestly how much of the
 * machine a venue is using, and "honestly" rules out the easy answer —
 * multiplying arenas by their grant. A grant is about twelve times what a real
 * robot uses, so a console built on grants would report a machine at capacity
 * while it sat nearly idle, and a venue would turn teams away for nothing.
 *
 * So the numbers come from `/proc`, per process, the way they were measured by
 * hand when the budget was first written down (`scratch/measure-arena.py`).
 *
 * **A sandboxed seat stays inside its arena's process tree**, which is what
 * makes a tree walk the right shape here: `systemd-run --user --scope` execs
 * the command in place rather than handing it to the service manager, so the
 * robot keeps the pid it was spawned with and stays a child of the arena's
 * Node process while living in its own cgroup. Verified on this machine before
 * this file was written, because the failure mode if it were not true is
 * silent: every robot would be missed and the console would report a tenth of
 * the truth with no error anywhere.
 *
 * Reading `/proc` rather than the cgroups is also what keeps this working on a
 * machine with no delegated cgroup at all. There the grants are unenforced and
 * `capacity` says so — but what is *being used* is still answerable, and that
 * is the number an operator is staring at when something has gone wrong.
 */

import { readFileSync, readdirSync } from 'node:fs';

/**
 * Clock ticks per second, as `/proc/<pid>/stat` counts them.
 *
 * `USER_HZ` is 100 on every Linux userspace ABI regardless of the kernel's own
 * tick rate — it is part of what `/proc` promises, not a build option — and
 * Node has no `sysconf` to ask with.
 */
const USER_HZ = 100;

/** One process's contribution, kept separate so `capacity --measure` can name them. */
export interface ProcessSample {
  pid: number;
  /** `/proc/<pid>/comm` — `bun`, `python3`, `bwrap`. */
  comm: string;
  /** utime + stime, in clock ticks since the process started. */
  cpuTicks: number;
  /** Resident set size, bytes. */
  rssBytes: number;
}

/** A process tree, sampled at one instant. */
export interface TreeSample {
  /** `Date.now()` when this was taken. */
  at: number;
  processes: ProcessSample[];
}

/** What a tree cost between two samples of it. */
export interface Usage {
  /** CPU used, as a fraction of one core. 1.0 is one core saturated. */
  cores: number;
  /** Resident memory at the later sample, MB. */
  memoryMb: number;
  /** How many processes were alive at the later sample. */
  processes: number;
}

/** One process, or `null` if it went away while being read. */
function sampleOne(pid: number): ProcessSample | null {
  try {
    // Everything after the last ')' — the comm field can contain spaces and
    // parentheses, which is why it cannot simply be split on whitespace.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);

    // VmRSS is in kB and says so, which beats `statm`'s page count: a page is
    // 4 KB on this machine and need not be on the next one.
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);

    return {
      pid,
      comm: readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
      cpuTicks: (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0),
      rssBytes: rss ? Number(rss[1]) * 1024 : 0,
    };
  } catch {
    // Gone between being listed and being read. A seat that died mid-sample is
    // a normal thing to see, not an error to report.
    return null;
  }
}

/** Every child pid of one process, across all its threads. */
function childrenOf(pid: number): number[] {
  const found: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
        if (raw.length === 0) continue;
        for (const part of raw.split(/\s+/)) {
          const child = Number(part);
          if (Number.isInteger(child) && child > 0) found.push(child);
        }
      } catch {
        // A thread that ended mid-walk.
      }
    }
  } catch {
    // The process itself ended mid-walk.
  }
  return found;
}

/**
 * A process and every descendant of it, sampled now.
 *
 * Returns an empty sample rather than throwing when the tree has gone: an
 * arena that exited a moment ago is a thing the supervisor discovers, not a
 * thing it should crash on.
 */
export function sampleTree(pid: number, limit = 256): TreeSample {
  const processes: ProcessSample[] = [];
  const seen = new Set<number>();
  const queue = [pid];

  while (queue.length > 0 && processes.length < limit) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const sample = sampleOne(next);
    if (!sample) continue;
    processes.push(sample);
    queue.push(...childrenOf(next));
  }

  return { at: Date.now(), processes };
}

/**
 * What the tree used between two samples.
 *
 * CPU is a delta over wall-clock, which is the only honest way to express it:
 * a process's lifetime average says nothing about what it is doing now, and
 * "now" is the entire question the admin console asks. Processes that appeared
 * between the samples count all of their time, and ones that ended are simply
 * absent — over a two-second window neither distorts anything, and pretending
 * otherwise would mean keeping a ledger of the dead.
 */
export function usageBetween(before: TreeSample, after: TreeSample): Usage {
  const elapsed = (after.at - before.at) / 1000;
  const previous = new Map(before.processes.map((p) => [p.pid, p.cpuTicks]));

  let ticks = 0;
  let rss = 0;
  for (const process of after.processes) {
    ticks += Math.max(0, process.cpuTicks - (previous.get(process.pid) ?? 0));
    rss += process.rssBytes;
  }

  return {
    cores: elapsed > 0 ? ticks / USER_HZ / elapsed : 0,
    memoryMb: rss / 1024 / 1024,
    processes: after.processes.length,
  };
}

/**
 * How much of real time a match is actually managing to play.
 *
 * The starvation guard in the realtime loops never tries to make up more than
 * a quarter second at once, so a host that is genuinely oversubscribed does
 * not catch up by simulating a second of football in one frame — it drops the
 * time instead. That is the right behaviour and it is also invisible: the
 * match simply takes longer in the hall than the clock on the wall says.
 *
 * This makes it a number. It is the first thing to move when a budget is
 * wrong, which is why the admin console watches it rather than watching CPU.
 *
 * Measured over a window rather than over the whole match, because the
 * question being asked is "is it keeping up *now*" — a match that stuttered
 * for ten seconds during the first half and recovered should not read as
 * degraded for the next five minutes.
 */
export class FidelityMeter {
  private simulated = 0;
  private wall = 0;
  private windowStarted = Date.now();
  private last: number | null = null;

  constructor(private readonly windowMs = 5_000) {}

  /** Simulated seconds advanced against wall seconds spent, while play is live. */
  advance(simulatedSeconds: number, wallSeconds: number): void {
    this.simulated += simulatedSeconds;
    this.wall += wallSeconds;
    if (Date.now() - this.windowStarted < this.windowMs) return;
    this.last = this.wall > 0 ? this.simulated / this.wall : null;
    this.simulated = 0;
    this.wall = 0;
    this.windowStarted = Date.now();
  }

  /** Simulated seconds per wall second, or `null` before a window has closed. */
  get value(): number | null {
    return this.last;
  }
}

/** Sum of several trees' usage — the whole venue, from its arenas. */
export function totalUsage(all: readonly Usage[]): Usage {
  return {
    cores: all.reduce((sum, u) => sum + u.cores, 0),
    memoryMb: all.reduce((sum, u) => sum + u.memoryMb, 0),
    processes: all.reduce((sum, u) => sum + u.processes, 0),
  };
}
