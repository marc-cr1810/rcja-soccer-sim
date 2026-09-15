/**
 * Who is making this request — asked, never assumed.
 *
 * `MatchServer` has three doors that are not open to everybody: the referee
 * console, a team's workspace, and a push. Until now each answered "who is
 * this?" for itself, against a hand-issued secret held in the server's own
 * options. That was right for Phases 1, 2 and 5, each of which said in the
 * same words that Phase 6 would replace where the secret comes from.
 *
 * This is that replacement, and the shape of it matters as much as the fact
 * of it. PHASES.md is explicit that accounts are *a layer above*
 * `MatchServer`, never a path threaded through it — so the server does not
 * learn about sessions, roles or a database. It is handed an `Authority` and
 * asks it questions. A laptop `serve` is handed the hand-issued one and
 * behaves exactly as it did yesterday; a league server is handed one backed by
 * accounts.
 *
 * The one rule both implementations keep, because it is the rule the whole
 * league rests on: **the team comes from the credential, never from the
 * request body.** A client that can name its own team can be any team.
 */

import type { IncomingMessage } from 'node:http';

/**
 * What a push is allowed to be written as.
 *
 * - `{ open: true }` — anybody may push anything, which is what a match server
 *   on a classroom laptop wants and has always done. There is no organiser to
 *   issue a credential and no competition to protect.
 * - `{ team }` — this push may only be written as this team, which is checked
 *   against the manifest before anything lands on disk.
 * - `null` — refused.
 */
export type Submitter = { open: true } | { open: false; team: string } | null;

export interface Authority {
  /**
   * Whether a referee surface exists on this server at all.
   *
   * False makes `/referee-api/*` answer 404 regardless of path or body and
   * makes `play({ refereed: true })` refuse — the behaviour a server started
   * without `--referee` has today, kept exactly.
   */
  readonly refereed: boolean;

  /** Whether a team-workspace surface exists on this server at all. */
  readonly workspaces: boolean;

  /** May this request control the match? */
  referee(req: IncomingMessage): Promise<boolean>;

  /** Whose workspace is this request allowed to touch, or null. */
  team(req: IncomingMessage): Promise<string | null>;

  /** What this push may be written as. */
  submitter(req: IncomingMessage): Promise<Submitter>;
}

/** `Authorization: Bearer <secret>`, or the empty string. */
export function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

export interface HandIssuedOptions {
  /** Minted once and handed to the referee out of band. Absent means no referee surface. */
  refereeToken?: string | null;
  /** Token to team name. Empty means no workspace surface. */
  workspaceTokens?: ReadonlyMap<string, string>;
}

/**
 * The arrangement every phase up to this one shipped: secrets an organiser
 * created by hand and handed out.
 *
 * This is the default, so a `MatchServer` constructed the way it always was
 * behaves the way it always did — including a push being open, which is what
 * a team running the simulator on their own laptop needs and is not a hole in
 * a competition, because a competition runs a league server.
 */
export function handIssuedAuthority(opts: HandIssuedOptions = {}): Authority {
  const refereeToken = opts.refereeToken ?? null;
  const tokens = opts.workspaceTokens ?? new Map<string, string>();

  return {
    refereed: refereeToken !== null,
    workspaces: tokens.size > 0,

    async referee(req) {
      if (!refereeToken) return false;
      return bearer(req) === refereeToken;
    },

    async team(req) {
      const presented = bearer(req);
      if (!presented) return null;
      return tokens.get(presented) ?? null;
    },

    async submitter() {
      return { open: true };
    },
  };
}
