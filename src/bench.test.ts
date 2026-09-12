/**
 * The harness has to be right before anything it says is worth reading.
 *
 * Two kinds of check. That it measures the world rather than a robot's opinion
 * of the world, which is the whole reason to have it; and that the findings
 * fire on faults that were actually in robots in this repository, because a
 * check nobody has seen trip is a check nobody should trust.
 */

import { describe, expect, it } from 'vitest';
import { runBench, formatBench, type BenchResult } from './bench';
import { Match, type MatchAgents } from './match';
import { referenceTeam } from './reference';
import { naiveChaser, statue } from './bots';
import { PROTOCOL_VERSION } from './protocol';

describe('the observer hook', () => {
  it('is called every physics step and sees the match', () => {
    let calls = 0;
    let sawBallMove = false;
    let first: number | null = null;
    const match = new Match({
      agents: { ...referenceTeam('cyan'), ...referenceTeam('yellow') } as unknown as MatchAgents,
      halfSeconds: 1,
      seed: 1,
      observe: (m) => {
        calls++;
        if (first === null) first = m.world.ball.x;
        else if (m.world.ball.x !== first) sawBallMove = true;
      },
    });
    match.world.kickOff('cyan');
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
        agents: { ...referenceTeam('cyan'), ...referenceTeam('yellow') } as unknown as MatchAgents,
        halfSeconds: 6,
        seed: 4,
        idealSensors: true,
        observe,
      });
      match.world.kickOff('cyan');
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
        m.world.robots.length + m.world.ball.x + m.world.score.cyan + m.world.events.length;
    });
    expect(touched).not.toBe(0);
    expect(watched).toEqual(play());
  });
});


describe('what the bench measures', () => {
  /** Play two built-in agents through the bench's own plumbing. */
  async function local(opponent: string, spawn: string | undefined): Promise<BenchResult> {
    return runBench({
      team: 'cyan',
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
    expect(result.tested).toEqual(['cyan-1', 'cyan-2']);
    expect(Object.keys(result.robots).sort()).toEqual([
      'cyan-1', 'cyan-2', 'yellow-1', 'yellow-2',
    ]);
    expect(result.robots['cyan-1']!.tested).toBe(true);
    expect(result.robots['yellow-1']!.tested).toBe(false);
    // Something moved, so distance and speed are not placeholders.
    expect(result.robots['cyan-1']!.metresTravelled).toBeGreaterThan(0);
    expect(result.calls['kickoff']).toBeGreaterThan(0);
  }, 40000);

  it('notices a robot that drives itself off the field', async () => {
    /*
     * A robot running at the -z touchline with the motors mixed for pure
     * sideways travel leaves the playing area within a couple of seconds and
     * stays there, which is rule 5.7.1.6 and thirty seconds off.
     */
    const result = await local('statue', `node -e "${inlineAgent(0, 1)}" -- {url}`);
    const wanderer = result.robots['cyan-1']!;
    expect(wanderer.whollyOut).toBeGreaterThan(5);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('wholly-out');
    const finding = result.findings.find((f) => f.code === 'wholly-out')!;
    expect(finding.message).toContain('5.7.1.6');
    expect(finding.advice).toBeTruthy();
  }, 40000);

  it('notices a program that never answers', async () => {
    // A program that connects and then says nothing is the commonest way a
    // robot is broken, and it looks exactly like a robot that is very slow.
    const result = await local('statue', `node -e "${silentAgent()}" -- {url}`);
    expect(result.robots['cyan-1']!.missed).toBeGreaterThan(700);
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
    expect(text).toContain('cyan-1');
    // A tested robot is marked, so it is obvious which rows are yours.
    expect(text).toMatch(/\*cyan-1/);
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
    team: id.startsWith('cyan') ? ('cyan' as const) : ('yellow' as const),
    tested,
    meanX: 0, meanZ: 0, possession: 10, nearBall: 30, attackThird: 10, ownThird: 20,
    outsideLines: 1, whollyOut: 0, stalled: 0, metresTravelled: 50, meanSpeed: 400,
    missed: 0, worstRun: 0, errors: 0, removals: {},
  });
  return {
    matches: 2,
    halfSeconds: 90,
    idealSensors: true,
    opponent: 'reference',
    tested: ['cyan-1', 'cyan-2'],
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
      'cyan-1': robot('cyan-1', true),
      'cyan-2': robot('cyan-2', true),
      'yellow-1': robot('yellow-1', false),
      'yellow-2': robot('yellow-2', false),
    },
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
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', protocol: ${PROTOCOL_VERSION}, team: 'cyan', robot, name: 'T' })));
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
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', protocol: ${PROTOCOL_VERSION}, team: 'cyan', robot, name: 'T' })));
  ws.on('error', () => {});
}
`;
  return body.replaceAll('\n', ' ').replaceAll('"', '\\"');
}

// Referenced so the imports are not dead weight if a test is skipped.
void naiveChaser;
void statue;
