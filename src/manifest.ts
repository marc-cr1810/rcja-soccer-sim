/**
 * A team folder's manifest.
 *
 * A push is for one robot, not a team's whole roster: the two robots on a
 * side are routinely written by two different students on two different
 * laptops, and neither should have to wait on the other before they can
 * submit. So a folder names exactly one robot, and a team arrives at the
 * server as two independent pushes over however long that takes.
 */

import { extname } from 'node:path';

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(reason: string): Result<T> {
  return { ok: false, reason };
}

export interface Manifest {
  /** The organisation's own name, for the scoreboard and the storage path. */
  team: string;
  robot: 1 | 2;
  /** The .py file this robot runs, relative to the folder root. */
  entry: string;
}

/**
 * Short enough to read on a scoreboard and safe enough to become a directory
 * name: letters, digits, spaces, "-" and "_" only.
 */
const TEAM_NAME = /^[A-Za-z0-9 _-]{1,40}$/;

/** No subdirectories in this slice — a flat folder is all the format allows. */
const ENTRY_FILENAME = /^[A-Za-z0-9_-]+\.py$/;

/**
 * Parse and validate `manifest.json`.
 *
 * Takes the raw bytes (or `undefined` if no such file was pushed) and the set
 * of every filename that came with it, so "entry names a file that exists"
 * can be checked without the caller handing over file contents it does not
 * otherwise need.
 */
export function parseManifest(
  raw: Buffer | undefined,
  availableFiles: ReadonlySet<string>,
): Result<Manifest> {
  if (!raw) return fail('no manifest.json in the push');

  let data: unknown;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail('manifest.json is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fail('manifest.json must be a JSON object');
  }
  const d = data as Record<string, unknown>;

  if (typeof d.team !== 'string' || !TEAM_NAME.test(d.team.trim())) {
    return fail(
      'manifest.json "team" must be a name of up to 40 letters, digits, spaces, "-" or "_"',
    );
  }
  if (d.robot !== 1 && d.robot !== 2) {
    return fail('manifest.json "robot" must be 1 or 2');
  }
  if (typeof d.entry !== 'string' || !ENTRY_FILENAME.test(d.entry) || extname(d.entry) !== '.py') {
    return fail('manifest.json "entry" must name a .py file in this same folder, with no subdirectory');
  }
  if (!availableFiles.has(d.entry)) {
    return fail(`manifest.json names "${d.entry}" as the entry point, but no such file was pushed`);
  }

  return ok({ team: d.team.trim(), robot: d.robot, entry: d.entry });
}

/** A safe, lowercase directory name for a team — never empty. */
export function slugifyTeam(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'team';
}
