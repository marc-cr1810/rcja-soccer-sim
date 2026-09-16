/**
 * Starting a match, or a tournament, and putting it on a screen.
 *
 * Kept deliberately blunt. The test for this is whether a state coordinator who
 * does not write software can get a match on the hall screen in ten minutes,
 * so there is one command, it prints a URL, and the defaults are the ones an
 * event actually wants.
 */

import { MatchServer } from './server';
import { isRole, type Role } from './capabilities';
import { Match, KICKOFF_COUNTDOWN_SECONDS, type MatchAgents } from './match';
import { PracticeSession } from './practice';
import { referenceTeam } from './reference';
import { runLadder, formatLadder, type Entry } from './ladder';
import { ReferenceAgent } from './reference';
import { botRoster } from './bots';
import { resolveLineup, spawnLineup, type SpawnedLineup } from './lineup';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DEFAULT_OPTIONS, formatBench, runBench, type BenchResult } from './bench';
import { slugifyTeam } from './manifest';
import { isLeagueId, type LeagueId } from './leagues';
import { hashSubmission } from './submission';
import { formatTable, makeDraw, type Draw } from './tournament';
import { listEntrants, loadDraw, loadResults, saveDraw } from './tournament-store';
import { runDraw } from './tournament-run';
import {
  bumpSeedValue,
  formatSeedValue,
  parseSeed,
  type SeedInput,
} from './rand';

interface Args {
  command: string;
  flags: Map<string, string>;
  /**
   * Words after the command and before the first flag — `arenas stop <id>`.
   *
   * Only the leading run of them, because everything further along is already
   * spoken for: a bare word after a `--flag` is that flag's value, and has
   * been since the first command took one.
   */
  words: string[];
}

function parse(argv: string[]): Args {
  let command = 'serve';
  const rest = [...argv];
  if (rest.length > 0 && !rest[0]!.startsWith('--')) {
    command = rest.shift()!;
  }
  const words: string[] = [];
  while (rest.length > 0 && !rest[0]!.startsWith('--')) words.push(rest.shift()!);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const [name, inline] = token.slice(2).split('=');
    if (!name) continue;
    if (inline !== undefined) {
      flags.set(name, inline);
    } else {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, 'true');
      }
    }
  }
  return { command, flags, words };
}

function num(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A `--seed`, accepted as a decimal or a `0x…` 64-bit seed, or the
 * fallback when the flag is absent. A decimal stays a plain number — that is
 * what everyone means by `--seed 5`, and it is what ladder and bench keep —
 * while a hex seed is the full 64-bit form. Anything else throws: a typo
 * silently defaulting is exactly how a replay stops being one.
 */
function seedOption(flags: Map<string, string>, fallback: SeedInput): SeedInput {
  const raw = flags.get('seed');
  return raw === undefined ? fallback : parseSeedLike(raw);
}

/** `0x…` → its 64-bit Seed; a valid decimal → that number; else throw. */
function parseSeedLike(raw: string): SeedInput {
  const trimmed = raw.trim();
  if (!/^0x/i.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0 && n < 2 ** 53) return n;
  }
  return parseSeed(trimmed);
}

/** 64 fresh bits for one competition match, from the OS entropy pool. */
function matchSeed(): SeedInput {
  const b = randomBytes(8);
  return { hi: b.readUInt32BE(0), lo: b.readUInt32BE(4) };
}

/**
 * Who is playing.
 *
 * Until submitted programs can be loaded both sides are the reference agent,
 * which is what an organiser wants on the screen while the hall fills up.
 *
 * `--opponent` swaps the lime side for one of the deliberately poor robots.
 * Not only for demonstrations: a waller drives itself off the field within
 * seconds, and that is the only quick way to watch a rule 5.7 stand-down
 * actually happen rather than waiting most of a match for one.
 */
function agentsFor(opponent: string | undefined): MatchAgents {
  const violet = referenceTeam('violet');
  if (!opponent || opponent === 'reference') {
    return { ...violet, ...referenceTeam('lime') } as unknown as MatchAgents;
  }
  const bot = botRoster().find((b) => b.name === opponent);
  if (!bot) {
    const names = ['reference', ...botRoster().map((b) => b.name)].join(', ');
    console.error(`  unknown opponent "${opponent}". try: ${names}`);
    process.exit(1);
  }
  const [y1, y2] = bot.make('lime');
  return { ...violet, 'lime-1': y1!, 'lime-2': y2! } as unknown as MatchAgents;
}

function findDistDir(name: string): string | undefined {
  for (const candidate of [`dist/${name}`, `dist-${name}`]) {
    const built = resolve(candidate);
    if (existsSync(built)) return built;
  }
  return undefined;
}

function viewerRoot(): string | undefined {
  return findDistDir('viewer');
}

function refereeRoot(): string | undefined {
  return findDistDir('referee');
}

function workspaceRoot(): string | undefined {
  return findDistDir('workspace');
}

/**
 * Hand-issued team credentials for `--workspaces`, read from a file.
 *
 * A JSON object of team name to secret — the direction an organiser thinks in,
 * writing one line per team they have registered. It is inverted here into the
 * token-to-team map the server looks things up by, and a duplicated secret is
 * refused rather than silently handing two teams each other's code.
 *
 * A file rather than repeated flags because a venue has twenty of these and a
 * shell history is the wrong place for twenty secrets.
 */
function teamTokens(flags: Map<string, string>): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();

  const inline = flags.get('team-token');
  if (inline) {
    const split = inline.indexOf('=');
    if (split <= 0) {
      console.error(`\n  --team-token wants TEAM=SECRET, not "${inline}"\n`);
      process.exit(1);
    }
    tokens.set(inline.slice(split + 1), inline.slice(0, split));
  }

  const path = flags.get('team-tokens');
  if (path) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
    } catch (error) {
      console.error(`\n  could not read ${path}: ${(error as Error).message}\n`);
      process.exit(1);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`\n  ${path} must be a JSON object of "team": "secret"\n`);
      process.exit(1);
    }
    for (const [team, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof secret !== 'string' || secret.length < 8) {
        console.error(`\n  the secret for "${team}" must be a string of at least 8 characters\n`);
        process.exit(1);
      }
      const already = tokens.get(secret);
      if (already && already !== team) {
        console.error(`\n  "${team}" and "${already}" were given the same secret\n`);
        process.exit(1);
      }
      tokens.set(secret, team);
    }
  }

  return tokens;
}

/** `--league`, checked rather than cast: a typo should not silently mean "open". */
function leagueFrom(flags: Map<string, string>): LeagueId | undefined {
  const raw = flags.get('league');
  if (raw === undefined) return undefined;
  if (!isLeagueId(raw)) {
    console.error(`\n  no league called "${raw}" — try "open" or "lightweight"\n`);
    process.exit(1);
  }
  return raw;
}

