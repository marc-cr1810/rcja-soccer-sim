/**
 * Every sensor here exists to throw information away in a particular way.
 * These tests assert the throwing-away, not the reading — a sensor that
 * silently became perfect would pass a naive test and ruin the league.
 */

import { describe, expect, it } from 'vitest';
import {
  CameraState,
  CompassState,
  EncoderState,
  Noise,
  blocks,
  readIr,
  readLines,
  readRange,
  surfaceAt,
  type Pose,
} from './sensors';
import { HALF_LENGTH, HALF_WIDTH, LINE_THICKNESS, WALL_X, goalMouth } from './field';

const at = (x: number, z: number, heading = 0): Pose => ({ x, z, heading });
const seed = () => new Noise(12345);

describe('infrared ball seeker', () => {
  it('points roughly at the ball', () => {
    const r = readIr(at(0, 0), { x: 500, z: 0 }, { blockers: [] }, seed());
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bearing)).toBeLessThan(0.25);
  });

  it('quantises the bearing to the ring, not to the truth', () => {
    // Sweep the ball around and count how many distinct bearings come back.
    // A 24-sector sensor resolves 15-degree buckets.
    const seen = new Set<string>();
    const n = seed();
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * 2 * Math.PI;
      const r = readIr(at(0, 0), { x: Math.cos(a) * 400, z: Math.sin(a) * 400 }, { blockers: [] }, n);
      if (r) seen.add(r.bearing.toFixed(4));
    }
    expect(seen.size).toBeLessThanOrEqual(24);
    expect(seen.size).toBeGreaterThan(12);
  });

  it('reads weaker the further away the ball is', () => {
    const n = seed();
    const near = readIr(at(0, 0), { x: 300, z: 0 }, { blockers: [] }, n)!;
    const far = readIr(at(0, 0), { x: 1200, z: 0 }, { blockers: [] }, n)!;
    expect(near.strength).toBeGreaterThan(far.strength * 3);
  });

  it('loses the ball entirely behind an opponent', () => {
    const blocked = readIr(
      at(0, 0),
      { x: 800, z: 0 },
      { blockers: [{ x: 400, z: 0 }] },
      seed(),
    );
    expect(blocked).toBeNull();
  });

  it('still sees a ball when the opponent is beside the line, not on it', () => {
    const clear = readIr(
      at(0, 0),
      { x: 800, z: 0 },
      { blockers: [{ x: 400, z: 400 }] },
      seed(),
    );
    expect(clear).not.toBeNull();
  });

  it('is not blocked by a robot standing behind the ball', () => {
    const r = readIr(at(0, 0), { x: 500, z: 0 }, { blockers: [{ x: 900, z: 0 }] }, seed());
    expect(r).not.toBeNull();
  });
});

describe('compass', () => {
  it('drifts measurably over a five minute half, without being told to', () => {
    const c = new CompassState();
    const n = seed();
    for (let t = 0; t < 300; t += 1 / 50) c.step(1 / 50, n);
    // Big enough to matter to a robot that integrates it; small enough that a
    // team testing for thirty seconds will not notice.
    expect(Math.abs(c.drift)).toBeGreaterThan(0.01);
    expect(Math.abs(c.drift)).toBeLessThan(0.6);
  });

  it('reads near the true heading in the short term', () => {
    const c = new CompassState();
    const n = seed();
    const r = c.read(1.2, n);
    expect(r).toBeGreaterThan(1.1);
    expect(r).toBeLessThan(1.3);
  });

  it('is repeatable for the same seed', () => {
    const run = () => {
      const c = new CompassState();
      const n = new Noise(999);
      for (let t = 0; t < 10; t += 0.02) c.step(0.02, n);
      return c.read(0, n);
    };
    expect(run()).toBe(run());
  });
});

describe('line sensors', () => {
  it('finds carpet in the middle of the field', () => {
    for (const r of readLines(at(0, 300), seed())) expect(r.surface).toBe('carpet');
  });

  it('sees the white line when the robot straddles it', () => {
    // Rule 2.1.1: the line sits just outside the playing area.
    const onLine = HALF_WIDTH + LINE_THICKNESS / 2;
    const readings = readLines(at(0, onLine), seed());
    expect(readings.some((r) => r.surface === 'line')).toBe(true);
  });

  it('reports the line brighter than the carpet', () => {
    const readings = readLines(at(0, HALF_WIDTH + LINE_THICKNESS / 2), seed());
    const line = readings.find((r) => r.surface === 'line')!;
    const carpet = readings.find((r) => r.surface === 'carpet')!;
    expect(line.value).toBeGreaterThan(carpet.value + 0.3);
  });

  it('tells the robot which side the line is on', () => {
    const onLine = HALF_WIDTH + LINE_THICKNESS / 2;
    const readings = readLines(at(0, onLine, 0), seed());
    const hits = readings.filter((r) => r.surface === 'line');
    // The line is at +z, which is to the robot's left at heading 0.
    for (const h of hits) expect(Math.sin(h.bearing)).toBeGreaterThan(-0.4);
  });

  it('finds the penalty box marking', () => {
    expect(surfaceAt(HALF_LENGTH - 300, 0)).toBe('marking');
  });
});

