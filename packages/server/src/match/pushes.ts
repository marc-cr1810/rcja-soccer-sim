/**
 * What a team pushed before the push that is live now.
 *
 * Until this existed, [`TeamApi.keep`](team-api.ts) removed a robot's folder
 * and renamed the new one into its place, so **the previous code was gone the
 * moment the next push landed**. That is fine for playing football and useless
 * the moment somebody uploads the wrong file twenty minutes before their match,
 * which is the failure Phase 12's gate names.
 *
 * Two decisions are worth stating where the code is, because both are about
 * things going wrong rather than about the feature:
 *
 * - **This tree is not inside `submissions/`.** That tree is walked by
 *   [`listEntrants`](tournament-store.ts), which treats every entry in it as a
 *   team slug, and by [`resolveLineup`](lineup.ts), which hands `readdir` of a
 *   robot's folder to `parseManifest` as the set of files that exist. A history
 *   directory in either place would be a folder they walk into, and the symptom
 *   would arrive on a competition day rather than in a test.
 * - **The join token is never copied.** It is a credential, minted fresh on
 *   every successful push, and a history that stored them would be a pile of
 *   live credentials for every push ever made. A rollback is an ordinary push,
 *   so it mints its own.
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { slugifyTeam, TOKEN_FILENAME, type Manifest } from '../infra/manifest';

/**
 * Who made a push, in the shape Slice D's amendments already use.
 *
 * `id` is null for a push made with a key rather than through an account, so
 * the difference between "a team's own push" and "an organiser did this" is
 * readable from the record rather than inferred from its timing.
 */
export interface PushBy {
  id: string | null;
  slug: string;
}

/** Which door a push came through. */
export type PushVia = 'push' | 'workspace' | 'rollback';

export interface PushRecord {
  /** The directory name, which is also the sort key. */
  stamp: string;
  at: string;
  by: PushBy;
  via: PushVia;
  /** The manifest's own team name, not the slug — that is what a table shows. */
  team: string;
  robot: 1 | 2;
  entry: string;
  files: { name: string; bytes: number }[];
}

/**
 * An instant as a directory name.
 *
 * ISO with the punctuation taken out, so the directory listing is already in
 * chronological order and the history needs no index file to be read in the
 * right sequence — the same reason a draw's amendments are numbered.
 */
export function stampFor(at: Date = new Date()): string {
  return at.toISOString().replace(/[-:.]/g, '');
}

function robotDir(pushesDir: string, team: string, robot: 1 | 2): string {
  return join(pushesDir, slugifyTeam(team), String(robot));
}

/**
 * Copy a folder that has just been kept, and prune back to the cap.
 *
 * Returns the record it wrote. Throws only on a genuine disk failure — the
 * caller decides whether that is worth failing a push over, and
 * [`TeamApi.keep`](team-api.ts) decides that it is not.
 */
export async function keepPush(
  pushesDir: string,
  opts: {
    /** The folder as it now sits in the submissions tree. */
    folder: string;
    manifest: Manifest;
    by: PushBy;
    via: PushVia;
    keep: number;
    at?: Date;
  },
): Promise<PushRecord> {
  const at = opts.at ?? new Date();
  const dir = robotDir(pushesDir, opts.manifest.team, opts.manifest.robot);
  const stamp = stampFor(at);
  const into = join(dir, stamp);

  await mkdir(join(into, 'files'), { recursive: true });

  const files: { name: string; bytes: number }[] = [];
  for (const name of (await readdir(opts.folder)).sort()) {
    // The one file that is deliberately not archived. See the note at the top.
    if (name === TOKEN_FILENAME) continue;
    const from = join(opts.folder, name);
    const info = await stat(from);
    if (!info.isFile()) continue;
    await cp(from, join(into, 'files', name));
    files.push({ name, bytes: info.size });
  }

  const record: PushRecord = {
    stamp,
    at: at.toISOString(),
    by: opts.by,
    via: opts.via,
    team: opts.manifest.team,
    robot: opts.manifest.robot,
    entry: opts.manifest.entry,
    files,
  };
  await writeFile(join(into, 'push.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  await prunePushes(pushesDir, opts.manifest.team, opts.manifest.robot, opts.keep);
  return record;
}

/**
 * Every kept push for one robot, newest first.
 *
 * A stamp whose `push.json` cannot be read is **skipped rather than thrown
 * over**, which is the opposite of the rule for amendments and right for the
 * same reason that one is: a missing amendment would silently un-void a
 * fixture, while a missing archive entry costs nothing but that one rollback.
 * A history that refused to list itself because of one bad folder would be
 * worse than useless on the day it is needed.
 */
export async function listPushes(pushesDir: string, team: string, robot: 1 | 2): Promise<PushRecord[]> {
  const dir = robotDir(pushesDir, team, robot);
  let stamps: string[];
  try {
    stamps = await readdir(dir);
  } catch {
    return [];
  }

  const out: PushRecord[] = [];
  for (const stamp of stamps.sort().reverse()) {
    try {
      const raw = await readFile(join(dir, stamp, 'push.json'), 'utf8');
      const record = JSON.parse(raw) as PushRecord;
      out.push({ ...record, stamp });
    } catch {
      continue;
    }
  }
  return out;
}

/** One kept push with its files, or `null` if there is no such stamp. */
export async function readPush(
  pushesDir: string,
  team: string,
  robot: 1 | 2,
  stamp: string,
): Promise<{ record: PushRecord; files: { name: string; content: Buffer }[] } | null> {
  // A stamp arrives from a URL, so it is held to the shape this module writes
  // rather than trusted as a path fragment.
  if (!/^[0-9TZ]+$/.test(stamp)) return null;
  const into = join(robotDir(pushesDir, team, robot), stamp);

  let record: PushRecord;
  try {
    record = JSON.parse(await readFile(join(into, 'push.json'), 'utf8')) as PushRecord;
  } catch {
    return null;
  }

  const files: { name: string; content: Buffer }[] = [];
  try {
    for (const name of (await readdir(join(into, 'files'))).sort()) {
      files.push({ name, content: await readFile(join(into, 'files', name)) });
    }
  } catch {
    return null;
  }

  return { record: { ...record, stamp }, files };
}

/** Drop the oldest stamps until only `keep` remain. */
export async function prunePushes(pushesDir: string, team: string, robot: 1 | 2, keep: number): Promise<void> {
  const dir = robotDir(pushesDir, team, robot);
  let stamps: string[];
  try {
    stamps = await readdir(dir);
  } catch {
    return;
  }
  const doomed = stamps.sort().slice(0, Math.max(0, stamps.length - Math.max(1, keep)));
  for (const stamp of doomed) {
    await rm(join(dir, stamp), { recursive: true, force: true }).catch(() => {});
  }
}
