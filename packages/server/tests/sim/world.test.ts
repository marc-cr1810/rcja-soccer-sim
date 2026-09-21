import { World } from '../../src/sim/world';
import { getLeague } from '@rcja/shared/leagues';
import {
  GOAL_BACK_X,
  GOAL_MOUTH_X,
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_DEPTH,
} from '../../src/sim/field';
import { distance } from '../../src/sim/physics';

const world = (
  leagueId: Parameters<typeof getLeague>[0],
  inclined = false,
  config: { kickoffCountdown?: number } = {},
) =>
  new World({
    league: getLeague(leagueId),
    halfLengthSeconds: 300,
    inclined,
    kickoffCountdown: config.kickoffCountdown ?? 0,
  });

/** Advance the simulation in small steps, as the render loop would. */
function run(w: World, seconds: number, dt = 1 / 120): void {
  for (let t = 0; t < seconds; t += dt) w.step(dt);
}

/** Until whoever is carrying the ball to a neutral point has put it down. */
function untilPlaced(w: World, dt = 1 / 120): void {
  for (let t = 0; !w.ballInPlay && t < 5; t += dt) w.step(dt);
}

describe('scoring (5.5.1)', () => {
  it('awards a goal when the ball strikes the back wall of the goal', () => {
    const w = world('open');
    w.robots.forEach((r) => (r.removed = true));
    // Fire the ball down the middle at the yellow goal (+x), which Violet attacks.
    w.ball.x = 400;
    w.ball.z = 0;
    w.ball.vx = 3000;
    run(w, 1.5);

    expect(w.score.violet).toBe(1);
    expect(w.events.some((e) => e.kind === 'goal' && e.rule === '5.5.1')).toBe(true);
  });

  it('does not award a goal for a ball that misses the mouth', () => {
    const w = world('open');
    w.robots.forEach((r) => (r.removed = true));
    w.ball.x = 400;
    w.ball.z = HALF_WIDTH - 60; // wide of the 450 mm goal
    w.ball.vx = 3000;
    run(w, 1.5);

    expect(w.score.violet).toBe(0);
  });

  it('keeps the ball inside the goal once it is in', () => {
    const w = world('open');
    w.robots.forEach((r) => (r.removed = true));
    w.ball.x = 400;
    w.ball.vx = 4000;
    run(w, 2);
    expect(Math.abs(w.ball.x)).toBeLessThanOrEqual(GOAL_BACK_X);
  });
});

describe('ball out of play (5.9.1)', () => {
  it('is out in Open as soon as it leaves the playing area', () => {
    const w = world('open');
    w.robots.forEach((r) => (r.removed = true));
    w.ball.x = 0;
    w.ball.z = HALF_WIDTH - 20;
    w.ball.vz = 900;
    // Long enough for somebody to walk the ball to its neutral point.
    run(w, 3);

    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(true);
    // 5.9.2: moved to the nearest neutral point, which is on the halfway line.
    expect(Math.abs(w.ball.x)).toBeLessThan(1);
    expect(Math.abs(w.ball.z)).toBeLessThanOrEqual(300);
  });

  it('never calls a goal-bound ball out of play', () => {
    const w = world('open');
    w.robots.forEach((r) => (r.removed = true));
    w.ball.x = 400;
    w.ball.vx = 3000;
    run(w, 1.5);

    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(false);
    expect(w.score.violet).toBe(1);
  });

  it('keeps a shot that clips the mouth edge in play, not out of play', () => {
    // Centre just wide enough to clip the post (225 - r < |z| <= 225): the
    // mouth wall rebounds it, and a live rebound is never 'out of play'.
    const w = world('open');
    // Park the robots clear of the shot corridor: with autoResolve on they
    // would otherwise be returned to a penalty-box corner and get clipped.
    w.robots.forEach((r, i) => {
      r.x = i % 2 === 0 ? -400 : 400;
      r.z = i < 2 ? 520 : -520;
    });
    w.ball.x = 600;
    w.ball.z = 220;
    w.ball.vx = 1800;
    run(w, 2.5);

    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(false);
    expect(w.score.violet).toBe(0);
    // It stayed on the field at its own z, not teleported to a neutral point.
    expect(w.ball.z).toBeCloseTo(220, 3);
    expect(Math.abs(w.ball.x)).toBeLessThan(HALF_LENGTH);
  });

  it('keeps a shot at the very edge of the mouth in play', () => {
    const w = world('open');
    w.robots.forEach((r, i) => {
      r.x = i % 2 === 0 ? -400 : 400;
      r.z = i < 2 ? 520 : -520;
    });
    w.ball.x = 600;
    w.ball.z = 224;
    w.ball.vx = 1800;
    run(w, 2.5);

    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(false);
    expect(w.score.violet).toBe(0);
    expect(w.ball.z).toBeCloseTo(224, 3);
  });

  it('rebounds a shot that clips the post rather than letting it through', () => {
    // A millimetre outside the mouth, so half the ball is on the post's front
    // face. The goal stands on the goal line now, so this never leaves the
    // playing area - it comes back off the woodwork.
    const w = world('open');
    w.robots.forEach((r, i) => {
      r.x = i % 2 === 0 ? -400 : 400;
      r.z = i < 2 ? 520 : -520;
    });
    w.ball.x = 600;
    w.ball.z = 226;
    w.ball.vx = 1800;
    run(w, 1);

    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(false);
    expect(w.score.violet).toBe(0);
    expect(Math.abs(w.ball.x)).toBeLessThan(HALF_LENGTH);
    expect(w.ball.z).toBeGreaterThan(HALF_GOAL_WIDTH);
  });

  it('calls out a ball that crosses the line wide of the mouth', () => {
    // Clear of the whole goal structure, walls included, so nothing is in the
    // way: it crosses the goal line into the out area beside the goal.
    const w = world('open');
    w.robots.forEach((r, i) => {
      r.x = i % 2 === 0 ? -400 : 400;
      r.z = i < 2 ? 520 : -520;
    });
    w.ball.x = 600;
    w.ball.z = 300;
    w.ball.vx = 1800;
    run(w, 3);

    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(true);
    // 5.9.2: moved to the nearest neutral point.
    expect(Math.abs(w.ball.x)).toBeLessThan(1);
    expect(Math.abs(w.ball.z)).toBeLessThanOrEqual(300);
  });
});

