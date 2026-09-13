/**
 * Two-dimensional rigid-body dynamics for the soccer field.
 *
 * The game is played on a flat carpet and the interesting behaviour is all in
 * the horizontal plane, so the simulation runs in 2D (x along the field, z
 * across it) and the renderer lifts it into 3D. That keeps the solver small
 * enough to be read and trusted, which matters more here than realism: this
 * drives referee training, so a referee has to be able to believe what they
 * saw.
 *
 * Units are millimetres and seconds throughout, matching the rule book.
 */

import {
  GOAL_BACK_X,
  GOAL_MOUTH_X,
  HALF_GOAL_SHELL,
  HALF_GOAL_WIDTH,
  WALL_X,
  WALL_Z,
} from './field';

export interface Body {
  x: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  mass: number;
  /** Vertical elevation above carpet in mm (defaults to radius when resting). */
  y?: number;
  /** Vertical velocity in mm/s (positive upwards). */
  vy?: number;
}

/**
 * Rolling resistance on the ball: a constant deceleration, not a decay rate.
 *
 * The lab damps the ball exponentially at 1.2/s, sized so a 2400 mm/s kick
 * crosses the field as rule 4.7.1's kicker test requires. That is right for the
 * kick and wrong for everything else, because exponential decay makes every
 * speed travel proportionally the same distance: a gentle 700 mm/s knock still
 * rolls 574 mm, and it is only 610 mm from the centre of the field to the
 * touchline. So almost every touch sent the ball out. A ten-minute match
 * between two competent robots contained 176 restarts, one every three and a
 * half seconds.
 *
 * A ball rolling on carpet does not do that. Rolling resistance is very nearly
 * a constant force, so speed falls linearly and distance goes with v squared:
 * hard kicks carry, gentle knocks die quickly. That is the difference between a
 * game and a series of restarts.
 *
 * At 1200 mm/s^2 a full 2400 mm/s kick still runs 2400 mm, comfortably the
 * 1930 mm goal-to-goal that 4.7.1 asks for, while that same 700 mm/s knock now
 * travels 204 mm instead of 574 mm and stays on the field.
 */
const BALL_ROLL_DECEL = 1200;
/** Gravity in mm/s^2 for vertical ball motion (Rule 4.7 chip kicks). */
const GRAVITY = 9810;
/** Vertical restitution when an airborne ball lands on carpet. */
const CARPET_BOUNCE = 0.42;
/**
 * Robots are far more damped than the ball, and deliberately so. A robot on
 * carpet with geared motors is close to a velocity servo: it holds the speed
 * it is driven at and sheds a disturbance almost immediately. At 8 per second
 * a robot nudged to 400 mm/s travels about 50 mm before stopping, which is
 * what a bump actually looks like. Lower values make robots glide as if the
 * carpet were ice.
 *
 * DRIVE in ai.ts is scaled against this so that a driven robot still reaches
 * its top speed: terminal velocity is DRIVE / ROBOT_DAMPING.
 */
const ROBOT_DAMPING = 8;

/** Coefficient of restitution against the walls and between bodies. */
const WALL_BOUNCE = 0.45;
const BODY_BOUNCE = 0.35;

/** Below this speed (mm/s) the ball is treated as stationary. */
const REST_SPEED = 12;

/**
 * Move a body under a constant deceleration opposing its motion.
 *
 * Friction can only bring a body to rest, never push it backwards, so the step
 * is clamped: a body slower than the deceleration times dt simply stops.
 */
export function rollingIntegrate(b: Body, dt: number, decel: number): void {
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  const speed = Math.hypot(b.vx, b.vz);
  if (speed <= REST_SPEED) {
    b.vx = 0;
    b.vz = 0;
    return;
  }
  const loss = Math.min(speed, decel * dt);
  const scale = (speed - loss) / speed;
  b.vx *= scale;
  b.vz *= scale;
  if (Math.hypot(b.vx, b.vz) < REST_SPEED) {
    b.vx = 0;
    b.vz = 0;
  }
}

export function integrate(b: Body, dt: number, ratePerSecond: number): void {
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  const decay = Math.exp(-ratePerSecond * dt);
  b.vx *= decay;
  b.vz *= decay;
  if (Math.hypot(b.vx, b.vz) < REST_SPEED) {
    b.vx = 0;
    b.vz = 0;
  }
}

