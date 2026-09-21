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
   * accelerating forever, and the main braking in the model.
   */
  freeSpeed: number;
  /**
   * Friction in the gearbox, as a force at the wheel, g·mm/s².
   *
   * This is what lets a robot stand its ground. Back-EMF brakes in proportion
   * to speed, so on its own any knock at all moves the robot, and a small one
   * leaves it creeping for a hand's width. A geared motor does not do that:
   * it will not back-drive until pushed past a threshold.
   *
   * The same friction is also a deadband, because the motor has to overcome
   * it before the robot moves: below gearFriction / (stallForce +
   * gearFriction) power a robot at rest stays at rest. Real teams meet this
   * the first time they try to creep up on the ball.
   *
   * `stallForce` and `freeSpeed` stay what they would be on a test bench, net
   * of this friction, so adding it changes neither top speed nor the pull from
   * a standstill.
   */
  gearFriction: number;
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
  /**
   * Coefficient of friction between the wheels and the carpet.
   *
   * No wheel can push harder than grip × its share of the robot's weight,
   * whatever the motor behind it can do. Past that it spins, and the encoder
   * reads the spinning wheel rather than the ground going past.
   */
  grip: number;
}

/**
 * Rule 4.1.2 caps the robot at a 220 mm cylinder, so the wheels sit inside
 * that. 90 mm puts them just inboard of the shell.
 */
export const MOUNT_RADIUS = 90;

/**
 * Sizing, for a 2.5 kg Open robot (rule 4.1.1) on four omni wheels.
 *
 * The motors were first sized to reproduce the top speed and acceleration the
 * lab's AI was tuned to:
 *
 *   Peak forward force is 4·S·cos45° = 2.83·S, so for the lab's 9200 mm/s²
 *   at 2500 g:  S = 9200 × 2500 / 2.83 ≈ 8.13e6 g·mm/s².
 *
 *   Forward motion turns each wheel at v·cos45°, so top speed is √2 × free
 *   speed. For the lab's 1150 mm/s:  freeSpeed = 1150 / √2 ≈ 813 mm/s.
 *
 * With the motors idle, back-EMF alone damps the robot at 2·S/(freeSpeed·m) =
 * 2 × 8.13e6 / (813 × 2500) ≈ 8.0 per second — exactly the ROBOT_DAMPING the
 * lab arrived at by hand, and for four wheels at 90° spacing the same in every
 * direction. The artificial damping constant was standing in for a motor.
 *
 * The 9200 mm/s² is what the motors can do, not what the robot does. Pulling
 * 0.94 g forward through wheels at 45° needs a grip of 1.33 along each wheel
 * axis, and omni rollers on carpet manage about half that. So the carpet, not
 * the motor, sets the launch: see CARPET_GRIP. Top speed is the motor's alone
 * and stays 1150 mm/s.
 */
const OPEN_STALL_FORCE = 8.13e6;
const OPEN_FREE_SPEED = 813;

/**
 * Gearbox friction, sized for a 10% deadband: S/9 makes
 * gearFriction / (stallForce + gearFriction) exactly a tenth.
 *
 * An idle robot bumped to 400 mm/s slides about 30 mm on this instead of the
 * 49 mm it slid on back-EMF alone, and a gentle nudge barely moves it.
 *
 * This is not the carpet-friction term an earlier draft had and dropped. That
 * one was rolling resistance added on top of the motor, and it pulled the top
 * speed 5% under the figure the drive is sized to hit. This one is inside the
 * motor: stallForce and freeSpeed are the bench figures net of it, so at full
 * power it changes nothing, and it only shows where a real gearbox shows —
 * being back-driven, and at low power.
 */
const OPEN_GEAR_FRICTION = OPEN_STALL_FORCE / 9;

/**
 * Rubber omni rollers on RCJ carpet.
 *
 * Each wheel carries a quarter of the weight, so at 0.7 no wheel pushes harder
 * than 0.7 × m·g / 4. The forward launch that allows is
 * 4 × 0.7 × (m·g/4) × cos45° / m ≈ 4860 mm/s², the same for every weight class
 * — which a Lightweight robot on Open motors needed, since it used to launch
 * at 16 m/s² — and a pushing contest is now won with grip and weight rather
 * than with whichever robot the solver shoved first.
 */
export const CARPET_GRIP = 0.7;

/** mm/s². */
const GRAVITY = 9810;

