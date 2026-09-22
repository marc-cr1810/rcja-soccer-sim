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
}

/**
 * The ball, which unlike a robot can spin independently of how it moves.
 *
 * Its spin is carried as SLIP: how much faster the ball is moving over the
 * carpet than its spin would roll it. Zero slip is a ball rolling cleanly, and
 * that is what a ball given a velocity directly - a staged arrangement, a test,
 * a practice drag - should be, so it is the default. Only something that
 * strikes the ball puts slip into it: a kicker, a wall, a bumper, a roller.
 *
 * Spin about the vertical axis is not carried. Carpet kills it within a few
 * centimetres and it changes nothing a referee could see.
 */
export interface Ball extends Body {
  slipVx: number;
  slipVz: number;
  /** I / (m r^2): 0.4 for a solid sphere, 2/3 for a thin shell. */
  inertia: number;
  /** Coefficient of restitution against any hard surface. */
  restitution: number;
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
 * At 1200 mm/s^2 a 2400 mm/s ROLLING ball runs 2400 mm, and a 700 mm/s knock
 * travels 204 mm instead of 574 mm and stays on the field. A kicked ball does
 * not start out rolling, though - see BALL_SLIDE_FRICTION.
 */
const BALL_ROLL_DECEL = 1200;
/** Gravity in mm/s^2: the normal force behind every friction below. */
const GRAVITY = 9810;
/**
 * Sliding friction between a skidding ball and the carpet.
 *
 * A kicker strikes the ball through its middle, so it leaves with no spin at
 * all and skids. Sliding friction then does two things at once: it slows the
 * ball and spins it up, until the spin matches the speed and it rolls. What is
 * conserved through the skid is v + k*w (k = I/mr^2, w the speed the spin would
 * roll at), so a spinless ball always settles at v/(1+k): 5/7 of its launch
 * speed for the solid golf ball, 2/3 for the IR ball. At 0.35 - felt and
 * short-pile carpet on a hard ball run 0.3-0.4 - that takes a tenth of a second
 * and about half a metre from a full kick. The same skid is what kills a ball
 * that comes back off a wall still spinning the way it was going.
 */
const BALL_SLIDE_FRICTION = 0.35;
/** Below this slip (mm/s) the ball is taken to be rolling cleanly. */
const SLIP_SPEED = 5;
/**
 * Friction where the ball meets a wall, a goal or a robot's bumper.
 *
 * Painted MDF and hard plastic against a golf ball or the IR ball's shell,
 * both around 0.3. An estimate, not a measurement. It is what makes a graze
 * lose some of its sideways speed, and it takes most of the spin off a ball
 * rolling into a wall, so the ball comes back rather than stopping dead.
 */
export const BALL_CONTACT_FRICTION = 0.3;

/** Coefficient of restitution for robots against the walls. */
const WALL_BOUNCE = 0.45;
/** Robot against robot. */
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

/**
 * One tick of the ball on the carpet: skidding if it slips, rolling if not.
 *
 * While it skids, sliding friction closes the slip at a(1 + 1/k), taking
 * k/(1+k) of the closure off the ball's speed and giving the rest to its spin.
 * The last step of a skid lands exactly on rolling rather than overshooting
 * into slip the other way.
 */
export function stepBall(ball: Ball, dt: number, frictionMultiplier = 1): void {
  const slip = Math.hypot(ball.slipVx, ball.slipVz);
  if (slip <= SLIP_SPEED) {
    ball.slipVx = 0;
    ball.slipVz = 0;
    rollingIntegrate(ball, dt, BALL_ROLL_DECEL * frictionMultiplier);
    return;
  }
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;
  const k = ball.inertia;
  const closing = Math.min(slip, BALL_SLIDE_FRICTION * GRAVITY * (1 + 1 / k) * dt);
  const speedLoss = (closing * k) / (1 + k);
  ball.vx -= (ball.slipVx / slip) * speedLoss;
  ball.vz -= (ball.slipVz / slip) * speedLoss;
  const keep = (slip - closing) / slip;
  ball.slipVx *= keep;
  ball.slipVz *= keep;
}

/** Stop the ball dead: no speed and no spin. */
export function stopBall(ball: Ball): void {
  ball.vx = 0;
  ball.vz = 0;
  ball.slipVx = 0;
  ball.slipVz = 0;
}

/**
 * The ball strikes a surface: a wall, a goal, a post, a bumper or a plunger.
 *
 * `nx, nz` is the contact normal, pointing out of the surface into the ball.
 * `surfaceVx, surfaceVz` is how fast the surface's contact point is moving -
 * zero for a wall, the robot's point velocity for a bumper. `otherInvMass` is
 * 1/mass of what is struck, zero for anything bolted to the field. Returns the
 * impulse given to the ball (g mm/s), so the caller can give the other body the
 * equal and opposite one, or null if they were already parting.
 *
 * Three things happen, all through the one normal impulse:
 *
 * - The normal part of the relative velocity is reversed and scaled by the
 *   ball's restitution, shared between the two bodies by their masses.
 * - Friction opposes the sideways slip at the contact, by at most mu times the
 *   normal impulse. A ball that stops slipping there has spun up about the
 *   vertical axis, which is why its effective inverse mass is (1/m)(1 + 1/k).
 * - The contact is on the ball's equator, so a ball rolling into a surface is
 *   also slipping DOWNWARDS against it, and friction takes spin off it. The
 *   two frictions share the one mu budget as a vector, as Coulomb friction
 *   does. Spin about the axis along the normal slips nowhere and is untouched.
 */
export function ballContact(
  ball: Ball,
  nx: number,
  nz: number,
  surfaceVx = 0,
  surfaceVz = 0,
  otherInvMass = 0,
  restitution = ball.restitution,
  mu = BALL_CONTACT_FRICTION,
): { jx: number; jz: number } | null {
  const ux = ball.vx - surfaceVx;
  const uz = ball.vz - surfaceVz;
  const un = ux * nx + uz * nz;
  if (un >= 0) return null;

  const invBall = 1 / ball.mass;
  const k = ball.inertia;
  const jn = (-(1 + restitution) * un) / (invBall + otherInvMass);

  // Sideways slip at the contact, and the impulse that would stop it.
  const tx = ux - un * nx;
  const tz = uz - un * nz;
  const ut = Math.hypot(tx, tz);
  const stickSide = ut / (invBall * (1 + 1 / k) + otherInvMass);

  // Spin along the normal, as the speed it would roll at: the rolling speed is
  // the velocity less the slip. The impulse that would stop the equator
  // slipping vertically changes only the spin.
  const spinN = (ball.vx - ball.slipVx) * nx + (ball.vz - ball.slipVz) * nz;
  const stickSpin = Math.abs(spinN) * ball.mass * k;

  const want = Math.hypot(stickSide, stickSpin);
  const scale = want > mu * jn ? (mu * jn) / want : 1;
  const jSide = stickSide * scale;
  const jSpin = stickSpin * scale;

  const jx = jn * nx - (ut > 1e-9 ? (tx / ut) * jSide : 0);
  const jz = jn * nz - (ut > 1e-9 ? (tz / ut) * jSide : 0);

  // A change of velocity with no change of spin is all slip; a change of spin
  // with no change of velocity is slip the other way.
  ball.vx += jx * invBall;
  ball.vz += jz * invBall;
  ball.slipVx += jx * invBall;
  ball.slipVz += jz * invBall;
  const spinCut = (Math.sign(spinN) * jSpin * invBall) / k;
  ball.slipVx += spinCut * nx;
  ball.slipVz += spinCut * nz;
  return { jx, jz };
}

/** A robot as the ball meets it: a body that may be turning. */
export type Striker = Body & { omega?: number; id?: string };

/** How fast the point of a robot at (px, pz) is moving over the carpet. */
function pointVelocity(robot: Striker, px: number, pz: number): [number, number] {
  const w = robot.omega ?? 0;
  return [robot.vx - w * (pz - robot.z), robot.vz + w * (px - robot.x)];
}

/**
 * The ball and a robot touching: pushed apart by their masses, then one
 * contact impulse, with the robot taking the reaction.
 *
 * The robot's point velocity is used, not its centre's, so a spinning robot
 * flicks the ball away sideways. Its yaw is left alone: the ball is 2-6% of
 * the robot's mass and its reaction on the robot's turning is negligible.
 */
export function collideBallRobot(robot: Striker, ball: Ball, recess = 0): boolean {
  const dx = ball.x - robot.x;
  const dz = ball.z - robot.z;
  const minDist = robot.radius + ball.radius - recess;
  if (Math.abs(dx) >= minDist || Math.abs(dz) >= minDist) return false;
  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist || distSq === 0) return false;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const nz = dz / dist;
  const overlap = minDist - dist;