describe('ultrasonics', () => {
  it('measures a wall square in front of it', () => {
    const r = readRange(at(0, 0, 0), seed());
    expect(r.front).toBeGreaterThan(1000);
    expect(r.front).toBeLessThan(1200);
  });

  it('loses the echo off a wall struck at a shallow angle', () => {
    // Near the end wall, firing at 75 degrees off its normal. The pulse skids
    // away instead of coming back, and the sensor reports nothing rather than
    // reporting something wrong — which is how a real one fails, and why
    // sonar-guided robots lose the plot in corners.
    const r = readRange(at(WALL_X - 200, 0, (75 * Math.PI) / 180), seed());
    expect(r.front).toBeNull();
  });

  it('still reads that same wall when squared up to it', () => {
    const r = readRange(at(WALL_X - 200, 0, 0), seed());
    expect(r.front).not.toBeNull();
  });

  it('reports all four directions near the middle of the field', () => {
    const r = readRange(at(0, 0, 0), seed());
    for (const v of [r.front, r.back, r.left, r.right]) expect(v).not.toBeNull();
  });

  it('reads shorter as the robot approaches a wall', () => {
    const far = readRange(at(0, 0, 0), seed()).front!;
    const near = readRange(at(600, 0, 0), seed()).front!;
    expect(near).toBeLessThan(far - 500);
  });

  it('detects another robot blocking the beam', () => {
    const clear = readRange(at(0, 0, 0), seed()).front!;
    // Place an obstacle robot at (500, 0) directly in front of the front beam
    const blocked = readRange(at(0, 0, 0), seed(), [{ x: 500, z: 0 }]).front!;
    // Wall is ~1105 mm away; bumper of obstacle at 500 mm is ~280 mm away
    expect(blocked).toBeLessThan(350);
    expect(blocked).toBeGreaterThan(200);
    expect(blocked).toBeLessThan(clear - 500);
  });

  it('ignores obstacles that are outside the beam or behind the robot', () => {
    const clear = readRange(at(0, 0, 0), seed()).front!;
    // Obstacle far off to the side (500, 400) or behind (-500, 0)
    const withSide = readRange(at(0, 0, 0), seed(), [{ x: 500, z: 400 }]).front!;
    const withBehind = readRange(at(0, 0, 0), seed(), [{ x: -500, z: 0 }]).front!;
    expect(Math.abs(withSide - clear)).toBeLessThan(25);
    expect(Math.abs(withBehind - clear)).toBeLessThan(25);
  });
});

describe('camera', () => {
  it('updates at its own frame rate, not the control loop rate', () => {
    const cam = new CameraState();
    let fresh = 0;
    // One second of a 50 Hz control loop against a 30 fps camera.
    for (let i = 0; i < 50; i++) if (cam.step(1 / 50)) fresh++;
    expect(fresh).toBeGreaterThan(20);
    expect(fresh).toBeLessThan(35);
  });

  it('repeats the previous frame in between, flagged as stale', () => {
    const cam = new CameraState();
    const n = seed();
    const pose = at(0, 0, 0);
    cam.step(1);
    const first = cam.read(pose, { x: 200, z: 0 }, [], n, true);
    const second = cam.read(pose, { x: 200, z: 0 }, [], n, false);
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);
    expect(second.goals.yellow?.bearing).toBe(first.goals.yellow?.bearing);
  });

  it('sees goals in all directions with 360-degree FOV', () => {
    const cam = new CameraState();
    const facingCyan = at(0, 0, Math.PI);
    const r = cam.read(facingCyan, { x: 0, z: 0 }, [], seed(), true);
    expect(r.goals.yellow).not.toBeNull();
    expect(r.goals.cyan).not.toBeNull();
  });

  it('resolves a goal opening when the near post is inside FOV even if center is outside', () => {
    const cam = new CameraState();
    // Robot at (0, 0) angled at ~35 degrees (0.61 rad) off-axis from yellow goal
    // Center point (915, 0) has bearing ~ -35 deg (outside 31 deg half-FOV)
    // But post at (915, +225) has bearing ~ -21 deg (well inside 31 deg FOV!)
    const pose = at(0, 0, 0.61);
    const r = cam.read(pose, { x: 0, z: 0 }, [], seed(), true);
    expect(r.goals.yellow).not.toBeNull();
  });

  it('estimates range badly enough to be worth distrusting', () => {
    const cam = new CameraState();
    const n = seed();
    const target = goalMouth('yellow');
    const truth = Math.hypot(target.x, target.z);
    const errors: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = cam.read(at(0, 0, 0), { x: 0, z: 0 }, [], n, true);
      errors.push(Math.abs(r.goals.yellow!.range - truth) / truth);
    }
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    expect(mean).toBeGreaterThan(0.01);
    expect(mean).toBeLessThan(0.25);
  });
});

