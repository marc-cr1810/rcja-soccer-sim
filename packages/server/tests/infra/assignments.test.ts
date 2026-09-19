/**
 * A referee, and the fixture they were given.
 *
 * What is defended here is a narrowing that fails quietly in both directions.
 * Too tight and a referee cannot start their own match twenty minutes before
 * kick-off; too loose and the referee on the next pitch over can abandon it.
 * Neither shows up as an error — both look like a working server until the
 * wrong person presses something — so the reach of an assignment is checked
 * one capability and one fixture at a time.
 */

import { Accounts } from '../../src/accounts/accounts';
import { assignedCapabilities, can, fixtureTarget } from '../../src/accounts/capabilities';

const PASSWORD = 'a-long-enough-password';

const ROUND_1 = fixtureTarget('round-1', 'act-robotics-v-nsw-lightning');
const OTHER = fixtureTarget('round-1', 'qld-thunder-v-vic-united');

function open(): Accounts {
  return new Accounts({ file: ':memory:' });
}

function referee(accounts: Accounts, name: string) {
  const made = accounts.createAccount({ role: 'referee', displayName: name, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  return made.value;
}

describe('an assignment', () => {
  it('is what turns a referee into one for a particular match', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    expect(can(accounts.actorFor(sam), 'match.control', ROUND_1)).toBe(false);

    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });
    expect(can(accounts.actorFor(sam), 'match.control', ROUND_1)).toBe(true);
  });

  it('reaches that fixture and no other', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });

    const actor = accounts.actorFor(sam);
    expect(can(actor, 'match.control', OTHER)).toBe(false);
    expect(can(actor, 'match.abandon', OTHER)).toBe(false);
  });

  it('does not answer "any match at all", which is what makes it an assignment', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });

    // The menu question. `can()` cannot say yes to it for a targeted scope, so
    // the table is asked instead — see `hasAssignment`.
    expect(can(accounts.actorFor(sam), 'match.control')).toBe(false);
    expect(accounts.hasAssignment(sam.id)).toBe(true);
  });

  it('carries every capability the table holds at that scope, and nothing more', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });
    const actor = accounts.actorFor(sam);

    for (const capability of assignedCapabilities('referee')) {
      expect(can(actor, capability, ROUND_1)).toBe(true);
    }
    expect(assignedCapabilities('referee')).toEqual([
      'fixture.setup',
      'match.control',
      'match.score.correct',
      'match.abandon',
    ]);
    // Being given a match is not being given the venue.
    expect(can(actor, 'account.manage', ROUND_1)).toBe(false);
    expect(can(actor, 'tournament.amend', ROUND_1)).toBe(false);
    expect(can(actor, 'arena.kill', ROUND_1)).toBe(false);
  });

  it('keeps two draws apart, because a fixture id alone does not', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    // The same two teams meeting in two divisions produce the same fixture id.
    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });

    const actor = accounts.actorFor(sam);
    expect(can(actor, 'match.control', fixtureTarget('round-1', 'act-robotics-v-nsw-lightning'))).toBe(true);
    expect(can(actor, 'match.control', fixtureTarget('round-2', 'act-robotics-v-nsw-lightning'))).toBe(false);
  });

  it('can be taken back', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });

    const removed = accounts.unassign({
      accountId: sam.id,
      drawId: 'round-1',
      fixtureId: 'act-robotics-v-nsw-lightning',
    });
    expect(removed).toBe(true);
    expect(can(accounts.actorFor(sam), 'match.control', ROUND_1)).toBe(false);
    expect(accounts.hasAssignment(sam.id)).toBe(false);
    // Taking back something they never had is a no, not a throw.
    expect(accounts.unassign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'nope' })).toBe(false);
  });

  it('is idempotent, and does not mind a second referee on the same fixture', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    const alex = referee(accounts, 'Alex');
    const fixture = { drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null };

    accounts.assign({ accountId: sam.id, ...fixture });
    accounts.assign({ accountId: sam.id, ...fixture });
    expect(accounts.assignmentsFor(sam.id).length).toBe(1);

    // Reassigning under pressure should not need somebody to remember to
    // unassign first, so both stand until one is taken back.
    accounts.assign({ accountId: alex.id, ...fixture });
    expect(can(accounts.actorFor(sam), 'match.control', ROUND_1)).toBe(true);
    expect(can(accounts.actorFor(alex), 'match.control', ROUND_1)).toBe(true);
    expect(accounts.listAssignments().length).toBe(2);
  });

  it('leaves an admin reaching everything and a team reaching nothing', () => {
    const accounts = open();
    const marc = accounts.createAccount({ role: 'admin', displayName: 'Marc', password: PASSWORD });
    const act = accounts.createAccount({ role: 'team', displayName: 'ACT Robotics', password: PASSWORD });
    if (!marc.ok || !act.ok) throw new Error('could not make the accounts');

    expect(can(accounts.actorFor(marc.value), 'match.control', ROUND_1)).toBe(true);
    expect(can(accounts.actorFor(marc.value), 'match.control', OTHER)).toBe(true);
    expect(accounts.hasAssignment(marc.value.id)).toBe(false);

    // A team account has no assigned-scope capabilities, so an assignment on
    // one would expand to nothing. It cannot control a match either way.
    accounts.assign({ accountId: act.value.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });
    expect(can(accounts.actorFor(act.value), 'match.control', ROUND_1)).toBe(false);
  });

  it('lists what a referee has, for a screen that shows them their day', () => {
    const accounts = open();
    const sam = referee(accounts, 'Sam');
    accounts.assign({ accountId: sam.id, drawId: 'round-1', fixtureId: 'act-robotics-v-nsw-lightning', by: null });
    accounts.assign({ accountId: sam.id, drawId: 'round-2', fixtureId: 'qld-thunder-v-vic-united', by: null });

    expect(accounts.assignmentsFor(sam.id).map((one) => one.fixtureId)).toEqual([
      'act-robotics-v-nsw-lightning',
      'qld-thunder-v-vic-united',
    ]);
    expect(accounts.listAssignments()[0]?.displayName).toBe('Sam');
  });
});