  const invR = 1 / robot.mass;
  const invB = 1 / ball.mass;
  const invSum = invR + invB;
  robot.x -= nx * overlap * (invR / invSum);
  robot.z -= nz * overlap * (invR / invSum);
  ball.x += nx * overlap * (invB / invSum);
  ball.z += nz * overlap * (invB / invSum);

  const [sx, sz] = pointVelocity(robot, robot.x + nx * (robot.radius - recess), robot.z + nz * (robot.radius - recess));
  const j = ballContact(ball, nx, nz, sx, sz, invR);
  if (j) {
    robot.vx -= j.jx * invR;
    robot.vz -= j.jz * invR;
  }
  return true;
}

/**
 * Rule 4.7: a solenoid kicker strikes the ball.
 *
 * Modelled as what it is, a plunger of known mass hitting the ball. The
 * plunger's speed is on top of the robot's own motion at the front, so a robot
 * kicking on the run kicks harder, and one sliding sideways kicks at an angle,
 * and the robot takes the recoil.
 *
 * Each league's robots carry a kicker built for that league's ball. One kicker
 * for both was tried first: sized so the 140 g IR ball passes rule 4.7.1, it
 * sent the 46 g golf ball away at 4900 mm/s, across the whole field in under
 * half a second, and it looked absurd. Nobody builds an Open kicker that way.
 * So the plunger's speed is sized per ball (`plungerSpeed`), and the masses
 * decide everything after the strike.
 */
