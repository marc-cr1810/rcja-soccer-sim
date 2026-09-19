/**
 * What a team pushed before the push that is live now.
 *
 * The store is pure over a directory — no server, no validator, no clock it
 * does not accept — so the things worth arguing with exhaustively are argued
 * with here, and `admin-teams.test.ts` is left to test the endpoints.
 *
 * Two of these tests are about a mistake rather than a feature: the token must
 * never be copied, and the history must never be written inside `submissions/`
 * where `listEntrants` would read it as a team.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'bun:test';

import { keepPush, listPushes, prunePushes, readPush } from '../../src/match/pushes';
import { TOKEN_FILENAME } from '../../src/infra/manifest';
import { listEntrants } from '../../src/league/tournament-store';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `rcja-${prefix}-`));
  dirs.push(dir);
  return dir;
}

const MANIFEST = { team: 'ACT Robotics', robot: 1, entry: 'robot.py' } as const;

/** A robot's folder as it sits in the submissions tree: files, and a token. */
async function live(body: string, token = 'a-live-credential'): Promise<string> {
  const dir = await scratch('live');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
  await writeFile(join(dir, 'robot.py'), body);
  await writeFile(join(dir, TOKEN_FILENAME), token);
  return dir;
}

describe('keeping a push', () => {
  it('copies the files and writes what it was', async () => {
    const pushes = await scratch('pushes');
    const folder = await live('print("one")');

    const record = await keepPush(pushes, {
      folder,
      manifest: MANIFEST,
      by: { id: null, slug: 'act-robotics' },
      via: 'push',
      keep: 10,
      at: new Date('2026-09-19T01:02:03.400Z'),
    });

    expect(record.stamp).toBe('20260919T010203400Z');
    expect(record.by).toEqual({ id: null, slug: 'act-robotics' });
    expect(record.via).toBe('push');
    expect(record.entry).toBe('robot.py');

    const back = await readPush(pushes, 'ACT Robotics', 1, record.stamp);
    expect(back?.files.map((f) => f.name)).toEqual(['manifest.json', 'robot.py']);
    expect(back?.files.find((f) => f.name === 'robot.py')?.content.toString()).toBe('print("one")');
  });

  it('never copies the join token', async () => {
    const pushes = await scratch('pushes');
    const record = await keepPush(pushes, {
      folder: await live('print("one")', 'the-secret'),
      manifest: MANIFEST,
      by: { id: null, slug: 'act-robotics' },
      via: 'push',
      keep: 10,
    });

    // It is a credential, minted fresh on every push. A history of them would
    // be a pile of live keys for every push ever made.
    const names = await readdir(join(pushes, 'act-robotics', '1', record.stamp, 'files'));
    expect(names).not.toContain(TOKEN_FILENAME);
    expect(record.files.map((f) => f.name)).not.toContain(TOKEN_FILENAME);
  });

  it('lists newest first, and says who made each one', async () => {
    const pushes = await scratch('pushes');
    for (const [n, at] of [
      ['one', '2026-09-19T01:00:00.000Z'],
      ['two', '2026-09-19T02:00:00.000Z'],
      ['three', '2026-09-19T03:00:00.000Z'],
    ] as const) {
      await keepPush(pushes, {
        folder: await live(`print("${n}")`),
        manifest: MANIFEST,
        by: n === 'three' ? { id: 'acct-1', slug: 'organiser' } : { id: null, slug: 'act-robotics' },
        via: n === 'three' ? 'rollback' : 'push',
        keep: 10,
        at: new Date(at),
      });
    }

    const kept = await listPushes(pushes, 'ACT Robotics', 1);
    expect(kept).toHaveLength(3);
    expect(kept[0]!.at).toBe('2026-09-19T03:00:00.000Z');
    // The point of the browser path: an organiser's rollback is an account,
    // a team's own push is not.
    expect(kept[0]!.by.id).toBe('acct-1');
    expect(kept[0]!.via).toBe('rollback');
    expect(kept[2]!.by.id).toBeNull();
  });

  it('keeps only as many as it was told to, oldest gone first', async () => {
    const pushes = await scratch('pushes');
    for (let n = 1; n <= 11; n += 1) {
      await keepPush(pushes, {
        folder: await live(`print(${n})`),
        manifest: MANIFEST,
        by: { id: null, slug: 'act-robotics' },
        via: 'push',
        keep: 10,
        at: new Date(Date.UTC(2026, 8, 19, 0, n, 0)),
      });
    }

    const kept = await listPushes(pushes, 'ACT Robotics', 1);
    expect(kept).toHaveLength(10);
    // The eleventh is the newest and the first is the one that went.
    expect(kept[0]!.at).toBe('2026-09-19T00:11:00.000Z');
    expect(kept.map((k) => k.at)).not.toContain('2026-09-19T00:01:00.000Z');
  });

  it('skips a stamp it cannot read rather than refusing to list at all', async () => {
    const pushes = await scratch('pushes');
    const good = await keepPush(pushes, {
      folder: await live('print("good")'),
      manifest: MANIFEST,
      by: { id: null, slug: 'act-robotics' },
      via: 'push',
      keep: 10,
      at: new Date('2026-09-19T01:00:00.000Z'),
    });
    await writeFile(join(pushes, 'act-robotics', '1', '20260919T020000000Z'), 'not a directory');

    // The opposite of the rule for amendments, and right for the same reason
    // that one is: a history that refused to list itself over one bad folder
    // would be worse than useless on the day it is wanted.
    const kept = await listPushes(pushes, 'ACT Robotics', 1);
    expect(kept.map((k) => k.stamp)).toEqual([good.stamp]);
  });

  it('refuses a stamp that is not one of its own', async () => {
    const pushes = await scratch('pushes');
    await keepPush(pushes, {
      folder: await live('print("one")'),
      manifest: MANIFEST,
      by: { id: null, slug: 'act-robotics' },
      via: 'push',
      keep: 10,
    });

    // A stamp arrives from a URL. It is held to the shape this module writes.
    expect(await readPush(pushes, 'ACT Robotics', 1, '../../../etc')).toBeNull();
    expect(await readPush(pushes, 'ACT Robotics', 1, 'nope')).toBeNull();
  });

  it('has nothing to say about a robot that has never pushed', async () => {
    const pushes = await scratch('pushes');
    expect(await listPushes(pushes, 'Nobody', 2)).toEqual([]);
    await prunePushes(pushes, 'Nobody', 2, 10);
  });
});

describe('where the history is kept', () => {
  it('is not somewhere listEntrants would read it as a team', async () => {
    // The mistake this is here to catch: `listEntrants` reads every entry in
    // the submissions directory as a team slug, and `resolveLineup` hands a
    // robot folder's listing to `parseManifest`. A history folder inside
    // either is something they walk into, and the symptom arrives on a
    // competition day rather than in a test.
    const submissions = await scratch('submissions');
    const pushes = await scratch('pushes');

    await keepPush(pushes, {
      folder: await live('print("one")'),
      manifest: MANIFEST,
      by: { id: null, slug: 'act-robotics' },
      via: 'push',
      keep: 10,
    });

    expect(pushes.startsWith(submissions)).toBe(false);
    expect(await listEntrants(submissions)).toEqual([]);
  });
});