function siteRoot(): string | undefined {
  return findDistDir('site');
}

function practiceRoot(): string | undefined {
  return findDistDir('practice');
}

function pythonLibDir(): string | undefined {
  const dir = resolve('python');
  return existsSync(dir) ? dir : undefined;
}

async function serve(flags: Map<string, string>): Promise<void> {
  const root = viewerRoot();
  const idealSensors = flags.get('ideal-sensors') === 'true';
  const refereed = flags.get('referee') === 'true';
  const refRoot = refereeRoot();
  // Hand-issued, like Phase 1's push token: minted once, printed once, never
  // stored anywhere the spectator bundle could read it. --referee-token lets
  // an organiser fix it in advance, for scripting a venue's setup.
  const refereeToken = refereed ? (flags.get('referee-token') ?? randomBytes(24).toString('base64url')) : undefined;
  // Opt-in, like --referee: a venue that wants teams rehearsing on the match
  // server says so, and gets a child process per field (see fields.ts).
  const practiceFields = flags.get('practice-fields') === 'true';
  // Opt-in the same way: a venue that wants teams editing in a browser says
  // so, and hands each team a secret out of band. A real competition runs
  // `league` instead, where the secret is an account - this is the laptop
  // arrangement, and it stays because a laptop has nobody to register with.
  const workspaceTokens = teamTokens(flags);
  const wsRoot = workspaceTokens.size > 0 ? workspaceRoot() : undefined;
  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    viewerRoot: root,
    refereeRoot: refRoot,
    refereeToken,
    practiceFields: practiceFields ? { maxArenas: num(flags, 'max-fields', 4) } : false,
    realtime: flags.get('fast') !== 'true',
    viewHz: num(flags, 'view-hz', 60),
    idealSensors,
    pythonLibDir: pythonLibDir(),
    workspaceRoot: wsRoot,
    workspaceTokens,
    workspacesDir: flags.get('workspaces-dir'),
    // Present means the operator said something ("0" included); absent lets
    // the server pick its own default for the mode.
    kickoffCountdown: flags.has('kickoff-countdown')
      ? num(flags, 'kickoff-countdown', KICKOFF_COUNTDOWN_SECONDS)
      : undefined,
  });
  const port = await server.listen();

  console.log(`\n  RCJA Soccer Simulation — match server`);
  console.log(`  sensors:   ${idealSensors ? 'ideal — noise-free, and not a mode to read a result from' : 'realistic (noise, drift, camera latency)'}`);
  console.log(`  watch at  http://localhost:${port}`);
  if (!root) {
    console.log(`  (no viewer built yet — run: bun run build:viewer)`);
  }
  if (practiceFields) {
    console.log(`  practice fields:  POST http://localhost:${port}/practice  opens one`);
    console.log(`  (open to whoever has the link — nothing on one is scored or recorded)`);
  }
  if (workspaceTokens.size > 0) {
    const teams = [...new Set(workspaceTokens.values())].sort();
    console.log(`  team workspaces:  http://localhost:${port}/workspace`);
    console.log(`  teams:            ${teams.join(', ')}`);
    if (!wsRoot) console.log(`  (no workspace built yet — run: bun run build:workspace)`);
  }
  if (refereed) {
    console.log(`  referee console:  http://localhost:${port}/referee`);
    console.log(`  referee token:    ${refereeToken}`);
    console.log(`  (hand this to the referee — it is not shown again)`);
    if (!refRoot) console.log(`  (no referee console built yet — run: bun run build:referee)`);
  }
  console.log(`  ctrl-c to stop\n`);

  const halfSeconds = num(flags, 'half', 300);
  const waitForAgents = flags.get('agents') === 'true';
  const teams = {
    violet: flags.get('home') ?? 'Violet',
    lime: flags.get('away') ?? flags.get('opponent') ?? 'Lime',
  };

  if (waitForAgents) {
    console.log(`  robots connect to  ws://localhost:${port}/agent`);
    console.log(`  waiting for all four…\n`);
  }

  /*
   * `--home`/`--away` double as a lookup: whichever of the four seats has a
   * validated submission under that team's name plays it, sandboxed; any
   * seat that does not falls back to the built-in agent `agentsFor` already
   * supplies for every seat regardless. Not attempted in `--agents` mode,
   * which already means "wait for four laptops" — the two are not something
   * a match needs at once.
   */
  let lineup: SpawnedLineup | null = null;
  if (!waitForAgents && pythonLibDir()) {
    const libDir = pythonLibDir()!;
    const resolved = await resolveLineup(server.submissionsDirectory, teams);
    const slots = ['violet-1', 'violet-2', 'lime-1', 'lime-2'] as const;
    const origin = (id: string): string =>
      resolved[id] ? `${teams[id.startsWith('violet') ? 'violet' : 'lime']} (submission)` : 'built-in';
    console.log(`  lineup:    ${slots.map((id) => `${id}=${origin(id)}`).join('  ')}`);

    const ids = Object.keys(resolved);
    if (ids.length > 0) {
      lineup = await spawnLineup(server, resolved, { pythonLibDir: libDir }, (line) =>
        console.log(`  ${line}`),
      );
      const missing = ids.filter((id) => !lineup!.transports[id]);
      if (missing.length > 0) {
        console.log(`  did not connect in time, playing built-in instead: ${missing.join(', ')}`);
      }
    }
    console.log();
  }
  process.on('SIGINT', () => {
    lineup?.stop();
    server.closeFields();
    process.exit(0);
  });

  // Keep playing. A screen in a hall should never be showing nothing, and an
  // organiser should not have to restart anything between matches.
  //
  // Without `--seed` every match draws 64 fresh bits from the OS, so a run of
  // matches is a run of different matches — which is what a competition is,
  // and what a seed was there to fight in the first place. With `--seed` the
  // run is deliberate and repeatable: the value is fixed, then bumps by one
  // per match as it always has.
  const explicitSeed = flags.get('seed') !== undefined;
  let seed: SeedInput = seedOption(flags, matchSeed());
  for (;;) {
    if (waitForAgents) {
      await server.agents.whenReady();
      // Whoever connected gets to say who they are; the scoreboard is theirs.
      Object.assign(teams, server.agents.teamNames());
    }
    const seedText = formatSeedValue(seed);
    console.log(
      refereed
        ? `  ready: ${teams.violet} v ${teams.lime}  (seed ${seedText}) — waiting for the referee to kick off`
        : `  kick-off: ${teams.violet} v ${teams.lime}  (seed ${seedText})`,
    );
    const dropouts: string[] = [];
    const result = await server.play({
      agents: agentsFor(flags.get('opponent')),
      transports: waitForAgents ? server.agents.transports() : lineup?.transports,
      teams,
      halfSeconds,
      seed,
      idealSensors,
      refereed,
    });
    console.log(
      `  full time: ${teams.violet} ${result.score.violet} — ${result.score.lime} ${teams.lime}` +
        `   (${server.watching} watching)`,
    );
    if (waitForAgents) {
      for (const [id, seat] of Object.entries(server.agents.report())) {
        if (!seat.connected) dropouts.push(`${id} never came back`);
        else if (seat.reconnects > 0) dropouts.push(`${id} reconnected ${seat.reconnects}x`);
      }
      if (dropouts.length > 0) console.log(`  connections: ${dropouts.join(', ')}`);
      // Seats are deliberately left alone between matches. A stand-down under
      // 5.7.2 belongs to the match it was served in, and the next match has
      // its own robots, all of them on the field — so `standDown` answers zero
      // and anyone who dropped out can simply rejoin. Closing the sockets here
      // instead would make every robot reconnect between every match, which is
      // a second of dead air and four lines of log for nothing.
    }
    seed = explicitSeed ? bumpSeedValue(seed) : matchSeed();
  }
}

