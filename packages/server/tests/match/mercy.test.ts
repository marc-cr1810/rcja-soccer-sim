/**
 * The mercy rule: a match is over when one side is too far ahead.
 *
 * Not a rule number — the RCJA rules have no mercy rule, and this is a venue's
 * decision about its own day. It is here because of what bounds it: the
 * pre-game penalty clock adds a goal a minute to the team that turned up, and
 * without a ceiling a fixture whose opponent is never coming holds a pitch all
 * afternoon. The ceiling turned out to be a rule about football, so it lives in
 * `match.ts` and applies to every match this repository plays except a practice
 * field.
 *
 * Which exposed something. `match.isEnded` was honoured by exactly one of the
 * loops that play football — `playRefereed` — because until now only a referee
 * could end a match early, and a referee only ever drove that loop. `run()`,
 * `playFast` and the realtime loop all ran to the clock and nothing else. Half
 * of this file is about those three, because a rule that ends a match is worth
 * nothing in a loop that does not ask.
 */

import { Match, DEFAULT_MERCY_MARGIN, PHYSICS_HZ, type MatchAgents } from '../../src/match/match';
import { MatchServer } from '../../src/infra/server';
import { DEFAULT_OPTIONS } from '../../src/league/bench';
import { runLadder, type Entry } from '../../src/league/ladder';
import { referenceTeam, ReferenceAgent } from '../../src/infra/reference';
import { statue } from '../../src/match/bots';
import type { ActuatorFrame } from '../../src/match/protocol';
import type { Transport } from '../../src/match/agent';

const dt = 1 / PHYSICS_HZ;
const HALF = 20;

