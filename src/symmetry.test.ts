/**
 * The two ends of the field have to be the same game.
 *
 * The symmetry that says so is a 180-degree ROTATION about the centre spot,
 * not a mirror. A mirror is the wrong test twice over: the open drivetrain is
 * chiral - four tangential wheels all driving the same way round, each mounted
 * a quarter turn back from the direction it drives - so its mirror image is a
 * different machine and a mirror test reports asymmetries that are not bugs.
 * And a mirror is not what separates the two attack directions anyway.
 *
 * A rotation is. Under
 *
 *     x -> -x,   z -> -z,   heading -> heading + PI
 *
 * the field maps onto itself (goals, walls, boxes and neutral points are all
 * symmetric about the origin) and the robot frame is carried along with the
 * robot. So every robot-frame reading - IR bearing, sonar, the line ring,
 * encoders, the camera's ball - must come back IDENTICAL, and only two things
 * may differ: the compass, by exactly PI, and the two goal sightings, which
 * swap labels. That makes "the agent emits the same motor powers" an exact
 * assertion rather than a statistical one.
 *
 * Which is the whole point of testing it here. This same question asked of a
 * scoreline needs tens of matches per run, takes half an hour, and still comes
 * back ambiguous - goals inside one match are not independent, so a single
 * runaway match contributes five correlated goals and the counts lie about how
 * much evidence there is. Asked at the tick it is exact, it runs in a second,
 * and it points at the line.
 */
import { describe, expect, it } from 'vitest';
import { Senses, type MatchView, type SenseInput } from './perception';
import { ReferenceAgent } from './reference';
import { World } from './world';
import { getLeague } from './leagues';
import type { SensorFrame } from './protocol';

/** atan2, not `(v + PI) % (2 PI) - PI`: JS % is remainder, and keeps the sign of the dividend. */
const wrap = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));

interface Pose {
  x: number;
  z: number;
  heading: number;
  bx: number;
  bz: number;
}

const rotate = (p: Pose): Pose => ({
  x: -p.x,
  z: -p.z,
  heading: p.heading + Math.PI,
  bx: -p.bx,
  bz: -p.bz,
});

/** Deterministic spread of poses, so a failure is reproducible. */
function poses(count: number): Pose[] {
  let state = 12345;
  const rnd = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const span = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  return Array.from({ length: count }, () => ({
    x: span(-850, 850),
    z: span(-560, 560),
    heading: span(-Math.PI, Math.PI),
    bx: span(-880, 880),
    bz: span(-580, 580),
  }));
}

/**
 * A short scripted run rather than one frame, because the agent is stateful -
 * a ball memory, a yaw estimate, a think budget - and a single frame tests
 * none of it. The other three robots are placed relative to the ball so they
 * actually get in the way: without them nothing occludes the IR or the camera,
 * every sonar sees a wall rather than a robot, and the blocked-shot branches
 * never run.
 */
function trajectory(p: Pose, ticks: number): Pose[] {
  return Array.from({ length: ticks }, (_, i) => ({
    x: p.x + Math.cos(p.heading) * 4 * i,
    z: p.z + Math.sin(p.heading) * 4 * i,
    heading: p.heading + 0.01 * i,
    bx: p.bx + 3 * i,
    bz: p.bz - 1.5 * i,
  }));
}

function others(p: Pose, team: 'violet' | 'lime') {
  const foe = team === 'violet' ? 'lime' : 'violet';
  return [
    { id: `${team}-2`, team, number: 2 as const, x: p.x * 0.2 - 300, z: p.z * 0.3 + 40, heading: p.heading + 0.5 },
    { id: `${foe}-1`, team: foe, number: 1 as const, x: (p.x + p.bx) / 2 + 90, z: (p.z + p.bz) / 2 - 30, heading: p.heading - 1.1 },
    { id: `${foe}-2`, team: foe, number: 2 as const, x: p.bx * 0.6 + 250, z: p.bz * 0.4 + 70, heading: p.heading + 2.2 },
  ];
}

