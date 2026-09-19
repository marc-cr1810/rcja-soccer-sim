/**
 * Whose field it is: ownership, invitations, the per-team cap and the queue.
 *
 * All of it is a data structure with an injectable clock, which is what makes
 * the queue's awkward case — a team offered a field who has gone home —
 * testable at all. At a venue that case takes ninety seconds to reach and
 * happens on the one afternoon nobody is watching the logs.
 */

import { describe, expect, it } from 'bun:test';

import { Tenancy } from '../../src/accounts/tenancy';

/** A tenancy with a clock the test turns by hand. */
function withClock(opts: { perTeam?: number; claimSeconds?: number } = {}) {
  let at = 1_000_000;
  const tenancy = new Tenancy({ ...opts, now: () => at });
  return { tenancy, tick: (seconds: number) => void (at += seconds * 1000) };
}

describe('owning a field', () => {
  it('records who a field belongs to, and forgets it when the arena goes', () => {
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    expect(tenancy.ownerOf('arena-a')).toBe('alpha');
    expect(tenancy.fieldsOwnedBy('alpha')).toEqual(['arena-a']);

    tenancy.forget('arena-a');
    expect(tenancy.ownerOf('arena-a')).toBeNull();
    expect(tenancy.fieldsOwnedBy('alpha')).toEqual([]);
  });

  it('lets the owner run the field and nobody else', () => {
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    tenancy.invite('arena-a', 'bravo');
    tenancy.accept('arena-a', 'bravo');

    expect(tenancy.mayRunField('alpha', 'arena-a')).toBe(true);
    // A guest may be on the field; running it — drag, start, re-stage, invite
    // — stays with whoever opened it.
    expect(tenancy.mayRunField('bravo', 'arena-a')).toBe(false);
    expect(tenancy.mayBeOnField('bravo', 'arena-a')).toBe(true);
    expect(tenancy.mayBeOnField('charlie', 'arena-a')).toBe(false);
    expect(tenancy.mayBeOnField(null, 'arena-a')).toBe(false);
  });

  it('holds a team to one field by default', () => {
    const tenancy = new Tenancy();
    expect(tenancy.perTeamRefusal('alpha')).toBeNull();
    tenancy.own('arena-a', 'alpha');
    expect(tenancy.perTeamRefusal('alpha')).toContain('close it before opening another');
    // Somebody else's field is not their problem.
    expect(tenancy.perTeamRefusal('bravo')).toBeNull();
  });

  it('allows two when a venue sets it, and never more', () => {
    // Two is reachable only by splitting robot 1 and robot 2; the ceiling is
    // the number of robots a team has, not a preference.
    const tenancy = new Tenancy({ perTeam: 2 });
    tenancy.own('arena-a', 'alpha');
    expect(tenancy.perTeamRefusal('alpha')).toBeNull();
    tenancy.own('arena-b', 'alpha');
    expect(tenancy.perTeamRefusal('alpha')).toContain('2 practice fields');

    const overset = new Tenancy({ perTeam: 9 });
    overset.own('arena-a', 'alpha');
    overset.own('arena-b', 'alpha');
    expect(overset.perTeamRefusal('alpha')).not.toBeNull();
  });

  it('does not charge a guest for being a guest', () => {
    // Ownership and occupancy are separate ledgers: accepting an invitation
    // never costs a team their own right to open a field.
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    tenancy.invite('arena-a', 'bravo');
    tenancy.accept('arena-a', 'bravo');

    expect(tenancy.perTeamRefusal('bravo')).toBeNull();
    expect(tenancy.fieldsOwnedBy('bravo')).toEqual([]);
    expect(tenancy.fieldsOpenTo('bravo')).toEqual(['arena-a']);
  });
});