function agents(): MatchAgents {
  return { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents;
}

const servers: MatchServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/**
 * A run-away scoreline, one goal at a time.
 *
 * Through the world's own score rather than `correctScore`, so this is the
 * goal path — the one a real blowout takes — rather than the referee's.
 */
function runaway(target = DEFAULT_MERCY_MARGIN) {
  return (match: Match): void => {
    if (match.world.clock > 0.5 && match.world.score.violet < target) {
      match.world.score.violet++;
    }
  };
}

describe('the mercy rule', () => {
  it('ends a headless match at a ten-goal difference, without abandoning it', () => {
    const result = new Match({
      agents: agents(),
      halfSeconds: HALF,
      seed: 5,
      observe: runaway(),
    }).run();

    expect(result.score.violet).toBe(DEFAULT_MERCY_MARGIN);
    expect(result.mercy).toBe(true);
    // The distinction the whole design hangs off: `runDraw` throws on an
    // abandoned leg and leaves the fixture unwritten, and this is a finished
    // match that counts.
    expect(result.abandoned).toBe(false);
    // Ten goals at one a physics step, half a second in — nowhere near the
    // two twenty-second halves it was told to play.
    expect(result.clock).toBeLessThan(HALF);
    expect(result.events.some((e) => e.kind === 'mercy')).toBe(true);
  });

  it('plays the whole match out when the margin is turned off', () => {
    const result = new Match({
      agents: agents(),
      halfSeconds: HALF,
      seed: 5,
      mercyMargin: null,
      observe: runaway(40),
    }).run();

    expect(result.mercy).toBeUndefined();
    expect(result.clock).toBeGreaterThanOrEqual(HALF * 2);
    expect(result.score.violet).toBeGreaterThan(DEFAULT_MERCY_MARGIN);
  });

  it('fires on a referee correction as well as on a goal', () => {
    // Two things move a score, and a rule that only watched one of them would
    // let a referee correct a match straight past its own ending.
    const match = new Match({ agents: agents(), halfSeconds: HALF, seed: 5, refereed: true });
    match.resetAgents();
    match.kickOff('violet');
    expect(match.isEnded).toBe(false);

    match.correctScore('lime', 10, 'Ten goals missed while the camera was down.');
    expect(match.isEnded).toBe(true);
    expect(match.isMercied).toBe(true);
    expect(match.world.running).toBe(false);
    expect(match.result().abandoned).toBe(false);
  });

  it('says it once, however far ahead the score goes', () => {
    const match = new Match({ agents: agents(), halfSeconds: HALF, seed: 5, observe: runaway(14) });
    match.resetAgents();
    match.kickOff('violet');
    for (let i = 0; i < 200; i++) match.step(dt);
    expect(match.result().events.filter((e) => e.kind === 'mercy')).toHaveLength(1);
  });

  it('starts a match already over when the penalties alone reach the margin', () => {
    // What a fixture nobody turned up for looks like if it ever reaches an
    // arena at all. The hub decides these without spawning anything, so this is
    // the safety net rather than the path — but a match that cannot be won
    // should not kick off, wherever the scoreline came from.
    const match = new Match({
      agents: agents(),
      halfSeconds: HALF,
      seed: 5,
      penalties: { violet: 10, lime: 0, reason: 'Lime did not arrive.' },
    });
    expect(match.isEnded).toBe(true);
    const result = match.result();
    expect(result.score).toEqual({ violet: 10, lime: 0 });
    // The reason travels with it: a 10-0 with nothing behind it is unreadable.
    expect(result.scoreCorrections).toHaveLength(1);
    expect(result.scoreCorrections[0]!.reason).toBe('Lime did not arrive.');
    // And no phantom goals, which is what a correction used to leave behind.
    expect(result.goals).toEqual([]);
  });
});

describe('the rigs that measure rather than play', () => {
  /** The reference team against a bot that never moves: all the goals go one way. */
  function rig(): Entry[] {
    return [
      {
        name: 'reference',
        origin: 'generated',
        make: (team) => [
          new ReferenceAgent({ team, number: 1, role: 'striker' }),
          new ReferenceAgent({ team, number: 2, role: 'goalie' }),
        ],
      },
      { name: 'statue', origin: 'generated', make: () => [statue, statue] },
    ];
  }

  it('the ladder plays every match out, and cuts them short only if asked', () => {
    // All three jobs in `ladder.ts`'s header are measurements, and a cap
    // truncates every one: a ladder of deliberately poor robots is *meant* to
    // produce blowouts, because that is where the rule detectors are exercised.
    const open = runLadder(rig(), { rounds: 1, halfSeconds: 45, seed: 1 });
    expect(open.goalsPerMatch).toBeGreaterThan(1);

    // The same ladder with a one-goal margin ends each match at the first goal,
    // which is what proves the default is genuinely off rather than merely
    // never reached by these two.
    const capped = runLadder(rig(), { rounds: 1, halfSeconds: 45, seed: 1, mercyMargin: 1 });
    expect(capped.goalsPerMatch).toBeLessThanOrEqual(1);
    expect(capped.goalsPerMatch).toBeLessThan(open.goalsPerMatch);
  }, 60_000);

  it('the bench defaults to no mercy rule at all', () => {
    // A venue plays under the rule; an instrument measuring the venue does not.
    expect(DEFAULT_OPTIONS.mercyMargin).toBeNull();
  });
});

describe('the loops that never asked whether a match had ended', () => {
  it('the headless loop stops, and plays no second half', () => {
    const halves = new Set<number>();
    const result = new Match({
      agents: agents(),
      halfSeconds: HALF,
      seed: 5,
      observe: (m) => {
        halves.add(m.world.half);
        runaway()(m);
      },
    }).run();

    expect(result.mercy).toBe(true);
    expect([...halves]).toEqual([1]);
  });

  it('the fast loop stops', async () => {
    // `playFast` is the path taken when programs are on a socket, so it needs
    // one transport to exist — it does not need one to answer.
    const silent: Transport = {
      name: 'silent',
      send: () => {},
      take: (): ActuatorFrame | null => null,
      reset: () => {},
      close: () => {},
      connected: true,
    };
    const server = new MatchServer({ port: 0, realtime: false });
    servers.push(server);

    const result = await server.play({
      agents: agents(),
      transports: { 'violet-1': silent },
      halfSeconds: HALF,
      seed: 5,
      observe: runaway(),
    });
    expect(result.mercy).toBe(true);
    expect(result.clock).toBeLessThan(HALF);
  }, 30_000);

  it('the realtime loop stops, rather than watching out the clock', async () => {
    // The one that would be most obviously wrong in a hall: a 10-0 on the
    // screen and nine more minutes of it.
    const server = new MatchServer({ port: 0, realtime: true, kickoffCountdown: 0, viewHz: 100 });
    servers.push(server);

    const began = Date.now();
    const result = await server.play({
      agents: agents(),
      halfSeconds: HALF,
      seed: 5,
      observe: runaway(),
    });
    expect(result.mercy).toBe(true);
    // Two twenty-second halves of wall-clock is forty seconds; this ends in
    // about one. Anything under a quarter of the match proves the loop asked.
    expect(Date.now() - began).toBeLessThan(HALF * 1000);
  }, 60_000);
});
