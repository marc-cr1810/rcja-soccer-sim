import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { referenceTeam } from '../../src/infra/reference';
import type { MatchAgents } from '../../src/match/match';
import { MatchServer } from '../../src/infra/server';
import { sandboxAvailable } from '../../src/match/sandbox';
import { resolveLineup, spawnLineup } from '../../src/accounts/lineup';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../../../../python');
const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const ready = pythonAvailable && sandboxAvailable();

const COAST_ROBOT = `
import time
from machine import Runtime
from rcja_soccer import coast

rt = Runtime.get()
while True:
    rt.sensors()
    rt.send_command(motors=coast())
    time.sleep_ms(20)
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
    const resolved = await resolveLineup(root, { violet: 'Test Team', lime: 'Lime' });
    expect(Object.keys(resolved)).toEqual(['violet-1']);
    expect(resolved['violet-1']?.manifest.entry).toBe('robot.py');
    expect(resolved['violet-1']?.token).toBe('test-token');
  });

  it('skips a submission with no token file, same as a bad manifest', async () => {
    const root = await submissionsRoot();
    await putSubmission(root, 'test-team', 1, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 1, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
    });
    const resolved = await resolveLineup(root, { violet: 'Test Team', lime: 'Lime' });
    expect(resolved).toEqual({});
  });

  it('leaves a slot unresolved when nothing was pushed for it', async () => {
    const root = await submissionsRoot();
    const resolved = await resolveLineup(root, { violet: 'Nobody', lime: 'Nobody Else' });
    expect(resolved).toEqual({});
  });

  it('does not trust a manifest whose robot number disagrees with its folder', async () => {
    const root = await submissionsRoot();
    // Manifest says robot 2 but was found under the "1" folder.
    await putSubmission(root, 'test-team', 1, {
      'manifest.json': JSON.stringify({ team: 'Test Team', robot: 2, entry: 'robot.py' }),
      'robot.py': COAST_ROBOT,
    });
    const resolved = await resolveLineup(root, { violet: 'Test Team', lime: 'Lime' });
    expect(resolved).toEqual({});
  });

  it('ignores a folder with an unparseable manifest', async () => {
    const root = await submissionsRoot();
    await putSubmission(root, 'test-team', 1, { 'manifest.json': '{not json' });
    const resolved = await resolveLineup(root, { violet: 'Test Team', lime: 'Lime' });
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

    const resolved = await resolveLineup(root, { violet: 'Test Team', lime: 'Lime' });
    expect(Object.keys(resolved).sort()).toEqual(['violet-1', 'violet-2']);

    const lineup = await spawnLineup(server, resolved, { pythonLibDir: PYTHON_LIB_DIR });
    try {
      expect(Object.keys(lineup.transports).sort()).toEqual(['violet-1', 'violet-2']);
      expect(lineup.transports['violet-1']?.connected).toBe(true);

      // The whole point: these transports play a real match, mixed with the
      // built-in agent filling the lime side nobody pushed anything for.
      const agents = {
        ...referenceTeam('violet'),
        ...referenceTeam('lime'),
      } as unknown as MatchAgents;
      const result = await server.play({
        agents,
        transports: lineup.transports,
        halfSeconds: 2,
        seed: 1,
      });
      expect(result.slots['violet-1']?.errors).toBe(0);
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
    const resolved = await resolveLineup(root, { violet: 'Crashy', lime: 'Lime' });

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