/**
 * Below this wheel speed the gearbox is sticking rather than sliding, mm/s.
 *
 * Coulomb friction is a step at zero, and a stepped simulation never lands on
 * zero exactly, so "stopped" has to be a band. Inside it friction balances the
 * motor instead of opposing the motion. It sits under REST_SPEED × cos45°:
 * a robot moving faster than REST_SPEED always has at least two wheels outside
 * the band, so a robot cannot coast along on held wheels.
 */
const STICTION_SPEED = 8;

/**
 * Below these thresholds a braking robot is treated as stopped, matching
 * physics.ts.
 *
 * Only a braking one. Snapping every slow robot to rest also snapped away the
 * first step of every gentle start: at 100 Hz any power that could not reach
 * 12 mm/s in one tick never moved the robot at all, a second deadband of about
 * 13% that nobody chose, which would have sat on top of the gearbox's own.
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
      gearFriction: OPEN_GEAR_FRICTION,
    });
  }
  return { motors, inertia: inertiaFor(2500), grip: CARPET_GRIP };
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
  /** Grams. The wheels grip in proportion to the weight on them. */
  mass: number;
}

/**
 * Resolve motor powers into a force and a torque.
 *
 * Each wheel is a linear DC motor: the force it makes falls off with how fast
 * its own contact point is already moving along its drive axis, reaching zero
 * at free speed. Drive against the motion and it brakes; that falls out of the
 * same expression rather than needing a separate case. Gearbox friction takes
 * its share off whatever the motor makes, and the carpet caps what is left.
 *
 * Powers outside −1..1 are clamped rather than rejected. A program that asks
 * for 5 gets 1, the same as a motor driver would give it.
 */
export function driveForces(
  spec: DriveSpec,
  powers: readonly number[],
  motion: DriveMotion,
): DriveResult {
  const { heading, vx, vz, omega, mass } = motion;

  // The most any one wheel can push before it spins or skids.
  const traction = (spec.grip * mass * GRAVITY) / spec.motors.length;

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

    // How fast the carpet under the wheel is moving along the direction it
    // drives. While the wheel grips, the wheel turns at exactly this speed.
    const u = px * ax + pz * az;

    // The motor proper, before its own gearbox takes a share. The electrical
    // stall force is S + friction and the electrical free speed is scaled to
    // match, which is what keeps the net figures the bench numbers.
    const peak = m.stallForce + m.gearFriction;
    const motor = clamp(peak * power - (m.stallForce * u) / m.freeSpeed, -peak, peak);
    // A wheel that is all but still is held: the gearbox meets the motor
    // force-for-force up to its limit, so a robot under the deadband stays put
    // rather than creeping. Once turning, friction is a steady drag.
    const drag =
      Math.abs(u) < STICTION_SPEED
        ? clamp(motor, -m.gearFriction, m.gearFriction)
        : m.gearFriction * Math.sign(u);
    const demand = motor - drag;

    const force = clamp(demand, -traction, traction);
    wheelSpeeds.push(force === demand ? u : slippingWheelSpeed(m, power, force));

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

/**
 * How fast a wheel turns while it slides on the carpet, mm/s.
 *
 * A slipping wheel has come loose from the ground, so its speed is whatever
 * the motor turns it at against the one force the carpet can still give it:
 * the speed w where motor(w) − friction(w) equals `force`. A wheel spun up
 * from a standstill turns faster than the robot moves; a robot shoved harder
 * than its wheels can hold drags them round slower than it slides. Either way
 * the encoder is off from the ground, which is the odometry drift teams
 * actually fight.
 *
 * The motor side falls as w rises, so there is at most one answer: try it
 * turning forwards, then backwards, and if neither is consistent the gearbox
 * is holding the wheel still while the robot skids over it.
 */
function slippingWheelSpeed(m: MotorSpec, power: number, force: number): number {
  const drive = (m.stallForce + m.gearFriction) * power - force;
  const forwards = (m.freeSpeed * (drive - m.gearFriction)) / m.stallForce;
  if (forwards > 0) return forwards;
  const backwards = (m.freeSpeed * (drive + m.gearFriction)) / m.stallForce;
  if (backwards < 0) return backwards;
  return 0;
}

/** A body the drive can move. Matches the shape of physics.ts's `Body`. */
export interface DrivenBody extends DriveMotion {
  x: number;
  z: number;
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

  if (Math.hypot(body.vx, body.vz) < REST_SPEED && result.fx * body.vx + result.fz * body.vz <= 0) {
    body.vx = 0;
    body.vz = 0;
  }
  if (Math.abs(body.omega) < REST_YAW && result.torque * body.omega <= 0) body.omega = 0;

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