/**
 * `seq` is always the UNROTATED trajectory; `rotated` turns the whole world
 * over at the end. Rotating the starting pose and then laying the other robots
 * out around it would place them by offsets that were never rotated, and the
 * two worlds would not be each other's image - which is a bug in the test that
 * looks exactly like a bug in the thing under test.
 */
function frames(seq: Pose[], attackDirection: 1 | -1, held: boolean, rotated: boolean): SensorFrame[] {
  // Ideal sensors, and the same seed either way: noise is drawn per sensor in
  // a fixed call order, and the rotation swaps which goal is read first, so
  // noisy frames cannot be compared draw for draw. Structural symmetry is what
  // is being asserted; noise is symmetric in distribution by construction.
  const senses = new Senses(0xbeef, 4, true);
  let clock = 0;
  const s = rotated ? -1 : 1;
  return seq.map((base) => {
    clock += 0.02;
    const p = rotated ? rotate(base) : base;
    const self = { id: 'violet-1', team: 'violet' as const, number: 1 as const, x: p.x, z: p.z, heading: p.heading };
    const rest = others(base, 'violet').map((r) => ({
      ...r,
      x: s * r.x,
      z: s * r.z,
      heading: r.heading + (rotated ? Math.PI : 0),
    }));
    const view: MatchView = {
      clock,
      playing: true,
      ball: { x: p.bx, z: p.bz },
      robots: [self, ...rest],
      kickoff: { pending: false, team: null },
    };
    const input: SenseInput = {
      view,
      self,
      wheelSpeeds: [100, -100, 100, -100],
      omega: 0,
      held,
      messages: [],
      attackDirection,
      dt: 0.02,
    };
    return senses.read(input);
  });
}

