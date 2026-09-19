/**
 * The motor model.
 *
 * In RCJA Soccer Lab a robot is driven by applying force in whatever direction
 * the AI wants and setting the heading separately. That is the right shape for
 * referee training, where the robots only have to be plausible. It is the wrong
 * shape for a competition: it hands the student a capability no robot has, and
 * it quietly makes every league's drivetrain identical.
 *
 * Here a robot is a set of motors. A program sets a power per motor and nothing
 * else. What the robot then does is whatever those motors can make it do, which
 * is the same constraint a team works under in the shed.
 *
 * Units follow the rest of the simulator: millimetres, seconds, grams. Forces
 * are therefore g·mm/s² and torques g·mm²/s².
 *
 * Robot frame: +x is the direction the robot faces, +z is 90 degrees
 * anticlockwise from it in the plane (the same sense in which `heading`
 * increases). Both are the field's own axes rotated by the robot's heading.
 */

/** One motor and the wheel on the end of it. */
export interface MotorSpec {
  /** Where the wheel touches the carpet, in the robot frame, mm. */
  mountX: number;
  mountZ: number;
  /**
   * The direction this wheel drives the robot when given positive power,
   * radians in the robot frame. An omni wheel rolls freely across this axis
   * and does nothing to resist motion along it, which is the whole trick.
   */
  axis: number;
  /** Force produced at full power and zero speed, g·mm/s². */
  stallForce: number;
  /**
   * Surface speed at full power under no load, mm/s. A motor at speed makes
   * less force; at free speed it makes none. This is what stops a robot
   * accelerating forever, and it is the only braking in the model.
   */
  freeSpeed: number;
}

export interface DriveSpec {
  motors: readonly MotorSpec[];
  /**
   * Moment of inertia about the vertical axis, g·mm².
   *
   * A uniform disc would be ½mr². A soccer robot is not a uniform disc: the
   * motors, battery, kicker capacitors and dribbler all sit near the rim, so
   * the mass is further out than a disc and the robot is correspondingly
   * harder to spin up and stop.
   */
  inertia: number;
}

/**
 * Rule 4.1.2 caps the robot at a 220 mm cylinder, so the wheels sit inside
 * that. 90 mm puts them just inboard of the shell.
 */
export const MOUNT_RADIUS = 90;

/**
 * Sizing, for a 2.5 kg Open robot (rule 4.1.1) on four omni wheels.
 *
 * Both numbers are chosen so this drive reproduces the top speed and
 * acceleration the lab's AI was tuned to, which keeps matches feeling the same
 * and lets the lab's reference play be ported without retuning:
 *
 *   Peak forward force is 4·S·cos45° = 2.83·S, so for the lab's 9200 mm/s²
 *   at 2500 g:  S = 9200 × 2500 / 2.83 ≈ 8.13e6 g·mm/s².
 *
 *   Forward motion turns each wheel at v·cos45°, so top speed is √2 × free
 *   speed. For the lab's 1150 mm/s:  freeSpeed = 1150 / √2 ≈ 813 mm/s.
 *
 * There is a pleasing check on this. With the motors idle, back-EMF alone
 * damps the robot at 2·S/(freeSpeed·m) = 2 × 8.13e6 / (813 × 2500) ≈ 8.0 per
 * second — which is exactly the ROBOT_DAMPING the lab arrived at by hand, and
 * for four wheels at 90° spacing it comes out the same in every direction. The
 * artificial damping constant was standing in for a motor all along.
 */
const OPEN_STALL_FORCE = 8.13e6;
const OPEN_FREE_SPEED = 813;

/**
 * There is deliberately no separate carpet-friction term.
 *
 * The first draft had one, and it was double-counting: back-EMF already brakes
 * an unpowered robot at 8 per second, which is the entire damping the lab used
 * for everything. Adding rolling resistance on top only pulled the top speed
 * 5% below the figure this drive is sized to hit. Rolling resistance on carpet
 * is real but it is small next to a geared motor being back-driven, and the
 * model is more honest without a constant standing in for it.
 *
 * Below these thresholds the robot is treated as stopped, matching physics.ts.
 */