export function stepBall(ball: Body, dt: number): void {
  rollingIntegrate(ball, dt, BALL_ROLL_DECEL);
  if (ball.y !== undefined || ball.vy !== undefined) {
    const restY = ball.radius;
    ball.y = ball.y ?? restY;
    ball.vy = ball.vy ?? 0;
    if (ball.y > restY || ball.vy !== 0) {
      ball.y += ball.vy * dt;
      ball.vy -= GRAVITY * dt;
      if (ball.y <= restY) {
        ball.y = restY;
        if (Math.abs(ball.vy) < 220) {
          ball.vy = 0;
        } else {
          ball.vy = -ball.vy * CARPET_BOUNCE;
        }
      }
    }
  }
}

export function stepRobot(robot: Body, dt: number): void {
  integrate(robot, dt, ROBOT_DAMPING);
}

/**
 * Bounce a body off the perimeter. Returns which wall was struck, or null.
 *
 * The field is 2430 x 1820 wall to wall, so the end wall is a full 250 mm out
 * band beyond the white line, not the goal line. The goal stands in that band
 * with its mouth on the goal line, and rule 2.3.6 carries its side walls back
 * to the end wall, so goal and walls together are one solid block: from the
 * goal line to the end wall, within the goal width. A body allowed into the
 * goal passes through the mouth and is held by the goal's own back and sides.
 * Everything else is kept out of the block, and is free to run past it into
 * the pocket of out area either side - the same out area a robot can reach at
 * the touchlines, and the same rule 5.7.1.6 exposure.
 */
export type WallHit = 'side' | 'end' | 'goal-back' | 'goal-side';

/**
 * Keep a body out of the solid block the goal and rule 2.3.6's walls make.
 *
 * Circle against box, resolved along the line from the nearest point on the
 * box - so a ball clipping the corner of a post is deflected along the way it
 * actually hit it rather than being sent straight back up the field, which is
 * the difference between a shot that rolls on out of play and one the referee
 * sees rebound. A body whose centre is somehow inside the block, shoved there
 * by another robot, has no such line and is pushed out through the nearest face.
 */
function pushOutOfGoalBlock(b: Body, sign: -1 | 1): WallHit | null {
  const xMin = sign > 0 ? GOAL_MOUTH_X : -WALL_X;
  const xMax = sign > 0 ? WALL_X : -GOAL_MOUTH_X;

  const nearX = Math.min(Math.max(b.x, xMin), xMax);
  const nearZ = Math.min(Math.max(b.z, -HALF_GOAL_SHELL), HALF_GOAL_SHELL);
  let dx = b.x - nearX;
  let dz = b.z - nearZ;
  let dist = Math.hypot(dx, dz);

  if (dist > 1e-9) {
    if (dist >= b.radius) return null;
    dx /= dist;
    dz /= dist;
  } else {
    // Centre inside the block: out through whichever face is nearest.
    const faces: [number, number, number][] = [
      [b.x - xMin, -1, 0],
      [xMax - b.x, 1, 0],
      [b.z + HALF_GOAL_SHELL, 0, -1],
      [HALF_GOAL_SHELL - b.z, 0, 1],
    ];
    const [depth, fx, fz] = faces.reduce((a, c) => (c[0] < a[0] ? c : a));
    dx = fx;
    dz = fz;
    dist = -depth;
  }

  b.x += dx * (b.radius - dist);
  b.z += dz * (b.radius - dist);

  // Restitution along the contact normal only, so the tangential component
  // survives and a graze stays a graze.
  const normal = b.vx * dx + b.vz * dz;
  if (normal < 0) {
    b.vx -= (1 + WALL_BOUNCE) * normal * dx;
    b.vz -= (1 + WALL_BOUNCE) * normal * dz;
  }
  return Math.abs(dx) >= Math.abs(dz) ? 'end' : 'goal-side';
}

