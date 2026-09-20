/**
 * Where a tournament lives on disk.
 *
 *     tournaments/<slug>/draw.json            written once, never modified
 *     tournaments/<slug>/results/<id>.json    one per completed fixture
 *     tournaments/<slug>/amendments/<n>.json  one per correction, appended
 *
 * Three kinds of file and no fourth. There is deliberately no index, no table
 * file and no "in progress" marker, because every one of those would be a
 * second copy of something already true on disk and a chance for the two to
 * disagree after a crash. Reading a tournament is reading the draw, listing two
 * directories and folding one over the other.
 *
 * The amendments are the same idea applied to the draw itself: `draw.json` must
 * never be rewritten, so a correction is appended beside it and the effective
 * draw is folded on every read. See `amendments.ts` for the fold.
 *
 * A result is written whole or not at all: into a scratch directory first, then
 * renamed into place, the same move `handleSubmit` makes for a pushed
 * submission and for the same reason. A fixture interrupted halfway leaves
 * nothing behind, so it is replayed rather than half-counted.
 */

import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foldTournament, parseAmendment, type Amendment, type DraftAmendment } from '../accounts/amendments';
import { parseManifest, slugifyTeam } from '../infra/manifest';
import type { Draw, FixtureResult } from './tournament';

export const DRAW_FILENAME = 'draw.json';
export const RESULTS_DIRNAME = 'results';
export const AMENDMENTS_DIRNAME = 'amendments';

export function tournamentDir(root: string, id: string): string {
  return join(root, id);
}

/** Refuses to overwrite: a draw is the one thing in here that must not change. */
export async function saveDraw(root: string, draw: Draw): Promise<string> {
  const dir = tournamentDir(root, draw.id);
  await mkdir(join(dir, RESULTS_DIRNAME), { recursive: true });
  const path = join(dir, DRAW_FILENAME);
  if (await Bun.file(path).exists()) {
    const err = new Error(`EEXIST: file already exists, open '${path}'`);
    (err as NodeJS.ErrnoException).code = 'EEXIST';
    throw err;
  }
  await Bun.write(path, JSON.stringify(draw, null, 2));
  return dir;
}

export async function loadDraw(root: string, id: string): Promise<Draw> {
  const path = join(tournamentDir(root, id), DRAW_FILENAME);
  return (await Bun.file(path).json()) as Draw;
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
      const parsed = (await Bun.file(join(dir, name)).json()) as FixtureResult;
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
    await Bun.write(staged, JSON.stringify(result, null, 2));
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
 * Every correction made to this draw, in the order they were made.
 *
 * **A record that will not parse throws**, which is the opposite of the rule
 * two functions up and deliberately so: a half-written result means a fixture
 * never finished and is replayed, whereas quietly skipping an amendment would
 * un-void a fixture somebody voided. A file that cannot be read has to be a
 * noise, not a silence.
 */
export async function loadAmendments(root: string, id: string): Promise<Amendment[]> {
  const dir = join(tournamentDir(root, id), AMENDMENTS_DIRNAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const found: Amendment[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = await Bun.file(join(dir, name)).json();
    } catch (error) {
      throw new Error(`${AMENDMENTS_DIRNAME}/${name} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = parseAmendment(raw);
    if (!parsed.ok) throw new Error(`${AMENDMENTS_DIRNAME}/${name}: ${parsed.reason}`);
    found.push(parsed.value);
  }
  // By the number inside the record rather than by filename, so a record's own
  // sequence is what orders it however it came to be named.
  return found.sort((a, b) => a.n - b.n);
}

/** `0001.json`, `0012.json` — sortable as text, readable as a number. */
function amendmentFilename(n: number): string {
  return `${String(n).padStart(4, '0')}.json`;
}

/**
 * Append one correction, and say which number it got.
 *
 * Written with an exclusive create rather than a check followed by a write:
 * two organisers pressing a button at the same moment must get 0007 and 0008,
 * not one overwriting the other. `n` is carried inside the record as well as in
 * the name, so a file copied or renamed by hand still knows its own place.
 */
export async function appendAmendment(
  root: string,
  id: string,
  record: DraftAmendment,
): Promise<Amendment> {
  const dir = join(tournamentDir(root, id), AMENDMENTS_DIRNAME);
  await mkdir(dir, { recursive: true });
  const existing = await loadAmendments(root, id);
  let n = existing.reduce((highest, one) => Math.max(highest, one.n), 0) + 1;

  for (;;) {
    const amendment = { ...record, n } as Amendment;
    try {
      await writeFile(join(dir, amendmentFilename(n)), JSON.stringify(amendment, null, 2), {
        flag: 'wx',
      });
      return amendment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      n += 1;
    }
  }
}

/**
 * A tournament as it actually stands: the draw, folded with its corrections.
 *
 * The one call every reader makes. Because the fold returns a plain `Draw` and
 * plain results, everything downstream — `deriveTable`, `nextFixture`, the
 * front page, a referee's list — is amendment-aware without knowing it.
 */
export async function loadTournament(
  root: string,
  id: string,
): Promise<{ draw: Draw; results: FixtureResult[]; amendments: Amendment[] }> {
  const raw = await loadDraw(root, id);
  const amendments = await loadAmendments(root, id);
  const { draw, results } = foldTournament(raw, await loadResults(root, raw), amendments);
  return { draw, results, amendments };
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
        const raw = Buffer.from(await Bun.file(join(dir, 'manifest.json')).arrayBuffer());
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
