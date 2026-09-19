/**
 * Every sensor here exists to throw information away in a particular way.
 * These tests assert the throwing-away, not the reading — a sensor that
 * silently became perfect would pass a naive test and ruin the league.
 */

import {
  CameraState,
  CompassState,
  EncoderState,
  GyroState,
  IR_REFERENCE_RANGE,
  Noise,
  blocks,
  readIr,
  readLines,
  readRange,
  surfaceAt,
  visibleArcs,
  type Arc,
  type Pose,
} from '../../src/sim/sensors';
import {
  CROSSBAR_HEIGHT,
  GOAL_MOUTH_X,
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  LINE_THICKNESS,
  WALL_X,
  goalMouth,
} from '../../src/sim/field';

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
  it('drifts a few degrees over a five minute half, not tens of degrees', () => {
    // The peak wander over a half, averaged across seeds, is what matters: a
    // robot dead-reckoning off the compass has to end the half visibly wide,
    // but by degrees, not by a goal and a half. One seed alone can wander back
    // through zero, so watch the peak and average the end error across seeds.
    let sumEnd = 0;
    const seeds = 12;
    for (let s = 1; s <= seeds; s++) {
      const c = new CompassState();
      const n = new Noise(s);
      let peak = 0;
      for (let t = 0; t < 300; t += 1 / 50) {
        c.step(1 / 50, n);
        peak = Math.max(peak, Math.abs(c.drift));
      }
      // 0.35 rad is about 20 degrees; the old 0.05 rate reached 40-100.
      expect(peak).toBeLessThan(0.35);
      sumEnd += Math.abs(c.drift);
    }
    // Typical end-of-half error is a handful of degrees (about 0.06 rad),
    // not the 0.6 rad the old rate produced, and not zero either.
    const meanEnd = sumEnd / seeds;
    expect(meanEnd).toBeGreaterThan(0.01);
    expect(meanEnd).toBeLessThan(0.2);
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

describe('gyro', () => {
  it('is fine to read directly, and bad to integrate, over a five minute half', () => {
    // Same shape as the compass test above, but the number that matters is
    // different: the compass's own drift is what a strategy sees. A gyro's
    // bias is invisible until a strategy integrates the rate into a heading
    // of its own - so track both the raw bias (small) and what dead
    // reckoning off it for a whole half would do (not small).
    let sumEndBias = 0;
    let sumEndIntegrated = 0;
    const seeds = 12;
    for (let s = 1; s <= seeds; s++) {
      const g = new GyroState();
      const n = new Noise(s);
      let peakBias = 0;
      let integrated = 0;
      for (let t = 0; t < 300; t += 1 / 50) {
        g.step(1 / 50, n);
        integrated += g.read(0, n) / 50;
        peakBias = Math.max(peakBias, Math.abs(g.bias));
      }
      // The bias itself stays small - nothing a per-tick damping term feels.
      expect(peakBias).toBeLessThan(0.03);
      sumEndBias += Math.abs(g.bias);
      sumEndIntegrated += Math.abs(integrated);
    }
    const meanEndBias = sumEndBias / seeds;
    expect(meanEndBias).toBeGreaterThan(0.0005);
    expect(meanEndBias).toBeLessThan(0.02);
    // Integrated over the same half, the same bias is a heading error well
    // past what the compass ever produces (0.35 rad peak, see above) - the
    // whole point of exposing a raw rate instead of a fused heading.
    const meanEndIntegratedDeg = ((sumEndIntegrated / seeds) * 180) / Math.PI;
    expect(meanEndIntegratedDeg).toBeGreaterThan(10);
  });

  it('reads near the true rate in the short term', () => {
    const g = new GyroState();
    const n = seed();
    const r = g.read(1.5, n);
    expect(r).toBeGreaterThan(1.2);
    expect(r).toBeLessThan(1.8);
  });

  it('is repeatable for the same seed', () => {
    const run = () => {
      const g = new GyroState();
      const n = new Noise(999);
      for (let t = 0; t < 10; t += 0.02) g.step(0.02, n);
      return g.read(0, n);
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

  it('estimates range off blob height, not off blob width', () => {
    // Square on and off to the side at the SAME distance from the goal plane.
    // The mouth foreshortens across its width, so a range taken off width
    // would disagree between these two. Height is what survives.
    const cam = new CameraState();
    const square = cam.read(at(GOAL_MOUTH_X - 400, 0), { x: 0, z: 0 }, [], seed(), true, true);
    const oblique = cam.read(at(GOAL_MOUTH_X - 400, 500), { x: 0, z: 0 }, [], seed(), true, true);

    const wide = square.goalBlobs.yellow[0]!;
    const thin = oblique.goalBlobs.yellow[0]!;
    // Width collapses when seen from the side...
    expect(thin.end - thin.start).toBeLessThan((wide.end - wide.start) * 0.6);
    // ...while height still reads the true distance to the plane, 400 mm.
    expect(CROSSBAR_HEIGHT / wide.height).toBeCloseTo(400, 0);
  });
});

/**
 * The reading a striker needs to shoot past a keeper.
 *
 * A goal is not a point, it is an opening, and what matters about an opening
 * is which parts of it are still open. These assert that the camera reports
 * the opening rather than the goal's middle - and, just as much, that it
 * reports it as raw colour rather than as an answer.
 */
describe('goal blobs', () => {
  const gx = GOAL_MOUTH_X;
  /** Ideal mode: occlusion is geometry, so it applies, but no noise. */
  const look = (pose: Pose, blockers: { x: number; z: number }[]) => {
    const cam = new CameraState();
    return cam.read(pose, { x: 0, z: 0 }, blockers, seed(), true, true).goalBlobs.yellow;
  };
  const width = (b: { start: number; end: number }) => b.end - b.start;

  it('is one unbroken patch when nothing is in front of the net', () => {
    const blobs = look(at(300, 0), []);
    expect(blobs).toHaveLength(1);
    // 450 mm of mouth from 665 mm out: 2*atan(225/665) = 37.4 degrees.
    expect(width(blobs[0]!)).toBeCloseTo(2 * Math.atan(HALF_GOAL_WIDTH / (gx - 300)), 3);
  });

  it('splits in two around a keeper standing in the middle of the mouth', () => {
    const blobs = look(at(300, 0), [{ x: gx - 100, z: 0 }]);
    expect(blobs).toHaveLength(2);
    // The gap between them is where the keeper is, and it is NOT open.
    expect(blobs[1]!.start).toBeGreaterThan(blobs[0]!.end);
    // Both remaining pieces are real goal, and narrower than the whole mouth.
    for (const b of blobs) expect(width(b)).toBeGreaterThan(0);
    expect(width(blobs[0]!) + width(blobs[1]!)).toBeLessThan(
      width(look(at(300, 0), [])[0]!),
    );
  });

  it('leaves one off-centre patch when the keeper sits on a post', () => {
    const blobs = look(at(300, 0), [{ x: gx - 100, z: -140 }]);
    expect(blobs).toHaveLength(1);
    // The opening is on the far side from the keeper, so its centre has moved
    // off the middle of the goal - which is the whole point of the reading.
    const centre = (blobs[0]!.start + blobs[0]!.end) / 2;
    expect(centre).toBeGreaterThan(0.05);
  });

  it('reports nothing at all when the mouth is smothered', () => {
    expect(look(at(300, 0), [{ x: 460, z: 0 }])).toHaveLength(0);
  });

  it('can only ever show a gap around ONE robot, because of how wide a robot is', () => {
    // Worth stating as a fact about the field rather than leaving implicit.
    // Rule 2.3 makes the mouth 450 mm and rule 4.1.2 makes a robot 220 mm, so
    // the mouth is almost exactly two robots wide - and a shadow is never
    // narrower than the robot casting it. Two robots in front of the net
    // therefore cover it, at every distance, and a striker's problem is
    // always "get past the keeper", never "pick one of several openings".
    for (const d of [400, 700, 1000, 1400]) {
      const pose = at(gx - d, 0);
      const goal = look(pose, [])[0]!;
      const pair = look(pose, [
        { x: gx - 60, z: -105 },
        { x: gx - 60, z: 105 },
      ]);
      const open = pair.reduce((a, b) => a + width(b), 0);
      // Whatever is left over is a rim, not an opening: under a tenth of it.
      expect(open).toBeLessThan(width(goal) * 0.1);
    }
  });

  it('merges overlapping shadows instead of inventing a gap between them', () => {
    // Asserted on the interval arithmetic directly, because the field itself
    // cannot set this case up - see the test above. Two shadows that overlap
    // must leave one hidden stretch, never two with a sliver of phantom goal
    // between them, or a striker would shoot at the space between two robots.
    const goal: Arc = { from: -0.5, to: 0.5 };
    const merged = visibleArcs(goal, [
      { centre: -0.1, half: 0.15 },
      { centre: 0.1, half: 0.15 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.to).toBeCloseTo(-0.25, 6);
    expect(merged[1]!.from).toBeCloseTo(0.25, 6);
  });

  it('leaves one more piece than there are separated shadows', () => {
    // The algorithm carries no cap at two; the goal's own width is the cap.
    const goal: Arc = { from: -1, to: 1 };
    const spread = visibleArcs(goal, [
      { centre: -0.6, half: 0.1 },
      { centre: 0, half: 0.1 },
      { centre: 0.6, half: 0.1 },
    ]);
    expect(spread).toHaveLength(4);
    for (let i = 1; i < spread.length; i++) {
      expect(spread[i]!.from).toBeGreaterThan(spread[i - 1]!.to);
    }
  });

  it('hides more of the goal the closer the blocker is to the robot', () => {
    const pose = at(300, 0);
    const near = look(pose, [{ x: 500, z: 0 }]);
    const far = look(pose, [{ x: gx - 20, z: 0 }]);
    const open = (bs: { start: number; end: number }[]) =>
      bs.reduce((a, b) => a + width(b), 0);
    // Same robot, same bearing, different distance: the near one eats the goal.
    expect(open(near)).toBeLessThan(open(far));
  });

  it('is blocked by a team mate exactly as it is by an opponent', () => {
    // The camera does not know whose robot it is, and neither does the goal.
    const mate = look(at(300, 0), [{ x: gx - 100, z: 0 }]);
    expect(mate).toHaveLength(2);
  });

  it('narrows as the robot moves round to the side', () => {
    const square = look(at(gx - 300, 0), []);
    const oblique = look(at(gx - 300, 500), []);
    expect(width(oblique[0]!)).toBeLessThan(width(square[0]!));
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

  it('eliminates gyro bias and noise', () => {
    const g = new GyroState();
    const n = seed();
    for (let t = 0; t < 300; t += 1 / 50) g.step(1 / 50, n, true);
    expect(g.bias).toBe(0);
    expect(g.read(0.75, n, true)).toBe(0.75);
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
    expect(r!.strength).toBeCloseTo((IR_REFERENCE_RANGE / 400) ** 2, 4);
  });

  it('still resolves range where the ball is close enough to touch', () => {
    // The band between the mouth and a standoff is where an approach is
    // decided, so it must not be one flat number. Saturating at 200 mm made it
    // one, for half of every sighting in a match.
    const near = readIr(at(0, 0), { x: 150, z: 0 }, { blockers: [], ideal: true }, seed())!;
    const mouth = readIr(at(0, 0), { x: 131, z: 0 }, { blockers: [], ideal: true }, seed())!;
    expect(mouth.strength).toBeCloseTo(1, 4);
    expect(near.strength).toBeLessThan(0.95);
    expect(IR_REFERENCE_RANGE / Math.sqrt(near.strength)).toBeCloseTo(150, 0);
  });
});