describe('multiple defence (5.11.2)', () => {
  it('moves the outfield robot when a goalie is involved', () => {
    const w = world('open');
    const [, , y1, y2] = w.robots;
    // Both lime robots inside their own penalty area.
    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = -160;
    y2!.x = HALF_LENGTH - 60;
    y2!.z = 0;
    expect(y2!.isGoalie).toBe(true);

    expect(w.multipleDefenceCandidates('lime')).toHaveLength(2);
    expect(w.suggestMultipleDefenceRemoval('lime')?.id).toBe(y1!.id);
  });

  it('suggests nothing when only one robot is in the area', () => {
    const w = world('open');
    expect(w.suggestMultipleDefenceRemoval('lime')).toBeNull();
  });

  it('moves the penalized robot to (0, 0) facing its own goal', () => {
    const w = world('open');
    // Move outfield robots and ball away from (0, 0) so centre is free
    const [c1, c2, y1, y2] = w.robots;
    c1!.x = -500; c1!.z = 0;
    c2!.x = -800; c2!.z = 0;
    w.placeBall({ x: 400, z: 200 });

    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = -160;
    y2!.x = HALF_LENGTH - 60;
    y2!.z = 0;

    const ok = w.callMultipleDefence('lime');
    expect(ok).toBe(true);
    expect(y1!.x).toBe(0);
    expect(y1!.z).toBe(0);
    expect(y1!.vx).toBe(0);
    expect(y1!.vz).toBe(0);
    expect(y1!.heading).toBe(0); // Facing yellow defending goal (+x)
    expect(w.events.some((e) => e.kind === 'possible-multiple-defence' && e.rule === '5.11.2')).toBe(true);
  });

  it('falls back to halfway neutral point if (0, 0) is occupied', () => {
    const w = world('open');
    const [c1, , y1, y2] = w.robots;
    // Occupy (0, 0) with violet robot
    c1!.x = 0;
    c1!.z = 0;

    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = -160;
    y2!.x = HALF_LENGTH - 60;
    y2!.z = 0;

    const ok = w.callMultipleDefence('lime');
    expect(ok).toBe(true);
    expect(y1!.x).toBe(0);
    expect(Math.abs(y1!.z)).toBe(300); // Neutral point (0, ±300)
    expect(w.events.some((e) => e.message.includes('halfway neutral point'))).toBe(true);
  });

  it('does not treat an outfield robot in the wing of the penalty box as a multiple defence candidate', () => {
    const w = world('open');
    const [, , y1, y2] = w.robots;
    // Both lime in penalty box, but y1 is in the wing (|z| = 350 > 275 mm goal mouth corridor)
    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = 350;
    y2!.x = HALF_LENGTH - 60;
    y2!.z = 0;

    // y1 is not directly blocking the goal mouth
    expect(w.multipleDefenceCandidates('lime')).toHaveLength(1);
    expect(w.multipleDefenceCandidates('lime')[0]!.id).toBe(y2!.id);
  });

  it('does not trigger multiple defence if ball is in the opponent half', () => {
    const w = world('open');
    w.running = true;
    w.sinceKickOff = 10;
    const [, , y1, y2] = w.robots;
    // Lime defenders directly blocking goal
    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = -100;
    y2!.x = HALF_LENGTH - 60;
    y2!.z = 0;

    // Ball is far downfield in violet's defending half (-600 mm)
    w.ball.x = -600;
    w.ball.z = 0;

    for (let i = 0; i < 60; i++) {
      w.step(1 / 30);
    }
    expect(w.events.some((e) => e.kind === 'possible-multiple-defence')).toBe(false);
  });

  it('requires sustained dwell time before auto-resolving multiple defence', () => {
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoResolve: true,
    });
    w.running = true;
    w.sinceKickOff = 10;
    const [c1, c2, y1, y2] = w.robots;
    c1!.x = -500; c1!.z = 0;
    c2!.x = -700; c2!.z = 0;
    w.ball.x = 400; w.ball.z = 0;

    // Lime defenders directly blocking goal
    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = -100;
    y2!.x = HALF_LENGTH - 60;
    y2!.z = 0;

    // Step for 0.5s: dwell < 1.0s, so robot should NOT be relocated yet
    for (let i = 0; i < 15; i++) {
      y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
      y1!.z = -100;
      y2!.x = HALF_LENGTH - 60;
      y2!.z = 0;
      w.step(1 / 30);
    }
    expect(y1!.x).not.toBe(0);

    // Step another 0.6s: dwell exceeds 1.0s, auto-relocation occurs
    for (let i = 0; i < 20; i++) {
      w.step(1 / 30);
    }
    expect(y1!.x).toBe(0);
    expect(y1!.z).toBe(0);
  });
});

describe('forcing (5.6.1.3 and 5.6.1.4)', () => {
  it('disallows a goal scored as a direct result of forcing in the penalty box (5.6.1.3)', () => {
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -800; c2!.z = -500;
    y1!.x = -500; y1!.z = -500;

    // Violet striker pushing Lime goalie at edge of Yellow penalty box (615 mm to 915 mm)
    // Put y2 at 750 (inside box), c1 at 520, ball at 635
    //
    // Shoving for 0.8 s, not the 0.25 s this used to use. The duration was
    // incidental when any contact at all disallowed a goal; now it is the
    // whole question, and a quarter second of contact is a striker going past
    // a keeper rather than through one.
    for (let t = 0; t < 0.8; t += 1 / 120) {
      y2!.x = 750;
      y2!.z = 0;
      c1!.x = 520;
      c1!.z = 0;
      c1!.heading = 0; // Facing +x (yellow goal)
      c1!.vx = 600; // Driving forward towards yellow goal
      w.ball.x = 635;
      w.ball.z = 0;
      w.ball.vx = 0;
      w.step(1 / 120);
    }

    // Now striker shoves ball through into the goal
    w.ball.x = GOAL_BACK_X;
    w.step(1 / 120);

    // Goal must be disallowed!
    expect(w.score.violet).toBe(0);
    expect(w.events.some((e) => e.rule === '5.6.1.3' && e.message.includes('Goal disallowed'))).toBe(true);
  });

  it('does NOT disallow a goal because the striker brushed the keeper on the way past', () => {
    /*
     * Reported from a real match: a striker carried the ball in, the keeper
     * came out and just missed it, the ball went in - and instead of a goal
     * the ball was moved to the centre spot for lack of progress.
     *
     * The disallow keyed off `lastForcingTeam`, which is set on ANY tick where
     * an attacker with the ball touches a defender in the box. A goal within
     * 0.8 s of a single touch was wiped. Measured over champion and reference
     * play that was 163 goals, 22% of every goal scored, 75 of them on one
     * tick of contact - and not one had been shoving long enough to be the
     * offence 5.6.1.3 actually describes.
     */
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -800; c2!.z = -500;
    y1!.x = -500; y1!.z = -500;

    // The same geometry as the test above, held for two ticks instead of 0.8 s.
    for (let t = 0; t < 2 / 120; t += 1 / 120) {
      y2!.x = 750; y2!.z = 0;
      c1!.x = 520; c1!.z = 0; c1!.heading = 0; c1!.vx = 600;
      w.ball.x = 635; w.ball.z = 0; w.ball.vx = 0;
      w.step(1 / 120);
    }

    w.ball.x = GOAL_BACK_X;
    w.step(1 / 120);

    expect(w.score.violet).toBe(1);
    expect(w.events.some((e) => (e.message ?? '').includes('Goal disallowed'))).toBe(false);
  });

  it('calls 5.6.1.4 lack of progress when attacker forces defenders into multiple defence', () => {
    const w = world('open');
    w.running = true;
    w.sinceKickOff = 10;
    const [c1, , y1, y2] = w.robots;

    // Lime defenders in box
    y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
    y1!.z = -50;
    // Off to one side, clear of its team-mate: two defenders overlapping each
    // other would shove one back out of the box and there would be no
    // multiple defence left for 5.6.1.4 to take priority over.
    y2!.x = HALF_LENGTH - 110;
    y2!.z = 200;

    // Violet striker contacting defender with ball between them, driving in
    for (let t = 0; t <= 1.1; t += 1 / 120) {
      c1!.x = y1!.x - 220;
      c1!.z = -50;
      c1!.vx = 500;
      // Held between them, not just placed there: without pinning the
      // velocity the separation solver squirts it out of the pinch and the
      // scenario stops being the one the rule is about.
      w.ball.x = y1!.x - 110;
      w.ball.z = -50;
      w.ball.vx = 0;
      w.ball.vz = 0;
      y1!.x = HALF_LENGTH - PENALTY_DEPTH + 40;
      y1!.z = -50;
      y2!.x = HALF_LENGTH - 110;
      y2!.z = 200;
      w.step(1 / 120);
    }

    // 5.6.1.4 must take priority over 5.11
    expect(w.events.some((e) => e.rule === '5.6.1.4')).toBe(true);
    expect(w.events.some((e) => e.rule === '5.11.1')).toBe(false);
  });
});

