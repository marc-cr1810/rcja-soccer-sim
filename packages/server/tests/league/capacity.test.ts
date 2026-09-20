/**
 * The budget: what a machine can hold, and what a venue is allowed to set.
 *
 * All of this is arithmetic over two inputs — the hardware and the settings —
 * which is exactly why it is worth testing here rather than discovering at a
 * venue. The numbers it produces are the ones an organiser uses to decide how
 * many teams can rehearse at once, and the failure mode of getting them wrong
 * is either turning teams away for nothing or a schedule that slips during
 * finals.
 */

import { describe, expect, it } from 'bun:test';

import { arenaGrant, refuseToStart, resolveBudget, type Machine } from '../../src/league/capacity';
import { defaultSettings, loadSettings, saveSettings, type LeagueSettings } from '../../src/infra/settings';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The machine the recorded measurements were taken on. */
const MEASURED: Machine = {
  cores: 22,
  memoryMb: 31 * 1024,
  sandboxUnavailable: null,
};

function settingsWith(changes: (s: LeagueSettings) => void): LeagueSettings {
  const settings = defaultSettings();
  changes(settings);
  return settings;
}

describe('what a machine can guarantee', () => {
  it('agrees with the figure the design was written around', () => {
    const budget = resolveBudget(defaultSettings(), MEASURED);
    // END-STATE.md says ten arenas at the defaults on this hardware, and that
    // number is quoted at venues. If this moves, that document is now wrong.
    expect(budget.guaranteed).toBe(10);
    expect(budget.limitedBy).toBe('cpu');
  });

  it('counts four seats and the arena process, not four seats', () => {
    const grant = arenaGrant(defaultSettings());
    expect(grant.arenaCores).toBeGreaterThan(2);
    expect(grant.arenaMemoryMb).toBeGreaterThan(4 * 512);
  });

  it('gives a smaller grant more room, proportionally', () => {
    const half = resolveBudget(
      settingsWith((s) => (s.arenas.seatCpuPercent = 25)),
      MEASURED,
    );
    expect(half.guaranteed).toBeGreaterThan(resolveBudget(defaultSettings(), MEASURED).guaranteed);
  });

  it('says so when nothing is enforcing the grant', () => {
    const budget = resolveBudget(defaultSettings(), {
      ...MEASURED,
      sandboxUnavailable: 'bubblewrap (bwrap) required but not available on this server',
    });
    // A capacity computed from grants nothing holds anyone to is arithmetic,
    // not a promise, and the console has to say which it is.
    expect(budget.enforced).toBe(false);
    expect(budget.warnings.join(' ')).toContain('unenforced');
  });

  it('refuses a machine that cannot honour even one arena', () => {
    const tiny = resolveBudget(defaultSettings(), { cores: 1, memoryMb: 512, sandboxUnavailable: null });
    expect(tiny.guaranteed).toBe(0);
    expect(refuseToStart(tiny)).not.toBeNull();
  });
});

describe('what a venue is allowed to set', () => {
  it('accepts a ceiling above what the machine guarantees, and names the consequence', () => {
    const over = resolveBudget(
      settingsWith((s) => (s.arenas.max = 14)),
      MEASURED,
    );
    expect(over.max).toBe(14);
    const said = over.warnings.join(' ');
    // A warning that grades the risk ("high") tells an organiser nothing they
    // can act on. One that names what happens does.
    expect(said).toContain('exceeds what this machine can guarantee');
    expect(said).toContain('slower than wall-clock');
    expect(said).toContain('Practice arenas are shed first');
  });

  it('derives practice capacity, and never lets policy add to it', () => {
    const budget = resolveBudget(
      settingsWith((s) => {
        s.arenas.max = 8;
        s.arenas.concurrentFixtures = 2;
        s.practice.max = 50;
      }),
      MEASURED,
    );
    // Capacity is arenas.max less what the schedule is using. `practice.max`
    // may only ever subtract from that — a second number able to contradict
    // the first is the thing this codebase keeps refusing.
    expect(budget.practice).toBe(6);
    expect(budget.warnings.join(' ')).toContain('Policy may only subtract');
  });

  it('lets policy subtract', () => {
    const budget = resolveBudget(
      settingsWith((s) => {
        s.arenas.max = 8;
        s.arenas.concurrentFixtures = 2;
        s.practice.max = 2;
      }),
      MEASURED,
    );
    expect(budget.practice).toBe(2);
  });

  it('closes practice entirely when asked', () => {
    const budget = resolveBudget(
      settingsWith((s) => (s.practice.open = false)),
      MEASURED,
    );
    expect(budget.practice).toBe(0);
    // Fixtures are untouched: closing practice during finals is the point.
    expect(budget.fixtures).toBeGreaterThan(0);
  });

  it('holds fixture slots back, so a fixture never queues behind a rehearsal', () => {
    const budget = resolveBudget(
      settingsWith((s) => {
        s.arenas.max = 3;
        s.arenas.concurrentFixtures = 2;
      }),
      MEASURED,
    );
    expect(budget.fixtures).toBe(2);
    expect(budget.practice).toBe(1);
  });
});