/**
 * Open a practice field and leave it open.
 *
 * One field, one port, in the foreground - which is all a team on their own
 * machine needs, and is also exactly what a venue server spawns per field.
 * Nothing here is scored and nothing is written: there is no result to print
 * at the end because there is no end.
 */
async function practice(flags: Map<string, string>): Promise<void> {
  await practiceArena(flags, false);
}

/**
 * One world, held for somebody else: what a hub spawns, of either kind.
 *
 * A **practice** arena is the field above, byte for byte — the hub starting
 * one and a team starting one by hand must be the same thing running, or a
 * rehearsal is a rehearsal of a different sport. A **fixture** arena is the
 * same `MatchServer` with a referee console, bound to loopback, waiting to be
 * told what to play (see `arena.ts`).
 *
 * Always in the foreground, always watching its stdin: the pipe its parent
 * holds is what makes `--die-with-parent` true even when the hub is killed
 * outright and never runs its own cleanup.
 */
async function arena(flags: Map<string, string>): Promise<void> {
  const kind = flags.get('kind') === 'fixture' ? 'fixture' : 'practice';
  if (kind === 'practice') {
    await practiceArena(flags, true);
    return;
  }

  const { FixtureArena } = await import('./arena');
  let fixture: InstanceType<typeof FixtureArena> | null = null;

  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    host: flags.get('host'),
    viewerRoot: viewerRoot(),
    refereeRoot: refereeRoot(),
    refereeToken: flags.get('referee-token'),
    realtime: true,
    viewHz: num(flags, 'view-hz', 60),
    pythonLibDir: pythonLibDir(),
    submissionsDir: flags.get('submissions'),
    control: (req, url) => fixture?.handle(req, url) ?? null,
  });

  fixture = new FixtureArena(server, {
    pythonLibDir: pythonLibDir() ?? null,
    seatCpuPercent: flags.has('seat-cpu') ? num(flags, 'seat-cpu', 50) : undefined,
    seatMemoryMb: flags.has('seat-mem') ? num(flags, 'seat-mem', 512) : undefined,
    log: (line) => console.log(`  ${line}`),
  });

  const port = await server.listen();
  console.log(`  fixture arena listening on ${port}`);

  const close = (): void => {
    fixture?.stop();
    process.exit(0);
  };
  process.on('SIGINT', close);
  dieWithParent(flags, close);
}

/** The practice field, started by hand or by a hub. */
async function practiceArena(flags: Map<string, string>, spawned: boolean): Promise<void> {
  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    host: flags.get('host'),
    viewerRoot: viewerRoot(),
    practiceRoot: practiceRoot(),
    realtime: true,
    viewHz: num(flags, 'view-hz', 60),
    idealSensors: flags.get('ideal-sensors') === 'true',
    pythonLibDir: pythonLibDir(),
    submissionsDir: flags.get('submissions'),
  });
  const port = await server.listen();

  const session = new PracticeSession(server, {
    submissionsDir: server.submissionsDirectory,
    pythonLibDir: pythonLibDir() ?? null,
    league: leagueFrom(flags),
    idealSensors: flags.get('ideal-sensors') === 'true',
    seed: seedOption(flags, 1),
    seatCpuPercent: flags.has('seat-cpu') ? num(flags, 'seat-cpu', 50) : undefined,
    seatMemoryMb: flags.has('seat-mem') ? num(flags, 'seat-mem', 512) : undefined,
    log: (line) => console.log(`  ${line}`),
  });

  if (!spawned) {
    console.log(`\n  RCJA Soccer Simulation — practice field`);
    console.log(`  watch at   http://localhost:${port}`);
    console.log(`  arrange at http://localhost:${port}/practice`);
    if (!practiceRoot()) console.log(`  (no practice console built yet — run: bun run build:practice)`);
    console.log(`  robots can also connect to  ws://localhost:${port}/agent`);
    console.log(`  open to anyone who has the link — nothing here is scored or recorded`);
    console.log(`  ctrl-c to stop\n`);
  }

  const close = (): void => {
    session.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  dieWithParent(flags, close);

  await server.practise(session);
}

/**
 * Spawned by a hub rather than started by hand: its stdin is a pipe held open
 * by the parent, so end-of-file on it means the parent is gone and this arena
 * has nobody left to belong to.
 */
function dieWithParent(flags: Map<string, string>, close: () => void): void {
  if (flags.get('die-with-parent') !== 'true') return;
  process.stdin.resume();
  process.stdin.on('end', close);
  process.stdin.on('close', close);
}

