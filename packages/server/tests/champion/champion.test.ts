/**
 * Comprehensive Unit and Benchmark Tests for Champion Soccer Agent.
 */

import { describe, expect, it } from 'bun:test';
import {
  BallEstimator,
  LeastSquaresLocator,
  steerClearOfEdges,
  championTeam,
  shotIsOpen,
  passIsOpen,
  CONTACT_RANGE,
  EDGE_STOP_X,
  EDGE_STOP_Z,
} from '../../src/champion';
import { Match, type MatchAgents } from '../../src/match/match';
import { referenceTeam } from '../../src/infra/reference';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/sim/field';
import type { SensorFrame } from '../../src/match/protocol';

function makeFrame(overrides: Partial<SensorFrame> = {}): SensorFrame {
  return {
    time: 0,
    robot: 1,
    team: 'violet',
    attackDirection: 1,
    start: true,
    ball: null,
    compass: { heading: 0 },
    gyro: { rate: 0 },
    lines: [],
    range: { front: null, back: null, left: null, right: null },
    encoders: [0, 0, 0, 0],
    camera: {
      goals: { cyan: null, yellow: null },
      goalBlobs: { cyan: [], yellow: [] },
      ball: null,
      fresh: true,
    },
    ballGate: { held: false },
    messages: [],
    ...overrides,
  };
}

describe('Champion AI Estimator', () => {
  it('LeastSquaresLocator gates sonar reflections from obstacles and preserves position', () => {
    const loc = new LeastSquaresLocator();
    // Prior sighting from camera of yellow goal at (915, 0) from robot at (0, 0)
    const f1 = makeFrame({
      camera: {
        goals: {
          cyan: null,
          yellow: { bearing: 0, range: 915 },
        },
        goalBlobs: { cyan: [], yellow: [] },
        ball: null,
        fresh: true,
      },
      range: {
        front: 1215 - 110, // clear to yellow wall at +1215
        back: 1215 - 110,  // clear to cyan wall at -1215
        left: 910 - 110,   // clear to +z wall at +910
        right: 910 - 110,  // clear to -z wall at -910
      },
    });

    const p1 = loc.update(f1, 0);
    expect(p1.x).toBeCloseTo(0, 50);
    expect(p1.z).toBeCloseTo(0, 50);
    expect(loc.obstacles.length).toBe(0);

    // Now an obstacle (opponent robot) stands 300 mm in front of this robot
    const f2 = makeFrame({
      time: 0.02,
      camera: {
        goals: {
          cyan: null,
          yellow: { bearing: 0, range: 915 },
        },
        goalBlobs: { cyan: [], yellow: [] },
        ball: null,
        fresh: true,
      },
      range: {
        front: 300, // echo arrives way earlier than 1215 - 110 = 1105 mm!
        back: 1215 - 110,
        left: 910 - 110,
        right: 910 - 110,
      },
    });

    const p2 = loc.update(f2, 0);
    // Position should NOT jump to x = 805 mm! It should stay at 0 mm!
    expect(p2.x).toBeCloseTo(0, 100);
    // Obstacle should be detected and recorded!
    expect(loc.obstacles.length).toBe(1);
    expect(loc.obstacles[0]!.range).toBe(300);
  });

  it('BallEstimator computes velocity and predicts future trajectory under drag', () => {
    const ball = new BallEstimator();
    const f1 = makeFrame({
      time: 0.0,
      ball: { bearing: 0, strength: 0.5 },
    });
    ball.update(f1, 0, 0, 0);
    expect(ball.seen).toBe(true);

    // Ball moves forward 20 mm in 0.02s -> velocity ~ 1000 mm/s
    const f2 = makeFrame({
      time: 0.02,
      camera: {
        goals: { cyan: null, yellow: null },
        goalBlobs: { cyan: [], yellow: [] },
        ball: { bearing: 0, range: 200 },
        fresh: true,
      },
    });
    ball.update(f2, 0, 0, 0);

    const [predX] = ball.predict(0.5);
    // Prediction should project forward but be physically bounded by drag
    expect(predX).toBeGreaterThan(ball.x);
  });
});

describe('Champion Geometry and Safety', () => {
  it('steerClearOfEdges turns hard when at the boundary', () => {
    // Robot heading outward past the stop line
    const travel = 0; // +x towards wall
    const steer = steerClearOfEdges(travel, HALF_LENGTH + 20, 0, 150, EDGE_STOP_X, EDGE_STOP_Z);
    // Outward direction must be turned around to inward (-x, angle Math.PI)
    expect(Math.cos(steer)).toBeLessThan(0);
  });

  it('steerClearOfEdges accounts for ball carry when held', () => {
    // Chassis is legally inside at z = HALF_WIDTH - 30, but ball in front at heading 0 is outside!
    const heading = Math.PI / 2; // facing +z
    const steer = steerClearOfEdges(
      Math.PI / 2,
      0,
      HALF_WIDTH - 30,
      150,
      EDGE_STOP_X,
      EDGE_STOP_Z,
      CONTACT_RANGE,
      heading,
    );
    // Must be turned back inward (-z)
    expect(Math.sin(steer)).toBeLessThan(0);
  });

  it('shotIsOpen verifies unoccluded angular window in goal mouth', () => {
    const openBlobs = [
      { start: -0.3, end: 0.3, height: 0.2 }, // Wide gap dead ahead
    ];
    expect(shotIsOpen(openBlobs, 2.5)).toBe(true);

    const blockedBlobs = [
      { start: 0.1, end: 0.3, height: 0.2 }, // Only right side open, dead ahead is blocked by goalie!
    ];
    expect(shotIsOpen(blockedBlobs, 2.5)).toBe(false);
  });

  it('passIsOpen validates passing lane and obstacle clearance', () => {
    const heading = 0; // along +x
    const meX = 0;
    const meZ = 0;
    const targetX = 600;
    const targetZ = 0;

    // Clear lane
    expect(passIsOpen(heading, meX, meZ, targetX, targetZ, null)).toBe(true);

    // Blocker at 300 mm in between
    expect(passIsOpen(heading, meX, meZ, targetX, targetZ, 300)).toBe(false);
  });
});

describe('Champion vs Reference Match Benchmark', () => {
  it('champion outscores or ties reference over 30s match', () => {
    const agents: MatchAgents = {
      ...championTeam('violet'),
      ...referenceTeam('lime'),
    } as unknown as MatchAgents;

    const m = new Match({
      agents,
      halfSeconds: 30,
      seed: 42,
    });

    const res = m.run();
    // Champion (violet) should score or defend cleanly against reference (lime)
    expect(res.score.violet).toBeGreaterThanOrEqual(res.score.lime);
    expect(res.abandoned).toBe(false);
  });
});
