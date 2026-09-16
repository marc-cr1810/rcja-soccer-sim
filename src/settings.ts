/**
 * What a venue has turned, kept in a file beside the database.
 *
 * Accounts are in SQLite because they are genuinely mutable state about
 * *who*. Settings are not that: they are a handful of numbers an organiser
 * sets once and looks at when something is wrong, and the standing promise in
 * this repository is that an organiser can open the broken thing in a text
 * editor at eleven at night. Draws, results, submissions and workspaces are
 * all still files for that reason, and `league.json` joins them rather than
 * becoming a second table nobody can read without a SQL client.
 *
 * **The file is the truth.** A flag on `league` overrides one value for one
 * run — useful for "try it with four" without editing anything — and the admin
 * console says which values came from where, because a setting that silently
 * disagrees with the file it is displayed next to is worse than no display.
 *
 * Nothing in here knows what the machine can do. `arenas.max` left unset means
 * *computed*, and computing it is `capacity.ts`'s job, over `os.cpus()` and
 * the grants below — keeping the file's reader and the machine's reader apart
 * is what lets both be tested without the other.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLeagueId, type LeagueId } from './leagues';

/** Per-seat grants, from `src/lineup.ts` where they were constants. */
export const DEFAULT_SEAT_CPU_PERCENT = 50;
export const DEFAULT_SEAT_MEMORY_MB = 512;

/** Seats in one arena. Four, and it has never been anything else. */
export const SEATS_PER_ARENA = 4;

export interface ArenaSettings {
  /**
   * How many arenas may run at once. `null` means whatever this machine can
   * guarantee — the default, because 4 was a guess made before anything had
   * been measured and it is wrong in both directions on different machines.
   */
  max: number | null;
  /** CPU grant per seat, as a percentage of one core. */
  seatCpuPercent: number;
  /** Memory grant per seat, MB. */
  seatMemoryMb: number;
  /** Cores held back for the hub, the operating system and the hall screen. */
  reserveCores: number;
  /** How many fixtures the schedule plays at once. */
  concurrentFixtures: number;
}

export interface PracticeSettings {
  /** Whether practice arenas may be opened at all. */
  open: boolean;
  /**
   * A policy cap on practice arenas. `null` means whatever is spare.
   *
   * It may only ever subtract: capacity is `arenas.max` less
   * `arenas.concurrentFixtures`, and a `practice.max` above that does nothing.
   * A second number able to silently contradict the first is the thing this
   * codebase keeps refusing — and deriving the fixture headroom from the
   * schedule is what guarantees a fixture never queues behind a rehearsal.
   */
  max: number | null;
  /** Minutes of quiet before a field is warned. */
  idleMins: number;
  /**
   * Minutes between the warning and the field actually closing.
   *
   * Warned, then closed — never silently killed. A fifteen-year-old who walked
   * away for lunch should come back to an explanation, not an absence, and a
   * banner they had no chance to see is not an explanation.
   */
  graceMins: number;
  /**
   * Fields one team may own at once.
   *
   * The one that does the most work at a real event: a global cap of eight is
   * no protection at all if one team opens eight. Its ceiling of **2** is not
   * a guess — it is how many robots a team has, and under one-robot-one-place
   * a second field is reachable only by splitting robot 1 onto one and robot 2
   * onto another. Three is not discouraged, it is unreachable.
   */
  perTeam: number;
  /**
   * How long a field freeing up is held for the team at the front of the queue.
   *
   * A queue that opened the field for them instead would start an idle clock
   * on an empty field belonging to somebody who has gone home, and stall
   * everyone behind them for the whole quiet period.
   */
  claimSecs: number;
}

/**
 * A demo arena that plays forever, filling a hall screen when the draw is
 * running or when nothing is on.
 *
 * The whole point is that the screen never sits still: one arena child runs
 * back-to-back matches at wall-clock speed with a fresh seed every time, never
 * recording a result. `bots` decides who plays — the built-in reference agent,
 * one of the deliberately poor bots, or the four python example robots that
 * join as remote seats.
 */