describe('damaged robots enforcement (5.7.1.2 and 5.8.3)', () => {
  it('removes a robot overstaying in the goal area > 20s (5.7.1.2)', () => {
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: true,
    });
    w.running = true;
    const [c1] = w.robots;
    c1!.x = -HALF_LENGTH;
    c1!.z = 0;

    for (let t = 0; t <= 20.5; t += 0.5) {
      c1!.x = -HALF_LENGTH;
      c1!.z = 0;
      w.step(0.5);
    }

    expect(c1!.removed).toBe(true);
    expect(c1!.removalRule).toBe('5.7.1.2');
  });

  it('removes a goalie failing to challenge forward in its penalty box (5.8.3)', () => {
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: true,
    });
    w.running = true;
    const [, , , y2] = w.robots;
    expect(y2!.isGoalie).toBe(true);

    // Ball stationary in yellow penalty box
    w.ball.x = HALF_LENGTH - 150;
    w.ball.z = 0;
    w.ball.vx = 0;
    w.ball.vz = 0;

    // Goalie stays on goal line
    y2!.x = HALF_LENGTH - 50;
    y2!.z = 0;

    for (let t = 0; t <= 8.5; t += 0.5) {
      y2!.x = HALF_LENGTH - 50;
      w.ball.vx = 0;
      w.ball.vz = 0;
      w.step(0.5);
    }

    expect(y2!.removed).toBe(true);
    expect(y2!.removalRule).toBe('5.8.3');
  });
});