const REST_SPEED = 12;
const REST_YAW = 0.05;

/**
 * The standard Open drivetrain: four omni wheels at 45°, 135°, 225° and 315°,
 * each driving tangentially. This is the layout nearly every Open and
 * Lightweight team converges on, for the reason the geometry shows — it is the
 * cheapest arrangement that can translate in any direction while turning.
 */
export function openDrive(): DriveSpec {
  const motors: MotorSpec[] = [];
  for (const axisDeg of [45, 135, 225, 315]) {
    const axis = (axisDeg * Math.PI) / 180;
    // A tangential wheel sits a quarter turn back from the direction it drives.
    const mount = axis - Math.PI / 2;
    motors.push({
      mountX: MOUNT_RADIUS * Math.cos(mount),
      mountZ: MOUNT_RADIUS * Math.sin(mount),
      axis,
      stallForce: OPEN_STALL_FORCE,
      freeSpeed: OPEN_FREE_SPEED,
    });
  }
  return { motors, inertia: inertiaFor(2500) };
}

/**
 * Moment of inertia for a robot of the given mass, g·mm².
 *
 * 0.6·m·r² rather than a disc's 0.5·m·r², because the heavy parts are outboard.
 */
export function inertiaFor(massGrams: number, radius = 110): number {
  return 0.6 * massGrams * radius * radius;
}

export interface DriveResult {
  /** Force in the FIELD frame, g·mm/s². */
  fx: number;
  fz: number;
  /** Torque about the vertical axis, g·mm²/s². Positive turns +x towards +z. */
  torque: number;
  /**
   * Each wheel's surface speed along its own drive axis, mm/s. This is what an
   * encoder measures, and it is not the robot's speed — a wheel can be turning
   * while the robot goes nowhere, which is exactly why odometry drifts.
   */
  wheelSpeeds: number[];
}

export interface DriveMotion {
  heading: number;
  vx: number;
  vz: number;
  /** Yaw rate, rad/s, positive turning +x towards +z. */
  omega: number;
}

/**
 * Resolve motor powers into a force and a torque.
 *
 * Each wheel is a linear DC motor: the force it makes falls off with how fast
 * its own contact point is already moving along its drive axis, reaching zero
 * at free speed. Drive against the motion and it brakes; that falls out of the
 * same expression rather than needing a separate case.
 *
 * Powers outside −1..1 are clamped rather than rejected. A program that asks
 * for 5 gets 1, the same as a motor driver would give it.
 */
export function driveForces(
  spec: DriveSpec,
  powers: readonly number[],
  motion: DriveMotion,
): DriveResult {
  const { heading, vx, vz, omega } = motion;

  // Field velocity into the robot frame.
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const vrx = vx * cos + vz * sin;
  const vrz = -vx * sin + vz * cos;

  let frx = 0;
  let frz = 0;
  let torque = 0;
  const wheelSpeeds: number[] = [];

  for (let i = 0; i < spec.motors.length; i++) {
    const m = spec.motors[i]!;
    const power = clamp(powers[i] ?? 0, -1, 1);

    // Velocity of this wheel's contact point: the robot's own velocity plus
    // the tangential velocity from spinning about the centre.
    const px = vrx - omega * m.mountZ;
    const pz = vrz + omega * m.mountX;

    const ax = Math.cos(m.axis);
    const az = Math.sin(m.axis);

    // How fast the wheel is already rolling along the direction it drives.
    const u = px * ax + pz * az;
    wheelSpeeds.push(u);

    const force = clamp(
      m.stallForce * (power - u / m.freeSpeed),
      -m.stallForce,
      m.stallForce,
    );

    const fx = force * ax;
    const fz = force * az;
    frx += fx;
    frz += fz;
    torque += m.mountX * fz - m.mountZ * fx;
  }

  return {
    fx: frx * cos - frz * sin,
    fz: frx * sin + frz * cos,
    torque,
    wheelSpeeds,
  };
}