function once(flags: Map<string, string>): void {
  const teams = {
    violet: flags.get('home') ?? 'Violet',
    lime: flags.get('away') ?? flags.get('opponent') ?? 'Lime',
  };
  const idealSensors = flags.get('ideal-sensors') === 'true';
  const started = Date.now();
  const match = new Match({
    agents: agentsFor(flags.get('opponent')),
    teams,
    halfSeconds: num(flags, 'half', 300),
    seed: seedOption(flags, 1),
    idealSensors,
  });
  const result = match.run();
  const wall = (Date.now() - started) / 1000;

  console.log(
    `\n  violet ${teams.violet}  ${result.score.violet} — ${result.score.lime}  ${teams.lime} lime`,
  );
  const faults = Object.values(result.slots).reduce((a, s) => a + s.errors + s.missed, 0);
  console.log(
    `  ${result.clock.toFixed(0)} s sim in ${wall.toFixed(1)} s wall · faults ${faults}`,
  );
  const calls = Object.entries(result.calls)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind} ${n}`)
    .join(' · ');
  console.log(`  ${calls}\n`);
}

function ladder(flags: Map<string, string>): void {
  const entries: Entry[] = [
    {
      name: 'reference',
      origin: 'reference',
      make: (team) => [
        new ReferenceAgent({ team, number: 1, role: 'striker' }),
        new ReferenceAgent({ team, number: 2, role: 'goalie' }),
      ],
    },
    ...botRoster().map(
      (b): Entry => ({ name: b.name, origin: 'generated', make: b.make }),
    ),
  ];
  console.log();
  console.log(
    formatLadder(
      runLadder(entries, {
        halfSeconds: num(flags, 'half', 120),
        seed: seedOption(flags, 1),
        rounds: num(flags, 'rounds', 1),
      }),
    ),
  );
  console.log();
}

/**
 * Measure a robot program instead of watching it.
 *
 * The defaults are the ones an afternoon of work wants: three matches against
 * the reference team, ideal sensors because that is what the server uses, and
 * a report short enough to read every time.
 */
async function bench(flags: Map<string, string>): Promise<void> {
  const seeds = parseSeeds(flags.get('seeds') ?? '1-3');
  const team = (flags.get('team') ?? 'violet') as 'violet' | 'lime' | 'both';
  if (!['violet', 'lime', 'both'].includes(team)) {
    console.error(`  --team must be violet, lime or both, not "${team}"`);
    process.exit(1);
  }

  /*
   * Where the JSON goes decides everything else about the output.
   *
   * To stdout, it has to be the ONLY thing on stdout - a report printed
   * alongside it is not JSON any more, and whatever is parsing it says so in a
   * stack trace. To a file, the person at the terminal still wants the report,
   * and the progress lines while it plays.
   */
  const jsonTo = flags.get('json');
  const toStdout = jsonTo === 'true' || jsonTo === '-';
  let result: BenchResult;
  try {
    result = await runBench(
      {
        team,
        opponent: flags.get('opponent') ?? DEFAULT_OPTIONS.opponent,
        seeds,
        halfSeconds: num(flags, 'half', 90),
        idealSensors: flags.get('ideal-sensors') === 'true',
        port: num(flags, 'port', 0),
        spawn: flags.get('spawn'),
        connectTimeout: num(flags, 'wait', 30),
      },
      (line) => {
        if (!toStdout) console.error(line);
      },
    );
  } catch (error) {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  if (jsonTo !== undefined) {
    const text = JSON.stringify(result, null, 2);
    if (toStdout) {
      console.log(text);
      return;
    }
    writeFileSync(jsonTo, text);
    console.error(`  wrote ${jsonTo}`);
  }

  let baseline: BenchResult | undefined;
  const against = flags.get('baseline');
  if (against) {
    try {
      baseline = JSON.parse(readFileSync(against, 'utf8')) as BenchResult;
    } catch {
      console.error(`  could not read baseline ${against}; showing absolute numbers`);
    }
  }
  console.log(formatBench(result, baseline));
}

function tournamentsRoot(): string {
  return resolve('tournaments');
}

function requireName(flags: Map<string, string>): string {
  const name = flags.get('name');
  if (!name || name === 'true') {
    console.error(`\n  --name is required: which tournament, e.g. --name "state-round-1"\n`);
    process.exit(1);
  }
  return name;
}

/**
 * Write a draw. Entrants default to whoever has actually pushed something.
 *
 * Separate from playing it because a draw is a decision an organiser makes
 * once, looks at, and then lives with — a fixture list that appears as a side
 * effect of starting a server is one nobody gets to check first.
 */
async function draw(flags: Map<string, string>): Promise<void> {
  const name = requireName(flags);
  const submissionsDir = resolve('submissions');
  const teamsFlag = flags.get('teams');
  const entrants =
    teamsFlag && teamsFlag !== 'true'
      ? teamsFlag
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : await listEntrants(submissionsDir);

  if (entrants.length < 2) {
    console.error(
      `\n  need at least two entrants, found ${entrants.length} in ${submissionsDir}` +
        `\n  push some robots first, or name them yourself: --teams "ACT,QLD,VIC"\n`,
    );
    process.exit(1);
  }

  const refereed = flags.get('headless') !== 'true';
  const made = makeDraw(entrants, {
    name,
    halfSeconds: num(flags, 'half', 300),
    legs: num(flags, 'legs', 1),
    seed: seedOption(flags, matchSeed()),
    refereed,
  });

  let dir: string;
  try {
    dir = await saveDraw(tournamentsRoot(), made);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      console.error(
        `\n  a draw called "${made.id}" already exists.` +
          `\n  a draw is never rewritten — delete it by hand, or pick another --name\n`,
      );
      process.exit(1);
    }
    throw error;
  }

  console.log(`\n  ${made.name}  (${made.id})`);
  console.log(`  ${made.entrants.length} entrants, ${made.fixtures.length} fixtures, ${made.legs} leg(s) each`);
  console.log(`  ${refereed ? 'refereed, wall-clock' : 'headless, unattended'}  ·  ${made.halfSeconds}s halves`);
  console.log(`  written to ${dir}\n`);
  for (const fixture of made.fixtures) {
    console.log(`    ${fixture.home} v ${fixture.away}   seeds ${fixture.seeds.map(formatSeedValue).join(', ')}`);
  }
  console.log(`\n  play it:  bun run serve -- tournament --name ${made.id}\n`);
}

/**
 * Play a draw through, picking up wherever it was left.
 *
 * Every fixture spawns its own lineup and tears it down again, which `serve`
 * has never had to do: it resolves one lineup for the life of the process. The
 * teardown is `stop()` *and* `agents.closeAll()`, because killing the child
 * does not vacate its seat — the gateway keeps the seat until the socket
 * closes, and `waitForSeats` only checks that a seat exists. Leave it and the
 * next fixture is handed the last team's dead transport and starts happily
 * against nobody.
 */
async function tournament(flags: Map<string, string>): Promise<void> {
  const root = tournamentsRoot();
  const id = slugifyTeam(requireName(flags));

  let made: Draw;
  try {
    made = await loadDraw(root, id);
  } catch {
    console.error(`\n  no draw called "${id}" under ${root}` + `\n  make one:  bun run serve -- draw --name "${id}"\n`);
    process.exit(1);
  }

  // The draw says whether this tournament is refereed; --headless overrides it
  // for this run only, because realtime is a property of the server and cannot
  // change between fixtures inside one process.
  const refereed = made.refereed && flags.get('headless') !== 'true';
  const refereeToken = refereed ? (flags.get('referee-token') ?? randomBytes(24).toString('base64url')) : undefined;
  const refRoot = refereeRoot();

  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    viewerRoot: viewerRoot(),
    refereeRoot: refRoot,
    refereeToken,
    realtime: refereed,
    viewHz: num(flags, 'view-hz', 60),
    pythonLibDir: pythonLibDir(),
  });
  const port = await server.listen();

  console.log(`\n  ${made.name} — ${made.fixtures.length} fixtures`);
  console.log(`  watch at  http://localhost:${port}`);
  if (refereed) {
    console.log(`  referee console:  http://localhost:${port}/referee`);
    console.log(`  referee token:    ${refereeToken}`);
    console.log(`  (hand this to the referee — it is not shown again, and it lasts the whole tournament)`);
    if (!refRoot) console.log(`  (no referee console built yet — run: bun run build:referee)`);
  } else {
    console.log(`  headless — nothing waits for a referee`);
  }
  console.log(`  ctrl-c to stop; re-run to carry on where it stopped\n`);

  const libDir = pythonLibDir();
  let running: SpawnedLineup | null = null;
  process.on('SIGINT', () => {
    running?.stop();
    process.exit(0);
  });

  const results = await runDraw(root, made, {
    onFixtureStart: (fixture, played, total) => {
      console.log(`  fixture ${played + 1} of ${total}:  ${fixture.home} v ${fixture.away}`);
    },
    onFixtureDone: (fixture, result) => {
      const score = result.legs
        .map((leg) => `${leg.result.score.violet}-${leg.result.score.lime}`)
        .join(', ');
      console.log(`  played:  ${fixture.home} v ${fixture.away}  ${score}\n`);
    },
    playLeg: async (fixture, seed, leg) => {
      const teams = { violet: fixture.home, lime: fixture.away };
      const submissions: Record<string, string> = {};
      let lineup: SpawnedLineup | null = null;

      if (libDir) {
        const resolved = await resolveLineup(server.submissionsDirectory, teams);
        const ids = Object.keys(resolved);
        if (ids.length > 0) {
          lineup = await spawnLineup(server, resolved, { pythonLibDir: libDir }, (line) =>
            console.log(`  ${line}`),
          );
          running = lineup;
          for (const [id, entry] of Object.entries(resolved)) {
            if (entry) submissions[id] = await hashSubmission(entry.dir);
          }
        }
      }

      if (made.legs > 1) console.log(`    leg ${leg + 1} of ${made.legs}  (seed ${formatSeedValue(seed)})`);

      try {
        const result = await server.play({
          agents: agentsFor(undefined),
          transports: lineup?.transports,
          teams,
          league: made.league,
          halfSeconds: made.halfSeconds,
          seed,
          refereed,
        });
        return { result, submissions };
      } finally {
        lineup?.stop();
        running = null;
        server.agents.closeAll();
      }
    },
  });

  console.log(`\n${formatTable(made, results)}\n`);
  await server.close();
}