describe('lack of progress (5.6)', () => {
  /**
   * The case a speed threshold misses, and the one that actually spoils a
   * match: robots wedged in a line against a wall with the ball trapped
   * between them. The ball is being jostled, so it is not stationary, but it
   * is going nowhere - which is exactly what 5.6.1.2 is about.
   */
  it('calls it when the ball is trapped in a scrum and stops progressing', () => {
    /*
     * Changed from the lab's version, which squeezed the ball between two
     * robots facing each other on a line with everything at z = 0.
     *
     * That is an unstable equilibrium, not a trap: a round ball pinched
     * between two round robots on a line has two ways out, and which one it
     * takes is decided by whatever rounding happens first. It held under the
     * lab's velocity damping and squirts out under the motor model, and both
     * are correct physics of a scenario that was always on a knife edge.
     *
     * Four robots closing from four sides is a real jam, and it is also what
     * 5.6.1.2 is actually written about. The assertions are unchanged.
     */
    const w = world('open');
    w.running = true;

    const [c1, c2, y1, y2] = w.robots;
    const bx = -420;
    const bz = 190;
    w.placeBall({ x: bx, z: bz });
    c1!.x = bx + 230; c1!.z = bz - 60;
    c2!.x = bx - 60;  c2!.z = bz + 230;
    y1!.x = bx - 230; y1!.z = bz + 60;
    y2!.x = bx + 60;  y2!.z = bz - 230;

    const startedAt = { x: w.ball.x, z: w.ball.z };
    for (let t = 0; t < 9; t += 1 / 120) {
      // Hold the squeeze: everyone keeps pressing, as they would in play.
      c1!.vx = -500; c1!.vz = 0;
      c2!.vx = 0;    c2!.vz = -500;
      y1!.vx = 500;  y1!.vz = 0;
      y2!.vx = 0;    y2!.vz = 500;
      w.step(1 / 120);
    }

    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(true);
    // The ball never left the field on its own; it was moved by the referee.
    expect(w.events.some((e) => e.kind === 'ball-out-of-play')).toBe(false);
    // 5.6.2: the ball is moved, so it is no longer where it was jammed.
    expect(distance(w.ball, startedAt)).toBeGreaterThan(200);
  });

  it('does NOT call lack of progress when a single robot is dribbling the ball', () => {
    // Possession that is going somewhere. The robot keeps the ball at its feet
    // the whole way, which is exactly what it is allowed to do with it.
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;

    for (let t = 0; t < 12; t += 1 / 60) {
      w.ball.x = -700 + t * 120;
      w.ball.z = 0;
      w.ball.vx = 120;
      c1!.x = w.ball.x - 140; c1!.z = 0;
      w.step(1 / 60);
    }
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(false);
  });

  it('DOES call it when a robot just sits on the ball unopposed', () => {
    /*
     * The hole the "one robot on it is possession" reading left open, and it
     * was not a small one: over a bot round-robin the longest any ball went
     * without getting anywhere was 240 seconds - a whole match - of a robot
     * sitting on it with no opponent near and the referee saying nothing.
     * 28% of every dead spell past eight seconds had this shape.
     *
     * Possession is still possession. It just does not last forever.
     */
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;
    w.placeBall({ x: 40, z: 0 });

    let calledAt: number | null = null;
    for (let t = 0; t < 12; t += 1 / 60) {
      c1!.x = 0; c1!.z = 0;
      w.ball.x = 40; w.ball.z = 0;
      w.step(1 / 60);
      if (calledAt === null && w.events.some((e) => e.kind === 'lack-of-progress')) calledAt = t;
    }
    expect(calledAt).not.toBeNull();
    // Longer rope than a contested ball gets, but rope, not the match.
    expect(calledAt!).toBeGreaterThan(5);
    expect(calledAt!).toBeLessThan(10);
  });

  it('DOES call it on a robot spinning the ball on the spot', () => {
    // Speed would say this ball is flying. Displacement says it is exactly
    // where it was eight seconds ago, which is the only question 5.6 asks.
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;
    c1!.x = 0; c1!.z = 0;

    let peak = 0;
    for (let t = 0; t < 12; t += 1 / 60) {
      c1!.x = 0; c1!.z = 0;
      w.ball.x = Math.cos(t * 6) * 120;
      w.ball.z = Math.sin(t * 6) * 120;
      w.ball.vx = -Math.sin(t * 6) * 720;
      w.ball.vz = Math.cos(t * 6) * 720;
      peak = Math.max(peak, Math.hypot(w.ball.vx, w.ball.vz));
      w.step(1 / 60);
      if (w.events.some((e) => e.kind === 'lack-of-progress')) break;
    }
    expect(peak).toBeGreaterThan(400);
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(true);
  });

  it('obeys the window a venue set, not only the simulator default', () => {
    // The point of the setting is that the number a venue writes in
    // league.json is the number the ball is actually judged by. Three seconds
    // is nothing like the default, so a call at three can only have come from
    // here.
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      kickoffCountdown: 0,
      heldBallSeconds: 3,
    });
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;
    w.placeBall({ x: 40, z: 0 });

    let calledAt: number | null = null;
    for (let t = 0; t < 8; t += 1 / 60) {
      c1!.x = 0; c1!.z = 0;
      w.ball.x = 40; w.ball.z = 0;
      w.step(1 / 60);
      if (calledAt === null && w.events.some((e) => e.kind === 'lack-of-progress')) calledAt = t;
    }
    expect(calledAt).not.toBeNull();
    expect(calledAt!).toBeGreaterThan(2.5);
    expect(calledAt!).toBeLessThan(4.5);
  });

  it('leaves a held ball alone forever when heldBallSeconds is turned off', () => {
    // The knob, because how long possession may sit on a ball is a judgement
    // about how the game should play, not a reading of the rule book.
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      kickoffCountdown: 0,
      heldBallSeconds: 0,
    });
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;
    w.placeBall({ x: 40, z: 0 });

    for (let t = 0; t < 30; t += 1 / 60) {
      c1!.x = 0; c1!.z = 0;
      w.ball.x = 40; w.ball.z = 0;
      w.step(1 / 60);
    }
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(false);
  });

  it('does NOT call lack of progress when teammates pass or hold the ball together', () => {
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    // Keep opponents far away
    y1!.x = 800; y2!.x = 850;
    // Two teammates either side of the ball
    c1!.x = -350; c1!.z = 0;
    c2!.x = 350; c2!.z = 0;
    w.placeBall({ x: 0, z: 0 });

    // Passing it about properly: the ball crosses between them, so it leaves
    // its own circle every time and the window never completes.
    for (let t = 0; t < 12; t += 1 / 60) {
      c1!.x = -350; c1!.z = 0;
      c2!.x = 350; c2!.z = 0;
      w.ball.x = Math.sin(t * 1.5) * 240;
      w.ball.z = 0;
      w.step(1 / 60);
    }
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(false);
  });

  it('does NOT call lack of progress when an opposing contest is broken before the window expires', () => {
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y2!.x = 1850;
    c1!.x = -60; c1!.z = 0;
    w.placeBall({ x: 0, z: 0 });

    for (let t = 0; t < 8; t += 1 / 60) {
      // y1 contests only for the first 2 seconds, then retreats far away -
      // and c1, now unopposed, takes the ball off up the field with it, which
      // is what winning a contest is for.
      if (t < 2) {
        y1!.x = 60; y1!.z = 0;
        c1!.x = -60; c1!.z = 0;
        w.ball.x = 0; w.ball.z = 0;
      } else {
        y1!.x = 1800; y1!.z = 0;
        w.ball.x = (t - 2) * 150;
        w.ball.z = 0;
        w.ball.vx = 150;
        c1!.x = w.ball.x - 140; c1!.z = 0;
      }
      w.step(1 / 60);
    }
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(false);
  });

  it('does NOT call lack of progress when the ball is going somewhere', () => {
    // Down the field at a walking pace, with robots in the neighbourhood. The
    // ball leaves its own circle again and again, which is what progress is.
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -800; y2!.x = 850;

    for (let t = 0; t < 8; t += 1 / 60) {
      w.ball.x = -700 + t * 175;
      w.ball.z = 0;
      w.ball.vx = 175;
      c1!.x = w.ball.x - 140; c1!.z = 0;
      y1!.x = w.ball.x + 160; y1!.z = 0;
      w.step(1 / 60);
    }
    // Specifically 5.6.1.1. Two robots escorting a ball down the field into a
    // penalty box is forcing under 5.6.1.3, which is a different offence that
    // happens to share an event kind, and not what this test is about.
    expect(w.events.some((e) => e.rule === '5.6.1.1')).toBe(false);
  });

  it('calls it on a jostled ball that is not stationary and not going anywhere', () => {
    /*
     * This is the case the describe block above is about, and for a long time
     * it was the case that got away.
     *
     * The ball rattles between two robots, crossing the old sixty-millimetre
     * speed threshold several times a second, and never leaves a region a
     * robot could stand in. A detector that reset its window whenever the ball
     * twitched could never finish a window here, so the call came at nearly
     * ten seconds instead of five, or not at all - and a spectator had already
     * decided nobody was refereeing.
     */
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -800; y2!.x = 850;
    c1!.x = -80; c1!.z = 0;
    y1!.x = 80; y1!.z = 0;

    let calledAt: number | null = null;
    let peakSpeed = 0;
    for (let t = 0; t < 12; t += 1 / 60) {
      w.ball.x = Math.sin(t * 4) * 120;
      w.ball.z = 0;
      // Genuinely moving: this is not a test about a stationary ball.
      w.ball.vx = Math.cos(t * 4) * 480;
      peakSpeed = Math.max(peakSpeed, Math.abs(w.ball.vx));
      w.step(1 / 60);
      if (calledAt === null && w.events.some((e) => e.kind === 'lack-of-progress')) {
        calledAt = t;
      }
    }

    expect(peakSpeed).toBeGreaterThan(60);
    expect(calledAt).not.toBeNull();
    // Within the window the rule actually sets, not twice it.
    expect(calledAt!).toBeLessThan(7);
  });


  it('does NOT call it on a ball being worked slowly but steadily down the field', () => {
    /*
     * The false call this pair of constants exists to stop, and the one that
     * spoiled matches that were perfectly fine to watch.
     *
     * The displacement test asks for 320 mm in 5 s, which is 64 mm/s of net
     * travel, so it was quietly a speed limit: a contested ball being edged
     * out of a corner at a walking pace is going somewhere unmistakably, and
     * was called for lack of progress anyway. Straightness is what tells the
     * two apart - this ball's path and its displacement are the same number.
     */
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y2!.x = 1850;

    // 55 mm/s: well under the 64 mm/s the displacement test implied.
    for (let t = 0; t < 12; t += 1 / 60) {
      w.ball.x = -700 + t * 55;
      w.ball.z = 0;
      w.ball.vx = 55;
      // Both teams in contest the whole way, so 5.6.1.2 is watching.
      c1!.x = w.ball.x - 150; c1!.z = 0;
      y1!.x = w.ball.x + 170; y1!.z = 0;
      w.step(1 / 60);
    }

    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(false);
    // And it really did travel - this is not a test that stood still.
    expect(w.ball.x).toBeGreaterThan(-100);
  });

  it('still calls it on a ball that covers ground without covering distance', () => {
    // The other side of the straightness test: same path length as the slow
    // walk above, spent going back and forth instead of down the field.
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y2!.x = 1850;
    c1!.x = -80; c1!.z = 0;
    y1!.x = 80; y1!.z = 0;

    for (let t = 0; t < 8; t += 1 / 60) {
      w.ball.x = Math.sin(t * 1.2) * 55;
      w.ball.z = 0;
      w.step(1 / 60);
      if (w.events.some((e) => e.kind === 'lack-of-progress')) break;
    }
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(true);
  });

  it('does NOT spend a held ball\'s banked seconds against the contested window', () => {
    /*
     * Reported from a real match: lack of progress called in front of the goal
     * mouth with a goal coming, on a ball that was moving the whole time.
     *
     * A striker that has the ball unopposed is judged on the eight-second held
     * window. A keeper coming out to meet it makes the ball contested, and
     * contested is judged on five. With one clock serving both, every second
     * the striker had already spent counted against a window it was never
     * running under - so a contest that was 0.00 seconds old was called for a
     * stall that could not have happened during it. Measured before the fix:
     * the call landed on the exact tick the keeper arrived.
     *
     * An opponent arriving is the clearest sign a ball is about to be fought
     * over rather than stuck. The clock restarts.
     */
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -800; c2!.z = 500; y2!.x = -800; y2!.z = -500;

    let calledAt: number | null = null;
    let contestedFrom: number | null = null;
    for (let t = 0; t < 16; t += 1 / 120) {
      // Creeping goalward, inside its own circle: held, and banking seconds.
      const bx = HALF_LENGTH - 400 + t * 12;
      w.ball.x = bx; w.ball.z = 0; w.ball.vx = 12; w.ball.vz = 0;
      // Clear of the ball, so the contact solver is not what is under test.
      c1!.x = bx - 152; c1!.z = 0;
      // The keeper waits wide, then steps in front at five seconds.
      if (t < 5) { y1!.x = HALF_LENGTH - 60; y1!.z = 640; }
      else { y1!.x = bx + 175; y1!.z = 0; }
      if (contestedFrom === null && Math.hypot(y1!.x - bx, y1!.z) < 320) contestedFrom = t;
      w.step(1 / 120);
      if (calledAt === null && w.events.some((e) => e.kind === 'lack-of-progress')) calledAt = t;
    }

    expect(contestedFrom).not.toBeNull();
    // Whatever the referee decides, it cannot be decided on the keeper's
    // arrival. The contested window is five seconds and it starts here.
    if (calledAt !== null) {
      expect(calledAt - contestedFrom!).toBeGreaterThan(4.9);
    }
  });

  it('does NOT call it on a ball being played around a goalmouth', () => {
    /*
     * Reported from real matches, more than once and with feeling: a ball
     * kicked at the goal, plainly moving the whole time, called for lack of
     * progress.
     *
     * PROGRESS_DISTANCE is measured from a single mark, so it asks where the
     * ball ENDED UP. A ball being hammered back and forth across a goalmouth
     * ends up nowhere without ever once being stuck, and the straightness
     * let-off cannot save it either, because a ball going back and forth is
     * not going straight. Measured on real play, those windows had the ball at
     * 205-346 mm/s mean with peaks past 2 m/s, ranging over a box 389-604 mm
     * across - while windows where the ball was genuinely stopped had a span
     * of ZERO at the 90th percentile.
     */
    const w = world('open');
    w.running = true;
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -800; c2!.z = 400; y2!.x = -700; y2!.z = -400;

    // Striker and keeper both on it, the ball worked across the mouth.
    let peak = 0;
    for (let t = 0; t < 14; t += 1 / 120) {
      const bz = Math.sin(t * 2.2) * 210;
      w.ball.x = HALF_LENGTH - 260 + Math.cos(t * 3.1) * 60;
      w.ball.z = bz;
      w.ball.vx = -Math.sin(t * 3.1) * 186;
      w.ball.vz = Math.cos(t * 2.2) * 462;
      peak = Math.max(peak, Math.hypot(w.ball.vx, w.ball.vz));
      c1!.x = w.ball.x - 150; c1!.z = bz;
      y1!.x = w.ball.x + 160; y1!.z = bz;
      w.step(1 / 120);
    }

    // It really was being played, not nudged.
    expect(peak).toBeGreaterThan(400);
    expect(w.events.some((e) => e.kind === 'lack-of-progress')).toBe(false);
  });

  it('escalates from a neutral point to the centre on the second call', () => {
    const w = world('open');
    w.ball.x = 500;
    w.ball.z = 250;

    w.callLackOfProgress();
    untilPlaced(w);
    const first = { x: w.ball.x, z: w.ball.z };
    expect(Math.abs(first.z)).toBe(300);

    w.ball.x = 500;
    w.ball.z = 250;
    w.callLackOfProgress();
    untilPlaced(w);
    expect(w.ball.x).toBe(0);
    expect(w.ball.z).toBe(0);
  });
});

