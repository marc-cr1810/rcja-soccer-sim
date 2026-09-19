/**
 * A team's two doors: pushing code, and editing it in a browser.
 *
 * Neither of these is football. A push is a validator over a folder; a
 * workspace is a directory a student types into. They lived inside
 * `MatchServer` because until now every deployment that had them also had a
 * world — and Phase 7 breaks that: **the hub plays no football at all**, and
 * yet a team still pushes to it and still edits there. Keeping these in the
 * match server would have meant the hub holding a world it never plays just to
 * reach two handlers, which is the kind of almost-true that turns into a
 * second copy six months later.
 *
 * So they are here, mounted by whoever needs them: a match server on a laptop
 * (unchanged, still one process, still no accounts) and a league server (no
 * world, no gateway, no viewer). Both get exactly the same handlers, which is
 * what keeps Phase 5's rule true — **one way in, not two**: a workspace pushed
 * from a browser and a folder pushed with `python/submit.py` go through the
 * same `validateSubmission`, land in the same place on disk, and get the same
 * join token minted beside them.
 *
 * Two rules from earlier phases are load-bearing here and are worth restating
 * where the code is:
 *
 * - **The team comes from the credential, never from the request.** A client
 *   that can name its own team can be any team. So `manifest.json` — which is
 *   the student's file and can say anything — is held to whoever the
 *   `Authority` says is asking, and a mismatch is refused rather than obeyed.
 * - **A push that fails changes nothing.** Everything is written to a scratch
 *   directory and validated there; only a pass is moved into the submissions
 *   tree, so a rejected push can never clobber the last-good code for that
 *   robot. Whatever passed last is still what will play.
 */

import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Authority } from './authority';
import { slugifyTeam, TOKEN_FILENAME, type Manifest } from './manifest';
import { keepPush, type PushBy, type PushVia } from './pushes';
import { validateSubmission } from './submission';
import type { RobotNumber, WorkspaceStore } from './workspace';
import { DeleteBodySchema, SaveBodySchema } from './api/schemas';
import { readJsonBody, validateBody } from './api/validate';

/** A team folder is a few small Python files; anything larger is a mistake. */
const MAX_SUBMIT_BYTES = 2 * 1024 * 1024;
const MAX_SUBMIT_FILES = 50;
/** Flat filenames only — a team folder is one level, and that is the format. */
const SAFE_SUBMIT_PATH = /^[A-Za-z0-9_.-]+$/;

export interface TeamApiOptions {
  /** Who is asking: a hand-issued token on a laptop, an account on a league. */
  authority: Authority;
  workspaces: WorkspaceStore;
  /** Where validated pushes are kept, as `<team>/<robot>`. */
  submissionsDir: string;
  /** The repo's `python/` directory. Without one, nothing can be validated. */
  pythonLibDir: string | null;
  /**
   * Anything a successful push needs told, beyond that it was accepted.
   *
   * There is exactly one caller and one sentence: a league server saying the
   * team's next match has already locked its lineup, so this push is their
   * code from the game after that one. It is a hook rather than a lookup in
   * here because a push knows nothing about draws, fixtures or referees and
   * should go on knowing nothing — a laptop running `serve` supplies none.
   */
  noticeFor?: (team: string, robot: RobotNumber) => string | null | Promise<string | null>;
  /**
   * Where to keep a copy of every push, if anywhere.
   *
   * A league server passes one; a laptop running `serve` does not, and its
   * push path is byte-for-byte what it has always been. Without a screen to
   * reach it from, history on a laptop is disk nobody can see — and the
   * organiser's screen only exists on a league.
   */
  pushesDir?: string;
  /** How many pushes to keep per robot. Ignored without `pushesDir`. */
  pushesKept?: number;
  /** Where a swallowed archive failure goes, so it is not silent as well. */
  log?: (line: string) => void;
  /**
   * Told that somebody changed a team's workspace, if anybody is listening.
   *
   * The same shape as `noticeFor`, and for the same reason: writing a file is
   * a workspace act, and *who* did it is an accounts question this class has
   * no business answering — it holds an `Authority`, not a ledger. The request
   * goes back out with it so the caller can resolve its own actor, which on a
   * league server is `accountFor(req)`. A laptop running `serve` supplies
   * none and records nothing.
   */
  onWrite?: (req: Request, what: { team: string; robot: RobotNumber; action: string; name?: string }) => void;
}

export class TeamApi {
  constructor(private readonly opts: TeamApiOptions) {}

