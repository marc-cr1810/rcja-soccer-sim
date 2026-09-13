/**
 * The harness has to be right before anything it says is worth reading.
 *
 * Two kinds of check. That it measures the world rather than a robot's opinion
 * of the world, which is the whole reason to have it; and that the findings
 * fire on faults that were actually in robots in this repository, because a
 * check nobody has seen trip is a check nobody should trust.
 */

import { describe, expect, it } from 'vitest';
import {
  Sampler,
  ballBlocked,
  formatBench,
  partnerId,
  relaying,
  runBench,
  type BenchResult,
} from './bench';
import { Match, type MatchAgents } from './match';
import { referenceTeam } from './reference';
import { naiveChaser, statue } from './bots';
import { HALF_LENGTH, HALF_WIDTH } from './field';
import { PROTOCOL_VERSION } from './protocol';

describe('teamwork telemetry', () => {
  it('recognises a relayed ball in any shape, and rejects everything else', () => {
    expect(relaying({ ball: [10, 20] })).toBe(true);
    expect(relaying({ ball: { x: 10, z: 20 } })).toBe(true);
    expect(relaying({ ball: null })).toBe(false);
    expect(relaying({ role: 'striker' })).toBe(false);
    expect(relaying(undefined)).toBe(false);
    expect(relaying('garbage')).toBe(false);
  });

  it('names the other robot on the same team', () => {
    expect(partnerId('violet-1')).toBe('violet-2');
    expect(partnerId('violet-2')).toBe('violet-1');
    expect(partnerId('lime-1')).toBe('lime-2');
  });

  it('calls a robot blocked when another shell sits on the line to the ball', () => {
    const me = { id: 'violet-1', x: 0, z: 0 };
    const ball = { x: 200, z: 0, radius: 40 };
    const inTheWay = { id: 'violet-2', x: 100, z: 0, radius: 100, removed: false };
    expect(ballBlocked(me, ball, [inTheWay])).toBe(true);
  });

  it('does not call it blocked when nothing is actually between them', () => {
    const me = { id: 'violet-1', x: 0, z: 0 };
    const ball = { x: 200, z: 0, radius: 40 };
    const toOneSide = { id: 'violet-2', x: 100, z: 400, removed: false, radius: 100 };
    const beyondTheBall = { id: 'lime-1', x: 400, z: 0, removed: false, radius: 100 };
    const removed = { id: 'lime-2', x: 100, z: 0, removed: true, radius: 100 };
    expect(ballBlocked(me, ball, [toOneSide, beyondTheBall, removed])).toBe(false);
    // A robot cannot block its own view of the ball.
    expect(ballBlocked(me, ball, [{ ...me, radius: 100, removed: false }])).toBe(false);
  });
});

describe('the observer hook', () => {
  it('is called every physics step and sees the match', () => {
    let calls = 0;
    let sawBallMove = false;
    let first: number | null = null;
    const match = new Match({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
      halfSeconds: 1,
      seed: 1,
      observe: (m) => {
        calls++;
        if (first === null) first = m.world.ball.x;
        else if (m.world.ball.x !== first) sawBallMove = true;
      },
    });
    match.world.kickOff('violet');
    match.world.running = true;
    for (let i = 0; i < 200; i++) match.step(1 / 100);
    expect(calls).toBe(200);
    expect(sawBallMove).toBe(true);
  });

  it('cannot change the match it is watching', () => {
    /*
     * The hook is handed the match, so it could in principle write to it. The
     * guarantee that it does not is worth a test rather than a comment,
     * because a harness that perturbs the thing it measures is worse than no
     * harness: it produces numbers, and they are wrong.
     *
     * Played twice from the same seed, once with a watcher that reads
     * everything it can reach and once with none at all. Ideal sensors, so
     * both runs are deterministic and any difference at all is the watcher.
     */
    const play = (observe?: (m: Match) => void): string => {
      const match = new Match({
        agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
        halfSeconds: 6,
        seed: 4,
        idealSensors: true,
        observe,
      });
      match.world.kickOff('violet');
      match.world.running = true;
      for (let i = 0; i < 600; i++) match.step(1 / 100);
      return JSON.stringify({
        score: match.world.score,
        ball: match.world.ball,
        robots: match.world.robots.map((r) => [r.x, r.z, r.heading, r.removed]),
      });
    };

    let touched = 0;
    const watched = play((m) => {
      touched +=
        m.world.robots.length + m.world.ball.x + m.world.score.violet + m.world.events.length;
    });
    expect(touched).not.toBe(0);
    expect(watched).toEqual(play());
  });
});