function leagueData(flags: Map<string, string>): string {
  return resolve(flags.get('data') ?? 'league');
}

/** A password, off the terminal rather than out of a shell history. */
async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error(`\n  ${prompt} — but this is not a terminal. Use --password.\n`);
    process.exit(1);
  }
  process.stdout.write(`  ${prompt}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let typed = '';
  for await (const chunk of process.stdin) {
    const text = (chunk as Buffer).toString('utf8');
    if (text === '\r' || text === '\n' || text === '\u0004') break;
    if (text === '\u0003') {
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      process.exit(130);
    }
    if (text === '\u007f' || text === '\b') typed = typed.slice(0, -1);
    else typed += text;
  }
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\n');
  return typed;
}

async function passwordFrom(flags: Map<string, string>, prompt: string): Promise<string> {
  const given = flags.get('password');
  if (given && given !== 'true') return given;
  const first = await askSecret(prompt);
  const again = await askSecret('and again');
  if (first !== again) {
    console.error('\n  those did not match\n');
    process.exit(1);
  }
  return first;
}

function roleFrom(flags: Map<string, string>): Role {
  const raw = flags.get('role');
  if (!raw || raw === 'true' || !isRole(raw) || raw === 'guest') {
    console.error('\n  --role must be team, referee or admin\n');
    process.exit(1);
  }
  return raw;
}

/**
 * The way in from outside the browser.
 *
 * The first admin cannot be made from a page that requires an admin to log
 * into, so this has to exist. It is also a debt the database choice incurred:
 * the standing promise that an organiser can fix the broken thing in a text
 * editor at eleven at night still holds for workspaces, submissions, draws and
 * results, and does not hold for accounts. `--passwd` rebuilds that hatch for
 * the failure most likely to happen under pressure — somebody cannot log in,
 * twenty minutes before their match.
 */
async function account(flags: Map<string, string>): Promise<void> {
  const { Accounts, MIN_PASSWORD } = await import('./accounts');
  const accounts = new Accounts({ file: join(leagueData(flags), 'league.db') });

  try {
    if (flags.get('list') === 'true') {
      const all = accounts.list();
      if (all.length === 0) {
        console.log('\n  no accounts yet — make one:  bun run serve -- account --create --role admin --name "Your Name"\n');
        return;
      }
      console.log('');
      for (const one of all) {
        const state = one.disabledAt ? '  (disabled)' : '';
        console.log(`  ${one.role.padEnd(8)}  ${one.slug.padEnd(24)}  ${one.displayName}${state}`);
      }
      console.log('');
      return;
    }

    if (flags.get('passwd') === 'true') {
      const slug = flags.get('name');
      if (!slug || slug === 'true') {
        console.error('\n  --passwd needs --name "who"\n');
        process.exit(1);
      }
      const password = await passwordFrom(flags, `new password for "${slug}" (at least ${MIN_PASSWORD} characters)`);
      const done = accounts.setPassword(slug, password);
      if (!done.ok) {
        console.error(`\n  ${done.reason}\n`);
        process.exit(1);
      }
      console.log(`\n  done — ${done.value.displayName} can log in again, and every old session is closed\n`);
      return;
    }

    if (flags.get('create') === 'true') {
      const role = roleFrom(flags);
      const name = flags.get('name');
      if (!name || name === 'true') {
        console.error('\n  --create needs --name "Their Name"\n');
        process.exit(1);
      }
      const password = await passwordFrom(flags, `a password (at least ${MIN_PASSWORD} characters)`);
      const made = accounts.createAccount({ role, displayName: name, password });
      if (!made.ok) {
        console.error(`\n  ${made.reason}\n`);
        process.exit(1);
      }
      accounts.record(null, 'account.manage', made.value.slug, 'created from the terminal');
      console.log(`\n  ${made.value.role} account "${made.value.displayName}" created`);
      console.log(`  they log in as:   ${made.value.slug}\n`);
      return;
    }

    console.log(`
  account --create --role admin|referee|team --name "Their Name"
  account --passwd --name <slug>
  account --list

  --data <dir>   where league.db lives (default: ./league)
`);
  } finally {
    accounts.close();
  }
}

/**
 * An invitation, single-use.
 *
 * A team invite carries the team's name so that registering cannot rename it:
 * the organiser decides who "ACT Robotics" is, the team decides their own
 * password. Same ergonomics as the hand-issued secret this replaces — an
 * organiser hands a team a string — and strictly better, because the string
 * stops working the moment it is used.
 */
async function invite(flags: Map<string, string>): Promise<void> {
  const { Accounts } = await import('./accounts');
  const accounts = new Accounts({ file: join(leagueData(flags), 'league.db') });
  try {
    if (flags.get('list') === 'true') {
      const all = accounts.listInvites();
      if (all.length === 0) {
        console.log('\n  no invitations issued\n');
        return;
      }
      console.log('');
      for (const one of all) {
        const state = one.usedAt ? 'used' : one.expiresAt < new Date().toISOString() ? 'expired' : 'open';
        console.log(`  ${state.padEnd(8)}  ${one.role.padEnd(8)}  ${(one.team ?? '').padEnd(24)}  ${one.code}`);
      }
      console.log('');
      return;
    }

    const role = roleFrom(flags);
    const team = flags.get('team');
    const made = accounts.createInvite({ role, team: team && team !== 'true' ? team : null });
    if (!made.ok) {
      console.error(`\n  ${made.reason}\n`);
      process.exit(1);
    }
    console.log(`\n  invitation for ${made.value.role}${made.value.team ? ` "${made.value.team}"` : ''}`);
    console.log(`  code:     ${made.value.code}`);
    console.log(`  expires:  ${made.value.expiresAt.slice(0, 10)}`);
    console.log(`  (hand this over; it works once)\n`);
  } finally {
    accounts.close();
  }
}

/**
 * The venue deployment: a front door, and the draw being played behind it.
 *
 * This is `tournament` with a site in front of it and accounts underneath, and
 * it is deliberately the same `runDraw` loop — so a league resumes after a
 * crash for the same reason a tournament does, which is that the next fixture
 * is the first one with no result on disk.
 *
 * Without `--name` it serves the front door and plays nothing, which is what a
 * venue wants the evening before: teams registering, pushing and checking the
 * schedule while nothing is on.
 */
async function league(flags: Map<string, string>): Promise<void> {
  const { LeagueServer } = await import('./league');
  const root = tournamentsRoot();
  const name = flags.get('name');
  const id = name && name !== 'true' ? slugifyTeam(name) : null;

  let made: Draw | null = null;
  if (id) {
    try {
      made = await loadDraw(root, id);
    } catch {
      console.error(`\n  no draw called "${id}" under ${root}` + `\n  make one:  bun run serve -- draw --name "${id}"\n`);
      process.exit(1);
    }
  }

  const refereed = (made?.refereed ?? true) && flags.get('headless') !== 'true';
  const site = siteRoot();

  // The budget, before anything is spawned. A venue that cannot honour one
  // arena at its configured grant should find out here rather than at kick-off.
  const { loadSettings } = await import('./settings');
  const { readMachine, refuseToStart, resolveBudget } = await import('./capacity');
  const { settings, sources, complaints } = loadSettings(leagueData(flags), budgetFlags(flags));
  for (const complaint of complaints) console.log(`  ${complaint}`);
  const budget = resolveBudget(settings, readMachine());
  const refusal = refuseToStart(budget);
  if (refusal) {
    console.error(`\n  ${refusal}\n  check it with:  bun run serve -- capacity\n`);
    process.exit(1);
  }

  const server = new LeagueServer({
    port: num(flags, 'port', 8080),
    dataDir: leagueData(flags),
    tournamentsDir: root,
    tournamentId: id,
    siteRoot: site,
    log: (line) => console.log(`  ${line}`),
    settings,
    settingSources: sources,
    world: {
      viewerRoot: viewerRoot(),
      refereeRoot: refereeRoot(),
      workspaceRoot: workspaceRoot(),
      workspacesDir: flags.get('workspaces-dir'),
      submissionsDir: flags.get('submissions'),
      pythonLibDir: pythonLibDir(),
      realtime: refereed,
      viewHz: num(flags, 'view-hz', 60),
      kickoffCountdown: flags.has('kickoff-countdown')
        ? num(flags, 'kickoff-countdown', KICKOFF_COUNTDOWN_SECONDS)
        : undefined,
    },
  });

  const port = await server.listen();
  console.log(`\n  RCJA Soccer Simulation — league server`);
  console.log(`  front page:  http://localhost:${port}`);
  console.log(`  watch:       http://localhost:${port}/live`);
  if (!site) console.log(`  (no site built yet — run: bun run build:site)`);
  console.log(
    `  arenas:      up to ${budget.max}` +
      (budget.set ? '' : ` (computed; this machine guarantees ${budget.guaranteed})`) +
      ` · ${budget.fixtures} for fixtures · ${budget.practice} for practice`,
  );
  for (const warning of budget.warnings) console.log(`\n  ${warning}`);
  if (made) console.log(`  playing:     ${made.name} — ${made.fixtures.length} fixtures`);
  else console.log(`  playing:     nothing — pass --name <draw> to run one`);
  if (server.accounts.empty) {
    console.log(`\n  there are no accounts yet. Make the first admin:`);
    console.log(`    bun run serve -- account --create --role admin --name "Your Name"`);
  }
  console.log(`\n  ctrl-c to stop; re-run to carry on where it stopped\n`);

  process.on('SIGINT', () => {
    void server.close();
    process.exit(0);
  });

  if (!made) return;

  const results = await runDraw(root, made, {
    // Several at once, from the budget. A fixture never queues behind a
    // rehearsal because those slots were never shared with practice.
    slots: budget.fixtures,
    // A venue's front door does not fall over because one match did.
    continueOnFailure: true,
    conditions: {
      seatCpuPercent: settings.arenas.seatCpuPercent,
      seatMemoryMb: settings.arenas.seatMemoryMb,
    },
    onFixtureStart: (fixture, played, total) => {
      console.log(`  fixture ${played + 1} of ${total}:  ${fixture.home} v ${fixture.away}`);
    },
    onFixtureDone: (fixture, result) => {
      server.closeFixture(fixture.id);
      const score = result.legs
        .map((leg) => `${leg.result.score.violet}-${leg.result.score.lime}`)
        .join(', ');
      console.log(`  played:  ${fixture.home} v ${fixture.away}  ${score}\n`);
    },
    onFixtureFailed: (fixture, error) => {
      // Left unwritten on purpose: an unfinished fixture is exactly what an
      // abandoned one looks like, and it replays as itself on the next run.
      server.closeFixture(fixture.id);
      console.log(`  could not play ${fixture.home} v ${fixture.away}: ${error.message}`);
      console.log(`  nothing was recorded; it will be played again on the next run\n`);
    },
    playLeg: async (fixture, seed, leg) => {
      // The hub plays no football. It opens an arena — a child process running
      // the same binary a team runs on a laptop — and tells it what to play;
      // the arena resolves its own lineup and spawns its own sandboxed robots.
      const arenaId = server.liveFor(fixture.id)?.arenaId ?? (await server.openFixture(fixture));
      if (made!.legs > 1) {
        console.log(`    leg ${leg + 1} of ${made!.legs}  (seed ${formatSeedValue(seed)})`);
      }
      if (refereed) {
        console.log(`    referee it at  http://localhost:${port}/a/${arenaId}/referee/`);
      }

      return server.playLeg(fixture.id, {
        teams: { violet: fixture.home, lime: fixture.away },
        seed,
        league: made!.league,
        halfSeconds: made!.halfSeconds,
        refereed,
        label: `${fixture.id} leg ${leg + 1}`,
      });
    },
  });

  console.log(`\n${formatTable(made, results)}`);
  // And then it keeps serving. A tournament is a batch job and stops when the
  // last fixture is played; a league server is a venue's front door, and the
  // moment the final ends is the moment everyone goes to look at the table.
  // Closing here took the front page, the schedule and every login down with
  // it — caught by playing the draw out rather than by any test.
  console.log(`  every fixture has been played — the site stays up until ctrl-c\n`);
}

