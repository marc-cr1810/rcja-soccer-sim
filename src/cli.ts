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
  const [command = 'serve', ...rest] = argv;
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
 * Two reference teams, for a demonstration match.
 *
 * Until submitted programs can be loaded, this is what there is to watch — and
 * it is also what an organiser wants on the screen while the hall fills up.
 */
function demoAgents(): MatchAgents {
  return {
    ...referenceTeam('cyan'),
    ...referenceTeam('yellow'),
  } as unknown as MatchAgents;
}

function viewerRoot(): string | undefined {
  const built = resolve('dist-viewer');
  return existsSync(built) ? built : undefined;
}

async function serve(flags: Map<string, string>): Promise<void> {
  const root = viewerRoot();
  const server = new MatchServer({
    port: num(flags, 'port', 8080),
    viewerRoot: root,
    realtime: flags.get('fast') !== 'true',
  });
  const port = await server.listen();

  console.log(`\n  RCJA Soccer Simulation — match server`);
  console.log(`  watch at  http://localhost:${port}`);
  if (!root) {
    console.log(`  (no viewer built yet — run: npm run build:viewer)`);
  }
  console.log(`  ctrl-c to stop\n`);

  const halfSeconds = num(flags, 'half', 300);
  const teams = {
    cyan: flags.get('home') ?? 'Cyan',
    yellow: flags.get('away') ?? 'Yellow',
  };

  // Keep playing. A screen in a hall should never be showing nothing, and an
  // organiser should not have to restart anything between matches.
  let seed = num(flags, 'seed', 1);
  for (;;) {
    console.log(`  kick-off: ${teams.cyan} v ${teams.yellow}  (seed ${seed})`);
    const result = await server.play({
      agents: demoAgents(),
      teams,
      halfSeconds,
      seed,
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
    yellow: flags.get('away') ?? 'Yellow',
  };
  const started = Date.now();
  const match = new Match({
    agents: demoAgents(),
    teams,
    halfSeconds: num(flags, 'half', 300),
    seed: num(flags, 'seed', 1),
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

    serve     run the match server and keep playing matches   [--port --half --home --away --seed --fast]
    match     play one match headless and print the result    [--half --home --away --seed]
    ladder    play every bot against every other              [--half --rounds --seed]

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