describe('what the bench measures', () => {
  /** Play two built-in agents through the bench's own plumbing. */
  async function local(opponent: string, spawn: string | undefined): Promise<BenchResult> {
    return runBench({
      team: 'violet',
      opponent,
      seeds: [1],
      halfSeconds: 8,
      idealSensors: true,
      port: 0,
      spawn,
      connectTimeout: 20,
    });
  }

  it('needs a program to measure, and says so rather than hanging', async () => {
    await expect(
      runBench({ seeds: [1], halfSeconds: 2, connectTimeout: 1, port: 0 }),
    ).rejects.toThrow(/no program connected/);
  }, 20000);

  it('reports a scoreline, per-robot telemetry and referee calls', async () => {
    const result = await local(
      'reference',
      `node -e "${inlineAgent(0.6, 0)}" -- {url}`,
    );
    expect(result.matches).toBe(1);
    expect(result.tested).toEqual(['violet-1', 'violet-2']);
    expect(Object.keys(result.robots).sort()).toEqual([
      'lime-1', 'lime-2', 'violet-1', 'violet-2',
    ]);
    expect(result.robots['violet-1']!.tested).toBe(true);
    expect(result.robots['lime-1']!.tested).toBe(false);
    // Something moved, so distance and speed are not placeholders.
    expect(result.robots['violet-1']!.metresTravelled).toBeGreaterThan(0);
    expect(result.calls['kickoff']).toBeGreaterThan(0);
  }, 40000);

  it('notices a robot that drives itself off the field', async () => {
    /*
     * A robot running at the -z touchline with the motors mixed for pure
     * sideways travel leaves the playing area within a couple of seconds and
     * stays there, which is rule 5.7.1.6 and thirty seconds off.
     */
    const result = await local('statue', `node -e "${inlineAgent(0, 1)}" -- {url}`);
    const wanderer = result.robots['violet-1']!;
    expect(wanderer.whollyOut).toBeGreaterThan(5);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('wholly-out');
    const finding = result.findings.find((f) => f.code === 'wholly-out')!;
    expect(finding.message).toContain('5.7.1.6');
    expect(finding.advice).toBeTruthy();
  }, 40000);

  it('measures the attacking third the same way in both halves', async () => {
    /*
     * Rule 1.4/5.4 swaps the ends at half-time, so which way is "up the field"
     * is a property of the half, not of the team. The harness used to decide it
     * once per match from the team colour, which made every second-half sample
     * come out backwards: a keeper that never left its own goal measured as
     * spending half the match in the opposition's third, and the harness
     * reported a wandering keeper that was standing perfectly still.
     *
     * Both sides park, so nothing moves all match and the only thing that can
     * move these numbers is the sign.
     */
    const result = await local('statue', `node -e "${inlineAgent(0, 0)}" -- {url}`);
    const keeper = result.robots['violet-2']!;
    expect(keeper.ownThird).toBeGreaterThan(60);
    expect(keeper.attackThird).toBeLessThan(5);
    // And "up-field" is signed towards the goal being attacked, so a keeper
    // sitting on its own line reads as deeply negative rather than averaging
    // the two halves out to nothing.
    expect(keeper.meanX).toBeLessThan(-300);
    expect(result.findings.map((f) => f.code)).not.toContain('wandering-keeper');
  }, 40000);

  it('notices a program that never answers', async () => {
    // A program that connects and then says nothing is the commonest way a
    // robot is broken, and it looks exactly like a robot that is very slow.
    const result = await local('statue', `node -e "${silentAgent()}" -- {url}`);
    expect(result.robots['violet-1']!.missed).toBeGreaterThan(700);
    expect(result.findings.map((f) => f.code)).toContain('slow');
  }, 40000);

  it('sorts findings with the worst first', async () => {
    const result = await local('statue', `node -e "${inlineAgent(0, 1)}" -- {url}`);
    const rank = { high: 0, medium: 1, low: 2 };
    const order = result.findings.map((f) => rank[f.severity]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  }, 40000);
});

describe('the report', () => {
  it('reads as a page, not a dump', () => {
    const result = skeleton();
    const text = formatBench(result);
    expect(text).toContain('SCORE  3 - 1');
    expect(text).toContain('violet-1');
    // A tested robot is marked, so it is obvious which rows are yours.
    expect(text).toMatch(/\*violet-1/);
    expect(text.split('\n').every((line) => line.length < 120)).toBe(true);
  });

  it('shows movement against a baseline, and which way is better', () => {
    const before = skeleton();
    const after = skeleton();
    after.goalsFor = 9;
    after.ball.outOfPlay = 4;
    const text = formatBench(after, before);
    // More goals is better, fewer balls out of play is better, and both should
    // read as an improvement rather than just as a number that changed.
    expect(text).toMatch(/SCORE.*▲\+6/);
    expect(text).toMatch(/ball out of play:.*▲-6/);
  });

  it('says so plainly when there is nothing wrong', () => {
    expect(formatBench(skeleton())).toContain('nothing flagged');
  });
});

function skeleton(): BenchResult {
  const robot = (id: string, tested: boolean) => ({
    id,
    team: id.startsWith('violet') ? ('violet' as const) : ('lime' as const),
    tested,
    meanX: 0, meanZ: 0, possession: 10, nearBall: 30, attackThird: 10, ownThird: 20,
    outsideLines: 1, whollyOut: 0, stalled: 0, metresTravelled: 50, meanSpeed: 400,
    missed: 0, worstRun: 0, errors: 0, removals: {},
    relayed: 0, blocked: 0, covered: 0,
  });
  return {
    matches: 2,
    halfSeconds: 90,
    idealSensors: true,
    opponent: 'reference',
    tested: ['violet-1', 'violet-2'],
    goalsFor: 3,
    goalsAgainst: 1,
    calls: { kickoff: 4 },
    callsAgainstUs: {},
    ball: {
      meanX: 0, inTestedAttackThird: 20, inTestedOwnThird: 20,
      outOfPlay: 10, overSideline: 5, overEndline: 5, outWhileFast: 2, outByRobot: {},
    },
    kicks: {},
    robots: {
      'violet-1': robot('violet-1', true),
      'violet-2': robot('violet-2', true),
      'lime-1': robot('lime-1', false),
      'lime-2': robot('lime-2', false),
    },
    kickoffs: [],
    findings: [],
    scores: [
      { seed: 1, for: 3, against: 1 },
      { seed: 2, for: 3, against: 1 },
    ],
  };
}

/**
 * A robot program in one line of node, so the tests do not need Python.
 *
 * Drives with a fixed motor mix: `forward` straight ahead, `sideways` across.
 * Crude on purpose - the point is to produce a specific, reproducible fault
 * for a finding to catch, not to play football.
 */
function inlineAgent(forward: number, sideways: number): string {
  const body = `
const WebSocket = require('ws');
const url = process.argv[process.argv.length - 1];
for (const robot of [1, 2]) {
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', protocol: ${PROTOCOL_VERSION}, team: 'violet', robot, name: 'T' })));
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type !== 'sensors') return;
    const f = ${forward}, s = ${sideways};
    ws.send(JSON.stringify({ type: 'command', frame: { motors: [f - s, -f - s, -f + s, f + s], dribbler: 1 } }));
  });
  ws.on('error', () => {});
}
`;
  return body.replaceAll('\n', ' ').replaceAll('"', '\\"');
}

/** Connects, joins, and then never answers a single frame. */
function silentAgent(): string {
  const body = `
const WebSocket = require('ws');
const url = process.argv[process.argv.length - 1];
for (const robot of [1, 2]) {
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', protocol: ${PROTOCOL_VERSION}, team: 'violet', robot, name: 'T' })));
  ws.on('error', () => {});
}
`;
  return body.replaceAll('\n', ' ').replaceAll('"', '\\"');
}

// Referenced so the imports are not dead weight if a test is skipped.
void naiveChaser;
void statue;

describe('kick telemetry attributes a goal to whoever actually scored it', () => {
  /**
   * The real sequence, which is what makes this awkward: the ball crosses the
   * line, it is out of play for a fifth of a second while the referee decides,
   * and only then does the score move. So the shot that scored has already
   * been resolved as "went out of play" by the time there is a goal to credit
   * it with - and the next kick after that is the kick-OFF, taken by the team
   * that just conceded.
   */
  const shootThenConcede = (scorer: 'violet' | 'lime') => {
    const match = new Match({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
      halfSeconds: 90,
      seed: 1,
    });
    const sampler = new Sampler('violet');
    match.world.kickOff('violet');
    match.world.running = true;

    const ball = match.world.ball;
    const shooter = match.world.robots.find((r) => r.id === 'violet-1')!;
    shooter.heading = 0;

    // At rest beside violet-1, so the next tick reads as an acceleration.
    ball.x = shooter.x + 60;
    ball.z = shooter.z;
    ball.vx = 0;
    ball.vz = 0;
    sampler.step(match);

    // Struck.
    ball.vx = 2600;
    ball.vz = 0;
    sampler.step(match);

    // Over the line and out of play, still no score: the referee is deciding.
    ball.x = HALF_LENGTH + 60;
    ball.z = 0;
    sampler.step(match);

    // Two tenths later the goal is given.
    match.world.clock += 0.2;
    match.world.score[scorer] += 1;
    sampler.step(match);

    return sampler.kicks.get('violet-1');
  };

  it("credits the kick when the shooter's own team scores", () => {
    expect(shootThenConcede('violet')?.goals).toBe(1);
  });

  it('does not credit it when the other team scores', () => {
    expect(shootThenConcede('lime')?.goals ?? 0).toBe(0);
  });

  it('still resolves the kick either way, rather than losing it', () => {
    expect(shootThenConcede('violet')?.total).toBe(1);
    expect(shootThenConcede('lime')?.total).toBe(1);
  });

  it('resolves a shot that went out and was never a goal, once the wait is up', () => {
    const match = new Match({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as unknown as MatchAgents,
      halfSeconds: 90,
      seed: 1,
    });
    const sampler = new Sampler('violet');
    match.world.kickOff('violet');
    match.world.running = true;
    const ball = match.world.ball;
    const shooter = match.world.robots.find((r) => r.id === 'violet-1')!;
    shooter.heading = 0;
    ball.x = shooter.x + 60;
    ball.z = shooter.z;
    ball.vx = 0;
    ball.vz = 0;
    sampler.step(match);
    ball.vx = 2600;
    sampler.step(match);
    // Out over a sideline, and nobody scores.
    ball.x = 0;
    ball.z = HALF_WIDTH + 60;
    sampler.step(match);
    match.world.clock += 1.0;
    sampler.step(match);

    const bag = sampler.kicks.get('violet-1');
    expect(bag?.goals ?? 0).toBe(0);
    expect(bag?.total).toBe(1);
  });
});
