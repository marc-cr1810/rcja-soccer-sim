/**
 * Who may do what, and to which thing.
 *
 * Four roles, each a named set of capabilities, each capability carrying a
 * scope — and every check in the league server goes through `can()` from the
 * first line of code rather than asking `role === 'admin'` in twenty places.
 * That is not ceremony: the thing this shape buys is that "this referee may
 * also amend the draw" is a row in `grants` rather than a fifth role invented
 * on the morning of an event.
 *
 * Scope is the part that matters. A team may push *their own* code and nobody
 * else's; an admin may push anybody's. The same capability, two reaches, one
 * check.
 *
 * Nothing in here reads a database or a request. It is a pure function over a
 * resolved actor, so it can be tested exhaustively and so the interesting
 * question — "who is this?" — stays in one place (`authority.ts`) rather than
 * being answered differently by each caller.
 */

/** What an account is allowed to be. `guest` is the absence of an account. */
export type Role = 'guest' | 'team' | 'referee' | 'admin';

export const ROLES: readonly Role[] = ['guest', 'team', 'referee', 'admin'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * How far a capability reaches.
 *
 * - `own` — only things belonging to this account, matched by slug.
 * - `assigned` — only things this account has been assigned to. Nothing is
 *   assigned to anybody until Phase 10 builds referee assignments, so this
 *   resolves to false today; it is defined now because leaving it out would
 *   mean threading a second concept through every check later.
 * - `any` — everything of that kind.
 */
export type Scope = 'own' | 'assigned' | 'any';

/**
 * Every capability in the league, including the ones nothing reaches yet.
 *
 * Written out whole rather than grown one string at a time, because the value
 * of the list is that it can be read in one sitting and argued with — see the
 * table in END-STATE.md, which this is the executable copy of.
 */
export type Capability =
  | 'match.watch'
  | 'results.read'
  | 'match.join'
  | 'team.workspace.write'
  | 'team.submit'
  | 'field.open'
  | 'field.invite'
  | 'field.join'
  | 'fixture.setup'
  | 'match.control'
  | 'match.score.correct'
  | 'match.abandon'
  | 'arena.list'
  | 'arena.kill'
  | 'tournament.create'
  | 'tournament.amend'
  | 'referee.assign'
  | 'account.manage'
  | 'capability.grant';

/**
 * A capability the caller has already been granted somewhere, at some reach.
 *
 * `target` narrows a grant to one thing — a referee granted `match.control`
 * with scope `own` and target `state-round-1:f3` controls that fixture and no
 * other. A grant with no target and scope `any` is the blanket form.
 */
export interface Grant {
  capability: Capability;
  scope: Scope;
  target: string | null;
}

/**
 * Who is asking, reduced to the three things a check needs.
 *
 * `slug` is what `own` is matched against — a team account's slug is its team
 * name slugified, which is also the name of its folder under `submissions/`
 * and `workspaces/`, so "own" means the same thing to the capability check and
 * to the disk.
 */
export interface Actor {
  id: string | null;
  role: Role;
  slug: string | null;
  grants: readonly Grant[];
}

/** Nobody in particular: a visitor with no account. Watching is still open. */
export const GUEST: Actor = { id: null, role: 'guest', slug: null, grants: [] };

/**
 * The capability table from END-STATE.md, as code.
 *
 * One deliberate looseness, recorded here rather than left to be discovered:
 * a referee's match capabilities are `any` rather than `assigned`, because
 * nothing assigns a referee to a fixture until Phase 10 and `any` is exactly
 * the reach the hand-issued referee token has today. Narrowing it later moves
 * from too-permissive to correct, which is the safe direction; granting
 * `assigned` now would mean no referee could kick anything off at all.
 */
const ROLE_CAPABILITIES: Record<Role, Partial<Record<Capability, Scope>>> = {
  guest: {
    'match.watch': 'any',
    'results.read': 'any',
  },
  team: {
    'match.watch': 'any',
    'results.read': 'any',
    'match.join': 'own',
    'team.workspace.write': 'own',
    'team.submit': 'own',
    'field.open': 'any',
    'field.invite': 'own',
    'field.join': 'own',
  },
  referee: {
    'match.watch': 'any',
    'results.read': 'any',
    'field.open': 'any',
    'field.join': 'any',
    // `any` until Phase 10 — see the note above.
    'fixture.setup': 'any',
    'match.control': 'any',
    'match.score.correct': 'any',
    'match.abandon': 'any',
  },
  admin: {
    'match.watch': 'any',
    'results.read': 'any',
    'match.join': 'any',
    'team.workspace.write': 'any',
    'team.submit': 'any',
    'field.open': 'any',
    'field.invite': 'any',
    'field.join': 'any',
    'fixture.setup': 'any',
    'match.control': 'any',
    'match.score.correct': 'any',
    'match.abandon': 'any',
    'arena.list': 'any',
    'arena.kill': 'any',
    'tournament.create': 'any',
    'tournament.amend': 'any',
    'referee.assign': 'any',
    'account.manage': 'any',
    'capability.grant': 'any',
  },
};

/** Every capability a role carries, for showing a person what they can do. */
export function capabilitiesOf(role: Role): Capability[] {
  return Object.keys(ROLE_CAPABILITIES[role]) as Capability[];
}

/**
 * May this actor do this, to this?
 *
 * `target` is whatever the capability is about — a team slug for the team
 * capabilities, a fixture id for the match ones. Omitting it asks the weaker
 * question "could they do this to anything at all", which is what a menu wants
 * when deciding whether to show a link; a capability held only at `own` cannot
 * answer that with yes, because the answer depends on the thing.
 */
export function can(actor: Actor, capability: Capability, target?: string): boolean {
  const fromRole = ROLE_CAPABILITIES[actor.role][capability];
  if (fromRole && satisfies(actor, fromRole, target, null)) return true;

  for (const grant of actor.grants) {
    if (grant.capability !== capability) continue;
    if (satisfies(actor, grant.scope, target, grant.target)) return true;
  }

  return false;
}

/**
 * Does one scope, at one reach, cover this target?
 *
 * `grantTarget` is the thing a `grants` row narrowed itself to, and it is
 * checked first: a row that names a target covers that target and nothing
 * else, whatever its scope says, because the narrower of the two is the one
 * the organiser meant.
 */
function satisfies(
  actor: Actor,
  scope: Scope,
  target: string | undefined,
  grantTarget: string | null,
): boolean {
  if (grantTarget !== null) return target === grantTarget;

  switch (scope) {
    case 'any':
      return true;
    case 'own':
      // No target means "anything of this kind", which `own` cannot promise.
      return target !== undefined && actor.slug !== null && target === actor.slug;
    case 'assigned':
      // Phase 10. Nothing is assigned to anybody yet, and pretending otherwise
      // would be a check that passes for the wrong reason.
      return false;
  }
}
