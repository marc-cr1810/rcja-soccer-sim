/**
 * What this machine can actually run, and what it is running.
 *
 * `maxFields = 4` was a guess made before anything had been measured. It has
 * been measured now, on an Intel Ultra 7 155H with 22 logical CPUs and 31 GB:
 * an arena of four real robots costs **0.17 cores and 176 MB** against a
 * **granted 2.00 cores and 2.00 GB**, and the grant is not decorative — a
 * submission written to spend it gets exactly 50.0% of a core, because the
 * cgroup is real.
 *
 * Those two numbers pull against each other, and this file refuses to pick a
 * side. **A grant is about twelve times what a real robot uses**, so budgeting
 * by grant allows about ten arenas where the measured load would allow well
 * over a hundred — but a team is *entitled* to its grant, and a venue that
 * budgets on the 2–3% robots have used so far is budgeting on teams staying
 * bad at this. So the guaranteed figure is computed from grants, the used
 * figure is read from `/proc` (see `usage.ts`), and the admin console shows
 * three numbers rather than one: what you set, what the machine guarantees,
 * and what is in use right now.
 *
 * Setting the ceiling above the guaranteed figure is allowed. It is a venue's
 * call, and on the measured evidence it will usually be fine; what this file
 * owes them is a warning that names the consequence rather than grading the
 * risk.
 */

import { cpus, totalmem } from 'node:os';

import { bwrapAvailable, cgroupAvailable, sandboxUnavailableReason } from '../match/sandbox';
import { SEATS_PER_ARENA, type LeagueSettings, type SettingSource } from '../infra/settings';
import type { Measurement } from '../sim/measure';

/**
 * The arena's own Node process, measured: physics at 100 Hz, control at 50 Hz
 * and a viewer broadcast at 30 Hz cost 6.5% of a core and 103 MB, whether or
 * not anybody is watching.
 */
export const ARENA_NODE_CORES = 0.065;
export const ARENA_NODE_MEMORY_MB = 103;

export interface Machine {
  cores: number;
  memoryMb: number;
  /** `null` when the sandbox is ready, otherwise what an operator must fix. */
  sandboxUnavailable: string | null;
}

export function readMachine(): Machine {
  return {
    cores: cpus().length,
    memoryMb: totalmem() / 1024 / 1024,
    sandboxUnavailable: sandboxUnavailableReason(),
  };
}

export interface Grant {
  seatCpuPercent: number;
  seatMemoryMb: number;
  /** One arena's whole claim: four seats plus its own Node process. */
  arenaCores: number;
  arenaMemoryMb: number;
}

export function arenaGrant(settings: LeagueSettings): Grant {
  const { seatCpuPercent, seatMemoryMb } = settings.arenas;
  return {
    seatCpuPercent,
    seatMemoryMb,
    arenaCores: (SEATS_PER_ARENA * seatCpuPercent) / 100 + ARENA_NODE_CORES,
    arenaMemoryMb: SEATS_PER_ARENA * seatMemoryMb + ARENA_NODE_MEMORY_MB,
  };
}

export interface Budget {
  grant: Grant;
  /** How many arenas the grants fit into this machine, whole. */
  guaranteed: number;
  /** Which of CPU or memory ran out first. */
  limitedBy: 'cpu' | 'memory';
  /** The ceiling in force: what was set, or the guaranteed figure if nothing was. */
  max: number;
  /** Whether that ceiling was set by hand rather than computed. */
  set: boolean;
  /** Slots held for the schedule, so a fixture never queues behind a rehearsal. */
  fixtures: number;
  /** What practice may have: capacity less fixtures, then policy, which may only subtract. */
  practice: number;
  /**
   * Grants need cgroups. Without them nothing is held to anything, so a
   * capacity computed from grants would be a promise this machine cannot keep.
   */
  enforced: boolean;
  /** Said plainly, or empty. Order is the order to read them in. */
  warnings: string[];
}

/**
 * Turn the settings and the machine into the numbers everything else shows.
 *
 * Memory is reserved in proportion to the cores held back, rather than given
 * its own setting: `reserveCores` means "this much of the machine is not
 * yours", and a core's share of the RAM goes with it. One number to turn is
 * the point — and CPU is what actually runs out first on every machine this
 * has been run on.
 */
