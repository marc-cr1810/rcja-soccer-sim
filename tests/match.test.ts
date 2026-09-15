/**
 * The Phase 0 gate, as a test.
 *
 * The question the whole boundary was built to ask is whether a robot that
 * sees only what a sensor sees can still play football. These run whole
 * matches and check that it does — and that a program which misbehaves takes
 * only itself down.
 */

import { Match, type MatchAgents } from '../src/match';
import { ReferenceAgent, escapeLine, locate, referenceTeam } from '../src/reference';
import type { Agent } from '../src/agent';
import type { SensorFrame } from '../src/protocol';
import { Senses, type SensedRobot } from '../src/perception';

function teams(skill = 1): MatchAgents {
  return {
    ...referenceTeam('violet', skill),
    ...referenceTeam('lime', skill),
  } as unknown as MatchAgents;
}

/** Short halves: enough football to judge, quick enough to run in a suite. */
const HALF = 90;

function play(seed: number, agents: MatchAgents = teams(), halfSeconds = HALF) {
  return new Match({ agents, halfSeconds, seed }).run();
}

// Whole live matches are CPU-heavy; under a parallel suite they can exceed
// vitest's 5 s default. Give this block room to breathe.
// Whole live matches are CPU-heavy; under a parallel suite they can exceed
// vitest's 5 s default. Give this block room to breathe.
describe('the gate: sensors-only robots play football', () => {
  it('scores goals across a range of seeds', () => {
    const totals = [1, 2, 3, 4].map((seed) => {
      const r = play(seed);
      return r.score.violet + r.score.lime;
    });
    // Not "every match has a goal" - a real match can end nil all, and a test
    // that forbids it would be testing luck. Across four matches, football
    // should have happened. (With the compass drift calibrated properly the
    // two reference teams both defend well and draws are the common result.)
    expect(totals.some((t) => t > 0)).toBe(true);
  }, 60_000);

  it('plays both halves out to the whistle', () => {
    const r = play(1);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
  });

  it('lets both sides score, rather than one always winning', () => {
    let violet = 0;
    let lime = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = play(seed);
      violet += r.score.violet;
      lime += r.score.lime;
    }
    expect(violet).toBeGreaterThan(0);
    expect(lime).toBeGreaterThan(0);
  }, 60_000);

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
  }, 120_000);
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
    agents['violet-1'] = crasher;
    const r = play(5, agents as unknown as MatchAgents);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
    expect(r.slots['violet-1']!.errors).toBeGreaterThan(100);
    expect(r.slots['lime-1']!.errors).toBe(0);
  });

  it('plays a full match out with a whole team dead', () => {
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['violet-1'] = crasher;
    agents['violet-2'] = crasher;
    const r = play(5, agents as unknown as MatchAgents, 120);
    // The match runs to the whistle, the dead side's faults are on the record,
    // and the working side's programs are untouched by any of it.
    expect(r.clock).toBeGreaterThanOrEqual(240 - 1);
    expect(r.slots['violet-1']!.errors).toBeGreaterThan(100);
    expect(r.slots['violet-2']!.errors).toBeGreaterThan(100);
    expect(r.slots['lime-1']!.errors).toBe(0);
    expect(r.slots['lime-2']!.errors).toBe(0);
  });

  it('no longer own-goals its way through a motionless opponent', () => {
    /*
     * This was the worst behaviour in the agent: against a team that did not
     * move, it put the ball in its own net nineteen times in four minutes.
     * Three causes were found and fixed - a keeper charging the ball from the
     * wrong side, the fix for that retreating straight through it, and a
     * striker trusting a position estimate that silently falls back to the
     * centre of the field - and the rolling-friction change did the rest.
     *
     * It is bounded now rather than solved: across five seeds the tally runs
     * zero to five. A robot that shoves a loose ball about will sometimes shove
     * it the wrong way, and that is football. This holds the line so it cannot
     * quietly return to nineteen.
     */
    const worst = [5, 6, 7, 8, 9].map((seed) => {
      const agents = { ...teams() } as unknown as Record<string, Agent>;
      agents['violet-1'] = crasher;
      agents['violet-2'] = crasher;
      return play(seed, agents as unknown as MatchAgents, 120).score.violet;
    });
    expect(Math.max(...worst)).toBeLessThanOrEqual(8);
  }, 30000);

  it('survives a program that returns nonsense', () => {
    const junk: Agent = {
      name: 'junk',
      tick: () => ({ motors: [NaN, Infinity, 'x' as unknown as number, 99] }),
    };
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['lime-1'] = junk;
    const r = play(6, agents as unknown as MatchAgents);
    expect(Number.isFinite(r.clock)).toBe(true);
    expect(Number.isFinite(r.score.violet)).toBe(true);
  });

  it('survives a program that never returns anything', () => {
    const mute: Agent = { name: 'mute', tick: () => null };
    const agents = { ...teams() } as unknown as Record<string, Agent>;
    agents['lime-2'] = mute;
    const r = play(7, agents as unknown as MatchAgents);
    expect(r.slots['lime-2']!.missed).toBeGreaterThan(100);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
  });
});

