/**
 * Where a tournament lives on disk.
 *
 *     tournaments/<slug>/draw.json          written once, never modified
 *     tournaments/<slug>/results/<id>.json  one per completed fixture
 *
 * Two files and no third. There is deliberately no index, no table file and no
 * "in progress" marker, because every one of those would be a second copy of
 * something already true on disk and a chance for the two to disagree after a
 * crash. Reading a tournament is reading the draw and listing a directory.
 *
 * A result is written whole or not at all: into a scratch directory first, then
 * renamed into place, the same move `handleSubmit` makes for a pushed
 * submission and for the same reason. A fixture interrupted halfway leaves
 * nothing behind, so it is replayed rather than half-counted.
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseManifest, slugifyTeam } from './manifest';
import type { Draw, FixtureResult } from './tournament';

export const DRAW_FILENAME = 'draw.json';
export const RESULTS_DIRNAME = 'results';

export function tournamentDir(root: string, id: string): string {
  return join(root, id);
}

/** Refuses to overwrite: a draw is the one thing in here that must not change. */
export async function saveDraw(root: string, draw: Draw): Promise<string> {
  const dir = tournamentDir(root, draw.id);
  await mkdir(join(dir, RESULTS_DIRNAME), { recursive: true });
  const path = join(dir, DRAW_FILENAME);
  await writeFile(path, JSON.stringify(draw, null, 2), { flag: 'wx' });
  return dir;
}

export async function loadDraw(root: string, id: string): Promise<Draw> {
  const path = join(tournamentDir(root, id), DRAW_FILENAME);
  return JSON.parse(await readFile(path, 'utf8')) as Draw;
}

/**
 * Every result written so far, in the draw's own fixture order.
 *
 * Order matters only for reading: the table folds to the same numbers whatever
 * order they arrive in, which is the point of deriving it.
 */
export async function loadResults(root: string, draw: Draw): Promise<FixtureResult[]> {
  const dir = join(tournamentDir(root, draw.id), RESULTS_DIRNAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const byId = new Map<string, FixtureResult>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as FixtureResult;
      byId.set(parsed.fixtureId, parsed);
    } catch {
      // A result that will not parse is a result that was never finished
      // writing. Leaving it out means its fixture is replayed, which is right.
      continue;
    }
  }
  return draw.fixtures.flatMap((f) => {
    const found = byId.get(f.id);
    return found ? [found] : [];
  });
}

export async function saveResult(root: string, draw: Draw, result: FixtureResult): Promise<void> {
  const dir = join(tournamentDir(root, draw.id), RESULTS_DIRNAME);
  await mkdir(dir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'rcja-result-'));
  try {
    const staged = join(scratch, 'result.json');
    await writeFile(staged, JSON.stringify(result, null, 2));
    const target = join(dir, `${result.fixtureId}.json`);
    try {
      await rename(staged, target);
    } catch {
      // Scratch and the tournament tree can be on different filesystems (a
      // tmpfs /tmp is common), which a plain rename cannot cross.
      await cp(staged, target);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Every team with at least one robot that would actually load into a match.
 *
 * The same three checks `resolveLineup` makes per seat — a manifest that
 * parses, a robot number matching the folder it was found in, and a token —
 * because a draw listing a team whose submission cannot load would produce a
 * fixture of four built-in agents wearing that team's name.
 */
export async function listEntrants(submissionsDir: string): Promise<string[]> {
  let teams: string[];
  try {
    teams = await readdir(submissionsDir);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const slug of teams.sort()) {
    for (const robot of [1, 2] as const) {
      const dir = join(submissionsDir, slug, String(robot));
      try {
        const raw = await readFile(join(dir, 'manifest.json'));
        const names = new Set(await readdir(dir));
        const parsed = parseManifest(raw, names);
        if (!parsed.ok || parsed.value.robot !== robot) continue;
        // The manifest's own team name, not the folder slug: that is the name
        // a lineup looks up by, and the one a scoreboard should show.
        if (slugifyTeam(parsed.value.team) !== slug) continue;
        found.push(parsed.value.team);
        break;
      } catch {
        continue;
      }
    }
  }
  return found;
}