export interface DemoSettings {
  /** Whether to keep a demo arena always playing, alongside the schedule. */
  on: boolean;
  /**
   * Who fills the seats: `reference` (built-in vs built-in), `examples` (the
   * repo's own `python/examples` line-up, both sides), or a bot-roster name
   * (reference vs that bot).
   */
  bots: string;
  /** The violet side's name on the card and in the team names. */
  home: string;
  /** The lime side. */
  away: string;
  /** Simulated seconds in a half. */
  halfSeconds: number;
  /** Which rule set; `null` means the default league. */
  league: LeagueId | null;
  /** Wall-clock pause between matches, so the hall can read the table. */
  gapSeconds: number;
}

export interface LeagueSettings {
  arenas: ArenaSettings;
  practice: PracticeSettings;
  demo: DemoSettings;
}

/** Where a value came from, for a console that has to be able to explain itself. */
export type SettingSource = 'default' | 'file' | 'flag';

export interface LoadedSettings {
  settings: LeagueSettings;
  /** Dotted path to where that value came from, e.g. `arenas.max`. */
  sources: Record<string, SettingSource>;
  /** The file these were read from, whether or not it exists yet. */
  file: string;
  /** Anything in the file that was wrong, said plainly. Never throws. */
  complaints: string[];
}

export const SETTINGS_FILE = 'league.json';

export function defaultSettings(): LeagueSettings {
  return {
    arenas: {
      max: null,
      seatCpuPercent: DEFAULT_SEAT_CPU_PERCENT,
      seatMemoryMb: DEFAULT_SEAT_MEMORY_MB,
      reserveCores: 1,
      concurrentFixtures: 2,
    },
    practice: { open: true, max: null, idleMins: 20, graceMins: 5, perTeam: 1, claimSecs: 90 },
    demo: { on: false, bots: 'reference', home: 'Violet', away: 'Lime', halfSeconds: 300, league: null, gapSeconds: 3 },
  };
}

/**
 * Fill in defaults for whatever a caller passed, field by field.
 *
 * A `LeagueServer` constructor takes a settings object because a test wants to
 * say "two practice fields and nothing else" without repeating the untouched
 * halves of the file — so missing fields here are defaults, never `undefined`.
 */
export function mergeSettings(partial: Partial<LeagueSettings> | undefined): LeagueSettings {
  const defaults = defaultSettings();
  if (!partial) return defaults;
  return {
    ...defaults,
    ...partial,
    arenas: { ...defaults.arenas, ...partial.arenas },
    practice: { ...defaults.practice, ...partial.practice },
    demo: { ...defaults.demo, ...partial.demo },
  };
}

/** A number from the file, or a complaint and the default kept. */
function readNumber(
  raw: unknown,
  path: string,
  fallback: number,
  bounds: { min: number; max: number },
  complaints: string[],
): { value: number; used: boolean } {
  if (raw === undefined || raw === null) return { value: fallback, used: false };
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    complaints.push(`${path} is not a number; using ${fallback}`);
    return { value: fallback, used: false };
  }
  if (value < bounds.min || value > bounds.max) {
    const clamped = Math.min(bounds.max, Math.max(bounds.min, value));
    complaints.push(`${path} must be between ${bounds.min} and ${bounds.max}; using ${clamped}`);
    return { value: clamped, used: true };
  }
  return { value, used: true };
}

/** A number or an explicit "work it out" — `null`, or absent. */
function readAuto(
  raw: unknown,
  path: string,
  bounds: { min: number; max: number },
  complaints: string[],
): { value: number | null; used: boolean } {
  if (raw === undefined || raw === null || raw === 'auto') {
    return { value: null, used: raw !== undefined };
  }
  const read = readNumber(raw, path, bounds.min, bounds, complaints);
  return { value: read.value, used: true };
}

/**
 * Read `league.json` out of the data directory.
 *
 * A missing file is the normal case and not a complaint: a venue that has
 * never set anything gets the defaults, and the file appears the first time
 * somebody changes something. A *broken* file is a complaint per bad value
 * and the defaults for those values — an organiser with a stray comma at
 * eleven at night should get a server that starts and a line saying what it
 * ignored, rather than a server that will not come up.
 */