describe('damaged robots (5.7)', () => {
  it('holds a removed robot off for thirty seconds with five-minute halves', () => {
    // Referee semantics: the human grants the return, so nothing returns it
    // automatically while the test is waiting.
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: false,
    });
    const robot = w.robots[0]!;
    w.removeRobot(robot.id, '5.7.1.1', 'Not responding to the ball.');

    expect(robot.removed).toBe(true);
    expect(robot.penaltyRemaining).toBe(30);
    expect(w.returnRobot(robot.id)).toBe(false);

    run(w, 31);
    expect(w.returnRobot(robot.id)).toBe(true);
    expect(robot.removed).toBe(false);
  });

  it('uses one minute for ten-minute halves', () => {
    const w = new World({ league: getLeague('open'), halfLengthSeconds: 600, inclined: false });
    const robot = w.robots[0]!;
    w.removeRobot(robot.id, '5.7.1.1', 'Not responding.');
    expect(robot.penaltyRemaining).toBe(60);
  });

  it('returns a robot to its own penalty box, not facing the ball', () => {
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: false,
    });
    const robot = w.robots.find((r) => r.id === 'lime-1')!;
    w.removeRobot(robot.id, '5.7.1.1', 'Not responding.');
    run(w, 31);
    w.returnRobot(robot.id);

    // Lime defends +x, so the robot must come back on that side.
    expect(robot.x).toBeGreaterThan(0);
    expect(Math.abs(robot.x)).toBeGreaterThan(HALF_LENGTH - PENALTY_DEPTH - 1);
  });

  it('tracks removal rule, reason, and stand-down timer until returned', () => {
    const w = new World({
      league: getLeague('lightweight'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: false,
    });
    const robot = w.robots[0]!;
    w.removeRobot(robot.id, '5.7.1.6', 'The whole robot entered the out area with no opponent involved.');

    expect(robot.removed).toBe(true);
    expect(robot.removalRule).toBe('5.7.1.6');
    expect(robot.removalReason).toContain('whole robot entered the out area');
    expect(robot.penaltyRemaining).toBe(30);

    // After 10s of match play, 20s should remain on the stand-down timer
    run(w, 10);
    expect(Math.round(robot.penaltyRemaining)).toBe(20);
    expect(robot.removed).toBe(true);

    // After remaining 20s, stand-down is complete and robot returns cleanly
    run(w, 20.5);
    expect(robot.penaltyRemaining).toBe(0);
    expect(w.returnRobot(robot.id)).toBe(true);
    expect(robot.removed).toBe(false);
    expect(robot.removalRule).toBeUndefined();
    expect(robot.removalReason).toBeUndefined();
  });

  it('comes back on at a kick-off, even mid stand-down', () => {
    // A restart puts every robot back on the field: the damage call ends at
    // the next kick-off rather than the robot sitting out the rest of its
    // thirty seconds while play restarts without it.
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: false,
    });
    const robot = w.robots[0]!;
    w.removeRobot(robot.id, '5.7.1.1', 'Not responding to the ball.');
    run(w, 5);
    expect(robot.penaltyRemaining).toBeGreaterThan(0);

    w.kickOff('lime');

    const same = w.robots.find((r) => r.id === robot.id)!;
    expect(same.removed).toBe(false);
    expect(same.penaltyRemaining).toBe(0);
    expect(same.removalRule).toBeUndefined();
    expect(same.removalReason).toBeUndefined();
    expect(w.active().some((r) => r.id === robot.id)).toBe(true);
  });
});

describe('kick-off placement (5.4.5)', () => {
  it('overlaps each non-kicking robot with its penalty box without sitting in it', () => {
    const w = world('open');
    w.kickOff('violet');

    for (const robot of w.robots.filter((r) => r.team === 'lime')) {
      const boxEdge = HALF_LENGTH - PENALTY_DEPTH;
      // 5.4.5: some part of the robot in the box.
      expect(robot.x + robot.radius, robot.id).toBeGreaterThan(boxEdge);
    }

    // ...but not so far in that the 5.11.1 detector reads a legal kick-off as
    // multiple defence. The goalie is allowed to be properly inside.
    const outfield = w.robots.find((r) => r.id === 'lime-1')!;
    expect(outfield.x).toBeLessThan(HALF_LENGTH - PENALTY_DEPTH);
    expect(w.suggestMultipleDefenceRemoval('lime')).toBeNull();
  });

  it('does not raise multiple defence during the kick-off settle', () => {
    const w = world('open');
    w.running = true;
    w.kickOff('violet');
    run(w, 2);
    expect(w.events.some((e) => e.kind === 'possible-multiple-defence')).toBe(false);
  });

  it('places the kicking-off robot close to the ball complying with rule 5.4.7', () => {
    const w = world('lightweight');
    w.kickOff('violet');
    const violetStriker = w.robots.find((r) => r.id === 'violet-1')!;
    const gap = distance(violetStriker, w.ball) - (violetStriker.radius + w.ball.radius);
    // In a kicking league, starts ~15 mm from the ball.
    expect(gap).toBeCloseTo(15, 0);
  });
});