describe('the reference agent', () => {
  it('works out roughly where it is from walls and a compass', () => {
    const self: SensedRobot = { id: 'violet-1', team: 'violet', number: 1, x: -400, z: 250, heading: 0.4 };
    const frame = new Senses(5, 4).read({
      view: {
        clock: 0,
        playing: true,
        ball: { x: 0, z: 0 },
        robots: [self],
        kickoff: { pending: false, team: null, countdown: 0 },
      },
      self,
      wheelSpeeds: [0, 0, 0, 0],
      omega: 0,
      held: false,
      messages: [],
      attackDirection: 1,
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
    const self: SensedRobot = { id: 'violet-1', team: 'violet', number: 1, x: -300, z: 120, heading: 0 };
    const frame = new Senses(5, 4).read({
      view: {
        clock: 0,
        playing: true,
        ball: { x: 0, z: 0 },
        robots: [self],
        kickoff: { pending: false, team: null, countdown: 0 },
      },
      self,
      wheelSpeeds: [0, 0, 0, 0],
      omega: 0,
      held: false,
      messages: [],
      attackDirection: 1,
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
    const a = new ReferenceAgent({ team: 'violet', number: 1 });
    // encoders included because the yaw filter runs before the whistle check:
    // the filters have to keep tracking while the game is stopped, or they
    // restart cold at every kick-off.
    const out = a.tick({
      playing: false,
      clock: 0,
      lines: [],
      encoders: [0, 0, 0, 0],
      kickoff: { pending: false, ours: false, countdown: 0 },
    } as unknown as SensorFrame);
    expect(out.motors.every((m) => m === 0)).toBe(true);
  });

  it('beats a slowed-down copy of itself, by more the slower it is', () => {
    /*
     * This is the damping check, and only incidentally a check on the dial.
     *
     * If thinking less often makes the robot better, its controller is
     * over-reacting - and for a long time it did. The striker chose between
     * two plans on a threshold ("am I within 90 mm of the standoff point?")
     * sitting on a noisy quantity, so it chattered between them several times
     * a second, and halving the decision rate was a low-pass filter on the
     * chatter: a 0.65-skill copy beat the full-rate original by 22 goals over
     * 48 matches. The approach is continuous now, and it does not.
     *
     * Two things about how this is measured, both learned the hard way.
     *
     * Every pairing is played BOTH WAYS and the two summed. Sides are not
     * symmetric in a single match - the halves alternate who kicks off, and
     * the contact solver resolves robots in array order - and when the agent
     * was giving away every kick-off under 5.4.7 that asymmetry was worth an
     * entire goal a match, always to lime. Playing each way cancels it,
     * which is the same reason a tournament plays every pairing twice.
     *
     * And the dial is only asserted where the handicap is bigger than the
     * noise. A match is about two goals a side, so the goal difference over
     * 48 matches has a standard deviation around ten; a 0.8-skill copy is
     * within that, and asserting a sign on it is asserting a coin flip. Below
     * about 0.5 the handicap is real and the numbers are not close.
     */
    const margins = [0.35, 0.2].map((skill) => {
      let goalDifference = 0;
      for (let seed = 31; seed < 55; seed++) {
        const asViolet = new Match({
          agents: {
            ...referenceTeam('violet', 1),
            ...referenceTeam('lime', skill),
          } as unknown as MatchAgents,
          halfSeconds: HALF,
          seed,
        }).run();
        const asLime = new Match({
          agents: {
            ...referenceTeam('violet', skill),
            ...referenceTeam('lime', 1),
          } as unknown as MatchAgents,
          halfSeconds: HALF,
          seed,
        }).run();
        goalDifference += asViolet.score.violet - asViolet.score.lime;
        goalDifference += asLime.score.lime - asLime.score.violet;
      }
      return goalDifference;
    });

    /*
     * Both handicaps lose, which is the damping check and the thing this test
     * exists for. What is NOT asserted is that the heavier handicap loses by
     * more, and that is a deliberate retreat: putting the goal mouth on the
     * goal line, where the rules put it, made defending easier and compressed
     * every margin. Measured over 48 seeds each way, goal difference per seed
     * went 1.48 +/- 0.19 to 1.44 +/- 0.17 at 0.35 skill and 1.88 +/- 0.19 to
     * 1.42 +/- 0.24 at 0.20, which leaves the two indistinguishable. Asserting
     * an order between them now would be asserting noise.
     */
    for (const margin of margins) expect(margin).toBeGreaterThan(0);
  }, 120000);

  it('takes a legal kick-off', () => {
    /*
     * Rule 5.4.7 wants the ball to roll 50 mm clear of the robot, and pushing
     * it never gets there: robot and ball separate by position in this world,
     * so a shoved ball travels along with whatever is shoving it. The agent
     * used to drive through the ball with the roller off and lose the
     * kick-off every single time - 10.6 of 10.6 across five matches - which
     * hands the restart to the opposition under 5.4.7 and turns a match into
     * a queue of restarts.
     *
     * A rate, over enough seeds to be one. This asked for a clean sweep of
     * six seeds, which is a lottery rather than a test: measured across 80
     * seeds the agent gives away one kick-off in 233, and the six it happened
     * to be handed either do or do not contain that one. The bound is loose
     * enough that the occasional fumble passes and tight enough that the
     * failure this was written for - losing every kick-off - cannot.
     */
    let kickoffs = 0;
    let illegal = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const result = new Match({
        agents: {
          ...referenceTeam('violet', 1),
          ...referenceTeam('lime', 1),
        } as unknown as MatchAgents,
        halfSeconds: HALF,
        seed,
      }).run();
      kickoffs += result.calls['kickoff'] ?? 0;
      illegal += result.calls['illegal-kickoff'] ?? 0;
    }
    expect(kickoffs).toBeGreaterThan(20);
    expect(illegal * 20).toBeLessThan(kickoffs);
  }, 60000);
});

describe('refereed play: a human starts each half; everything else resolves itself', () => {
  const dt = 1 / 100;

  function refereedMatch(skill = 1) {
    return new Match({ agents: teams(skill), halfSeconds: HALF, refereed: true, seed: 1 });
  }

  it('does not start until the referee kicks off', () => {
    const m = refereedMatch();
    m.world.half = 1;
    for (let i = 0; i < 200; i++) m.step(dt);
    expect(m.world.running).toBe(false);
    expect(m.world.clock).toBe(0);
  });

  it("starts play on the referee's kick-off; after that, a goal resolves itself exactly like a self-running match", () => {
    const m = refereedMatch();
    m.world.half = 1;
    m.resetAgents();
    m.kickOff('violet');
    expect(m.world.running).toBe(true);

    // Clear the field and fire the ball at the goal - the same technique
    // world.test.ts uses to test scoring in isolation.
    m.world.robots.forEach((r) => (r.removed = true));
    m.world.ball.x = 400;
    m.world.ball.z = 0;
    m.world.ball.vx = 3000;
    for (let i = 0; i < 200; i++) m.step(dt);

    expect(m.world.score.violet).toBe(1);
    // Auto-resolved: play never stopped for a human to act on it.
    expect(m.world.running).toBe(true);
  });

  it('supports a fully-manual staged mode when autoResolve/autoDamaged are explicitly turned off', () => {
    // refereed alone no longer implies this - it's an independent knob for a
    // future staged-scenario use, not what a live refereed match wants by
    // default.
    const m = new Match({
      agents: teams(),
      halfSeconds: HALF,
      refereed: true,
      autoResolve: false,
      autoDamaged: false,
      seed: 1,
    });
    m.resetAgents();
    m.kickOff('violet');

    m.world.robots.forEach((r) => (r.removed = true));
    m.world.ball.x = 400;
    m.world.ball.z = 0;
    m.world.ball.vx = 3000;
    for (let i = 0; i < 200; i++) m.step(dt);

    // A goal stops play instead of restarting it, because this match asked
    // to be told rather than have it handled automatically.
    expect(m.world.score.violet).toBe(1);
    expect(m.world.running).toBe(false);
  });

  it('pause and resume toggle play and appear in the event log', () => {
    const m = refereedMatch();
    m.resetAgents();
    m.kickOff('violet');
    m.pause();
    expect(m.world.running).toBe(false);
    expect(m.world.events.at(-1)?.kind).toBe('paused');

    m.resume();
    expect(m.world.running).toBe(true);
    expect(m.world.events.at(-1)?.kind).toBe('resumed');
  });

  it('a stood-down robot returns automatically once its penalty is served, just like a self-running match', () => {
    const m = refereedMatch();
    m.resetAgents();
    m.kickOff('violet');
    m.removeRobot('violet-1', '5.7.1', 'Testing a manual removal.');
    const robot = m.world.robots.find((r) => r.id === 'violet-1')!;
    expect(robot.removed).toBe(true);

    // Run the penalty all the way down.
    while (robot.penaltyRemaining > 0) m.step(dt);
    expect(robot.removed).toBe(false); // autoDamaged defaults true even when refereed
  });

  it('lets the referee still remove and return a robot by hand, on top of the automatic behaviour', () => {
    const m = refereedMatch();
    m.resetAgents();
    m.kickOff('violet');
    m.removeRobot('violet-1', 'unsporting conduct', 'Deliberately obstructing an opponent.');
    const robot = m.world.robots.find((r) => r.id === 'violet-1')!;
    expect(robot.removed).toBe(true);

    // A manual return still respects the 5.7.2 stand-down period.
    expect(m.returnRobot('violet-1')).toBe(false);
    robot.penaltyRemaining = 0;
    expect(m.returnRobot('violet-1')).toBe(true);
    expect(robot.removed).toBe(false);
  });

  it('correctScore mutates the score and is recorded with a reason', () => {
    const m = refereedMatch();
    m.correctScore('violet', 2, 'Goal miscounted by the scoreboard operator.');
    expect(m.world.score.violet).toBe(2);
    expect(m.world.events.at(-1)?.kind).toBe('score-corrected');

    m.abandon('Field fault.');
    const result = m.result();
    expect(result.scoreCorrections).toEqual([
      {
        team: 'violet',
        from: 0,
        to: 2,
        reason: 'Goal miscounted by the scoreboard operator.',
        at: 0,
      },
    ]);
  });

  it('abandon ends the match and records the reason', () => {
    const m = refereedMatch();
    m.resetAgents();
    m.kickOff('violet');
    for (let i = 0; i < 50; i++) m.step(dt);
    m.abandon('Safety issue on the field.');

    expect(m.isAbandoned).toBe(true);
    expect(m.isEnded).toBe(true);
    expect(m.world.running).toBe(false);
    const result = m.result();
    expect(result.abandoned).toBe(true);
    expect(result.abandonReason).toBe('Safety issue on the field.');
  });

  it('refuses to resume a half that was never kicked off', () => {
    // Found live: clicking Resume instead of Kick Off at the top of a half
    // used to start play with every robot wherever the last half left it,
    // skipping the rule 5.4 restart placement entirely.
    const m = refereedMatch();
    m.resetAgents();
    m.resume();
    expect(m.world.running).toBe(false);

    m.kickOff('violet');
    m.pause();
    expect(m.world.running).toBe(false);
    m.resume(); // fine once this half has actually been kicked off
    expect(m.world.running).toBe(true);
  });

  it('requires a fresh kick-off after resetAgents, even mid-match', () => {
    const m = refereedMatch();
    m.resetAgents();
    m.kickOff('violet');
    m.pause();
    // A new half (or any other resetAgents boundary) needs its own kick-off.
    m.resetAgents();
    m.resume();
    expect(m.world.running).toBe(false);
  });

  it('endHalf stops just this half; endMatch stops the whole thing', () => {
    const half = refereedMatch();
    half.resetAgents();
    half.kickOff('violet');
    half.endHalf();
    expect(half.consumeHalfEndRequest()).toBe(true);
    expect(half.world.running).toBe(false);
    expect(half.isEnded).toBe(false); // only this half ends, not the match

    const whole = refereedMatch();
    whole.resetAgents();
    whole.kickOff('violet');
    whole.endMatch();
    expect(whole.consumeHalfEndRequest()).toBe(true);
    expect(whole.world.running).toBe(false);
    expect(whole.isEnded).toBe(true);
    expect(whole.isAbandoned).toBe(false); // ended on purpose, not abandoned
    expect(whole.result().abandoned).toBe(false);
  });

  it('refuses to run() itself - a refereed match is driven by referee calls', () => {
    expect(() => refereedMatch().run()).toThrow();
  });

  it('leaves an unreferereed match exactly as it always behaved', () => {
    // The compatibility-critical seam: no refereed/autoResolve/autoDamaged
    // option set at all should be indistinguishable from before this feature.
    const r = play(1);
    expect(r.clock).toBeGreaterThanOrEqual(HALF * 2 - 1);
    expect(r.abandoned).toBe(false);
    expect(r.scoreCorrections).toEqual([]);
  });
});

/**
 * Phase 4: a rehearsal is a match with a different arrangement, not a mode.
 *
 * The seat/robot split is the part worth pinning down. A seat holds a program
 * and exists for the whole run; a robot is on the field only while an
 * arrangement says so. A rehearsal that stages one robot now and two of them a
 * moment later depends on the second seat still being there, unused, in
 * between.
 */
describe('staged matches (Phase 4)', () => {
  const dt = 1 / 100;
  const alone = {
    robots: [{ id: 'violet-1', x: -800, z: 0, heading: 0, isGoalie: false }],
    ball: { x: -400, z: 0 },
  };

  it('plays one robot alone, with one program and no seats for the rest', () => {
    const m = new Match({
      agents: { 'violet-1': new ReferenceAgent({ team: 'violet', number: 1, role: 'striker' }) },
      arrangement: alone,
      halfSeconds: HALF,
      seed: 1,
    });
    m.kickOff('violet');

    expect(m.world.robots.map((r) => r.id)).toEqual(['violet-1']);
    const before = { x: m.world.robots[0]!.x, z: m.world.robots[0]!.z };
    for (let i = 0; i < 600; i++) m.step(dt);

    // It went for the ball: nothing else is on the field to push it anywhere.
    const moved = Math.hypot(m.world.robots[0]!.x - before.x, m.world.robots[0]!.z - before.z);
    expect(moved).toBeGreaterThan(100);
  });

  it('refuses a robot the arrangement puts on the field with no program to drive it', () => {
    expect(
      () =>
        new Match({
          agents: {},
          arrangement: alone,
          halfSeconds: HALF,
          seed: 1,
        }),
    ).toThrow(/no program for robot violet-1/);
  });

  it('keeps a seat while its robot is off the field, and drives it when staged back on', () => {
    const m = new Match({
      agents: {
        'violet-1': new ReferenceAgent({ team: 'violet', number: 1, role: 'striker' }),
        'lime-1': new ReferenceAgent({ team: 'lime', number: 1, role: 'striker' }),
      },
      // lime-1 has a program from the start but is not on the field yet.
      arrangement: alone,
      halfSeconds: HALF,
      seed: 1,
    });
    m.kickOff('violet');
    for (let i = 0; i < 60; i++) m.step(dt);
    expect(m.world.robots.map((r) => r.id)).toEqual(['violet-1']);

    m.stage({
      robots: [
        ...alone.robots,
        { id: 'lime-1', x: 800, z: 0, heading: Math.PI, isGoalie: false },
      ],
      ball: { x: 0, z: 0 },
    });
    const before = { x: 800, z: 0 };
    for (let i = 0; i < 600; i++) m.step(dt);

    const lime = m.world.robots.find((r) => r.id === 'lime-1')!;
    expect(Math.hypot(lime.x - before.x, lime.z - before.z)).toBeGreaterThan(100);
  });
});
