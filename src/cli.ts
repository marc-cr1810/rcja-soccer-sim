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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
 * `--opponent` swaps the yellow side for one of the deliberately poor robots.
 * Not only for demonstrations: a waller drives itself off the field within
 * seconds, and that is the only quick way to watch a rule 5.7 stand-down
 * actually happen rather than waiting most of a match for one.
 */
function agentsFor(opponent: string | undefined): MatchAgents {
  const cyan = referenceTeam('cyan');
  if (!opponent || opponent === 'reference') {
    return { ...cyan, ...referenceTeam('yellow') } as unknown as MatchAgents;
  }
  const bot = botRoster().find((b) => b.name === opponent);
  if (!bot) {
    const names = ['reference', ...botRoster().map((b) => b.name)].join(', ');
    console.error(`  unknown opponent "${opponent}". try: ${names}`);
    process.exit(1);
  }
  const [y1, y2] = bot.make('yellow');
  return { ...cyan, 'yellow-1': y1!, 'yellow-2': y2! } as unknown as MatchAgents;
}

function viewerRoot(): string | undefined {
  const built = resolve('dist-viewer');
  return existsSync(built) ? built : undefined;
}

async function serve(flags: Map<string, string>): Promise<void> {
  const root = viewerRoot();
  const idealSensors = flags.get('noisy-sensors') !== 'true';
  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    viewerRoot: root,
    realtime: flags.get('fast') !== 'true',
    viewHz: num(flags, 'view-hz', 60),
    idealSensors,
  });
  const port = await server.listen();

  console.log(`\n  RCJA Soccer Simulation — match server`);
  console.log(`  sensors:   ${idealSensors ? 'ideal (noise-free, 24 IR, 360° camera)' : 'noisy (legacy)'}`);
  console.log(`  watch at  http://localhost:${port}`);
  if (!root) {
    console.log(`  (no viewer built yet — run: npm run build:viewer)`);
  }
  console.log(`  ctrl-c to stop\n`);

  const halfSeconds = num(flags, 'half', 300);
  const waitForAgents = flags.get('agents') === 'true';
  const teams = {
    cyan: flags.get('home') ?? 'Cyan',
    yellow: flags.get('away') ?? flags.get('opponent') ?? 'Yellow',
  };

  if (waitForAgents) {
    console.log(`  robots connect to  ws://localhost:${port}/agent`);
    console.log(`  waiting for all four…\n`);
  }

  // Keep playing. A screen in a hall should never be showing nothing, and an
  // organiser should not have to restart anything between matches.
  let seed = num(flags, 'seed', 1);
  for (;;) {
    if (waitForAgents) {
      await server.agents.whenReady();
      // Whoever connected gets to say who they are; the scoreboard is theirs.
      Object.assign(teams, server.agents.teamNames());
    }
    console.log(`  kick-off: ${teams.cyan} v ${teams.yellow}  (seed ${seed})`);
    const result = await server.play({
      agents: agentsFor(flags.get('opponent')),
      transports: waitForAgents ? server.agents.transports() : undefined,
      teams,
      halfSeconds,
      seed,
      idealSensors,
    });
    console.log(
      `  full time: ${teams.cyan} ${result.score.cyan} — ${result.score.yellow} ${teams.yellow}` +
        `   (${server.watching} watching)`,
    );
    seed++;
  }
}

function once(flags: Map<string, string>): void {
  const teams = {
    cyan: flags.get('home') ?? 'Cyan',
    yellow: flags.get('away') ?? flags.get('opponent') ?? 'Yellow',
  };
  const idealSensors = flags.get('noisy-sensors') !== 'true';
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
    `\n  cyan ${teams.cyan}  ${result.score.cyan} — ${result.score.yellow}  ${teams.yellow} yellow`,
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

function usage(): void {
  console.log(`
  rcja-soccer-sim

    serve     run the match server and keep playing matches   [--port --half --home --away --seed --opponent --agents --fast]
    match     play one match headless and print the result    [--half --home --away --seed --opponent]
    ladder    play every bot against every other              [--half --rounds --seed]

  --opponent puts a test robot on the yellow side instead of the reference
  agent: naive-chaser, shover, chaser+camper, spinner, waller, wanderer, statue

  --agents waits for four robot programs to connect on /agent before kicking
  off, instead of playing the built-in reference team. See python/README.md.

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
  default:
    usage();
}