/** The table as it stands, without playing anything. */
/**
 * What this machine can run, and what an arena really costs on it.
 *
 * Asked the week before an event, by somebody deciding how many fields to
 * promise teams — which is why the bare form is instant and needs nothing
 * running. `--measure` is the same question answered by playing rather than by
 * arithmetic, which is how every other claim in this repository is settled.
 */
async function capacity(flags: Map<string, string>): Promise<void> {
  const { loadSettings } = await import('./settings');
  const { formatCapacity, readMachine, resolveBudget } = await import('./capacity');

  const { settings, sources, complaints } = loadSettings(leagueData(flags), budgetFlags(flags));
  for (const complaint of complaints) console.log(`  ${complaint}`);

  const machine = readMachine();
  const budget = resolveBudget(settings, machine);

  let measured;
  if (flags.get('measure') === 'true' || flags.has('measure')) {
    const { measureArena } = await import('./measure');
    const seconds = num(flags, 'measure', 30);
    measured = await measureArena({
      seconds: Number.isFinite(seconds) && seconds > 1 ? seconds : 30,
      seatCpuPercent: settings.arenas.seatCpuPercent,
      seatMemoryMb: settings.arenas.seatMemoryMb,
      log: (line) => console.log(`  ${line}`),
    });
  }

  console.log(formatCapacity(machine, settings, budget, sources, measured));
}