describe('kick-off countdown (placed but not live)', () => {
  it('runs the countdown after kickOff without starting the clock', () => {
    const w = world('open', false, { kickoffCountdown: 3 });
    w.kickOff('violet');

    expect(w.countdownSeconds).toBe(3);
    expect(w.running).toBe(false);
    // 5.4.7 is NOT armed while the countdown runs: it opens at the whistle.
    expect(w.restart.pending).toBe(false);
    expect(w.restart.team).toBe('violet'); // still this side's restart

    run(w, 1);
    expect(w.countdownSeconds).toBeCloseTo(2, 1); // run() steps 121 times per sim-second
    expect(w.clock).toBe(0); // half-start clock stays stopped
  });

  it('blows the whistle at zero: clock starts and 5.4.7 opens', () => {
    const w = world('open', false, { kickoffCountdown: 3 });
    w.kickOff('violet');
    run(w, 3.5);

    expect(w.countdownSeconds).toBe(0);
    expect(w.running).toBe(true);
    expect(w.events.some((e) => e.kind === 'kickoff-live')).toBe(true);
    // The striker is ~15 mm from the ball, so it may take the strike.
    expect(w.restart.pending).toBe(true);
    // The 3-second window of rule 5.4.7 starts at the whistle, not at the
    // placement: an illegal kick-off is only possible while actually live.
    expect(w.sinceKickOff).toBeCloseTo(0.5, 1);
  });

  it('keeps post-goal auto-resolve going through the countdown', () => {
    const w = world('open', false, { kickoffCountdown: 2 });
    w.running = true; // play is under way when the goal is scored
    w.robots.forEach((r) => (r.removed = true));
    w.ball.x = 400;
    w.ball.vx = 3000;
    run(w, 1); // the goal restarts without a whistle-before-clock

    expect(w.score.violet).toBe(1);
    // World.kickOff (not Match.kickOff) leaves `running` alone, so the clock
    // keeps running while the next restart is placed and counts down.
    expect(w.running).toBe(true);
    expect(w.countdownSeconds).toBeGreaterThan(0);
    expect(w.clock).toBeGreaterThan(0);
    expect(w.events.some((e) => e.kind === 'kickoff-live')).toBe(false);

    run(w, 3);
    expect(w.countdownSeconds).toBe(0);
    expect(w.events.some((e) => e.kind === 'kickoff-live')).toBe(true);
  });

  it('requires a clear strike only once the ball is live', () => {
    const w = world('open', false, { kickoffCountdown: 1 });
    w.kickOff('violet');

    // Mid-countdown the ball is not live: take it off the spot and hold it,
    // and rule 5.4.7 cannot be asked for compliance because no kick-off has
    // been taken yet. The detector must stay silent.
    const striker = w.robots.find((r) => r.id === 'violet-1')!;
    w.ball.x = 180; // carried more than 120 mm from the centre spot
    striker.x = w.ball.x - striker.radius - w.ball.radius + 5; // touching it
    w.step(1 / 120);
    expect(w.events.some((e) => e.kind === 'illegal-kickoff')).toBe(false);
    expect(w.restart.pending).toBe(false);

    // The whistle opens 5.4.7. The ball is still held off the spot, so the
    // next eligible step awards the kick-off to the other side.
    run(w, 3.5);
    expect(w.countdownSeconds).toBe(0);
    expect(w.events.some((e) => e.kind === 'illegal-kickoff')).toBe(true);
  });

  it('pause freezes the countdown and resume continues it', () => {
    const w = world('open', false, { kickoffCountdown: 3 });
    w.kickOff('violet');
    run(w, 1);
    w.paused = true;
    w.running = true; // a referee pausing an already-started restart
    run(w, 2);
    expect(w.countdownSeconds).toBeCloseTo(2, 1);
    w.paused = false;
    run(w, 1);
    expect(w.countdownSeconds).toBeCloseTo(1, 1);
  });

  it('skipKickoffCountdown blows the whistle immediately', () => {
    const w = world('open', false, { kickoffCountdown: 3 });
    w.kickOff('violet');
    expect(w.running).toBe(false);
    w.skipKickoffCountdown();
    expect(w.countdownSeconds).toBe(0);
    expect(w.running).toBe(true);
    expect(w.events.some((e) => e.kind === 'kickoff-live')).toBe(true);
  });

  it('leaves countdown 0 and the instant restart exactly as before', () => {
    const w = world('open'); // kickoffCountdown 0, today's behaviour
    w.kickOff('violet');
    expect(w.countdownSeconds).toBe(0);
    expect(w.restart.pending).toBe(true);
    expect(w.running).toBe(false); // the caller decides, as always
  });
});

describe('rule 5.7.1.6 is applied, not just reported', () => {
  it('removes a Lightweight robot that drives wholly into the out area alone', () => {
    const w = world('lightweight');
    const robot = w.robots.find((r) => r.id === 'violet-1')!;
    // Park every other robot far away so no opponent contact can be claimed.
    for (const other of w.robots) if (other !== robot) other.removed = true;

    robot.x = 0;
    robot.z = HALF_WIDTH + robot.radius + 40;
    run(w, 1.5);

    expect(robot.removed).toBe(true);
    expect(w.events.some((e) => e.rule === '5.7.1.6')).toBe(true);
  });

  it('applies the exception and nudges back a robot an opponent pushed out', () => {
    const w = world('lightweight');
    const pushed = w.robots.find((r) => r.id === 'violet-1')!;
    const pusher = w.robots.find((r) => r.id === 'lime-1')!;

    pushed.x = 0;
    pushed.z = HALF_WIDTH + pushed.radius + 30;
    pusher.x = 0;
    pusher.z = pushed.z - pushed.radius * 1.6; // in contact
    run(w, 1.5);

    expect(pushed.removed).toBe(false);
    expect(w.events.some((e) => e.message.includes('exception applies'))).toBe(true);
  });

  it('leaves the call to the referee when autoDamaged is off', () => {
    const w = new World({
      league: getLeague('lightweight'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: false,
    });
    const robot = w.robots.find((r) => r.id === 'violet-1')!;
    for (const other of w.robots) if (other !== robot) other.removed = true;
    robot.x = 0;
    robot.z = HALF_WIDTH + robot.radius + 40;
    run(w, 1.5);

    expect(robot.removed).toBe(false);
    expect(w.events.some((e) => e.rule === '5.7.1.6')).toBe(true);
  });

  });

describe('robots do not merge into each other', () => {
  /** Smallest gap between any two active robots, negative when overlapping. */
  function minGap(w: World): number {
    const actives = w.robots.filter((r) => !r.removed);
    let worst = Infinity;
    for (let i = 0; i < actives.length; i++) {
      for (let j = i + 1; j < actives.length; j++) {
        const a = actives[i]!;
        const b = actives[j]!;
        worst = Math.min(worst, Math.hypot(a.x - b.x, a.z - b.z) - a.radius - b.radius);
      }
    }
    return worst;
  }

  it('separates robots that start on top of one another', () => {
    const w = world('open');
    for (const robot of w.robots) {
      robot.x = 0;
      robot.z = 0;
    }
    run(w, 1);
    expect(minGap(w)).toBeGreaterThan(-1);
  });

  it('holds them apart while they are driven together', () => {
    const w = world('open');
    const [c1, c2, y1, y2] = w.robots;
    c1!.x = -200; c1!.z = 0;
    y1!.x = 200; y1!.z = 0;
    c2!.x = -200; c2!.z = 240;
    y2!.x = 200; y2!.z = 240;

    // Drive both teams straight at each other for a couple of seconds.
    for (let t = 0; t < 2; t += 1 / 120) {
      c1!.vx = 900; c2!.vx = 900;
      y1!.vx = -900; y2!.vx = -900;
      w.step(1 / 120);
      expect(minGap(w), `t=${t.toFixed(2)}`).toBeGreaterThan(-2);
    }
  });

  /**
   * The worst case on this field, and the one rule 5.6.1.3 is written about: a
   * robot forced against the wall by an opponent with another alongside.
   */
  it('resolves a robot pinned between opponents and the wall', () => {
    const w = world('open');
    const [c1, c2, y1, y2] = w.robots;
    y1!.x = HALF_LENGTH - 20; y1!.z = 0;
    c1!.x = HALF_LENGTH - 200; c1!.z = 0;
    c2!.x = HALF_LENGTH - 200; c2!.z = 200;
    y2!.removed = true;

    for (let t = 0; t < 1.5; t += 1 / 120) {
      c1!.vx = 1100;
      c2!.vx = 1100;
      w.step(1 / 120);
    }
    expect(minGap(w)).toBeGreaterThan(-3);
    for (const r of w.robots.filter((x) => !x.removed)) {
      expect(Math.abs(r.x), r.id).toBeLessThan(1215);
    }
  });
});

describe('contact solver holds up under a pile-up', () => {
  /**
   * All four robots driven into one corner is the worst contact case the field
   * offers. A single separation pass leaves about 47 mm of overlap here, which
   * is plainly visible as robots merging.
   */
  it('keeps overlap negligible with four robots in one corner', () => {
    // The perimeter wall is outside the playing area, so robots held against
    // it are in the out area and 5.7.1.6 would legitimately remove them. This
    // test is about the contact solver, so that rule is left to the referee.
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      autoDamaged: false,
    });
    for (let t = 0; t < 2; t += 1 / 120) {
      for (const r of w.robots) {
        r.vx = 1400;
        r.vz = 1100;
      }
      w.step(1 / 120);
    }

    const a = w.robots.filter((r) => !r.removed);
    let worst = Infinity;
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        worst = Math.min(
          worst,
          Math.hypot(a[i]!.x - a[j]!.x, a[i]!.z - a[j]!.z) - a[i]!.radius - a[j]!.radius,
        );
      }
    }
    expect(worst).toBeGreaterThan(-5);
  });
});