describe('league.json', () => {
  function dir(): string {
    return mkdtempSync(join(tmpdir(), 'rcja-settings-'));
  }

  it('is the defaults when there is no file', () => {
    const { settings, complaints, sources } = loadSettings(dir());
    expect(complaints).toEqual([]);
    expect(settings.arenas.max).toBeNull();
    expect(sources['arenas.max']).toBe('default');
  });

  it('round-trips what it saves', () => {
    const where = dir();
    const written = settingsWith((s) => {
      s.arenas.max = 6;
      s.practice.idleMins = 45;
    });
    saveSettings(where, written);
    const { settings, sources } = loadSettings(where);
    expect(settings.arenas.max).toBe(6);
    expect(settings.practice.idleMins).toBe(45);
    expect(sources['arenas.max']).toBe('file');
  });

  it('starts anyway when the file is broken, and says what it ignored', () => {
    const where = dir();
    writeFileSync(join(where, 'league.json'), '{ "arenas": { "seatCpuPercent": "loads" } }');
    const { settings, complaints } = loadSettings(where);
    // An organiser with a typo at eleven at night should get a server that
    // starts and a line saying what it ignored, not a server that will not
    // come up.
    expect(settings.arenas.seatCpuPercent).toBe(50);
    expect(complaints.join(' ')).toContain('seatCpuPercent');
  });

  it('clamps a value that is out of range rather than obeying it', () => {
    const where = dir();
    writeFileSync(join(where, 'league.json'), '{ "arenas": { "seatCpuPercent": 5000 } }');
    const { settings, complaints } = loadSettings(where);
    expect(settings.arenas.seatCpuPercent).toBe(400);
    expect(complaints.join(' ')).toContain('must be between');
  });

  it('keeps the mercy rule when a file says nothing about it', () => {
    const where = dir();
    // The one setting where "absent" and "null" are different answers.
    // `autoStartMins` absent means no timer, which is right; `mercyMargin`
    // absent has to mean ten, or a venue that never opened this file would
    // silently have no mercy rule at all — read with the same helper, it did.
    writeFileSync(join(where, 'league.json'), '{ "arenas": { "max": 6 } }');
    const { settings, sources, complaints } = loadSettings(where);
    expect(settings.rules.mercyMargin).toBe(10);
    expect(sources['rules.mercyMargin']).toBe('default');
    expect(settings.pregame.autoStartMins).toBeNull();
    expect(complaints).toEqual([]);
  });

  it('lets a venue turn the mercy rule off, and say so on purpose', () => {
    const where = dir();
    writeFileSync(join(where, 'league.json'), '{ "rules": { "mercyMargin": null } }');
    const off = loadSettings(where);
    expect(off.settings.rules.mercyMargin).toBeNull();
    expect(off.sources['rules.mercyMargin']).toBe('file');

    writeFileSync(join(where, 'league.json'), '{ "rules": { "mercyMargin": 6 } }');
    expect(loadSettings(where).settings.rules.mercyMargin).toBe(6);
  });

  it('reads the held-ball window, keeps it when the file says nothing, and clamps a silly one', () => {
    const where = dir();
    // Absent has to mean the simulator's eight, not zero: a venue that never
    // opened this file must not silently be running with the test switched
    // off, which is exactly the state that let a robot sit on the ball for a
    // whole match before it existed.
    writeFileSync(join(where, 'league.json'), '{ "arenas": { "max": 6 } }');
    const absent = loadSettings(where);
    expect(absent.settings.rules.heldBallSeconds).toBe(8);
    expect(absent.sources['rules.heldBallSeconds']).toBe('default');
    expect(absent.complaints).toEqual([]);

    // Zero is a venue saying it on purpose, not a missing value.
    writeFileSync(join(where, 'league.json'), '{ "rules": { "heldBallSeconds": 0 } }');
    const off = loadSettings(where);
    expect(off.settings.rules.heldBallSeconds).toBe(0);
    expect(off.sources['rules.heldBallSeconds']).toBe('file');

    writeFileSync(join(where, 'league.json'), '{ "rules": { "heldBallSeconds": 600 } }');
    const silly = loadSettings(where);
    expect(silly.settings.rules.heldBallSeconds).toBe(60);
    expect(silly.complaints.join(' ')).toContain('heldBallSeconds');
  });

  it('reads the pre-game clock, and clamps a silly one', () => {
    const where = dir();
    writeFileSync(
      join(where, 'league.json'),
      '{ "pregame": { "autoStartMins": 15, "penaltyPerMin": 99 } }',
    );
    const { settings, complaints } = loadSettings(where);
    expect(settings.pregame.autoStartMins).toBe(15);
    expect(settings.pregame.penaltyPerMin).toBe(10);
    expect(complaints.join(' ')).toContain('penaltyPerMin');
  });

  it('lets a flag override the file for one run, and says which it was', () => {
    const where = dir();
    saveSettings(where, settingsWith((s) => (s.arenas.max = 6)));
    const { settings, sources } = loadSettings(where, { arenasMax: 2 });
    expect(settings.arenas.max).toBe(2);
    expect(sources['arenas.max']).toBe('flag');
  });

  it('loads home and away objects with name and bots in demo settings', () => {
    const where = dir();
    writeFileSync(
      join(where, 'league.json'),
      JSON.stringify({
        demo: {
          on: true,
          home: { name: 'TeamRef', bots: 'reference' },
          away: { name: 'Lightning', bots: 'nsw-lightning' },
        },
      }),
    );
    const { settings, complaints } = loadSettings(where);
    expect(complaints).toEqual([]);
    expect(settings.demo.home).toBe('TeamRef');
    expect(settings.demo.homeBots).toBe('reference');
    expect(settings.demo.away).toBe('Lightning');
    expect(settings.demo.awayBots).toBe('nsw-lightning');
  });

  it('loads bots object and allows flag overrides for demo team bots', () => {
    const where = dir();
    writeFileSync(
      join(where, 'league.json'),
      JSON.stringify({
        demo: {
          on: true,
          bots: { home: 'reference', away: 'example' },
        },
      }),
    );
    const { settings } = loadSettings(where, { demoAwayBots: 'rehearsal' });
    expect(settings.demo.homeBots).toBe('reference');
    expect(settings.demo.awayBots).toBe('rehearsal');
  });

  it('loads demo.teams array and syncs home/away defaults', () => {
    const where = dir();
    writeFileSync(
      join(where, 'league.json'),
      JSON.stringify({
        demo: {
          on: true,
          teams: [
            { name: 'Red Dragons', bots: 'champion' },
            'Blue Ocean',
            { name: 'Green Forest' },
          ],
        },
      }),
    );
    const { settings, complaints } = loadSettings(where);
    expect(complaints).toEqual([]);
    expect(settings.demo.teams).toEqual([
      { name: 'Red Dragons', bots: 'champion' },
      'Blue Ocean',
      { name: 'Green Forest' },
    ]);
    expect(settings.demo.home).toBe('Red Dragons');
    expect(settings.demo.homeBots).toBe('champion');
    expect(settings.demo.away).toBe('Blue Ocean');
  });

  it('allows demo.teams flag override', () => {
    const where = dir();
    const { settings } = loadSettings(where, { demoTeams: ['Team Alpha', 'Team Beta'] });
    expect(settings.demo.teams).toEqual(['Team Alpha', 'Team Beta']);
    expect(settings.demo.home).toBe('Team Alpha');
    expect(settings.demo.away).toBe('Team Beta');
  });
});
