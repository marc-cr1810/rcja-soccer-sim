/**
 * A team's robot code, kept on the venue server and edited from a browser.
 *
 * The point of this is a student on a school Chromebook who cannot install
 * Python, cannot install an editor, and cannot run a server. Everything they
 * need is already on the venue's machine: CPython, the sandbox, the simulator,
 * the practice fields. What was missing was somewhere to put their code and a
 * way to type into it.
 *
 * **A workspace is a folder, and nothing else.** Same shape as a submission —
 * a `manifest.json` and some flat `.py` files — stored at
 * `<dir>/<team>/<robot>/`. There is no database, no metadata file and no
 * per-team record: the files on disk *are* the state, the way a tournament is
 * its draw plus whichever results exist. That is what makes submitting a
 * workspace a copy through the existing validator rather than a conversion,
 * and what lets a venue admin fix a team's code with an ordinary text editor
 * when something goes wrong at eleven at night.
 *
 * **Editing is not submitting.** Nothing here validates, sandboxes or runs
 * anything — a workspace holds whatever the student last typed, including
 * code that does not parse, because an editor that refused to save broken code
 * would be an editor you cannot use. Validation happens at the moment they
 * push, which is exactly where it happens for a team on a laptop.
 *
 * Identity is a hand-issued token, matching Phase 1's push credential and
 * Phase 2's referee one: a secret per team, created by the admin running the
 * venue. Registration and real accounts are Phase 6's job.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fail, ok, slugifyTeam, type Result } from './manifest';

/** Which robot of the two a folder is for. A team submits each separately. */
export type RobotNumber = 1 | 2;

/**
 * What a workspace filename may be.
 *
 * The same rule a push is held to, and for the same reason: this becomes a
 * path on the venue's disk. No subdirectories, because the submission format
 * has none.
 */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Only these ever belong in a robot folder. */
const ALLOWED_EXTENSIONS = ['.py', '.json'];

/** Generous for hand-written Python, small enough that nobody stores a dataset. */
export const MAX_FILE_BYTES = 256 * 1024;
/** A flat folder of a robot's code. Well past a manifest plus a handful of modules. */
export const MAX_FILES = 32;

export interface WorkspaceOptions {
  /** Where team folders live. Defaults to ./workspaces alongside ./submissions. */
  dir: string;
  /**
   * Hand-issued credentials, token to team name.
   *
   * Keyed by token rather than by team because that is the direction every
   * lookup goes: a request presents a secret and the server has to decide who
   * that is. Storing it the other way round would mean scanning every team on
   * every request.
   */
  tokens: ReadonlyMap<string, string>;
}

export interface WorkspaceFile {
  name: string;
  content: string;
}

export class WorkspaceStore {
  private readonly dir: string;
  private readonly tokens: ReadonlyMap<string, string>;

  constructor(opts: WorkspaceOptions) {
    this.dir = opts.dir;
    this.tokens = opts.tokens;
  }

  /** Whether any team is configured at all. */
  get enabled(): boolean {
    return this.tokens.size > 0;
  }

  /** The team a token belongs to, or null if it belongs to nobody. */
  teamFor(token: string): string | null {
    if (!token) return null;
    return this.tokens.get(token) ?? null;
  }

  /** Where one robot's folder lives. */
  private folder(team: string, robot: RobotNumber): string {
    return join(this.dir, slugifyTeam(team), String(robot));
  }

  /**
   * Every file in a robot's folder.
   *
   * An empty folder and a folder that has never existed are the same answer,
   * deliberately: a team logging in for the first time should see an empty
   * workspace rather than an error about a directory.
   */
  async read(team: string, robot: RobotNumber): Promise<WorkspaceFile[]> {
    const dir = this.folder(team, robot);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }

    const files: WorkspaceFile[] = [];
    for (const name of names.sort()) {
      if (!SAFE_FILENAME.test(name)) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        files.push({ name, content: await readFile(path, 'utf8') });
      } catch {
        // Vanished between the listing and the read. Not this request's problem.
      }
    }
    return files;
  }

  /** Save one file, creating the folder if this is the team's first edit. */
  async write(
    team: string,
    robot: RobotNumber,
    name: string,
    content: string,
  ): Promise<Result<WorkspaceFile>> {
    const checked = checkName(name);
    if (!checked.ok) return checked;

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      return fail(`"${name}" is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB`);
    }

    const dir = this.folder(team, robot);
    const existing = await this.read(team, robot);
    if (existing.length >= MAX_FILES && !existing.some((f) => f.name === name)) {
      return fail(`a robot folder holds at most ${MAX_FILES} files`);
    }

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content, 'utf8');
    return ok({ name, content });
  }

  /** Delete one file. Deleting something that is not there is not an error. */
  async remove(team: string, robot: RobotNumber, name: string): Promise<Result<null>> {
    const checked = checkName(name);
    if (!checked.ok) return checked;
    await rm(join(this.folder(team, robot), name), { force: true });
    return ok(null);
  }

  /**
   * Put a starter robot in an empty folder.
   *
   * A blank editor is a worse first experience than a robot that already
   * drives at the ball: the student's first act should be changing something
   * and seeing what happens, not working out what a manifest is from a blank
   * page. Only ever fills a folder that is empty, so it cannot overwrite
   * anybody's work.
   */
  async seed(team: string, robot: RobotNumber): Promise<WorkspaceFile[]> {
    const existing = await this.read(team, robot);
    if (existing.length > 0) return existing;

    await this.write(team, robot, 'manifest.json', starterManifest(team, robot));
    await this.write(team, robot, 'robot.py', STARTER_ROBOT);
    return this.read(team, robot);
  }

  /**
   * The folder as a push would carry it: filename to base64.
   *
   * The same shape `POST /submit` already takes, so submitting a workspace is
   * handing the existing endpoint what it already understands rather than
   * teaching it a second format.
   */
  async asPush(team: string, robot: RobotNumber): Promise<Record<string, string>> {
    const files = await this.read(team, robot);
    const push: Record<string, string> = {};
    for (const file of files) {
      push[file.name] = Buffer.from(file.content, 'utf8').toString('base64');
    }
    return push;
  }
}

function checkName(name: string): Result<null> {
  if (!SAFE_FILENAME.test(name)) {
    return fail(
      `"${name}" is not a usable filename — letters, digits, ".", "_" and "-" only, and no subdirectories`,
    );
  }
  if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return fail(`"${name}" must end in ${ALLOWED_EXTENSIONS.join(' or ')}`);
  }
  return ok(null);
}

function starterManifest(team: string, robot: RobotNumber): string {
  return `${JSON.stringify({ team, robot, entry: 'robot.py' }, null, 2)}\n`;
}

/**
 * The robot a team starts with.
 *
 * Drives at the ball and nothing else. It is deliberately not good — beating
 * it should be the first afternoon's work — but it is complete, legal and
 * runnable, so the first thing a student does is change a number and watch
 * what that did.
 */
const STARTER_ROBOT = `"""Our robot."""

import argparse

from rcja_soccer import Robot, drive

parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet", choices=["violet", "lime"])
parser.add_argument("--number", type=int, default=1, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()

robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)


@robot.tick
def think(s, me):
    # s is what the sensors report. me is somewhere to remember things
    # between ticks - this runs fifty times a second.
    if s.ball is None:
        # The infrared ring cannot see the ball. Sit still rather than guess.
        return robot.coast()

    # Drive straight at it, and run the dribbler so it sticks.
    return robot.motors(drive(bearing=s.ball.bearing, speed=0.8), dribbler=1.0)


robot.run(url=args.url)
`;
