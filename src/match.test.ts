/**
 * The Phase 0 gate, as a test.
 *
 * The question the whole boundary was built to ask is whether a robot that
 * sees only what a sensor sees can still play football. These run whole
 * matches and check that it does — and that a program which misbehaves takes
 * only itself down.
 */

import { describe, expect, it } from 'vitest';
import { Match, type MatchAgents } from './match';
import { ReferenceAgent, escapeLine, locate, referenceTeam } from './reference';
import type { Agent } from './agent';
import type { SensorFrame } from './protocol';
import { Senses, type SensedRobot } from './perception';

function teams(skill = 1): MatchAgents {
  return {
    ...referenceTeam('cyan', skill),
    ...referenceTeam('yellow', skill),
  } as unknown as MatchAgents;
}

/** Short halves: enough football to judge, quick enough to run in a suite. */
const HALF = 90;

function play(seed: number, agents: MatchAgents = teams(), halfSeconds = HALF) {
  return new Match({ agents, halfSeconds, seed }).run();
}

describe('the gate: sensors-only robots play football', () => {
  it('scores goals across a range of seeds', () => {
    const totals = [1, 2, 3, 4].map((seed) => {
      const r = play(seed);
      return r.score.cyan + r.score.yellow;
    });
    // Not "every match has a goal" - a real match can end nil all, and a test
    // that forbids it would be testing luck. Across four matches, football
    // should have happened.
    expect(totals.reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
  });

  it('plays both halves out to the whistle', () => {
    const r = play(1);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
  });

  it('lets both sides score, rather than one always winning', () => {
    let cyan = 0;
    let yellow = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = play(seed);
      cyan += r.score.cyan;
      yellow += r.score.yellow;
    }
    expect(cyan).toBeGreaterThan(0);
    expect(yellow).toBeGreaterThan(0);
  });

  it('runs the referee: the detectors fire during real play', () => {
    const m = new Match({ agents: teams(), halfSeconds: HALF, seed: 3 });
    m.run();
    // world.events is a 60-entry ring buffer for the referee panel, so this
    // is the tail of the match rather than all of it. Something should have
    // been called.
    expect(m.world.events.length).toBeGreaterThan(0);
  });

  it('reports clean connections for programs that behave', () => {
    const r = play(1);
    for (const slot of Object.values(r.slots)) {
      expect(slot.errors).toBe(0);
      // One missed cycle at each kick-off: a slot takes before it sends, so
      // the first cycle after a reset has nothing to take yet.
      expect(slot.missed).toBeLessThanOrEqual(4);
    }
  });

  it('is fast enough to run a tournament', () => {
    const started = Date.now();
    play(1, teams(), 300);
    const wall = (Date.now() - started) / 1000;
    // Ten minutes of football in a fraction of that. The number that matters
    // for a 380-match round robin is this one.
    expect(wall).toBeLessThan(20);
    expect(600 / wall).toBeGreaterThan(30);
  });
});

describe('a match can be replayed', () => {
  it('gives the same result for the same seed', () => {
    const a = play(11);
    const b = play(11);
    expect(b.score).toEqual(a.score);
    expect(b.goals).toEqual(a.goals);
  });

  it('gives a different match for a different seed', () => {
    const results = [21, 22, 23, 24].map((s) => JSON.stringify(play(s).goals));
    expect(new Set(results).size).toBeGreaterThan(1);
  });
});

describe('a misbehaving program only hurts itself', () => {
  const crasher: Agent = {
    name: 'crasher',
    tick() {
      throw new Error('IndexError: list index out of range');
    },
  };

  it('plays on when one robot crashes every tick', () => {
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['cyan-1'] = crasher;
    const r = play(5, agents as unknown as MatchAgents);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
    expect(r.slots['cyan-1']!.errors).toBeGreaterThan(100);
    expect(r.slots['yellow-1']!.errors).toBe(0);
  });

  it('plays a full match out with a whole team dead', () => {
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['cyan-1'] = crasher;
    agents['cyan-2'] = crasher;
    const r = play(5, agents as unknown as MatchAgents, 120);
    // The match runs to the whistle, the dead side's faults are on the record,
    // and the working side's programs are untouched by any of it.
    expect(r.clock).toBeGreaterThanOrEqual(240 - 1);
    expect(r.slots['cyan-1']!.errors).toBeGreaterThan(100);
    expect(r.slots['cyan-2']!.errors).toBeGreaterThan(100);
    expect(r.slots['yellow-1']!.errors).toBe(0);
    expect(r.slots['yellow-2']!.errors).toBe(0);
  });

  /*
   * KNOWN LIMITATION, recorded rather than asserted away.
   *
   * Against a team that does not move at all, the reference agent sometimes
   * scores repeatedly into its own net - on seed 5 it managed nineteen in four
   * minutes, while seeds 6 and 7 behave. Two causes have been found and fixed
   * (a keeper that charged the ball from the wrong side, then one that
   * retreated straight through it, and a striker that trusted a position
   * estimate which silently falls back to the centre of the field). Something
   * in this configuration still repeats.
   *
   * It is a fault in the reference opponent, not in the boundary or the match
   * loop: the world, the referee and the agent host all behave correctly
   * throughout, and it does not appear when both sides play. It is exactly
   * what the ladder harness is for, and it is the first thing to chase next.
   */
  it('does not yet handle a motionless opponent gracefully', () => {
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['cyan-1'] = crasher;
    agents['cyan-2'] = crasher;
    const own = play(5, agents as unknown as MatchAgents, 120).score.cyan;
    // Documenting the bug at its current size, so a fix shows up as a failure
    // here and nobody has to remember this was ever a problem.
    expect(own).toBeGreaterThan(5);
  });

  it('survives a program that returns nonsense', () => {
    const junk: Agent = {
      name: 'junk',
      tick: () => ({ motors: [NaN, Infinity, 'x' as unknown as number, 99] }),
    };
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['yellow-1'] = junk;
    const r = play(6, agents as unknown as MatchAgents);
    expect(Number.isFinite(r.clock)).toBe(true);
    expect(Number.isFinite(r.score.cyan)).toBe(true);
  });

  it('survives a program that never returns anything', () => {
    const mute: Agent = { name: 'mute', tick: () => null };
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['yellow-2'] = mute;
    const r = play(7, agents as unknown as MatchAgents);
    expect(r.slots['yellow-2']!.missed).toBeGreaterThan(100);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
  });
});

