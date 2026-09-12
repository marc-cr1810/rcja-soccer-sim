import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { referenceTeam } from './reference';
import type { MatchAgents } from './match';
import { MatchServer } from './server';
import { sandboxAvailable } from './sandbox';
import { resolveLineup, spawnLineup } from './lineup';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../python');
const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const ready = pythonAvailable && sandboxAvailable();

const COAST_ROBOT = `
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--team", default="cyan")
parser.add_argument("--number", type=int, default=1)
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()

from rcja_soccer import Robot

robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)

@robot.tick
def think(s, me):
    return robot.coast()

robot.run(args.url)
`;

async function submissionsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rcja-lineup-test-'));
}

async function putSubmission(
  root: string,
  slug: string,
  robot: number,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(root, slug, String(robot));
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

describe('resolveLineup', () => {
  it('finds a valid submission for the team named on that side', async () => {
    const root = await submissionsRoot();
    await putSubmission(root, 'test-team', 1, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 1, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
      token: 'test-token',
    });
    const resolved = await resolveLineup(root, { cyan: 'Test Team', yellow: 'Yellow' });
    expect(Object.keys(resolved)).toEqual(['cyan-1']);
    expect(resolved['cyan-1']?.manifest.entry).toBe('robot.py');
    expect(resolved['cyan-1']?.token).toBe('test-token');
  });

  it('skips a submission with no token file, same as a bad manifest', async () => {
    const root = await submissionsRoot();
    await putSubmission(root, 'test-team', 1, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 1, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
    });
    const resolved = await resolveLineup(root, { cyan: 'Test Team', yellow: 'Yellow' });
    expect(resolved).toEqual({});
  });

  it('leaves a slot unresolved when nothing was pushed for it', async () => {
    const root = await submissionsRoot();
    const resolved = await resolveLineup(root, { cyan: 'Nobody', yellow: 'Nobody Else' });
    expect(resolved).toEqual({});
  });

  it('does not trust a manifest whose robot number disagrees with its folder', async () => {
    const root = await submissionsRoot();
    // Manifest says robot 2 but was found under the "1" folder.
    await putSubmission(root, 'test-team', 1, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 2, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
    });
    const resolved = await resolveLineup(root, { cyan: 'Test Team', yellow: 'Yellow' });
    expect(resolved).toEqual({});
  });

  it('ignores a folder with an unparseable manifest', async () => {
    const root = await submissionsRoot();
    await putSubmission(root, 'test-team', 1, { 'manifest.json': '{not json' });
    const resolved = await resolveLineup(root, { cyan: 'Test Team', yellow: 'Yellow' });
    expect(resolved).toEqual({});
  });
});

describe.skipIf(!ready)('spawnLineup', () => {
  const servers: MatchServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function start(): Promise<MatchServer> {
    const server = new MatchServer({ port: 0, realtime: false, pythonLibDir: PYTHON_LIB_DIR });
    servers.push(server);
    await server.listen();
    return server;
  }

  it('connects a resolved submission and hands back its transports', async () => {
    const server = await start();
    const root = await submissionsRoot();
    await putSubmission(root, 'test-team', 1, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 1, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
      token: 'test-token-1',
    });
    await putSubmission(root, 'test-team', 2, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 2, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
      token: 'test-token-2',
    });

    const resolved = await resolveLineup(root, { cyan: 'Test Team', yellow: 'Yellow' });
    expect(Object.keys(resolved).sort()).toEqual(['cyan-1', 'cyan-2']);

    const lineup = await spawnLineup(server, resolved, { pythonLibDir: PYTHON_LIB_DIR });
    try {
      expect(Object.keys(lineup.transports).sort()).toEqual(['cyan-1', 'cyan-2']);
      expect(lineup.transports['cyan-1']?.connected).toBe(true);

      // The whole point: these transports play a real match, mixed with the
      // built-in agent filling the yellow side nobody pushed anything for.
      const agents = {
        ...referenceTeam('cyan'),
        ...referenceTeam('yellow'),
      } as unknown as MatchAgents;
      const result = await server.play({
        agents,
        transports: lineup.transports,
        halfSeconds: 2,
        seed: 1,
      });
      expect(result.slots['cyan-1']?.errors).toBe(0);
    } finally {
      lineup.stop();
    }
  }, 20000);

  it('gives up respawning a slot after the cap, and says so', async () => {
    const server = await start();
    const root = await submissionsRoot();
    await putSubmission(root, 'crashy', 1, {
      'manifest.json': JSON.stringify({ team: 'Crashy', robot: 1, entry: 'robot.py' }),
      'robot.py': 'import sys\nsys.exit(1)\n',
      token: 'test-token',
    });
    const resolved = await resolveLineup(root, { cyan: 'Crashy', yellow: 'Yellow' });

    const logs: string[] = [];
    await expect(
      spawnLineup(
        server,
        resolved,
        { pythonLibDir: PYTHON_LIB_DIR, connectTimeoutSeconds: 3, maxRespawns: 2 },
        (line) => logs.push(line),
      ),
    ).rejects.toThrow();

    expect(logs.some((l) => l.includes('not respawning again'))).toBe(true);
  }, 15000);
});