export function loadSettings(dataDir: string, overrides: Partial<Flags> = {}): LoadedSettings {
  const file = join(dataDir, SETTINGS_FILE);
  const settings = defaultSettings();
  const sources: Record<string, SettingSource> = {};
  const complaints: string[] = [];

  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    } else {
      complaints.push(`${SETTINGS_FILE} is not a JSON object; ignoring all of it`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      complaints.push(`${SETTINGS_FILE} could not be read (${(error as Error).message}); using defaults`);
    }
  }

  const arenas = (raw.arenas ?? {}) as Record<string, unknown>;
  const practice = (raw.practice ?? {}) as Record<string, unknown>;
  const demo = (raw.demo ?? {}) as Record<string, unknown>;

  const set = <K extends string>(path: K, used: boolean): void => {
    sources[path] = used ? 'file' : 'default';
  };

  const max = readAuto(arenas.max, 'arenas.max', { min: 1, max: 512 }, complaints);
  settings.arenas.max = max.value;
  set('arenas.max', max.used);

  const cpu = readNumber(arenas.seatCpuPercent, 'arenas.seatCpuPercent', DEFAULT_SEAT_CPU_PERCENT, { min: 5, max: 400 }, complaints);
  settings.arenas.seatCpuPercent = cpu.value;
  set('arenas.seatCpuPercent', cpu.used);

  const mem = readNumber(arenas.seatMemoryMb, 'arenas.seatMemoryMb', DEFAULT_SEAT_MEMORY_MB, { min: 64, max: 8192 }, complaints);
  settings.arenas.seatMemoryMb = mem.value;
  set('arenas.seatMemoryMb', mem.used);

  const reserve = readNumber(arenas.reserveCores, 'arenas.reserveCores', 1, { min: 0, max: 64 }, complaints);
  settings.arenas.reserveCores = reserve.value;
  set('arenas.reserveCores', reserve.used);

  const concurrent = readNumber(arenas.concurrentFixtures, 'arenas.concurrentFixtures', 2, { min: 1, max: 64 }, complaints);
  settings.arenas.concurrentFixtures = Math.round(concurrent.value);
  set('arenas.concurrentFixtures', concurrent.used);

  if (typeof practice.open === 'boolean') {
    settings.practice.open = practice.open;
    set('practice.open', true);
  } else {
    if (practice.open !== undefined) complaints.push('practice.open must be true or false; using true');
    set('practice.open', false);
  }

  const practiceMax = readAuto(practice.max, 'practice.max', { min: 0, max: 512 }, complaints);
  settings.practice.max = practiceMax.value;
  set('practice.max', practiceMax.used);

  const idle = readNumber(practice.idleMins, 'practice.idleMins', 20, { min: 1, max: 600 }, complaints);
  settings.practice.idleMins = idle.value;
  set('practice.idleMins', idle.used);

  const grace = readNumber(practice.graceMins, 'practice.graceMins', 5, { min: 1, max: 60 }, complaints);
  settings.practice.graceMins = grace.value;
  set('practice.graceMins', grace.used);

  // 2 is the ceiling because a team has two robots, not because two felt like
  // enough - see PracticeSettings.perTeam.
  const perTeam = readNumber(practice.perTeam, 'practice.perTeam', 1, { min: 1, max: 2 }, complaints);
  settings.practice.perTeam = Math.round(perTeam.value);
  set('practice.perTeam', perTeam.used);

  const claim = readNumber(practice.claimSecs, 'practice.claimSecs', 90, { min: 10, max: 3600 }, complaints);
  settings.practice.claimSecs = Math.round(claim.value);
  set('practice.claimSecs', claim.used);

  // Demo arena — a single, always-on, never-scored child that plays
  // back-to-back matches for the hall screen.
  if (typeof demo.on === 'boolean') {
    settings.demo.on = demo.on;
    set('demo.on', true);
  } else {
    if (demo.on !== undefined) complaints.push('demo.on must be true or false; using false');
    set('demo.on', false);
  }

  if (typeof demo.bots === 'string' && demo.bots !== '') {
    settings.demo.bots = demo.bots;
    set('demo.bots', true);
  } else {
    if (demo.bots !== undefined) complaints.push('demo.bots must be a string; using "reference"');
    set('demo.bots', false);
  }

  if (typeof demo.home === 'string' && demo.home !== '') {
    settings.demo.home = demo.home;
    set('demo.home', true);
  } else {
    if (demo.home !== undefined) complaints.push('demo.home must be a string; using "Violet"');
    set('demo.home', false);
  }

  if (typeof demo.away === 'string' && demo.away !== '') {
    settings.demo.away = demo.away;
    set('demo.away', true);
  } else {
    if (demo.away !== undefined) complaints.push('demo.away must be a string; using "Lime"');
    set('demo.away', false);
  }

  const demoHalf = readNumber(demo.halfSeconds, 'demo.halfSeconds', 300, { min: 30, max: 1800 }, complaints);
  settings.demo.halfSeconds = Math.round(demoHalf.value);
  set('demo.halfSeconds', demoHalf.used);

  if (typeof demo.league === 'string') {
    if (isLeagueId(demo.league)) {
      settings.demo.league = demo.league;
      set('demo.league', true);
    } else {
      complaints.push(`demo.league "${demo.league}" is not a known league; using the default`);
      set('demo.league', false);
    }
  } else {
    if (demo.league !== undefined && demo.league !== null) {
      complaints.push('demo.league must be "lightweight" or "open"; using the default');
    }
    set('demo.league', false);
  }

  const demoGap = readNumber(demo.gapSeconds, 'demo.gapSeconds', 3, { min: 0, max: 60 }, complaints);
  settings.demo.gapSeconds = Math.round(demoGap.value);
  set('demo.gapSeconds', demoGap.used);

  applyFlags(settings, sources, overrides);
  return { settings, sources, file, complaints };
}