  /**
   * How many pushes to keep, changed while the venue is running.
   *
   * Read at the moment a push is archived rather than captured, so this is the
   * whole of it. A lower number does not go back and delete: the next push
   * prunes to it, which is what `keep` has always meant.
   */
  reconfigure(opts: { pushesKept?: number }): void {
    if (opts.pushesKept !== undefined) this.opts.pushesKept = opts.pushesKept;
  }

  /**
   * Take a request if it is one of ours, or hand it back.
   *
   * `null` rather than a 404 so the caller keeps its own routing: on a match
   * server there are a dozen other doors after this one, and on a league
   * server there is a whole site.
   */
  async handle(req: Request, url: string): Promise<Response | null> {
    if (url === '/submit' && req.method === 'POST') return this.push(req);
    if (req.method === 'POST' && url.startsWith('/workspace-api/')) {
      return this.workspaceAction(req, url.slice('/workspace-api/'.length));
    }
    return null;
  }

  /**
   * One workspace action, over `POST /workspace-api/<action>`.
   *
   * With no workspace credential configured the whole surface is 404, so a
   * server that was not told to host workspaces grows no new door.
   *
   * Every action takes the team from the *credential*, never from the body —
   * which is why there is no `team` parameter here to get wrong.
   */
  private async workspaceAction(req: Request, action: string): Promise<Response> {
    if (!this.opts.authority.workspaces) {
      return Response.json(
        { ok: false, reason: 'this server is not hosting team workspaces' },
        { status: 404 },
      );
    }

    const team = await this.opts.authority.team(req);
    if (!team) {
      return Response.json({ ok: false, reason: 'invalid or missing team token' }, { status: 401 });
    }

    const body = await readJsonBody(req, MAX_SUBMIT_BYTES);
    if (!body.ok) return Response.json({ ok: false, reason: body.reason }, { status: body.status });

    const robot: RobotNumber = body.payload.robot === 2 ? 2 : 1;
    const { workspaces } = this.opts;

    switch (action) {
      case 'open': {
        // What the page asks for on login: who am I, and what is in my folder.
        // Seeding here rather than on first save means a team that has never
        // touched this has something that runs before they type anything.
        const files = await workspaces.seed(team, robot);
        return Response.json({ ok: true, team, robot, files });
      }

      case 'save': {
        const validated = validateBody(body.payload, SaveBodySchema, '"name" and "content" must be strings');
        if (!validated.ok) return validated.response;
        const { name, content } = validated.value;
        const result = await workspaces.write(team, robot, name, content);
        if (!result.ok) return Response.json({ ok: false, reason: result.reason }, { status: 400 });
        this.opts.onWrite?.(req, { team, robot, action: 'save', name });
        return Response.json({ ok: true, name });
      }

      case 'delete': {
        const validated = validateBody(body.payload, DeleteBodySchema, '"name" must be a string');
        if (!validated.ok) return validated.response;
        const result = await workspaces.remove(team, robot, validated.value.name);
        if (!result.ok) return Response.json({ ok: false, reason: result.reason }, { status: 400 });
        this.opts.onWrite?.(req, { team, robot, action: 'delete', name: validated.value.name });
        return Response.json({ ok: true, files: await workspaces.read(team, robot) });
      }

      case 'submit':
        return this.submitWorkspace(team, robot);

      default:
        return Response.json(
          { ok: false, reason: `unknown workspace action "${action}"` },
          { status: 404 },
        );
    }
  }