describe('invitations', () => {
  it('lands on the invited team’s dashboard rather than in a link', () => {
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    expect(tenancy.invite('arena-a', 'bravo').ok).toBe(true);

    const waiting = tenancy.invitationsFor('bravo');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ arenaId: 'arena-a', from: 'alpha', to: 'bravo' });
    // Invited is not yet on the field.
    expect(tenancy.mayBeOnField('bravo', 'arena-a')).toBe(false);
  });

  it('is idempotent, and refuses the silly cases plainly', () => {
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    tenancy.invite('arena-a', 'bravo');
    expect(tenancy.invite('arena-a', 'bravo').ok).toBe(true);
    expect(tenancy.invitedTo('arena-a')).toEqual(['bravo']);

    const own = tenancy.invite('arena-a', 'alpha');
    expect(own.ok).toBe(false);
    const gone = tenancy.invite('arena-gone', 'bravo');
    expect(gone.ok).toBe(false);
  });

  it('accepts, declines, and refuses an uninvited team', () => {
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    tenancy.invite('arena-a', 'bravo');

    expect(tenancy.accept('arena-a', 'bravo').ok).toBe(true);
    expect(tenancy.guestsOf('arena-a')).toEqual(['bravo']);
    expect(tenancy.invitationsFor('bravo')).toEqual([]);

    expect(tenancy.accept('arena-a', 'charlie').ok).toBe(false);

    tenancy.invite('arena-a', 'delta');
    tenancy.decline('arena-a', 'delta');
    expect(tenancy.invitationsFor('delta')).toEqual([]);
    expect(tenancy.mayBeOnField('delta', 'arena-a')).toBe(false);
  });

  it('takes a guest off a field again', () => {
    const tenancy = new Tenancy();
    tenancy.own('arena-a', 'alpha');
    tenancy.invite('arena-a', 'bravo');
    tenancy.accept('arena-a', 'bravo');

    tenancy.removeGuest('arena-a', 'bravo');
    expect(tenancy.mayBeOnField('bravo', 'arena-a')).toBe(false);
  });
});

describe('the queue', () => {
  it('gives a team their place and what is ahead of them', () => {
    const { tenancy } = withClock();
    expect(tenancy.enqueue('alpha')).toMatchObject({ position: 1, ahead: 0, offer: null });
    expect(tenancy.enqueue('bravo')).toMatchObject({ position: 2, ahead: 1 });
    // Asking twice does not move you.
    expect(tenancy.enqueue('alpha')).toMatchObject({ position: 1 });
    expect(tenancy.waiting()).toEqual(['alpha', 'bravo']);
  });

  it('holds a freed slot for the team at the front rather than opening it', () => {
    const { tenancy } = withClock({ claimSeconds: 90 });
    tenancy.enqueue('alpha');
    tenancy.enqueue('bravo');

    const offer = tenancy.slotFreed();
    expect(offer?.offeredTo).toBe('alpha');
    // Held means held: nobody else may take it while the hold stands.
    expect(tenancy.reserved()).toBe(1);
    expect(tenancy.offeredTo('alpha')).toBe(true);
    expect(tenancy.offeredTo('bravo')).toBe(false);
    expect(tenancy.placeOf('alpha')?.offer).not.toBeNull();
  });

  it('frees a slot to nobody when nobody is waiting', () => {
    const { tenancy } = withClock();
    expect(tenancy.slotFreed()).toBeNull();
    expect(tenancy.reserved()).toBe(0);
  });

  it('passes an unclaimed hold on, and drops the team that let it lapse', () => {
    // Cycling them to the back instead would make every team behind them wait
    // a claim window each time round, for a team that has gone home.
    const { tenancy, tick } = withClock({ claimSeconds: 90 });
    tenancy.enqueue('alpha');
    tenancy.enqueue('bravo');
    tenancy.slotFreed();

    tick(91);
    expect(tenancy.offeredTo('bravo')).toBe(true);
    expect(tenancy.waiting()).toEqual(['bravo']);
    expect(tenancy.placeOf('alpha')).toBeNull();
  });

  it('lets a hold lapse to nothing when the queue empties', () => {
    const { tenancy, tick } = withClock({ claimSeconds: 30 });
    tenancy.enqueue('alpha');
    tenancy.slotFreed();

    tick(31);
    expect(tenancy.reserved()).toBe(0);
    expect(tenancy.waiting()).toEqual([]);
  });

  it('clears the claim once the field is actually open', () => {
    const { tenancy } = withClock();
    tenancy.enqueue('alpha');
    tenancy.enqueue('bravo');
    tenancy.slotFreed();

    tenancy.claimed('alpha');
    expect(tenancy.reserved()).toBe(0);
    expect(tenancy.waiting()).toEqual(['bravo']);
  });

  it('lets a team give up their place', () => {
    const { tenancy } = withClock();
    tenancy.enqueue('alpha');
    tenancy.enqueue('bravo');
    tenancy.slotFreed();

    tenancy.leaveQueue('alpha');
    expect(tenancy.reserved()).toBe(0);
    expect(tenancy.waiting()).toEqual(['bravo']);
  });
});