describe('encoders', () => {
  it('accumulate while the wheels turn', () => {
    const e = new EncoderState(4);
    for (let i = 0; i < 100; i++) e.step([500, 500, 500, 500], 1 / 50);
    for (const c of e.read()) expect(c).toBeGreaterThan(0);
  });

  it('count wheel rotation, not distance travelled', () => {
    // A robot held still with its wheels spinning: the encoders climb anyway.
    // This is the failure that makes odometry drift, and it has to be present.
    const e = new EncoderState(4);
    e.step([800, 800, 800, 800], 1);
    const spun = e.read();
    expect(spun.every((c) => c > 20)).toBe(true);
  });

  it('quantise to the encoder step', () => {
    const e = new EncoderState(1);
    e.step([1], 1 / 50);
    // A tiny movement is below one count and reads as nothing at all.
    expect(e.read()[0]).toBe(0);
  });
});

describe('occlusion geometry', () => {
  it('blocks only what is between the two points', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 1000, z: 0 };
    expect(blocks(a, b, { x: 500, z: 0 }, 110)).toBe(true);
    expect(blocks(a, b, { x: 500, z: 300 }, 110)).toBe(false);
    expect(blocks(a, b, { x: 1500, z: 0 }, 110)).toBe(false);
    expect(blocks(a, b, { x: -500, z: 0 }, 110)).toBe(false);
  });
});

describe('ideal sensors mode', () => {
  it('eliminates compass drift and noise', () => {
    const c = new CompassState();
    const n = seed();
    for (let t = 0; t < 300; t += 1 / 50) c.step(1 / 50, n, true);
    expect(c.drift).toBe(0);
    expect(c.read(1.234, n, true)).toBeCloseTo(1.234, 5);
  });

  it('reports exact reflectance without line noise', () => {
    const readings = readLines(at(0, 0), seed(), true);
    for (const r of readings) {
      expect(r.value).toBe(0.22); // carpet reflectance exactly
    }
  });

  it('measures sonar distances at grazing angles without drop-out or noise', () => {
    // 75 degrees off wall normal
    const grazing = readRange(at(WALL_X - 200, 0, (75 * Math.PI) / 180), seed(), [], true);
    expect(grazing.front).not.toBeNull();
    expect(grazing.front!).toBeGreaterThan(0);
  });

  it('updates camera every tick and gives exact sightings', () => {
    const cam = new CameraState();
    expect(cam.step(1 / 50, true)).toBe(true);
    const pose = at(0, 0, 0);
    const n = seed();
    const r = cam.read(pose, { x: 500, z: 0 }, [], n, true, true);
    expect(r.goals.yellow?.bearing).toBeCloseTo(0, 5);
    expect(r.goals.yellow?.range).toBeCloseTo(915, 2);
    expect(r.goals.cyan?.bearing).toBeCloseTo(Math.PI, 4);
    expect(r.goals.cyan?.range).toBeCloseTo(915, 2);
    expect(r.ball?.bearing).toBeCloseTo(0, 5);
    expect(r.ball?.range).toBeCloseTo(500, 2);
  });

  it('reports exact wheel encoder counts without quantization', () => {
    const e = new EncoderState(1);
    e.step([1], 1 / 50); // tiny speed: 1 / 25 / 50 = 0.0008 rad
    expect(e.read(true)[0]).toBeGreaterThan(0);
  });

  it('reports unjittered 24-sector bearing and exact inverse-square strength', () => {
    const r = readIr(at(0, 0), { x: 400, z: 0 }, { blockers: [], ideal: true }, seed());
    expect(r).not.toBeNull();
    expect(r!.bearing).toBe(0);
    expect(r!.strength).toBeCloseTo(0.25, 4); // (200 / 400)^2 = 0.25
  });
});