export function collideWithPerimeter(b: Body, allowGoalEntry: boolean): WallHit | null {
  let hit: WallHit | null = null;

  // Sidelines run the full length and have no openings.
  if (b.z - b.radius < -WALL_Z) {
    b.z = -WALL_Z + b.radius;
    b.vz = Math.abs(b.vz) * WALL_BOUNCE;
    hit = 'side';
  } else if (b.z + b.radius > WALL_Z) {
    b.z = WALL_Z - b.radius;
    b.vz = -Math.abs(b.vz) * WALL_BOUNCE;
    hit = 'side';
  }

  // End walls, at the far side of the out band. Nothing that reaches these is
  // inside a goal: the goal back stops well short of them.
  if (b.x - b.radius < -WALL_X) {
    b.x = -WALL_X + b.radius;
    b.vx = Math.abs(b.vx) * WALL_BOUNCE;
    hit = 'end';
  } else if (b.x + b.radius > WALL_X) {
    b.x = WALL_X - b.radius;
    b.vx = -Math.abs(b.vx) * WALL_BOUNCE;
    hit = 'end';
  }

  const insideGoalWidth = Math.abs(b.z) <= HALF_GOAL_WIDTH - b.radius * 0.5;
  const enteringGoal = allowGoalEntry && insideGoalWidth;

  for (const sign of [-1, 1] as const) {
    const mouth = sign * GOAL_MOUTH_X;
    const beyondMouth = sign > 0 ? b.x + b.radius > mouth : b.x - b.radius < mouth;
    if (!beyondMouth) continue;

    if (!enteringGoal) {
      const blocked = pushOutOfGoalBlock(b, sign);
      if (blocked && hit !== 'side') hit = blocked;
      continue;
    }

    // Inside the goal: contained by the back wall and the goal's side walls.
    const back = sign * GOAL_BACK_X;
    const beyondBack = sign > 0 ? b.x + b.radius > back : b.x - b.radius < back;
    if (beyondBack) {
      b.x = back - sign * b.radius;
      b.vx = -sign * Math.abs(b.vx) * WALL_BOUNCE;
      hit = 'goal-back';
    }
    if (Math.abs(b.z) + b.radius > HALF_GOAL_WIDTH) {
      const zSign = Math.sign(b.z) || 1;
      b.z = zSign * (HALF_GOAL_WIDTH - b.radius);
      b.vz = -zSign * Math.abs(b.vz) * WALL_BOUNCE;
      if (!hit) hit = 'goal-side';
    }
  }

  return hit;
}

/** Resolve overlap between two circular bodies, conserving momentum. */
export function collideBodies(a: Body, b: Body, minDistDelta = 0): boolean {
  // If one body is an airborne ball elevated above bumper height (85 mm),
  // it flies clear over the other body without horizontal impact.
  if ((a.y !== undefined && a.y > 85) || (b.y !== undefined && b.y > 85)) {
    return false;
  }

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  const minDist = a.radius + b.radius - minDistDelta;
  if (dist >= minDist || dist === 0) return false;

  const nx = dx / dist;
  const nz = dz / dist;
  const overlap = minDist - dist;

  // Positional correction, split by inverse mass so a heavy robot barely moves.
  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const invSum = invA + invB;
  a.x -= nx * overlap * (invA / invSum);
  a.z -= nz * overlap * (invA / invSum);
  b.x += nx * overlap * (invB / invSum);
  b.z += nz * overlap * (invB / invSum);

  // Impulse along the contact normal.
  const rvx = b.vx - a.vx;
  const rvz = b.vz - a.vz;
  const velAlongNormal = rvx * nx + rvz * nz;
  if (velAlongNormal > 0) return true;

  const j = (-(1 + BODY_BOUNCE) * velAlongNormal) / invSum;
  a.vx -= j * nx * invA;
  a.vz -= j * nz * invA;
  b.vx += j * nx * invB;
  b.vz += j * nz * invB;
  return true;
}

/**
 * Push two overlapping bodies apart without touching their velocities.
 *
 * Separation has to be iterated separately from the impulse: a robot in
 * contact with two others at once cannot be resolved in a single pass, because
 * fixing the first contact pushes it into the second. Running the impulse that
 * many times would instead make collisions springy.
 */
export function separateBodies(a: Body, b: Body, minDistDelta = 0): boolean {
  if ((a.y !== undefined && a.y > 85) || (b.y !== undefined && b.y > 85)) {
    return false;
  }

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let dist = Math.hypot(dx, dz);
  const minDist = a.radius + b.radius - minDistDelta;
  if (dist >= minDist) return false;

  let nx: number;
  let nz: number;
  if (dist === 0) {
    // Exactly coincident centres have no contact normal; pick one so the
    // bodies still come apart rather than staying fused forever.
    nx = 1;
    nz = 0;
    dist = 0.001;
  } else {
    nx = dx / dist;
    nz = dz / dist;
  }

  const overlap = minDist - dist;
  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const invSum = invA + invB;
  a.x -= nx * overlap * (invA / invSum);
  a.z -= nz * overlap * (invA / invSum);
  b.x += nx * overlap * (invB / invSum);
  b.z += nz * overlap * (invB / invSum);
  return true;
}

export function speed(b: Body): number {
  return Math.hypot(b.vx, b.vz);
}

export function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