describe('robots stay on the table', () => {
  it('never lets a robot escape the perimeter', () => {
    const w = world('open');
    for (const r of w.robots) {
      r.vx = 9000;
      r.vz = 9000;
    }
    run(w, 3);
    for (const r of w.robots) {
      expect(Math.abs(r.x)).toBeLessThan(1300);
      expect(Math.abs(r.z)).toBeLessThan(1000);
      expect(Number.isFinite(r.x)).toBe(true);
    }
  });
});

describe('lack of progress 5.6.1.1: nobody can get to the ball', () => {
  /*
   * The case that prompted this: a ball rolled into the goal and stopped short
   * of the back wall.
   *
   * Not a goal, because 5.5.1 wants the back wall struck. Not out of play
   * either, because detectBallOutOfPlay exempts the goal mouth so a ball on its
   * way in is not called out before it can score. And unreachable forever:
   * 5.5.2 notes robots are built so the crossbar keeps them out of the goal.
   * Nothing resolved it and nothing could, so the match stopped being a match.
   *
   * 5.6.1.1 is the rule that names it - "no robot has any chance of locating
   * the ball" - and it had not been implemented at all. Only 5.6.1.2, the
   * scrum, had.
   */
  it('frees a ball stranded ON the goal line, which no robot can reach', () => {
    /*
     * What is left of this rule now that 5.5.1 is a line and not a wall.
     *
     * A ball whose centre is past the line but whose trailing edge is not has
     * not scored, and the crossbar means no robot can ever come and settle it.
     * That is the ball this rule is for, and it is the only one left: the ball
     * parked deeper in the goal, which this test used to use, is a goal now.
     */
    const w = world('open');
    w.running = true;
    // Centre 10 mm past the line, so with a 21 mm radius it straddles it.
    w.placeBall({ x: HALF_LENGTH + 10, z: 0 });
    w.ball.vx = 0;
    w.ball.vz = 0;
    expect(Math.abs(w.ball.x) - w.ball.radius).toBeLessThan(HALF_LENGTH);

    for (let t = 0; t < 6; t += 1 / 100) w.step(1 / 100);

    expect(w.score.violet + w.score.lime).toBe(0);
    const call = w.events.find((e) => e.rule === '5.6.1.1');
    expect(call).toBeDefined();
    expect(call!.message).toContain('crossbar');
    // And it is actually back on the field, not just complained about.
    expect(Math.abs(w.ball.x)).toBeLessThan(HALF_LENGTH);
  });

  it('counts a ball sitting over the line once, not once a tick', () => {
    /*
     * The one thing the line reading has to handle that the back wall did not.
     *
     * Striking a wall is an event and happens on one tick. Being over the line
     * is a state, and a ball that stays there is over it on every tick that
     * follows. A match that restarts itself hides this, because the kick-off
     * takes the ball away; a match with `autoResolve` off does not, and scored
     * five for one shot.
     */
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 300,
      inclined: false,
      kickoffCountdown: 0,
      autoResolve: false,
    });
    w.running = true;
    w.robots.forEach((r) => (r.removed = true));
    w.placeBall({ x: GOAL_BACK_X - 30, z: 0 });

    for (let t = 0; t < 4; t += 1 / 100) w.step(1 / 100);

    expect(w.score.violet + w.score.lime).toBe(1);
    expect(w.events.filter((e) => e.kind === 'goal').length).toBe(1);
  });

  it('gives the goal for a ball that crossed the line and stopped short of the wall', () => {
    /*
     * Reported from a real match: a robot walked the ball in, kicked it over
     * the line, and the referee called lack of progress instead of a goal.
     *
     * The goal is 74 mm deep and the ball 42 mm across, so a ball that has
     * completely crossed has about 32 mm left to reach the back wall, and
     * carpet takes that off a ball at a walking pace. Hanging 5.5.1 on the
     * wall meant 433 of the 434 balls that died inside the goal had fully
     * crossed the line and none of them counted.
     */
    const w = world('open');
    w.running = true;
    w.placeBall({ x: GOAL_BACK_X - 30, z: 0 });
    w.ball.vx = 0;
    w.ball.vz = 0;
    // Wholly over the line, and nowhere near the back wall.
    expect(Math.abs(w.ball.x) - w.ball.radius).toBeGreaterThan(HALF_LENGTH);
    expect(Math.abs(w.ball.x) + w.ball.radius).toBeLessThan(GOAL_BACK_X);

    for (let t = 0; t < 2; t += 1 / 100) w.step(1 / 100);

    expect(w.events.some((e) => e.kind === 'goal' && e.rule === '5.5.1')).toBe(true);
    expect(w.score.violet + w.score.lime).toBe(1);
  });

  it('does not award a goal for a ball that stopped short of the back wall', () => {
    const w = world('open');
    w.running = true;
    w.placeBall({ x: GOAL_MOUTH_X + 20, z: 0 });
    for (let t = 0; t < 6; t += 1 / 100) w.step(1 / 100);
    expect(w.score.violet + w.score.lime).toBe(0);
  });

  it('still scores when the ball does reach the back wall', () => {
    const w = world('open');
    w.running = true;
    w.placeBall({ x: HALF_LENGTH - 50, z: 0 });
    w.ball.vx = 2000;
    for (let t = 0; t < 3; t += 1 / 100) w.step(1 / 100);
    expect(w.events.some((e) => e.kind === 'goal' && e.rule === '5.5.1')).toBe(true);
  });

  it('frees a ball nobody is anywhere near', () => {
    const w = world('open');
    w.running = true;
    w.placeBall({ x: 300, z: 400 });
    const [c1, c2, y1, y2] = w.robots;
    c1!.x = -800; c1!.z = -500;
    c2!.x = -800; c2!.z = 500;
    y1!.x = 800; y1!.z = -500;
    y2!.x = 850; y2!.z = 500;

    for (let t = 0; t < 12; t += 1 / 100) w.step(1 / 100);
    expect(w.events.some((e) => e.rule === '5.6.1.1')).toBe(true);
  });

  it('leaves a ball alone while a robot has it', () => {
    // One robot on the ball is possession, not a stall, and calling it would
    // take the ball off a team that had earned it.
    const w = world('open');
    w.running = true;
    w.placeBall({ x: 0, z: 0 });
    const [c1] = w.robots;
    c1!.x = -135;
    c1!.z = 0;
    for (let t = 0; t < 12; t += 1 / 100) w.step(1 / 100);
    expect(w.events.some((e) => e.rule === '5.6.1.1')).toBe(false);
  });

  it('frees a ball the robots have stopped going after', () => {
    /*
     * The hole between the two halves of 5.6, and the reason a dead ball could
     * sit through the rest of a half with the referee saying nothing.
     *
     * A robot 250 mm from a stopped ball keeps the gap under
     * UNREACHABLE_DISTANCE, so 5.6.1.1 read it as reachable and stayed quiet.
     * There is no opponent within PROGRESS_DISTANCE, so 5.6.1.2 was not
     * looking either. Nothing moved and nothing ever would.
     *
     * Distance was the wrong question. Whether anyone is still closing on the
     * ball is the right one.
     */
    const w = world('open');
    w.running = true;
    w.placeBall({ x: 0, z: 0 });
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;

    let calledAt: number | null = null;
    for (let t = 0; t < 12; t += 1 / 100) {
      // Parked, near the ball, going nowhere - and no opponent in sight.
      c1!.x = -250; c1!.z = 0; c1!.vx = 0; c1!.vz = 0;
      w.ball.x = 0; w.ball.z = 0; w.ball.vx = 0; w.ball.vz = 0;
      w.step(1 / 100);
      if (calledAt === null && w.events.some((e) => e.rule === '5.6.1.1')) calledAt = t;
    }

    expect(calledAt).not.toBeNull();
    expect(calledAt!).toBeLessThan(7);
  });

  it('leaves a stopped ball alone while a robot is still closing on it', () => {
    // The flip side: a ball nobody is touching yet is not a ball nobody wants.
    // A robot on its way keeps making ground, and that is the whole test.
    const w = world('open');
    w.running = true;
    w.placeBall({ x: 0, z: 0 });
    const [c1, c2, y1, y2] = w.robots;
    c2!.x = -1800; y1!.x = 1800; y2!.x = 1850;

    for (let t = 0; t < 10; t += 1 / 100) {
      // Crossing the field at a slow but honest 80 mm/s, never arriving.
      c1!.x = -1000 + t * 80; c1!.z = 0;
      w.ball.x = 0; w.ball.z = 0; w.ball.vx = 0; w.ball.vz = 0;
      w.step(1 / 100);
    }
    expect(w.events.some((e) => e.rule === '5.6.1.1')).toBe(false);
  });

  it('leaves a moving ball alone', () => {
    // A ball rolling across an empty field is in play, however alone it is.
    const w = world('open');
    w.running = true;
    w.placeBall({ x: -700, z: 0 });
    const [c1, c2, y1, y2] = w.robots;
    for (const r of [c1, c2, y1, y2]) { r!.x = 850; r!.z = 550; }
    for (let t = 0; t < 4; t += 1 / 100) {
      w.ball.vx = 300;
      w.step(1 / 100);
    }
    expect(w.events.some((e) => e.rule === '5.6.1.1')).toBe(false);
  });
});