/**
 * What is running on a league server, and stopping one of it.
 *
 * Over HTTP rather than over the data directory, because an arena is a child
 * process in the hub's memory and nothing on disk knows about it. And as its
 * own command rather than only a page on `/admin`, because the day this gets
 * asked in earnest is the day `/admin` is the thing that has gone wrong.
 *
 * The key is an ordinary admin API key from `/team/settings` — an API key
 * works anywhere a session does, which is what lets a script do what a person
 * can without inventing a second way in.
 */
async function arenasCommand(flags: Map<string, string>, args: string[]): Promise<void> {
  const base = (flags.get('url') ?? 'http://localhost:8080').replace(/\/$/, '');
  const key = flags.get('key');
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};

  const ask = async (path: string, init?: RequestInit): Promise<any> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    } catch (err) {
      console.error(`\n  no league server answering at ${base} (${(err as Error).message})\n`);
      process.exit(1);
    }
    if (res.status === 401 || res.status === 403) {
      console.error(`\n  that key cannot do this. Make one at /team/settings on an admin account, then pass --key\n`);
      process.exit(1);
    }
    return await res.json().catch(() => ({}));
  };

  const stopping = args[0] === 'stop' ? args[1] : null;
  if (args[0] === 'stop') {
    if (!stopping) {
      console.error(`\n  which one? try:  bun run serve -- arenas\n`);
      process.exit(1);
    }
    const answer = await ask(`/api/admin/arenas/${encodeURIComponent(stopping)}/stop`, { method: 'POST' });
    console.log(answer.ok ? `\n  stopped ${stopping}\n` : `\n  ${answer.reason ?? 'that did not work'}\n`);
    return;
  }

  const answer = await ask('/api/admin/arenas');
  const arenas: any[] = answer.arenas ?? [];
  const fields: any[] = (await ask('/practice')).fields ?? [];
  const guests = new Map<string, string[]>(fields.map((f: any) => [f.id, f.guests ?? []]));
  const robots = new Map<string, any[]>(fields.map((f: any) => [f.id, f.robots ?? []]));

  if (arenas.length === 0) {
    console.log(`\n  nothing running on ${base}\n`);
    return;
  }
  console.log('');
  for (const arena of arenas) {
    const age = Math.round((Date.now() - Date.parse(arena.createdAt)) / 60000);
    const seated = (robots.get(arena.id) ?? []).map((r: any) => `${r.slug}/${r.number} in ${r.seatId}`);
    console.log(`  ${arena.id}  ${arena.kind.padEnd(8)} ${arena.owner ?? '—'}  ${age}m`);
    if ((guests.get(arena.id) ?? []).length > 0) {
      console.log(`      guests: ${(guests.get(arena.id) ?? []).join(', ')}`);
    }
    for (const line of seated) console.log(`      ${line}`);
  }
  console.log(`\n  ${arenas.length} running, of ${answer.budget?.max ?? '?'}\n`);
}

/** Budget settings given on the command line, for this run only. */
function budgetFlags(flags: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  if (flags.has('arenas-max')) out.arenasMax = num(flags, 'arenas-max', 0);
  if (flags.has('concurrent-fixtures')) out.concurrentFixtures = num(flags, 'concurrent-fixtures', 0);
  if (flags.has('seat-cpu')) out.seatCpuPercent = num(flags, 'seat-cpu', 0);
  if (flags.has('seat-mem')) out.seatMemoryMb = num(flags, 'seat-mem', 0);
  if (flags.has('practice-max')) out.practiceMax = num(flags, 'practice-max', 0);
  return out;
}

async function table(flags: Map<string, string>): Promise<void> {
  const root = tournamentsRoot();
  const id = slugifyTeam(requireName(flags));
  let made: Draw;
  try {
    made = await loadDraw(root, id);
  } catch {
    console.error(`\n  no draw called "${id}" under ${root}\n`);
    process.exit(1);
  }
  console.log(`\n${formatTable(made, await loadResults(root, made))}\n`);
}