/** One-run overrides, from `league`'s own flags. */
export interface Flags {
  arenasMax: number;
  concurrentFixtures: number;
  seatCpuPercent: number;
  seatMemoryMb: number;
  practiceMax: number;
  idleMins: number;
  perTeam: number;
  demoOn: boolean;
  demoBots: string;
  demoHome: string;
  demoAway: string;
  demoHalf: number;
  demoLeague: LeagueId | null;
  demoGap: number;
}

function applyFlags(
  settings: LeagueSettings,
  sources: Record<string, SettingSource>,
  flags: Partial<Flags>,
): void {
  const take = <T>(value: T | undefined, path: string, apply: (v: T) => void): void => {
    if (value === undefined) return;
    apply(value);
    sources[path] = 'flag';
  };

  take(flags.arenasMax, 'arenas.max', (v) => (settings.arenas.max = v));
  take(flags.concurrentFixtures, 'arenas.concurrentFixtures', (v) => (settings.arenas.concurrentFixtures = v));
  take(flags.seatCpuPercent, 'arenas.seatCpuPercent', (v) => (settings.arenas.seatCpuPercent = v));
  take(flags.seatMemoryMb, 'arenas.seatMemoryMb', (v) => (settings.arenas.seatMemoryMb = v));
  take(flags.practiceMax, 'practice.max', (v) => (settings.practice.max = v));
  take(flags.idleMins, 'practice.idleMins', (v) => (settings.practice.idleMins = v));
  take(flags.perTeam, 'practice.perTeam', (v) => (settings.practice.perTeam = v));
  take(flags.demoOn, 'demo.on', (v) => (settings.demo.on = v));
  take(flags.demoBots, 'demo.bots', (v) => (settings.demo.bots = v));
  take(flags.demoHome, 'demo.home', (v) => (settings.demo.home = v));
  take(flags.demoAway, 'demo.away', (v) => (settings.demo.away = v));
  take(flags.demoHalf, 'demo.halfSeconds', (v) => (settings.demo.halfSeconds = v));
  take(flags.demoLeague, 'demo.league', (v) => (settings.demo.league = v));
  take(flags.demoGap, 'demo.gapSeconds', (v) => (settings.demo.gapSeconds = v));
}

/**
 * Write the file back.
 *
 * Whole and pretty-printed, because the next person to open it is as likely to
 * be an organiser in a text editor as it is to be this program.
 */
export function saveSettings(dataDir: string, settings: LeagueSettings): void {
  writeFileSync(join(dataDir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
