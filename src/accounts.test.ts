/**
 * Who everybody is, and what that lets them do.
 *
 * Two files' worth of behaviour tested together because they are one idea: an
 * account is only interesting through the capability check, and a capability
 * check is only interesting over a real account. What is being defended here
 * is mostly the things that are quiet when they break — an invitation that can
 * be used twice, a revoked key that still opens a door, a password change that
 * leaves the old sessions alive.
 */

import { describe, expect, it } from 'vitest';

import { Accounts, MIN_PASSWORD } from './accounts';
import { can, GUEST, type Actor } from './capabilities';

function open(): Accounts {
  return new Accounts({ file: ':memory:' });
}

const PASSWORD = 'a-long-enough-password';

describe('an account', () => {
  it('is empty until somebody makes one', () => {
    const accounts = open();
    expect(accounts.empty).toBe(true);
    accounts.createAccount({ role: 'admin', displayName: 'Marc', password: PASSWORD });
    expect(accounts.empty).toBe(false);
  });

  it('takes its slug from its name, so "own" and the folder on disk are one string', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'team', displayName: 'ACT Robotics', password: PASSWORD });
    expect(made.ok && made.value.slug).toBe('act-robotics');
  });

  it('refuses a name somebody already has', () => {
    const accounts = open();
    accounts.createAccount({ role: 'team', displayName: 'ACT Robotics', password: PASSWORD });
    const again = accounts.createAccount({ role: 'team', displayName: 'act  robotics', password: PASSWORD });
    expect(again.ok).toBe(false);
  });

  it('refuses a password nobody would have to guess', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'team', displayName: 'ACT', password: 'short' });
    expect(made.ok).toBe(false);
    expect(!made.ok && made.reason).toContain(String(MIN_PASSWORD));
  });

  it('checks a password rather than storing one', () => {
    const accounts = open();
    accounts.createAccount({ role: 'team', displayName: 'ACT Robotics', password: PASSWORD });
    expect(accounts.authenticate('ACT Robotics', PASSWORD)?.slug).toBe('act-robotics');
    expect(accounts.authenticate('act-robotics', PASSWORD)?.slug).toBe('act-robotics');
    expect(accounts.authenticate('ACT Robotics', 'something else')).toBeNull();
    expect(accounts.authenticate('nobody', PASSWORD)).toBeNull();
  });

  it('cannot log in once it is disabled', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'team', displayName: 'ACT', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    accounts.setDisabled(made.value.id, true);
    expect(accounts.authenticate('ACT', PASSWORD)).toBeNull();
  });
});

describe('a session', () => {
  it('names its account, and stops when it is closed', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'referee', displayName: 'Sam', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    const { token } = accounts.openSession(made.value.id);

    expect(accounts.accountForSession(token)?.id).toBe(made.value.id);
    accounts.closeSession(token);
    expect(accounts.accountForSession(token)).toBeNull();
  });

  it('is not a session if it was never issued', () => {
    const accounts = open();
    expect(accounts.accountForSession('made-up')).toBeNull();
  });

  it('ends when the password changes, because that is what changing it is for', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'team', displayName: 'ACT', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    const { token } = accounts.openSession(made.value.id);

    const reset = accounts.setPassword('ACT', 'another-good-password');
    expect(reset.ok).toBe(true);
    expect(accounts.accountForSession(token)).toBeNull();
    expect(accounts.authenticate('ACT', 'another-good-password')).not.toBeNull();
  });
});

describe('a push key', () => {
  it('is handed back once and never stored', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'team', displayName: 'ACT', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    const key = accounts.createKey(made.value.id, "Ada's laptop");

    expect(key.key.startsWith('rcja_')).toBe(true);
    expect(accounts.accountForKey(key.key)?.id).toBe(made.value.id);
    // The listing knows the key exists; it does not know what it is.
    expect(JSON.stringify(accounts.listKeys(made.value.id))).not.toContain(key.key);
  });

  it('stops opening anything once it is revoked', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'team', displayName: 'ACT', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    const key = accounts.createKey(made.value.id, 'laptop');

    expect(accounts.revokeKey(made.value.id, key.info.id)).toBe(true);
    expect(accounts.accountForKey(key.key)).toBeNull();
    // And a second revocation is not a second event.
    expect(accounts.revokeKey(made.value.id, key.info.id)).toBe(false);
  });

  it('cannot be revoked by somebody else', () => {
    const accounts = open();
    const act = accounts.createAccount({ role: 'team', displayName: 'ACT', password: PASSWORD });
    const nsw = accounts.createAccount({ role: 'team', displayName: 'NSW', password: PASSWORD });
    if (!act.ok || !nsw.ok) throw new Error('setup');
    const key = accounts.createKey(act.value.id, 'laptop');

    expect(accounts.revokeKey(nsw.value.id, key.info.id)).toBe(false);
    expect(accounts.accountForKey(key.key)).not.toBeNull();
  });
});

