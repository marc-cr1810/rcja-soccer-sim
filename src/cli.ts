/**
 * Starting a match, or a tournament, and putting it on a screen.
 *
 * Kept deliberately blunt. The test for this is whether a state coordinator who
 * does not write software can get a match on the hall screen in ten minutes,
 * so there is one command, it prints a URL, and the defaults are the ones an
 * event actually wants.
 */

import { MatchServer } from './server';
import { Match, type MatchAgents } from './match';
import { referenceTeam } from './reference';
import { runLadder, formatLadder, type Entry } from './ladder';
import { ReferenceAgent } from './reference';
import { botRoster } from './bots';
import { resolveLineup, spawnLineup, type SpawnedLineup } from './lineup';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DEFAULT_OPTIONS, formatBench, runBench, type BenchResult } from './bench';

interface Args {
  command: string;
  flags: Map<string, string>;
}

function parse(argv: string[]): Args {
  let command = 'serve';
  const rest = [...argv];
  if (rest.length > 0 && !rest[0]!.startsWith('--')) {
    command = rest.shift()!;
  }
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
  return { command, flags };
}

function num(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
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

function viewerRoot(): string | undefined {
  const built = resolve('dist-viewer');
  return existsSync(built) ? built : undefined;
}

function refereeRoot(): string | undefined {
  const built = resolve('dist-referee');
  return existsSync(built) ? built : undefined;
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
  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    viewerRoot: root,
    refereeRoot: refRoot,
    refereeToken,
    realtime: flags.get('fast') !== 'true',
    viewHz: num(flags, 'view-hz', 60),
    idealSensors,
    pythonLibDir: pythonLibDir(),
  });
  const port = await server.listen();

  console.log(`\n  RCJA Soccer Simulation — match server`);
  console.log(`  sensors:   ${idealSensors ? 'ideal — noise-free, and not a mode to read a result from' : 'realistic (noise, drift, camera latency)'}`);
  console.log(`  watch at  http://localhost:${port}`);
  if (!root) {
    console.log(`  (no viewer built yet — run: npm run build:viewer)`);
  }
  if (refereed) {
    console.log(`  referee console:  http://localhost:${port}/referee`);
    console.log(`  referee token:    ${refereeToken}`);
    console.log(`  (hand this to the referee — it is not shown again)`);
    if (!refRoot) console.log(`  (no referee console built yet — run: npm run build:referee)`);
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
    process.exit(0);
  });

  // Keep playing. A screen in a hall should never be showing nothing, and an
  // organiser should not have to restart anything between matches.
  let seed = num(flags, 'seed', 1);
  for (;;) {
    if (waitForAgents) {
      await server.agents.whenReady();
      // Whoever connected gets to say who they are; the scoreboard is theirs.
      Object.assign(teams, server.agents.teamNames());
    }
    console.log(
      refereed
        ? `  ready: ${teams.violet} v ${teams.lime}  (seed ${seed}) — waiting for the referee to kick off`
        : `  kick-off: ${teams.violet} v ${teams.lime}  (seed ${seed})`,
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
    seed++;
  }
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
    seed: num(flags, 'seed', 1),
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
        seed: num(flags, 'seed', 1),
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

/** "1-5", "1,4,9" or "7" - a range, a list, or one. */
function parseSeeds(raw: string): number[] {
  if (raw.includes('-')) {
    const [from, to] = raw.split('-').map(Number);
    if (Number.isFinite(from) && Number.isFinite(to) && to! >= from!) {
      return Array.from({ length: to! - from! + 1 }, (_, i) => from! + i);
    }
  }
  const list = raw.split(',').map(Number).filter(Number.isFinite);
  return list.length > 0 ? list : DEFAULT_OPTIONS.seeds;
}

function usage(): void {
  console.log(`
  rcja-soccer-sim

    serve     run the match server and keep playing matches   [--port --half --home --away --seed --opponent --agents --fast --referee]
    match     play one match headless and print the result    [--half --home --away --seed --opponent]
    ladder    play every bot against every other              [--half --rounds --seed]
    bench     measure your robot program and say what is wrong

  --opponent puts a test robot on the lime side instead of the reference
  agent: naive-chaser, shover, chaser+camper, spinner, waller, wanderer, statue

  --agents waits for four robot programs to connect on /agent before kicking
  off, instead of playing the built-in reference team. See python/README.md.

  --referee waits for a human at /referee to kick off each half, rather than
  starting on its own; a match plays itself the rest of the way exactly as
  without the flag, but that human can pause/resume, abandon, award a
  kick-off, remove/return a robot or correct the score at any time. Prints a
  one-time token; --referee-token sets it yourself instead of a random one.
  Needs npm run build:referee. See docs/running-a-server.md.

  bench flags:
    --spawn CMD     start your robots with CMD; {url} becomes the address
    --team          violet (default), lime, or both for a mirror match
    --opponent      reference (default) or a bot name, as above
    --seeds 1-5     which matches to play: a range, a list, or one
    --half 90       seconds per half
    --ideal-sensors noise-free sensors. A diagnostic mode, not a fair one:
                    the reference team cannot score at all against a keeper
                    with exact ball data, and a seed varies a noise-free match
                    far less than a noisy one
    --json FILE     write the full numbers as JSON (- for stdout)
    --baseline FILE compare against a JSON written earlier

  Measure a change:
    npm run bench -- --spawn "python3 python/examples/play.py --url {url}" --json before.json
    ...edit the robot...
    npm run bench -- --spawn "python3 python/examples/play.py --url {url}" --baseline before.json

  Watch a match:   npm run build:viewer && npm run serve
`);
}

const { command, flags } = parse(process.argv.slice(2));
switch (command) {
  case 'serve':
    await serve(flags);
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
  default:
    usage();
}