describe('the field is the same game at both ends', () => {
  it('gives identical sensor frames for a pose and its 180-degree rotation', () => {
    for (const pose of poses(40)) {
      const a = frames(trajectory(pose, 30), 1, false, false);
      const b = frames(trajectory(pose, 30), -1, false, true);

      for (let i = 0; i < a.length; i++) {
        const A = a[i]!;
        const B = b[i]!;
        expect(wrap(B.compass.heading - (A.compass.heading + Math.PI))).toBeCloseTo(0, 6);
        expect(wrap((B.ball?.bearing ?? 0) - (A.ball?.bearing ?? 0))).toBeCloseTo(0, 6);
        expect(B.ball?.strength ?? 0).toBeCloseTo(A.ball?.strength ?? 0, 6);

        for (const k of ['front', 'left', 'back', 'right'] as const) {
          expect(B.range[k] === null).toBe(A.range[k] === null);
          if (A.range[k] !== null) expect(B.range[k]!).toBeCloseTo(A.range[k]!, 6);
        }
        for (let j = 0; j < A.lines.length; j++) {
          expect(wrap(B.lines[j]!.bearing - A.lines[j]!.bearing)).toBeCloseTo(0, 6);
          expect(B.lines[j]!.value).toBeCloseTo(A.lines[j]!.value, 6);
        }
        // The goals keep their paint, so the rotation swaps which one is which.
        for (const [ka, kb] of [
          ['cyan', 'yellow'],
          ['yellow', 'cyan'],
        ] as const) {
          const av = A.camera.goals[ka];
          const bv = B.camera.goals[kb];
          expect(bv === null).toBe(av === null);
          if (av && bv) {
            expect(wrap(bv.bearing - av.bearing)).toBeCloseTo(0, 6);
            expect(bv.range).toBeCloseTo(av.range, 6);
          }
        }
      }
    }
  });

  it('steps the physics to the rotation of the rotated world', () => {
    const build = (rotated: boolean): World => {
      const w = new World({
        league: getLeague('open'),
        halfLengthSeconds: 600,
        inclined: false,
        commsEnabled: true,
      });
      w.resetRobots('violet');
      w.running = true;
      const s = rotated ? -1 : 1;
      const at: [string, number, number, number][] = [
        ['violet-1', 120, -80, 0.3],
        ['violet-2', -700, 40, 0.1],
        ['lime-1', -60, 150, 2.6],
        ['lime-2', 690, -30, 3.0],
      ];
      for (const [id, x, z, h] of at) {
        const r = w.robots.find((q) => q.id === id)!;
        r.x = s * x;
        r.z = s * z;
        r.heading = h + (rotated ? Math.PI : 0);
      }
      w.ball.x = s * 40;
      w.ball.z = s * -20;
      w.ball.vx = s * 900;
      w.ball.vz = s * 420;
      return w;
    };

    const a = build(false);
    const b = build(true);
    // The robot frame is carried along by the rotation, so the SAME powers are
    // the rotated command.
    const powers: Record<string, number[]> = {
      'violet-1': [0.8, -0.2, 0.5, 0.9],
      'violet-2': [-0.4, 0.7, 0.3, -0.6],
      'lime-1': [0.6, 0.6, -0.9, 0.1],
      'lime-2': [0.2, -0.8, 0.4, 0.5],
    };

    for (let i = 0; i < 1200; i++) {
      for (const w of [a, b]) for (const r of w.robots) r.motors = powers[r.id]!;
      a.step(0.01);
      b.step(0.01);
    }

    expect(b.ball.x).toBeCloseTo(-a.ball.x, 6);
    expect(b.ball.z).toBeCloseTo(-a.ball.z, 6);
    expect(b.ball.vx).toBeCloseTo(-a.ball.vx, 6);
    expect(b.ball.vz).toBeCloseTo(-a.ball.vz, 6);
    expect(b.score).toEqual(a.score);
    for (const ra of a.robots) {
      const rb = b.robots.find((q) => q.id === ra.id)!;
      expect(rb.x).toBeCloseTo(-ra.x, 6);
      expect(rb.z).toBeCloseTo(-ra.z, 6);
      expect(wrap(rb.heading - (ra.heading + Math.PI))).toBeCloseTo(0, 6);
      expect(rb.removed).toBe(ra.removed);
    }
  });

  /**
   * The one that catches a strategy naming a fixed direction on the field.
   *
   * A tie-break resolved by a bare `1.0`, or by the sign of a quantity that is
   * zero on the centre line, picks the same PHYSICAL side in both worlds
   * instead of mirrored ones - so the team attacking +x and the team attacking
   * -x stop playing the same game, and swapping ends at half-time does not
   * cancel it. Restarts put robots and ball on z = 0 exactly, so that is the
   * normal case and not a corner.
   */
  for (const [label, held] of [
    ['in open play', false],
    ['while holding the ball', true],
  ] as const) {
    it(`makes the reference agent command the same motors under rotation, ${label}`, () => {
      for (const [role, number] of [
        ['striker', 1],
        ['goalie', 2],
      ] as const) {
        for (const pose of poses(40)) {
          const a = new ReferenceAgent({ team: 'violet', number, role });
          const b = new ReferenceAgent({ team: 'violet', number, role });
          const fa = frames(trajectory(pose, 30), 1, held, false);
          const fb = frames(trajectory(pose, 30), -1, held, true);

          for (let i = 0; i < fa.length; i++) {
            const ca = a.tick(fa[i]!);
            const cb = b.tick(fb[i]!);
            expect(!!cb).toBe(!!ca);
            if (!ca || !cb) continue;
            for (let m = 0; m < ca.motors.length; m++) {
              expect(cb.motors[m]!).toBeCloseTo(ca.motors[m]!, 9);
            }
            expect(cb.dribbler ?? 0).toBeCloseTo(ca.dribbler ?? 0, 9);
            expect(cb.kicker === true).toBe(ca.kicker === true);
          }
        }
      }
    });
  }
});
