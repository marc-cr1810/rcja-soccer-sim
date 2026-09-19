/**
 * What one arena costs on *this* machine, measured rather than reasoned.
 *
 * `END-STATE.md` tells a venue to re-measure on its own hardware before an
 * event, and the numbers it quotes were produced by hand with a `/proc`
 * sampler (`scratch/measure-arena.py`). Advice that requires writing a `/proc`
 * sampler is advice nobody takes, so this is that script as a command.
 *
 * Two choices in here are worth stating, because they are what make one
 * venue's number comparable with another's:
 *
 * **It measures the repository's own example robots**, not a pushed team.
 * Nobody has pushed anything the week before an event, which is precisely when
 * this question gets asked — and a calibration robot that changes with whoever
 * happens to have submitted makes two venues' figures mean different things.
 * The striker and keeper under `python/examples/` are real football, 1,254
 * lines of it, and they are what the recorded 0.17 cores was measured against.
 *
 * **It plays a real arena, sandboxed, at the configured grant.** Not an
 * estimate, not a synthetic loop: the same child process a fixture runs in,
 * with the same cgroups around the same CPython. A measurement taken under
 * easier conditions than a match would be measuring a different sport, which
 * is the argument this codebase keeps making.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ArenaSupervisor } from '../league/arenas';
import { SEAT_IDS } from '../match/match';
import { TOKEN_FILENAME } from '../infra/manifest';
import { sampleTree } from '../infra/usage';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** The repository's example robots: `python/examples/` beside the working
 * directory if it exists, else the source tree next to this file. The first
 * matters because a compiled binary cannot read files next to
 * `import.meta.dirname` — that is the Bun virtual filesystem, inside the
 * executable — so a deployed calendar measures against the `python/` shipped
 * beside the binary. */
function calibrationSources(): string {
  const beside = resolve('python', 'examples');
  if (existsSync(beside)) return beside;
  return join(REPO_ROOT, 'python', 'examples');
}

/** The team name the calibration submission is pushed under. */
const CALIBRATION_TEAM = 'Calibration';

export interface MeasureOptions {
  /** How long to sample for, once everything is running. */
  seconds?: number;
  seatCpuPercent?: number;
  seatMemoryMb?: number;
  log?: (line: string) => void;
}

export interface Part {
  label: string;
  cores: number;
  memoryMb: number;
}

export interface Measurement {
  seconds: number;
  /** One line per process: the arena's Node, then each robot. */
  parts: Part[];
  total: Part;
  /** Simulated seconds per wall second over the sample. 1.0 is keeping up. */
  fidelity: number;
  /** How many seats actually had a program in them when it was sampled. */
  seats: number;
}

/** A calibration submission: the repo's own striker and keeper, as a real push. */
async function writeCalibration(dir: string): Promise<void> {
  const team = 'calibration';
  for (const [robot, source] of [
    [1, 'striker.py'],
    [2, 'goalie.py'],
  ] as const) {
    const folder = join(dir, team, String(robot));
    await mkdir(folder, { recursive: true });
    await cp(join(calibrationSources(), source), join(folder, 'robot.py'));
    await writeFile(
      join(folder, 'manifest.json'),
      `${JSON.stringify({ team: CALIBRATION_TEAM, robot, entry: 'robot.py' }, null, 2)}\n`,
    );
    // A seat will not load a folder with no token beside it — that is the rule
    // that stops a submission appearing in a match without having been pushed.
    // Here the push is this function, so the token is minted here.
    await writeFile(join(folder, TOKEN_FILENAME), `${randomBytes(24).toString('base64url')}\n`);
  }
}

async function post(port: number, path: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
}

async function clockOf(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/practice-api/state`);
  const payload = (await res.json()) as { state: { clock: number } };
  return payload.state.clock;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Start one arena, fill it, let it settle, and watch it for a while.
 *
 * The settling matters more than it looks: four CPython interpreters starting
 * at once cost far more than four running, and a sample that began at the same
 * instant as the spawn would report the start-up rather than the match.
 */
export async function measureArena(opts: MeasureOptions = {}): Promise<Measurement> {
  const seconds = opts.seconds ?? 30;
  const log = opts.log ?? (() => {});
  const submissions = await mkdtemp(join(tmpdir(), 'rcja-calibration-'));
  const supervisor = new ArenaSupervisor({
    maxArenas: 1,
    submissionsDir: submissions,
    seatCpuPercent: opts.seatCpuPercent,
    seatMemoryMb: opts.seatMemoryMb,
  });

  try {
    await writeCalibration(submissions);
    log('starting one arena…');
    const arena = await supervisor.create({ kind: 'practice' });
    const port = supervisor.portOf(arena.id);
    const pid = supervisor.pidOf(arena.id);
    if (port === null || pid === undefined || pid === null) {
      throw new Error('the arena did not start');
    }

    log(`filling four seats with ${CALIBRATION_TEAM.toLowerCase()}…`);
    for (const seat of SEAT_IDS) {
      await post(port, '/practice-api/seat', { seat, fill: 'submission', team: CALIBRATION_TEAM });
    }
    await post(port, '/practice-api/start', {});

    // Long enough for four interpreters to import, connect and settle into
    // their control loops.
    await sleep(5_000);

    log(`measuring for ${seconds}s…`);
    const before = sampleTree(pid);
    const clockBefore = await clockOf(port);
    const wallBefore = Date.now();
    await sleep(seconds * 1000);
    const after = sampleTree(pid);
    const clockAfter = await clockOf(port);
    const wall = (Date.now() - wallBefore) / 1000;

    const elapsed = (after.at - before.at) / 1000;
    const wasTicks = new Map(before.processes.map((p) => [p.pid, p.cpuTicks]));
    const cost = (pids: typeof after.processes): { cores: number; memoryMb: number } => ({
      cores: pids.reduce(
        (sum, p) => sum + (elapsed > 0 ? (p.cpuTicks - (wasTicks.get(p.pid) ?? 0)) / 100 / elapsed : 0),
        0,
      ),
      memoryMb: pids.reduce((sum, p) => sum + p.rssBytes, 0) / 1024 / 1024,
    });

    // Three kinds of process live in an arena's tree, and they are worth
    // separating because they answer different questions. The arena itself is
    // the root of the tree, whatever its `comm` — `node` under tsx, `bun` from
    // source, the compiled binary's own name when that is what runs an arena —
    // so it is identified by position, not by name. Each robot arrives wrapped
    // in `bwrap` — the sandbox, which costs almost nothing but is honestly part
    // of what a seat takes.
    const [world = null, ...rest] = after.processes;
    const robots = after.processes.filter((p) => p.comm.startsWith('python'));
    const wrappers = rest.filter((p) => !p.comm.startsWith('python'));

    const parts: Part[] = [];
    if (world) parts.push({ label: 'arena', ...cost([world]) });
    robots.forEach((robot, index) => {
      parts.push({ label: `robot ${index + 1}`, ...cost([robot]) });
    });
    if (wrappers.length > 0) {
      parts.push({ label: `sandbox (${wrappers.length} procs)`, ...cost(wrappers) });
    }

    const total: Part = { label: 'whole arena', ...cost(after.processes) };

    return {
      seconds: elapsed,
      parts,
      total,
      fidelity: wall > 0 ? (clockAfter - clockBefore) / wall : 0,
      seats: robots.length,
    };
  } finally {
    supervisor.closeAll();
    await rm(submissions, { recursive: true, force: true });
  }
}