describe('an invitation', () => {
  it('names the team, so registering cannot rename it', () => {
    const accounts = open();
    const invite = accounts.createInvite({ role: 'team', team: 'ACT Robotics' });
    if (!invite.ok) throw new Error(invite.reason);

    const joined = accounts.redeem(invite.value.code, { displayName: 'Something Else', password: PASSWORD });
    expect(joined.ok && joined.value.displayName).toBe('ACT Robotics');
  });

  it('works exactly once', () => {
    const accounts = open();
    const invite = accounts.createInvite({ role: 'team', team: 'ACT Robotics' });
    if (!invite.ok) throw new Error(invite.reason);

    expect(accounts.redeem(invite.value.code, { password: PASSWORD }).ok).toBe(true);
    const again = accounts.redeem(invite.value.code, { password: PASSWORD });
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toContain('already been used');
  });

  it('refuses a code this server never issued', () => {
    const accounts = open();
    expect(accounts.redeem('not-a-code', { password: PASSWORD }).ok).toBe(false);
  });

  it('leaves nothing behind when the registration itself fails', () => {
    const accounts = open();
    const invite = accounts.createInvite({ role: 'team', team: 'ACT Robotics' });
    if (!invite.ok) throw new Error(invite.reason);

    // Too short a password: the account is not made, and the code is not spent.
    expect(accounts.redeem(invite.value.code, { password: 'short' }).ok).toBe(false);
    expect(accounts.redeem(invite.value.code, { password: PASSWORD }).ok).toBe(true);
  });

  it('wants a team name for a team, and refuses one for anybody else', () => {
    const accounts = open();
    expect(accounts.createInvite({ role: 'team' }).ok).toBe(false);
    expect(accounts.createInvite({ role: 'referee', team: 'ACT' }).ok).toBe(false);
    expect(accounts.createInvite({ role: 'referee' }).ok).toBe(true);
  });

  it('will not invite a team that already has an account', () => {
    const accounts = open();
    accounts.createAccount({ role: 'team', displayName: 'ACT Robotics', password: PASSWORD });
    expect(accounts.createInvite({ role: 'team', team: 'ACT Robotics' }).ok).toBe(false);
  });
});

describe('who may do what', () => {
  const team = (slug: string): Actor => ({ id: 'x', role: 'team', slug, grants: [] });
  const referee: Actor = { id: 'r', role: 'referee', slug: 'sam', grants: [] };
  const admin: Actor = { id: 'a', role: 'admin', slug: 'marc', grants: [] };

  it('lets anybody watch and read results, with no account at all', () => {
    expect(can(GUEST, 'match.watch')).toBe(true);
    expect(can(GUEST, 'results.read')).toBe(true);
  });

  it('gives a guest nothing else', () => {
    expect(can(GUEST, 'team.submit', 'act-robotics')).toBe(false);
    expect(can(GUEST, 'match.control')).toBe(false);
    expect(can(GUEST, 'account.manage')).toBe(false);
  });

  it('holds a team to its own things', () => {
    const act = team('act-robotics');
    expect(can(act, 'team.submit', 'act-robotics')).toBe(true);
    expect(can(act, 'team.workspace.write', 'act-robotics')).toBe(true);
    expect(can(act, 'team.submit', 'nsw-lightning')).toBe(false);
    // "Could they push to anything at all" is a question `own` cannot answer yes to.
    expect(can(act, 'team.submit')).toBe(false);
  });

  it('lets a referee control a match but not administer anything', () => {
    expect(can(referee, 'match.control')).toBe(true);
    expect(can(referee, 'match.abandon')).toBe(true);
    expect(can(referee, 'account.manage')).toBe(false);
    expect(can(referee, 'team.submit', 'act-robotics')).toBe(false);
  });

  it('lets an admin reach anybody', () => {
    expect(can(admin, 'team.submit', 'act-robotics')).toBe(true);
    expect(can(admin, 'match.control')).toBe(true);
    expect(can(admin, 'account.manage')).toBe(true);
  });

  it('adds a single extra as a row rather than a fifth role', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'referee', displayName: 'Sam', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    expect(can(accounts.actorFor(made.value), 'tournament.amend')).toBe(false);

    accounts.grant(made.value.id, 'tournament.amend', 'any');
    expect(can(accounts.actorFor(made.value), 'tournament.amend')).toBe(true);
  });

  it('honours a grant narrowed to one thing, and only that thing', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'referee', displayName: 'Sam', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);
    accounts.grant(made.value.id, 'team.submit', 'any', 'act-robotics');
    const actor = accounts.actorFor(made.value);

    expect(can(actor, 'team.submit', 'act-robotics')).toBe(true);
    expect(can(actor, 'team.submit', 'nsw-lightning')).toBe(false);
  });
});

describe('the audit log', () => {
  it('records who did what, newest first', () => {
    const accounts = open();
    const made = accounts.createAccount({ role: 'admin', displayName: 'Marc', password: PASSWORD });
    if (!made.ok) throw new Error(made.reason);

    accounts.record(made.value.id, 'account.manage', 'act-robotics', 'issued an invitation');
    const rows = accounts.audit();
    expect(rows[0]?.capability).toBe('account.manage');
    expect(rows[0]?.actorName).toBe('Marc');
    expect(rows[0]?.target).toBe('act-robotics');
  });
});