  /**
   * Push a team's workspace through the same validator a laptop's push goes
   * through, and keep it if it passes.
   *
   * Deliberately the identical path — `validateSubmission` on a scratch copy,
   * then a move into the submissions tree and a freshly minted join token.
   * A competition where the entry route changed the rules would not be a
   * competition.
   */
  private async submitWorkspace(team: string, robot: RobotNumber): Promise<Response> {
    const { pythonLibDir, workspaces } = this.opts;
    if (!pythonLibDir) {
      return Response.json(
        { ok: false, reason: 'this server has no python library configured; nothing can be validated' },
        { status: 400 },
      );
    }

    const files = await workspaces.read(team, robot);
    if (files.length === 0) {
      return Response.json({ ok: false, reason: 'there is nothing in this workspace yet' }, { status: 400 });
    }

    const scratch = await mkdtemp(join(tmpdir(), 'rcja-workspace-'));
    try {
      for (const file of files) {
        await writeFile(join(scratch, file.name), file.content, 'utf8');
      }

      const result = await validateSubmission(scratch, { pythonLibDir });
      if (!result.ok) return Response.json({ ok: false, reason: result.reason }, { status: 400 });

      const manifest = result.value;
      // The manifest is the student's to edit, so it can name a team that is
      // not theirs. The credential said who they are; believe that instead.
      if (slugifyTeam(manifest.team) !== slugifyTeam(team)) {
        return Response.json(
          {
            ok: false,
            reason: `manifest.json says the team is "${manifest.team}", but this workspace belongs to "${team}"`,
          },
          { status: 400 },
        );
      }
      if (manifest.robot !== robot) {
        return Response.json(
          {
            ok: false,
            reason: `manifest.json says this is robot ${manifest.robot}, but it is robot ${robot}'s workspace`,
          },
          { status: 400 },
        );
      }

      await this.keep(scratch, manifest, { id: null, slug: team }, 'workspace');
      const notice = await this.opts.noticeFor?.(manifest.team, manifest.robot);
      return Response.json({
        ok: true,
        team: manifest.team,
        robot: manifest.robot,
        ...(notice ? { notice } : {}),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * One robot's folder, pushed as `{ files: { path: base64 } }`.
   *
   * Written to a scratch directory and validated there first; only a pass
   * gets moved into the real submissions tree.
   */
  private async push(req: Request): Promise<Response> {
    const { pythonLibDir } = this.opts;
    if (!pythonLibDir) {
      return Response.json(
        { ok: false, reason: 'this server has no python library configured; nothing can be validated' },
        { status: 400 },
      );
    }

    // Who this push may be written as, asked before a byte of it is read.
    // On a laptop the answer is "anybody", which is what it has always been
    // and what a team practising in a classroom needs. On a league server it
    // is one team, and the manifest is held to it below.
    const submitter = await this.opts.authority.submitter(req);
    if (!submitter) {
      return Response.json({ ok: false, reason: 'invalid or missing push key' }, { status: 401 });
    }

    const body = await readBody(req, MAX_SUBMIT_BYTES);
    if (body === null) {
      return Response.json({ ok: false, reason: 'push too large' }, { status: 413 });
    }

    let payload: { files?: unknown };
    try {
      payload = JSON.parse(body) as { files?: unknown };
    } catch {
      return Response.json({ ok: false, reason: 'body is not valid JSON' }, { status: 400 });
    }

    const rawFiles = payload.files;
    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
      return Response.json(
        { ok: false, reason: '"files" must be an object of path -> base64 content' },
        { status: 400 },
      );
    }

    const entries = Object.entries(rawFiles as Record<string, unknown>);
    if (entries.length === 0) {
      return Response.json({ ok: false, reason: 'no files in the push' }, { status: 400 });
    }
    if (entries.length > MAX_SUBMIT_FILES) {
      return Response.json(
        { ok: false, reason: `too many files (${entries.length}, limit ${MAX_SUBMIT_FILES})` },
        { status: 400 },
      );
    }

    const decoded = new Map<string, Buffer>();
    for (const [path, value] of entries) {
      if (!SAFE_SUBMIT_PATH.test(path)) {
        return Response.json(
          {
            ok: false,
            reason: `"${path}" is not a safe filename — no subdirectories, only letters, digits, ".", "_", "-"`,
          },
          { status: 400 },
        );
      }
      if (typeof value !== 'string') {
        return Response.json({ ok: false, reason: `"${path}" must be base64 text` }, { status: 400 });
      }
      decoded.set(path, Buffer.from(value, 'base64'));
    }

    const scratch = await mkdtemp(join(tmpdir(), 'rcja-submit-'));
    try {
      for (const [path, buf] of decoded) {
        await writeFile(join(scratch, path), buf);
      }

      const result = await validateSubmission(scratch, { pythonLibDir });
      if (!result.ok) return Response.json({ ok: false, reason: result.reason }, { status: 400 });

      const manifest = result.value;
      if (!submitter.open && slugifyTeam(manifest.team) !== slugifyTeam(submitter.team)) {
        return Response.json(
          {
            ok: false,
            reason: `manifest.json says the team is "${manifest.team}", but this key belongs to "${submitter.team}"`,
          },
          { status: 403 },
        );
      }

      const token = await this.keep(scratch, manifest, { id: null, slug: slugifyTeam(manifest.team) }, 'push');
      const notice = await this.opts.noticeFor?.(manifest.team, manifest.robot);
      return Response.json({
        ok: true,
        team: manifest.team,
        robot: manifest.robot,
        token,
        ...(notice ? { notice } : {}),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Move a validated folder into the submissions tree and mint its join token.
   *
   * The token is minted after the move, into the real tree rather than
   * scratch: validation never sees it and never needs to, because no token
   * exists at the point a push is only being checked. A fresh one every
   * successful push, whether or not the code changed — it authenticates this
   * validated copy, not a standing account.
   */
  private async keep(scratch: string, manifest: Manifest, by: PushBy, via: PushVia): Promise<string> {
    const teamDir = join(this.opts.submissionsDir, slugifyTeam(manifest.team));
    const target = join(teamDir, String(manifest.robot));
    await mkdir(teamDir, { recursive: true });
    await rm(target, { recursive: true, force: true });
    try {
      await rename(scratch, target);
    } catch {
      // Scratch and the submissions tree can be on different filesystems
      // (a tmpfs /tmp is common), which a plain rename cannot cross.
      await cp(scratch, target, { recursive: true });
    }

    const token = randomBytes(24).toString('base64url');
    await writeFile(join(target, TOKEN_FILENAME), token);

    // Kept after the move, so the archive is a copy of what is actually live
    // rather than of a scratch folder that might not have survived it — and
    // **after** the token exists, because `keepPush` is the thing that knows
    // not to copy it.
    //
    // Wrapped, because a push that has already succeeded must not be reported
    // as failed for want of a copy. The team's code is in; the history is a
    // convenience for somebody else entirely, and a full disk is not a reason
    // to tell a student their robot did not upload.
    if (this.opts.pushesDir) {
      try {
        await keepPush(this.opts.pushesDir, {
          folder: target,
          manifest,
          by,
          via,
          keep: this.opts.pushesKept ?? 10,
        });
      } catch (err) {
        this.opts.log?.(`[pushes] ${slugifyTeam(manifest.team)}/${manifest.robot} not archived: ${(err as Error).message}`);
      }
    }

    return token;
  }

  /**
   * Put a folder through the push path on somebody else's behalf.
   *
   * This is how an organiser rolls a team back to an earlier push, and it is
   * deliberately **not a way into the submissions tree** — it is the same
   * `validateSubmission` and the same `keep` an ordinary push takes, with the
   * caller supplying who is doing it. Everything that matters follows from
   * that rather than being re-implemented: a push that no longer validates
   * fails loudly, a fresh join token is minted, `noticeFor` fires so Phase
   * 11's lineup lock answers exactly as it does for a team's own push, and the
   * restore is itself archived — so undoing one is just another one.
   */
  async restore(
    files: { name: string; content: Buffer }[],
    expect: { team: string; robot: RobotNumber },
    by: PushBy,
  ): Promise<
    | { ok: true; team: string; robot: RobotNumber; token: string; notice?: string }
    | { ok: false; reason: string; status: number }
  > {
    const { pythonLibDir } = this.opts;
    if (!pythonLibDir) {
      return { ok: false, status: 400, reason: 'this server has no python library configured; nothing can be validated' };
    }
    if (files.length === 0) return { ok: false, status: 400, reason: 'that push kept no files' };

    const scratch = await mkdtemp(join(tmpdir(), 'rcja-restore-'));
    try {
      for (const file of files) {
        if (!SAFE_SUBMIT_PATH.test(file.name)) {
          return { ok: false, status: 400, reason: `"${file.name}" is not a safe filename` };
        }
        await writeFile(join(scratch, file.name), file.content);
      }

      const result = await validateSubmission(scratch, { pythonLibDir });
      // A push that was valid when it was made and is not valid now — the
      // python library has moved on under it, say. Loud, with the validator's
      // own sentence, rather than quietly seating a robot that cannot load.
      if (!result.ok) return { ok: false, status: 400, reason: result.reason };

      const manifest = result.value;
      if (slugifyTeam(manifest.team) !== slugifyTeam(expect.team) || manifest.robot !== expect.robot) {
        return {
          ok: false,
          status: 400,
          reason: `that push says it is ${manifest.team} robot ${manifest.robot}, not ${expect.team} robot ${expect.robot}`,
        };
      }

      const token = await this.keep(scratch, manifest, by, 'rollback');
      const notice = await this.opts.noticeFor?.(manifest.team, manifest.robot);
      return { ok: true, team: manifest.team, robot: manifest.robot, token, ...(notice ? { notice } : {}) };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** The body, or `null` if it is over the limit. */
async function readBody(req: Request, limit: number): Promise<string | null> {
  try {
    const text = await req.text();
    return text.length > limit ? null : text;
  } catch {
    return null;
  }
}
