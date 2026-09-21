/**
 * Putting the ball back takes a person's time.
 *
 * 5.6.2 and 5.9.2 send the ball to a neutral point, and at a real field a
 * person walks over, picks it up and puts it down. For those moments the ball
 * is not on the field: nothing touches it, no rule about it fires, and no
 * robot can sense it. It used to teleport in the same tick, which handed every
 * robot a ball that was never out of sight.
 */
import { describe, expect, it } from 'bun:test';
import { getLeague } from '@rcja/shared/leagues';
import { HALF_WIDTH, NEUTRAL_OFFSET } from '../../src/sim/field';
import { BALL_PLACEMENT_SECONDS, World } from '../../src/sim/world';

const DT = 1 / 120;

function world(opts: { seed?: number; range?: { min: number; max: number } } = {}): World {
  const w = new World({
    league: getLeague('open'),
    halfLengthSeconds: 300,
    inclined: false,
    autoDamaged: false,
    placementSeed: opts.seed,
    ballPlacementSeconds: opts.range,
  });
  w.running = true;
  return w;
}

/** Everybody off but the one robot a test wants, so nobody wanders into it. */
function clearField(w: World, keep: string | null = null): void {
  for (const r of w.robots) {
    if (r.id === keep) continue;
    r.removed = true;
    r.penaltyRemaining = 1e9;
  }
}

function run(w: World, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) w.step(DT);
}

/** Seconds from now until the ball is back on the field. */
function timeInHand(w: World): number {
  let t = 0;
  while (!w.ballInPlay) {
    w.step(DT);
    t += DT;
    if (t > 10) throw new Error('the ball never came back');
  }
  return t;
}

/** Knock the ball over the side line, and let the referee see it. */
function sendOut(w: World): void {
  w.ball.x = 0;
  w.ball.z = -(HALF_WIDTH + 60);
  w.ball.vx = 0;
  w.ball.vz = 0;
  w.step(DT);
}

describe('putting the ball back (5.6.2, 5.9.2)', () => {
  it('takes the ball off the field, and puts it down only when the delay has run', () => {
    const w = world({ range: { min: 1, max: 1 } });
    clearField(w);
    sendOut(w);

    expect(w.ballInPlay).toBe(false);
    expect(w.ballAwayReason).toBe('hand');
    run(w, 0.9);
    expect(w.ballInPlay).toBe(false);
    run(w, 0.2);
    expect(w.ballInPlay).toBe(true);
    expect(w.ball.x).toBe(0);
    expect(w.ball.z).toBe(-NEUTRAL_OFFSET);
  });

  it('draws every delay from inside the range, the same way for the same seed', () => {
    const delays = (seed: number): number[] => {
      const w = world({ seed });
      clearField(w);
      const out: number[] = [];
      for (let i = 0; i < 12; i++) {
        w.callLackOfProgress();
        out.push(timeInHand(w));
      }
      return out;
    };
    const a = delays(7);
    for (const d of a) {
      expect(d).toBeGreaterThanOrEqual(BALL_PLACEMENT_SECONDS.min);
      expect(d).toBeLessThanOrEqual(BALL_PLACEMENT_SECONDS.max + DT);
    }
    // Varies from one placement to the next, not one number every time.
    expect(new Set(a.map((d) => d.toFixed(3))).size).toBeGreaterThan(3);
    expect(delays(7)).toEqual(a);
    expect(delays(8)).not.toEqual(a);
  });

  it("cannot be touched, scored or called while it is in somebody's hand", () => {
    const w = world({ range: { min: 2, max: 2 } });
    clearField(w, 'violet-1');
    const robot = w.robots.find((r) => r.id === 'violet-1')!;
    sendOut(w);
    const eventsAtLift = w.events.length;
    const lastTouch = w.lastBallTouch;

    // Parked right on top of where the ball was picked up.
    robot.x = w.ball.x;
    robot.z = w.ball.z + 200;
    const where = { x: w.ball.x, z: w.ball.z };
    run(w, 1.5);

    expect(w.ball.x).toBe(where.x);
    expect(w.ball.z).toBe(where.z);
    expect(w.lastBallTouch).toBe(lastTouch);
    // Out of play is not called again every tick the ball sits off the field.
    expect(w.events.length).toBe(eventsAtLift);
  });

  it('lands on a neutral point that is free when it lands, not when it was picked up', () => {
    const w = world({ range: { min: 1, max: 1 } });
    clearField(w, 'violet-1');
    const robot = w.robots.find((r) => r.id === 'violet-1')!;
    sendOut(w);

    // While the ball is being carried, a robot parks on the point it was
    // heading for.
    robot.x = 0;
    robot.z = -NEUTRAL_OFFSET;
    robot.motors = [0, 0, 0, 0];
    timeInHand(w);

    expect(Math.hypot(w.ball.x - 0, w.ball.z + NEUTRAL_OFFSET)).toBeGreaterThan(100);
  });

  it('still goes to the centre on a second lack of progress', () => {
    const w = world({ range: { min: 0.5, max: 0.5 } });
    clearField(w);
    w.ball.x = 500;
    w.ball.z = -NEUTRAL_OFFSET;
    w.callLackOfProgress();
    timeInHand(w);
    expect(w.ball.z).toBe(-NEUTRAL_OFFSET);

    w.callLackOfProgress();
    timeInHand(w);
    expect(w.ball.x).toBe(0);
    expect(w.ball.z).toBe(0);
  });

  it('is cancelled by a kick-off or a ball put down by hand', () => {
    const w = world();
    clearField(w);
    sendOut(w);
    w.kickOff('violet');
    expect(w.ballInPlay).toBe(true);

    sendOut(w);
    w.placeBall({ x: 123, z: 45 });
    expect(w.ballInPlay).toBe(true);
    run(w, 3);
    expect(Math.round(w.ball.x)).toBe(123);
  });

  it('moves instantly with a max of 0, as every match did before', () => {
    const w = world({ range: { min: 0, max: 0 } });
    clearField(w);
    sendOut(w);
    expect(w.ballInPlay).toBe(true);
    expect(w.ball.z).toBe(-NEUTRAL_OFFSET);
  });
});

describe('a ball switched off (practice field)', () => {
  it('stays off through restarts until it is switched back on', () => {
    const w = world();
    w.setBallOnField(false);
    expect(w.ballAwayReason).toBe('off');
    w.kickOff('lime');
    run(w, 3);
    expect(w.ballInPlay).toBe(false);

    w.setBallOnField(true, { x: 200, z: 100 });
    expect(w.ballInPlay).toBe(true);
    expect(w.ball.x).toBe(200);
    expect(w.ball.z).toBe(100);
  });

  it('is not put back by a placement by hand either', () => {
    const w = world();
    w.setBallOnField(false);
    w.placeBall({ x: 0, z: 0 });
    expect(w.ballInPlay).toBe(false);
    w.callLackOfProgress();
    expect(w.ballAwayReason).toBe('off');
  });
});
