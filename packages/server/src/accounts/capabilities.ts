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
 * - `assigned` — only things this account has been assigned to, named one at a
 *   time by a targeted grant. A role holding a capability at this scope holds
 *   it over nothing until something assigns it; that is the point, and it is
 *   why the blanket form has to fail.
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
  | 'field.control'
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
 * A referee's match capabilities are `assigned`, which means they are held
 * over nothing at all until `assignments` names a fixture. The blanket reach
 * they used to carry is gone: a referee at a venue with two pitches controls
 * the match they were given and not the one on the next pitch over.
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
    // Targeted by the field's *owner*, so `own` means "a field of mine". A
    // guest is on a field by invitation rather than by capability — the two
    // ledgers in `tenancy.ts` — which is why running one and being on one are
    // separate questions.
    'field.control': 'own',
    'field.invite': 'own',
    'field.join': 'own',
  },
  referee: {
    'match.watch': 'any',
    'results.read': 'any',
    'field.open': 'any',
    'field.join': 'any',
    // Held over an assigned fixture and nothing else. `assignedCapabilities`
    // reads these back, so this table stays the only place the list lives.
    'fixture.setup': 'assigned',
    'match.control': 'assigned',
    'match.score.correct': 'assigned',
    'match.abandon': 'assigned',
  },
  admin: {
    'match.watch': 'any',
    'results.read': 'any',
    'match.join': 'any',
    'team.workspace.write': 'any',
    'team.submit': 'any',
    'field.open': 'any',
    'field.control': 'any',
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

/**
 * Every capability there is, in a list a screen can offer.
 *
 * Written as a `Record<Capability, true>` rather than an array so that the
 * *compiler* keeps it complete: adding a capability to the union above and
 * forgetting this list is a type error, not a dropdown that quietly stops
 * offering the newest thing. `capabilitiesOf('admin')` happens to name all of
 * them today, but that is a fact about who an organiser is, not about what
 * exists — a capability no role held would vanish from a screen built on it.
 */
const EVERY_CAPABILITY: Record<Capability, true> = {
  'match.watch': true,
  'results.read': true,
  'match.join': true,
  'team.workspace.write': true,
  'team.submit': true,
  'field.open': true,
  'field.control': true,
  'field.invite': true,
  'field.join': true,
  'fixture.setup': true,
  'match.control': true,
  'match.score.correct': true,
  'match.abandon': true,
  'arena.list': true,
  'arena.kill': true,
  'tournament.create': true,
  'tournament.amend': true,
  'referee.assign': true,
  'account.manage': true,
  'capability.grant': true,
};

export const CAPABILITIES: readonly Capability[] = Object.keys(EVERY_CAPABILITY) as Capability[];

export const SCOPES: readonly Scope[] = ['own', 'assigned', 'any'];

/** Every capability a role carries, for showing a person what they can do. */
export function capabilitiesOf(role: Role): Capability[] {
  return Object.keys(ROLE_CAPABILITIES[role]) as Capability[];
}

/**
 * What a role carries, **with the reach of each**.
 *
 * `capabilitiesOf` answers "does this role have it at all", which is the right
 * question for a menu and the wrong one for a screen that is about to widen
 * something. A referee *has* `match.control` — over nothing, until a fixture
 * is named — so a grant of it at `any` hands them every match at the venue
 * while a list of bare names says they already had it. That sentence was on
 * the screen for about an hour of Phase 12 G before anybody read it properly.
 */
export function reachOf(role: Role): { capability: Capability; scope: Scope }[] {
  return Object.entries(ROLE_CAPABILITIES[role]).map(([capability, scope]) => ({
    capability: capability as Capability,
    scope: scope as Scope,
  }));
}

/**
 * The capabilities a role holds only over what it is assigned.
 *
 * Read back out of the table rather than written down a second time, so that
 * flipping a capability to `assigned` is the whole of the change — an
 * assignment starts granting it with nothing else edited.
 */
export function assignedCapabilities(role: Role): Capability[] {
  return Object.entries(ROLE_CAPABILITIES[role])
    .filter(([, scope]) => scope === 'assigned')
    .map(([capability]) => capability as Capability);
}

/**
 * What a fixture is called when it is the thing a capability is about.
 *
 * A fixture's own id is `home-v-away` and is unique only inside its own draw,
 * so the draw has to be part of the name or two divisions can hand one referee
 * somebody else's match.
 */
export function fixtureTarget(drawId: string, fixtureId: string): string {
  return `${drawId}:${fixtureId}`;
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
      // An assignment arrives as a grant naming its fixture, which the early
      // return above answers. Reaching here means the blanket form was asked
      // for instead, and holding a capability over everything is exactly what
      // being assigned is not.
      return false;
  }
}