describe('the reference agent', () => {
  it('works out roughly where it is from walls and a compass', () => {
    const self: SensedRobot = { id: 'cyan-1', team: 'cyan', number: 1, x: -400, z: 250, heading: 0.4 };
    const frame = new Senses(5, 4).read({
      view: {
        clock: 0,
        playing: true,
        ball: { x: 0, z: 0 },
        robots: [self],
        kickoff: { pending: false, team: null },
      },
      self,
      wheelSpeeds: [0, 0, 0, 0],
      held: false,
      messages: [],
      dt: 0.02,
    });
    const me = locate(frame);
    expect(Math.abs(me.x - self.x)).toBeLessThan(60);
    expect(Math.abs(me.z - self.z)).toBeLessThan(60);
    // Confidence is full only when opposite beams agree. At this heading one
    // pair grazes and returns nothing, so the estimate is good but unverified -
    // exactly the distinction the cross-check exists to draw.
    expect(me.confidence).toBeGreaterThan(0);
  });

  it('is confident when it can check one wall against the opposite one', () => {
    const self: SensedRobot = { id: 'cyan-1', team: 'cyan', number: 1, x: -300, z: 120, heading: 0 };
    const frame = new Senses(5, 4).read({
      view: {
        clock: 0,
        playing: true,
        ball: { x: 0, z: 0 },
        robots: [self],
        kickoff: { pending: false, team: null },
      },
      self,
      wheelSpeeds: [0, 0, 0, 0],
      held: false,
      messages: [],
      dt: 0.02,
    });
    const me = locate(frame);
    expect(me.confidence).toBe(1);
    expect(Math.abs(me.x - self.x)).toBeLessThan(60);
  });

  it('reads the line sensors and runs inwards', () => {
    // Sitting on the +z touchline, the escape should have a -z component.
    const lines: SensorFrame['lines'] = [
      { bearing: Math.PI / 2, surface: 'line', value: 0.86 },
      { bearing: 0, surface: 'carpet', value: 0.22 },
    ];
    const escape = escapeLine({ lines } as SensorFrame);
    expect(escape).not.toBeNull();
    expect(Math.sin(escape!)).toBeLessThan(-0.5);
  });

  it('has nothing to escape in open field', () => {
    const lines: SensorFrame['lines'] = [{ bearing: 0, surface: 'carpet', value: 0.22 }];
    expect(escapeLine({ lines } as SensorFrame)).toBeNull();
  });

  it('stands still before the whistle', () => {
    const a = new ReferenceAgent({ team: 'cyan', number: 1 });
    const out = a.tick({ playing: false, clock: 0, lines: [] } as unknown as SensorFrame);
    expect(out.motors.every((m) => m === 0)).toBe(true);
  });

  /*
   * KNOWN ISSUE: the skill dial does not currently make a weaker robot.
   *
   * `skill` slows the drive and runs the decision loop at a fraction of the
   * rate. It used to give the full-strength robot a mild edge - +13 goals over
   * sixteen matches. After the kick-off and localisation fixes it reversed, and
   * the 0.35 version now wins outright: in a nine-entry ladder it finished
   * first, ahead of the full-strength one.
   *
   * The reason is worth more than the dial. This agent's control law is
   * under-damped - it reacts to a noisy 16-sector bearing every cycle and
   * overshoots - so thinking less often is a fix rather than a handicap.
   *
   * The work is therefore to damp the controller, not to re-tune the dial.
   * Until that lands, a ladder of practice opponents cannot be built by turning
   * skill down, and this records the inversion so a fix shows up here.
   */
  it('is currently no better than a slowed-down version of itself', () => {
    let goalDifference = 0;
    for (let seed = 31; seed <= 46; seed++) {
      const agents = {
        ...referenceTeam('cyan', 1),
        ...referenceTeam('yellow', 0.35),
      } as unknown as MatchAgents;
      const r = new Match({ agents, halfSeconds: HALF, seed }).run();
      goalDifference += r.score.cyan - r.score.yellow;
    }
    // Documenting the inversion, not endorsing it. Damping the controller
    // should turn this positive and make this test fail.
    expect(goalDifference).toBeLessThanOrEqual(0);
  }, 30000);
});