export function resolveBudget(settings: LeagueSettings, machine: Machine): Budget {
  const grant = arenaGrant(settings);

  const usableCores = Math.max(0, machine.cores - settings.arenas.reserveCores);
  const reservedMemory =
    machine.cores > 0 ? (machine.memoryMb * settings.arenas.reserveCores) / machine.cores : 0;
  const usableMemory = Math.max(0, machine.memoryMb - reservedMemory);

  const byCpu = Math.floor(usableCores / grant.arenaCores);
  const byMemory = Math.floor(usableMemory / grant.arenaMemoryMb);
  const guaranteed = Math.max(0, Math.min(byCpu, byMemory));

  const set = settings.arenas.max !== null;
  const overcommit = settings.arenas.overcommit ?? 1.0;
  const computedMax = overcommit > 1.0 ? Math.max(1, Math.floor(guaranteed * overcommit)) : guaranteed;
  const max = settings.arenas.max ?? computedMax;
  const fixtures = Math.min(settings.arenas.concurrentFixtures, max);

  const spare = Math.max(0, max - fixtures);
  const practice = settings.practice.open ? Math.min(spare, settings.practice.max ?? spare) : 0;

  const warnings: string[] = [];
  const enforced = machine.sandboxUnavailable === null;

  if (!enforced) {
    warnings.push(
      `Grants are unenforced on this machine: ${machine.sandboxUnavailable}. ` +
        `Nothing holds a robot to ${grant.seatCpuPercent}% of a core, so the guaranteed figure below is arithmetic rather than a promise.`,
    );
  }

  if (guaranteed < 1) {
    warnings.push(
      `This machine cannot honour even one arena at the configured grant ` +
        `(${grant.arenaCores.toFixed(2)} cores and ${(grant.arenaMemoryMb / 1024).toFixed(2)} GB per arena, ` +
        `against ${machine.cores} cores and ${(machine.memoryMb / 1024).toFixed(1)} GB with ${settings.arenas.reserveCores} held back). ` +
        `Lower arenas.seatCpuPercent or arenas.reserveCores before an event, not during one.`,
    );
  }

  if (!set && overcommit > 1.0 && max > guaranteed) {
    warnings.push(
      `Capacity is scheduled with ${overcommit}× overcommit (${max} arenas against ${guaranteed} guaranteed). ` +
        `Typical robots use about a twelfth of their grant, so this will very likely be fine. ` +
        `If load spikes, matches run slower than wall-clock rather than wrongly.`,
    );
  } else if (set && max > guaranteed) {
    warnings.push(
      `${max} arenas exceeds what this machine can guarantee (${guaranteed}). ` +
        `Typical robots use about a twelfth of their grant, so this will very likely be fine. ` +
        `It stops being fine the moment enough teams push heavy robots — and the most likely day for that is finals day. ` +
        `If it happens, matches run slower than wall-clock rather than wrongly: a five-minute half takes longer in the hall and the schedule slips. ` +
        `Practice arenas are shed first; fixtures are never shed.`,
    );
  }

  if (settings.practice.max !== null && settings.practice.max > spare) {
    warnings.push(
      `practice.max of ${settings.practice.max} is above the ${spare} arenas actually spare ` +
        `(arenas.max ${max} less ${fixtures} kept for fixtures), so it is doing nothing. ` +
        `Policy may only subtract.`,
    );
  }

  if (settings.arenas.concurrentFixtures > max) {
    warnings.push(
      `arenas.concurrentFixtures of ${settings.arenas.concurrentFixtures} is above arenas.max of ${max}; ` +
        `${fixtures} fixtures will run at once and there is no room for practice.`,
    );
  }

  if (settings.demo.on && spare < 1) {
    warnings.push(
      `the demo arena fills a hall screen and takes a slot of its own, but every one of the ${max} arenas is held for ${fixtures} fixtures. ` +
        `Raise arenas.max by one or turn demo off — otherwise a fixture waits behind it.`,
    );
  }

  return {
    grant,
    guaranteed,
    limitedBy: byCpu <= byMemory ? 'cpu' : 'memory',
    max,
    set,
    fixtures,
    practice,
    enforced,
    warnings,
  };
}