export const PLUNGER_MASS = 100;
/** Steel plunger face on a ball: a hard, short, lossy strike. */
export const PLUNGER_RESTITUTION = 0.5;
/**
 * How far a kick from a standing robot carries, mm.
 *
 * The carry the kick always had. Rule 4.7.1 asks for goal to goal, 1930 mm
 * between the goal lines, so this passes it with the same margin as before.
 */
export const KICK_CARRY = 2400;

/**
 * The speed a ball has to leave the plunger at to carry `KICK_CARRY`.
 *
 * It skids from v0 to v0/(1+k) at the sliding deceleration, then rolls to a
 * stop at the rolling one: distance = v0^2 times the constant below. About
 * 2900 mm/s for the golf ball and 3000 for the IR ball, whose heavier share
 * of spin costs it more in the skid.
 */
export function kickSpeed(ball: Pick<Ball, 'inertia'>): number {
  const settle = 1 / (1 + ball.inertia) ** 2;
  const perSpeedSquared = (1 - settle) / (2 * BALL_SLIDE_FRICTION * GRAVITY) + settle / (2 * BALL_ROLL_DECEL);
  return Math.sqrt(KICK_CARRY / perSpeedSquared);
}

/** The plunger speed that sends this ball away at `kickSpeed` from a standing robot. */
export function plungerSpeed(ball: Pick<Ball, 'inertia' | 'mass'>): number {
  return (kickSpeed(ball) * (PLUNGER_MASS + ball.mass)) / (PLUNGER_MASS * (1 + PLUNGER_RESTITUTION));
}

export function kickBall(ball: Ball, robot: Striker & { heading: number }): void {
  const hx = Math.cos(robot.heading);
  const hz = Math.sin(robot.heading);
  const [px, pz] = pointVelocity(robot, robot.x + hx * robot.radius, robot.z + hz * robot.radius);
  const plunger = plungerSpeed(ball);
  // A plunger face is flat and the strike short: no friction worth modelling.
  const j = ballContact(ball, hx, hz, px + hx * plunger, pz + hz * plunger, 1 / PLUNGER_MASS, PLUNGER_RESTITUTION, 0);
  if (j) {
    robot.vx -= j.jx / robot.mass;
    robot.vz -= j.jz / robot.mass;
  }
}