/** "1-5", "1,4,9", "7", or a mix with 0x… 64-bit seeds — a range, a list, or one. */
function parseSeeds(raw: string): SeedInput[] {
  const out: SeedInput[] = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!t) continue;
    if (!t.startsWith('0x') && t.includes('-')) {
      const [from, to] = t.split('-').map(Number);
      if (Number.isFinite(from) && Number.isFinite(to) && to! >= from!) {
        for (let s = from!; s <= to!; s++) out.push(s);
        continue;
      }
    }
    try {
      out.push(parseSeedLike(t));
    } catch {
      // Not a number or a hex seed; ignored, as a NaN token always was.
    }
  }
  return out.length > 0 ? out : DEFAULT_OPTIONS.seeds;
}

function usage(): void {
  console.log(`
  rcja-soccer-sim

    serve     run the match server and keep playing matches   [--port --half --home --away --seed --opponent --agents --fast --referee --practice-fields --team-tokens --kickoff-countdown]
    practice  open a practice field and leave it open          [--port --league --seed --ideal-sensors]
    match     play one match headless and print the result    [--half --home --away --seed --opponent]
    ladder    play every bot against every other              [--half --rounds --seed]
    bench     measure your robot program and say what is wrong

    draw        write a fixture list for a tournament          [--name --teams --legs --half --seed --headless]
    tournament  play a draw through, resumably                 [--name --headless --port --referee-token]
    table       print a tournament's table as it stands        [--name]

    league    run the venue: a front page, accounts, and a draw  [--name --port --data --headless]
    capacity  what this machine can run, and what an arena costs  [--measure --data]
    arenas    list what a league server is running, or stop one     [stop <id> --url --key]
    account   make or repair an account                          [--create --passwd --list --role --name --data]
    invite    issue a single-use registration code               [--role --team --list --data]

  --opponent puts a test robot on the lime side instead of the reference
  agent: naive-chaser, shover, chaser+camper, spinner, waller, wanderer, statue

  --team-tokens <file> hosts a browser workspace per team: a JSON object of
  "team": "secret", one line per team you have registered. Each team opens
  /workspace, pastes their secret, and edits their robot on the server — for a
  student on a school machine who cannot install Python. --team-token
  TEAM=SECRET does one team inline, for trying it out. --workspaces-dir moves
where the folders are kept (default ./workspaces). Needs bun run
   build:workspace. See docs/writing-in-a-browser.md.

  league is the tournament deployment, and serve is unchanged by it: no
  login, no front page, no database file. A league server owns accounts (in
  <data>/league.db, default ./league) and shows a front page of what is
  upcoming, on now and already played, while the football happens in the same
  match server a team runs on a laptop. Watching needs no account; entering,
  refereeing and administering do. Make the first admin with the account
  command, then hand out invite codes — an admin cannot come from a page that
  needs
  an admin to log into. See docs/running-a-league.md.

  --practice-fields lets anyone with the link open a practice field on the
  match server: POST /practice answers with a URL, and each field is its own
  child process reached back through this same port.

  --seed N         fix every seed the command uses: a decimal like 7, or a
                   64-bit seed like 0x1a2b3c4d5e6f7081. Without it, live play
                   (serve, draw) draws a fresh 64-bit seed per match, because
                   a real match should not repeat; ladder and bench keep their
                   numeric defaults, because they are measurements. The seed a
                   match actually plays is printed before kick-off, and pasting
                   it straight back in as --seed replays that exact match.

  practice opens one field that never ends: drag the robots and the ball
  where you want them, fill a seat with a pushed submission, the built-in
  agent or a program on your own laptop, and start and stop it as you like.
  Nothing is scored and nothing is written to disk.

  --agents waits for four robot programs to connect on /agent before kicking
  off, instead of playing the built-in reference team. See python/README.md.

  --referee waits for a human at /referee to kick off each half, rather than
  starting on its own; a match plays itself the rest of the way exactly as
  without the flag, but that human can pause/resume, abandon, award a
  kick-off, remove/return a robot or correct the score at any time. Prints a
  one-time token; --referee-token sets it yourself instead of a random one.
  Needs bun run build:referee. See docs/running-a-server.md.

  --kickoff-countdown N  pause each kick-off for N seconds of placed-but-not-
                         live wait (default 3 for spectated matches, 0 for
                         headless). The whistle blows when it reaches zero;
                         the referee's "Kick off now" skips it. 0 disables it.

  bench flags:
    --spawn CMD     start your robots with CMD; {url} becomes the address
    --team          violet (default), lime, or both for a mirror match
    --opponent      reference (default) or a bot name, as above
    --seeds 1-5     which matches to play: a range, a list, or one. Hex
                    64-bit seeds like 0x… are accepted as their own entry
    --half 90       seconds per half
    --ideal-sensors noise-free sensors. A diagnostic mode, not a fair one:
                    the reference team cannot score at all against a keeper
                    with exact ball data, and a seed varies a noise-free match
                    far less than a noisy one
    --json FILE     write the full numbers as JSON (- for stdout)
    --baseline FILE compare against a JSON written earlier

  tournament flags:
    --name SLUG     which tournament; the folder under tournaments/
    --teams "A,B"   entrants for a draw (default: everyone who has pushed)
    --legs 1        matches per fixture. 3 for best-of-three on recorded
                    seeds, which costs three times the match time and buys a
                    table that is not mostly one seed's luck
    --headless      on draw, make a tournament that never waits for a referee;
                    on tournament, play this run unattended whatever the draw
                    says. Without it, every fixture waits at /referee for a
                    kick-off and plays at wall-clock so a hall can watch

  A draw is written once and never rewritten, and a fixture's result is written
  only when the whole fixture is done — so ctrl-c and re-run carries on at the
  fixture that did not finish, and never counts one twice.

  Run a tournament:
    bun run serve -- draw --name state-round-1 --legs 3
    bun run serve -- tournament --name state-round-1
    bun run serve -- table --name state-round-1

  Measure a change:
    bun run bench -- --spawn "python3 python/examples/play.py --url {url}" --json before.json
    ...edit the robot...
    bun run bench -- --spawn "python3 python/examples/play.py --url {url}" --baseline before.json

  Watch a match:   bun run build:viewer && bun run serve
`);
}

const { command, flags, words } = parse(process.argv.slice(2));
switch (command) {
  case 'serve':
    await serve(flags);
    break;
  case 'practice':
    await practice(flags);
    break;
  case 'arena':
    await arena(flags);
    break;
  case 'match':
    once(flags);
    break;
  case 'ladder':
    ladder(flags);
    break;
  case 'bench':
    await bench(flags);
    break;
  case 'draw':
    await draw(flags);
    break;
  case 'tournament':
    await tournament(flags);
    break;
  case 'table':
    await table(flags);
    break;
  case 'capacity':
    await capacity(flags);
    break;
  case 'arenas':
    await arenasCommand(flags, words);
    break;
  case 'league':
    await league(flags);
    break;
  case 'account':
    await account(flags);
    break;
  case 'invite':
    await invite(flags);
    break;
  default:
    usage();
}