/** A body the drive can move. Matches the shape of physics.ts's `Body`. */
export interface DrivenBody extends DriveMotion {
  x: number;
  z: number;
  mass: number;
}

/**
 * Advance a driven robot by one step.
 *
 * Move first with the velocity the robot already had, then apply this step's
 * forces — the same order physics.ts uses in `integrate`, so a driven robot and
 * the ball advance consistently and collisions land where the existing solver
 * expects them.
 *
 * This replaces `stepRobot` for robots under power. It has to do the whole job,
 * position included: an earlier draft applied forces and left the position to
 * the caller, which quietly froze every robot in place. The rule detectors did
 * not notice, because most of them put robots where they want them and step;
 * the lack-of-progress test did, because it is the one that needs robots to
 * actually push.
 */
export function stepDrive(
  body: DrivenBody,
  spec: DriveSpec,
  powers: readonly number[],
  dt: number,
): DriveResult {
  const result = driveForces(spec, powers, body);

  body.x += body.vx * dt;
  body.z += body.vz * dt;

  body.vx += (result.fx / body.mass) * dt;
  body.vz += (result.fz / body.mass) * dt;
  body.omega += (result.torque / spec.inertia) * dt;

  if (Math.hypot(body.vx, body.vz) < REST_SPEED) {
    body.vx = 0;
    body.vz = 0;
  }
  if (Math.abs(body.omega) < REST_YAW) body.omega = 0;

  body.heading = wrapAngle(body.heading + body.omega * dt);

  return result;
}

/**
 * Powers that move a holonomic drive in a given direction while turning.
 *
 * This is the inverse kinematics, and it ships as ordinary readable code
 * because a team needs *something* that moves on day one. It is deliberately
 * the simple version — it projects the wanted velocity onto each wheel axis and
 * normalises — so there is real room above it. Teams that want to beat each
 * other will want acceleration limits, slip compensation and a smarter
 * normalisation, and they should have to write those themselves.
 *
 * `bearing` is in the robot frame: 0 drives straight ahead.
 */
export function mixOmni(
  spec: DriveSpec,
  bearing: number,
  speed: number,
  spin: number,
): number[] {
  const dx = Math.cos(bearing);
  const dz = Math.sin(bearing);

  // Project the wanted direction onto each wheel axis, then scale so the
  // hardest-working wheel is at full power, which is what makes `speed: 1` mean
  // "everything this drive has" in whichever direction was asked for.
  //
  // It does not make the robot equally fast in every direction, and no mixing
  // can: a wheel saturates at its own free speed, so top speed in direction θ
  // is freeSpeed / max|cos(θ − axis)|. For four wheels that is √2 faster
  // between two axes than along one — about 1150 mm/s driving forward against
  // 810 mm/s driving at 45°. That asymmetry is the drivetrain's, not the
  // library's, and a team that notices it and orients their approach to exploit
  // it has found something real.
  const direction = spec.motors.map((m) => dx * Math.cos(m.axis) + dz * Math.sin(m.axis));
  const spread = Math.max(...direction.map(Math.abs)) || 1;

  const combined = spec.motors.map((m, i) => {
    // Spinning turns every tangential wheel the same way; the arm is the
    // component of the mount offset perpendicular to the drive axis.
    const arm = (m.mountX * Math.sin(m.axis) - m.mountZ * Math.cos(m.axis)) / MOUNT_RADIUS;
    return (direction[i]! / spread) * speed + arm * spin;
  });

  // Scale down together if anything saturates, so the robot still goes where it
  // was asked to go — just slower. Clipping each motor separately would bend
  // the path instead, which is a bug teams spend a weekend finding.
  const peak = Math.max(1, ...combined.map(Math.abs));
  return combined.map((p) => p / peak);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Keep an angle in −π..π so headings stay comparable. */
export function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}