function isBall(b: Body): b is Ball {
  return (b as Ball).slipVx !== undefined;
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
function pushOutOfGoalBlock(b: Body, sign: -1 | 1, bounce = WALL_BOUNCE): WallHit | null {
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

  if (isBall(b)) {
    ballContact(b, dx, dz);
    return Math.abs(dx) >= Math.abs(dz) ? 'end' : 'goal-side';
  }
  // Restitution along the contact normal only, so the tangential component
  // survives and a graze stays a graze.
  const normal = b.vx * dx + b.vz * dz;
  if (normal < 0) {
    b.vx -= (1 + bounce) * normal * dx;
    b.vz -= (1 + bounce) * normal * dz;
  }
  return Math.abs(dx) >= Math.abs(dz) ? 'end' : 'goal-side';
}

/**
 * Keep a body inside the field and out of the goal block.
 *
 * `bounce` is for robots. The ball brings its own restitution and meets every
 * wall through `ballContact`, with friction and spin.
 */
export function collideWithPerimeter(b: Body, allowGoalEntry: boolean, bounce = WALL_BOUNCE): WallHit | null {
  let hit: WallHit | null = null;
  // Set a velocity component the way a robot has always bounced, or strike a
  // ball against the wall whose normal is (nx, nz).
  const wall = (nx: number, nz: number, robot: () => void) => (isBall(b) ? ballContact(b, nx, nz) : robot());

  // Sidelines run the full length and have no openings.
  if (b.z - b.radius < -WALL_Z) {
    b.z = -WALL_Z + b.radius;
    wall(0, 1, () => (b.vz = Math.abs(b.vz) * bounce));
    hit = 'side';
  } else if (b.z + b.radius > WALL_Z) {
    b.z = WALL_Z - b.radius;
    wall(0, -1, () => (b.vz = -Math.abs(b.vz) * bounce));
    hit = 'side';
  }

  // End walls, at the far side of the out band. Nothing that reaches these is
  // inside a goal: the goal back stops well short of them.
  if (b.x - b.radius < -WALL_X) {
    b.x = -WALL_X + b.radius;
    wall(1, 0, () => (b.vx = Math.abs(b.vx) * bounce));
    hit = 'end';
  } else if (b.x + b.radius > WALL_X) {
    b.x = WALL_X - b.radius;
    wall(-1, 0, () => (b.vx = -Math.abs(b.vx) * bounce));
    hit = 'end';
  }

  const insideGoalWidth = Math.abs(b.z) <= HALF_GOAL_WIDTH - b.radius * 0.5;
  const enteringGoal = allowGoalEntry && insideGoalWidth;

  for (const sign of [-1, 1] as const) {
    const mouth = sign * GOAL_MOUTH_X;
    const beyondMouth = sign > 0 ? b.x + b.radius > mouth : b.x - b.radius < mouth;
    if (!beyondMouth) continue;

    if (!enteringGoal) {
      const blocked = pushOutOfGoalBlock(b, sign, bounce);
      if (blocked && hit !== 'side') hit = blocked;
      continue;
    }

    // Inside the goal: contained by the back wall and the goal's side walls.
    const back = sign * GOAL_BACK_X;
    const beyondBack = sign > 0 ? b.x + b.radius > back : b.x - b.radius < back;
    if (beyondBack) {
      b.x = back - sign * b.radius;
      wall(-sign, 0, () => (b.vx = -sign * Math.abs(b.vx) * bounce));
      hit = 'goal-back';
    }
    if (Math.abs(b.z) + b.radius > HALF_GOAL_WIDTH) {
      const zSign = Math.sign(b.z) || 1;
      b.z = zSign * (HALF_GOAL_WIDTH - b.radius);
      wall(0, -zSign, () => (b.vz = -zSign * Math.abs(b.vz) * bounce));
      if (!hit) hit = 'goal-side';
    }
  }

  return hit;
}

export interface SweptHit {
  t: number;
  nx: number;
  nz: number;
  hit: WallHit | 'robot';
  robotId?: string;
}

/**
 * Continuous collision detection for fast-moving balls to prevent tunneling.
 * Resolves against goal posts, perimeter walls, goal boundaries, and robots.
 *
 * A robot struck is a body with a mass and a velocity, not a wall: a keeper
 * stepping into a shot sends it back harder than one standing still, and the
 * shot knocks the keeper back by what the masses say.
 */
export function sweptBallCollision(
  ball: Ball,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  robots: readonly Striker[] = [],
  allowGoalEntry = false,
): SweptHit | null {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const distSq = dx * dx + dz * dz;
  if (distSq < 1e-9) return null;

  let earliestT = 1.0;
  const result: { hit: SweptHit | null; robot?: Striker } = { hit: null };

  const checkCircle = (
    cx: number,
    cz: number,
    radius: number,
    hitType: WallHit | 'robot',
    robot?: Striker,
  ) => {
    const vx = x0 - cx;
    const vz = z0 - cz;
    const rEff = ball.radius + radius;
    const cTerm = vx * vx + vz * vz - rEff * rEff;
    if (cTerm <= 0) return;

    const a = distSq;
    const bTerm = 2 * (vx * dx + vz * dz);
    const disc = bTerm * bTerm - 4 * a * cTerm;
    if (disc < 0) return;

    const t = (-bTerm - Math.sqrt(disc)) / (2 * a);
    if (t >= 0 && t < earliestT) {
      earliestT = t;
      const hitX = x0 + t * dx;
      const hitZ = z0 + t * dz;
      const nx = (hitX - cx) / rEff;
      const nz = (hitZ - cz) / rEff;
      result.hit = { t, nx, nz, hit: hitType, robotId: robot?.id };
      result.robot = robot;
    }
  };

  const checkPlaneX = (
    planeX: number,
    zMin: number,
    zMax: number,
    normalX: number,
    hitType: WallHit,
  ) => {
    const targetX = planeX + normalX * ball.radius;
    if (dx === 0) return;
    const t = (targetX - x0) / dx;
    if (t >= 0 && t < earliestT) {
      const hitZ = z0 + t * dz;
      if (hitZ >= zMin && hitZ <= zMax) {
        earliestT = t;
        result.hit = { t, nx: normalX, nz: 0, hit: hitType };
      }
    }
  };

  const checkPlaneZ = (
    planeZ: number,
    xMin: number,
    xMax: number,
    normalZ: number,
    hitType: WallHit,
  ) => {
    const targetZ = planeZ + normalZ * ball.radius;
    if (dz === 0) return;
    const t = (targetZ - z0) / dz;
    if (t >= 0 && t < earliestT) {
      const hitX = x0 + t * dx;
      if (hitX >= xMin && hitX <= xMax) {
        earliestT = t;
        result.hit = { t, nx: 0, nz: normalZ, hit: hitType };
      }
    }
  };

  // 1. Perimeter walls
  checkPlaneZ(-WALL_Z, -WALL_X, WALL_X, 1, 'side');
  checkPlaneZ(WALL_Z, -WALL_X, WALL_X, -1, 'side');
  checkPlaneX(-WALL_X, -WALL_Z, WALL_Z, 1, 'end');
  checkPlaneX(WALL_X, -WALL_Z, WALL_Z, -1, 'end');

  // 2. Goals
  for (const sign of [-1, 1] as const) {
    const mouthX = sign * GOAL_MOUTH_X;
    const backX = sign * GOAL_BACK_X;
    const normalX = -sign;

    // Post corners
    checkCircle(mouthX, -HALF_GOAL_WIDTH, 0, 'end');
    checkCircle(mouthX, HALF_GOAL_WIDTH, 0, 'end');

    if (allowGoalEntry) {
      // Goal back
      checkPlaneX(backX, -HALF_GOAL_WIDTH, HALF_GOAL_WIDTH, normalX, 'goal-back');
      // Goal sides inside
      const minX = Math.min(mouthX, backX);
      const maxX = Math.max(mouthX, backX);
      checkPlaneZ(-HALF_GOAL_WIDTH, minX, maxX, 1, 'goal-side');
      checkPlaneZ(HALF_GOAL_WIDTH, minX, maxX, -1, 'goal-side');
    } else {
      // Goal mouth block front
      checkPlaneX(mouthX, -HALF_GOAL_SHELL, HALF_GOAL_SHELL, normalX, 'end');
    }

    // Front goal walls outside the opening
    checkPlaneX(mouthX, HALF_GOAL_WIDTH, HALF_GOAL_SHELL, normalX, 'end');
    checkPlaneX(mouthX, -HALF_GOAL_SHELL, -HALF_GOAL_WIDTH, normalX, 'end');
  }

  // 3. Robots
  for (let i = 0; i < robots.length; i++) {
    const r = robots[i]!;
    checkCircle(r.x, r.z, r.radius, 'robot', r);
  }

  const bestHit = result.hit;
  if (bestHit) {
    ball.x = x0 + bestHit.t * dx + bestHit.nx * 0.05;
    ball.z = z0 + bestHit.t * dz + bestHit.nz * 0.05;
    const robot = bestHit.hit === 'robot' ? result.robot : undefined;
    if (robot) {
      const [sx, sz] = pointVelocity(
        robot,
        ball.x - bestHit.nx * ball.radius,
        ball.z - bestHit.nz * ball.radius,
      );
      const j = ballContact(ball, bestHit.nx, bestHit.nz, sx, sz, 1 / robot.mass);
      if (j) {
        robot.vx -= j.jx / robot.mass;
        robot.vz -= j.jz / robot.mass;
      }
    } else {
      ballContact(ball, bestHit.nx, bestHit.nz);
    }
    return bestHit;
  }

  return null;
}

/** Resolve overlap between two circular bodies, conserving momentum. */
export function collideBodies(a: Body, b: Body, minDistDelta = 0, restitution = BODY_BOUNCE): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const minDist = a.radius + b.radius - minDistDelta;
  if (Math.abs(dx) >= minDist || Math.abs(dz) >= minDist) return false;

  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist || distSq === 0) return false;
  const dist = Math.sqrt(distSq);

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

  const j = (-(1 + restitution) * velAlongNormal) / invSum;
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
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const minDist = a.radius + b.radius - minDistDelta;
  if (Math.abs(dx) >= minDist || Math.abs(dz) >= minDist) return false;

  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist) return false;

  let dist = Math.sqrt(distSq);

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