/**
 * Phase 4: a situation put on the field by hand rather than by rule 5.4.
 *
 * The substitution is deliberately the only thing that changes - the
 * detectors still watch a staged world and the rules still fire on it - so
 * these check the roster, the placement and, most of all, that a restart goes
 * back to the arrangement rather than onto the kick-off marks. That last one
 * is what makes a rehearsal repeat itself without anything driving it.
 */
describe('staged arrangements (Phase 4)', () => {
  it('puts only the robots the arrangement names on the field', () => {
    const w = world('open');
    w.stage({
      robots: [{ id: 'violet-1', x: -500, z: 200, heading: 0, isGoalie: false }],
      ball: { x: 100, z: -100 },
    });

    expect(w.robots.map((r) => r.id)).toEqual(['violet-1']);
    expect(w.robots[0]!.x).toBe(-500);
    expect(w.robots[0]!.z).toBe(200);
    expect(w.ball.x).toBe(100);
    expect(w.ball.z).toBe(-100);
  });

  it('restarts back into the arrangement instead of onto the kick-off marks', () => {
    const w = world('open');
    const arrangement = {
      robots: [{ id: 'violet-1', x: 300, z: -600, heading: 0, isGoalie: false }],
      // Rolling at the yellow goal, which Violet attacks in the first half.
      ball: { x: GOAL_MOUTH_X - 600, z: 0, vx: 3000 },
    };
    w.stage(arrangement);
    // Somewhere it could only have got to by playing, so the check below is
    // about the restart putting it back rather than it never having moved.
    w.robots[0]!.x = -1200;
    w.robots[0]!.z = 900;

    run(w, 1.5);

    expect(w.score.violet).toBeGreaterThanOrEqual(1);
    // Still one robot: a kick-off restart would have put all four out.
    expect(w.robots.map((r) => r.id)).toEqual(['violet-1']);
    expect(w.robots[0]!.x).toBe(300);
    expect(w.robots[0]!.z).toBe(-600);
  });

  it('separates robots an arrangement puts on top of each other', () => {
    const w = world('open');
    w.stage({
      robots: [
        { id: 'violet-1', x: 0, z: 0, heading: 0, isGoalie: false },
        { id: 'lime-1', x: 40, z: 0, heading: Math.PI, isGoalie: false },
      ],
      ball: { x: 1000, z: 0 },
    });

    const [a, b] = w.robots as [(typeof w.robots)[number], (typeof w.robots)[number]];
    expect(distance(a, b)).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-6);
  });

  it('carries the goalie nomination the arrangement asks for, not the robot number', () => {
    const w = world('open');
    w.stage({
      robots: [
        { id: 'violet-1', x: -1000, z: 0, heading: 0, isGoalie: true },
        { id: 'violet-2', x: 0, z: 0, heading: 0, isGoalie: false },
      ],
      ball: { x: 1000, z: 0 },
    });

    expect(w.robots.find((r) => r.id === 'violet-1')!.isGoalie).toBe(true);
    expect(w.robots.find((r) => r.id === 'violet-2')!.isGoalie).toBe(false);
  });

  it('kicks off ordinarily when unstaged, with the robots that are in it', () => {
    const w = world('open');
    w.stage({
      robots: [
        { id: 'violet-1', x: 300, z: -600, heading: 0, isGoalie: false },
        { id: 'lime-1', x: -300, z: 600, heading: Math.PI, isGoalie: false },
      ],
      ball: { x: 0, z: 0 },
    });
    w.unstage();

    // Nothing moved yet: unstaging is about the next restart, not this moment.
    expect(w.robots.map((r) => r.id)).toEqual(['violet-1', 'lime-1']);
    expect(w.stagedArrangement).toBeNull();

    w.kickOff('violet');
    // On the kick-off marks now rather than where they were put - but still
    // the two robots in this situation, not the four a full match has. A
    // rehearsal of one robot a side that answered a goal by conjuring two
    // keepers onto the field would be rehearsing a different game.
    expect(w.robots.map((r) => r.id).sort()).toEqual(['lime-1', 'violet-1']);
    const violet = w.robots.find((r) => r.id === 'violet-1')!;
    expect(violet.x).not.toBe(300);
    expect(violet.z).not.toBe(-600);
  });

  it('leaves a match that stages nothing exactly as it was', () => {
    const w = world('open');
    expect(w.stagedArrangement).toBeNull();
    expect(w.robots.map((r) => r.id)).toEqual(['violet-1', 'violet-2', 'lime-1', 'lime-2']);
    expect(w.robots.find((r) => r.id === 'violet-2')!.isGoalie).toBe(true);
    expect(w.robots.find((r) => r.id === 'violet-1')!.isGoalie).toBe(false);
  });
});
