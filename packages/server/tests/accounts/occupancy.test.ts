/**
 * One robot, one place.
 *
 * The rule is an invariant rather than a setting, and its failure mode is
 * silent: every field would look correct on its own while a team's robot
 * played in two of them. That is exactly the shape of thing worth testing
 * exhaustively here, where the ledger is a pure data structure with no server,
 * no process and no clock around it.
 */

import { describe, expect, it } from 'bun:test';

import { Occupancy, numberOfSeat, robotKey } from '../../src/accounts/occupancy';

describe('reading a seat id', () => {
  it('takes the robot number from the seat, never from a fill', () => {
    expect(numberOfSeat('violet-1')).toBe(1);
    expect(numberOfSeat('violet-2')).toBe(2);
    expect(numberOfSeat('lime-1')).toBe(1);
    expect(numberOfSeat('lime-2')).toBe(2);
  });

  it('keys a robot by its team and its number', () => {
    expect(robotKey('nsw-lightning', 2)).toBe('nsw-lightning:2');
  });
});

describe('claiming a seat', () => {
  it('puts a robot somewhere and says where it is', () => {
    const occupancy = new Occupancy();
    expect(occupancy.claim('alpha', 1, 'arena-a', 'violet-1').ok).toBe(true);

    const at = occupancy.where('alpha', 1);
    expect(at?.arenaId).toBe('arena-a');
    expect(at?.seatId).toBe('violet-1');
    expect(occupancy.where('alpha', 2)).toBeNull();
  });

  it('refuses the same robot a second seat, and says where it already is', () => {
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 1, 'arena-a', 'violet-1');

    const second = occupancy.claim('alpha', 1, 'arena-b', 'lime-1');
    expect(second.ok).toBe(false);
    // The refusal has to be phraseable as a sentence, so it carries the
    // placement rather than a boolean.
    if (!second.ok) {
      expect(second.held.arenaId).toBe('arena-a');
      expect(second.held.seatId).toBe('violet-1');
    }
    // And nothing moved.
    expect(occupancy.where('alpha', 1)?.arenaId).toBe('arena-a');
  });

  it('lets a team split its two robots across two fields, which is the whole ceiling', () => {
    const occupancy = new Occupancy();
    expect(occupancy.claim('alpha', 1, 'arena-a', 'violet-1').ok).toBe(true);
    expect(occupancy.claim('alpha', 2, 'arena-b', 'violet-2').ok).toBe(true);
    expect(occupancy.all()).toHaveLength(2);
  });

  it('treats re-claiming the same seat as nothing happening', () => {
    // A team pressing Restart, or setting the same seat twice, is not a rule
    // violation and must not read like one.
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 1, 'arena-a', 'violet-1');
    expect(occupancy.claim('alpha', 1, 'arena-a', 'violet-1').ok).toBe(true);
    expect(occupancy.all()).toHaveLength(1);
  });

  it('evicts whatever was in a seat when a new robot takes it', () => {
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 1, 'arena-a', 'violet-1');
    occupancy.claim('bravo', 1, 'arena-a', 'violet-1');

    expect(occupancy.where('alpha', 1)).toBeNull();
    expect(occupancy.where('bravo', 1)?.arenaId).toBe('arena-a');
    expect(occupancy.all()).toHaveLength(1);
  });

  it('answers what is in a seat', () => {
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 2, 'arena-a', 'lime-2');
    expect(occupancy.inSeat('arena-a', 'lime-2')?.slug).toBe('alpha');
    expect(occupancy.inSeat('arena-a', 'lime-1')).toBeNull();
  });
});

describe('giving robots back', () => {
  it('frees one seat', () => {
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 1, 'arena-a', 'violet-1');

    const freed = occupancy.release('arena-a', 'violet-1');
    expect(freed?.slug).toBe('alpha');
    expect(occupancy.where('alpha', 1)).toBeNull();
    // And the robot may now go somewhere else, which is the point.
    expect(occupancy.claim('alpha', 1, 'arena-b', 'lime-1').ok).toBe(true);
  });

  it('frees every seat in an arena that has gone', () => {
    // An arena that died still holding robots would deadlock the teams whose
    // robots those are.
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 1, 'arena-a', 'violet-1');
    occupancy.claim('bravo', 1, 'arena-a', 'lime-1');
    occupancy.claim('charlie', 1, 'arena-b', 'violet-1');

    const freed = occupancy.releaseArena('arena-a');
    expect(freed.map((one) => one.slug).sort()).toEqual(['alpha', 'bravo']);
    expect(occupancy.all()).toHaveLength(1);
    expect(occupancy.where('charlie', 1)?.arenaId).toBe('arena-b');
  });

  it('takes both of a team’s robots back wherever they are, for a fixture', () => {
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 1, 'arena-a', 'violet-1');
    occupancy.claim('alpha', 2, 'arena-b', 'lime-2');
    occupancy.claim('bravo', 1, 'arena-b', 'violet-1');

    const freed = occupancy.releaseTeam('alpha');
    expect(freed.map((one) => one.arenaId).sort()).toEqual(['arena-a', 'arena-b']);
    expect(occupancy.forTeam('alpha').every((r) => r.at === null)).toBe(true);
    // A pre-emption takes the fixture's teams back and leaves everyone else be.
    expect(occupancy.where('bravo', 1)?.arenaId).toBe('arena-b');
  });

  it('reports both robots for a dashboard, seated or not', () => {
    const occupancy = new Occupancy();
    occupancy.claim('alpha', 2, 'arena-a', 'lime-2');

    const rows = occupancy.forTeam('alpha');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ number: 1, at: null });
    expect(rows[1]?.at?.seatId).toBe('lime-2');
  });
});