/**
 * The whole answer, for somebody standing at a terminal the week before an
 * event.
 *
 * Three numbers, never one — what you set, what this machine guarantees, and
 * (with `--measure`) what an arena actually costs — because any one of them on
 * its own is misleading in a different direction.
 */
export function formatCapacity(
  machine: Machine,
  settings: LeagueSettings,
  budget: Budget,
  sources: Record<string, SettingSource> = {},
  measured?: Measurement,
): string {
  const { grant } = budget;
  const lines: string[] = [];
  const where = (path: string): string => {
    const source = sources[path];
    return source === 'file' ? '  (league.json)' : source === 'flag' ? '  (this run only)' : '';
  };

  lines.push('');
  lines.push('  this machine');
  lines.push(
    `    ${machine.cores} logical CPUs · ${(machine.memoryMb / 1024).toFixed(0)} GB · ` +
      `cgroup ${cgroupAvailable() ? '✓' : '✗'} · bwrap ${bwrapAvailable() ? '✓' : '✗'}`,
  );
  lines.push('');
  lines.push(`  per-seat grant       ${grant.seatCpuPercent}% of a core · ${grant.seatMemoryMb} MB${where('arenas.seatCpuPercent')}`);
  lines.push(
    `  per-arena grant      ${grant.arenaCores.toFixed(2)} cores · ${(grant.arenaMemoryMb / 1024).toFixed(2)} GB` +
      `   (${SEATS_PER_ARENA} seats and the arena's own process)`,
  );

  if (measured) {
    lines.push('');
    lines.push(`  measured  (one arena, four calibration robots, ${measured.seconds.toFixed(0)}s)`);
    for (const part of measured.parts) {
      lines.push(
        `    ${part.label.padEnd(17)}${(part.cores * 100).toFixed(1).padStart(6)}% of a core · ${part.memoryMb.toFixed(0).padStart(4)} MB`,
      );
    }
    lines.push(
      `    ${'whole arena'.padEnd(17)}${measured.total.cores.toFixed(2).padStart(6)} cores    · ` +
        `${measured.total.memoryMb.toFixed(0).padStart(4)} MB · realtime ${(measured.fidelity * 100).toFixed(1)}%`,
    );
  }

  lines.push('');
  lines.push(
    `  guaranteed capacity  ${budget.guaranteed} arenas   ` +
      `(${budget.limitedBy === 'cpu' ? 'CPU' : 'memory'} runs out first, with ${settings.arenas.reserveCores} core(s) held back)`,
  );
  if (measured && measured.total.cores > 0 && measured.total.memoryMb > 0) {
    const usableCores = Math.max(0, machine.cores - settings.arenas.reserveCores);
    const usableMemory = Math.max(
      0,
      machine.memoryMb - (machine.memoryMb * settings.arenas.reserveCores) / Math.max(1, machine.cores),
    );
    const byLoad = Math.min(
      Math.floor(usableCores / measured.total.cores),
      Math.floor(usableMemory / measured.total.memoryMb),
    );
    lines.push(`  measured capacity    ~${byLoad} arenas  — not a promise: a team may spend its grant`);
  }
  lines.push('');
  lines.push(
    `  configured           arenas.max ${budget.set ? budget.max : `${budget.max} (computed${(settings.arenas.overcommit ?? 1.0) > 1.0 ? ` at ${settings.arenas.overcommit}× overcommit` : ''})`}${where('arenas.max')}`,
  );
  lines.push(
    `                       concurrentFixtures ${settings.arenas.concurrentFixtures}${where('arenas.concurrentFixtures')}`,
  );
  lines.push(
    `                       practice ${settings.practice.open ? `${budget.practice} arenas` : 'closed'}` +
      `${settings.practice.max === null ? ' (whatever is spare)' : ''}${where('practice.max')}`,
  );

  for (const warning of budget.warnings) {
    lines.push('');
    lines.push(`  ${wrap(warning, 72, '  ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Warnings are sentences, and a sentence that runs off the terminal is not read. */
function wrap(text: string, width: number, indent: string): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) out.push(line);
  return out.join(`\n${indent}`);
}

/** A machine that cannot run one arena has nothing useful to do. */
export function refuseToStart(budget: Budget): string | null {
  return budget.guaranteed < 1 && budget.max < 1
    ? 'this machine cannot run a single arena at the configured grant'
    : null;
}
