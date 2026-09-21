/**
 * The follow camera, as a camera operator would work it.
 *
 * The old one eased its look point toward the ball, took the ball's speed from
 * the difference between two rendered frames, and leaned 0.3 s ahead along
 * it. Any unevenness in the frames turned into a spike in that speed, and the
 * lean turned the spike into a lurch. It also followed the ball's height, so
 * every bounce nodded the whole picture.
 *
 * What it does instead, in metres on the carpet:
 *
 * - The ball's velocity is filtered, and a jump no ball could make — a
 *   placement, a kick-off reset — is a cut, not a sweep across the field.
 * - It aims a little ahead of the ball along its path, so there is room in the
 *   picture for where play is going (lead room), capped so it never leaves the
 *   ball behind.
 * - A small dead zone: a ball jostling between two robots does not drag the
 *   camera with every nudge. Only when the aim leaves the zone does the
 *   camera go after it.
 * - The look point chases that aim on a critically damped spring, so it
 *   accelerates and settles without overshoot, and its speed never steps.
 *   The camera's position is a fixed function of that point, so it has
 *   nothing of its own to lag or wobble with.
 * - It pulls back a little while the ball is moving fast, and settles in
 *   close when play is tight.
 * - It stays on the spectator side and angles itself toward whichever goal
 *   play is heading for, as before.
 */

/** Ball speed (m/s) past which a change of position is taken to be a teleport. */
const CUT_SPEED = 6;
/** A reappearing ball this far (m) from where the camera is looking is cut to. */
const CUT_DISTANCE = 0.4;
/** Time constant of the velocity filter, s. */
const VELOCITY_TAU = 0.12;
/**
 * How far ahead along its path the camera aims, s, and the most that can be, m.
 * The spring below trails a moving aim by about SMOOTH_TIME's worth of travel,
 * so the lead has to cover that before it puts any room in front of the ball.
 */
const LEAD_TIME = 0.5;
const LEAD_MAX = 0.4;
/** Radius of the dead zone, m. */
const DEAD_ZONE = 0.05;
/** How long the look point takes to catch its aim, roughly, s. */
const SMOOTH_TIME = 0.28;
/** The camera's distance from the look point at rest, m: sideways, up and back. */
const SIDE = 0.75;
const HEIGHT = 1.05;
const BACK = 1.15;
/** How much further back at full pull-back, and the ball speed (m/s) that means. */
const PULL_BACK = 0.25;
const PULL_BACK_SPEED = 2.5;
/** Where facing reaches a full angle toward a goal, m from the halfway line. */
const FACING_SPAN = 0.35;

export interface FollowShot {
  /** Where the camera is, metres, three.js axes (y up). */
  position: { x: number; y: number; z: number };
  /** Where it is looking. */
  target: { x: number; y: number; z: number };
  /** True when this frame is a cut: place the camera, do not ease it. */
  cut: boolean;
}

export interface FollowBounds {
  /** Half the playing area's length and width, metres. The camera aims inside it. */
  halfX: number;
  halfZ: number;
}

/**
 * Critically damped spring toward `target`, stable for any step size.
 * (Game Programming Gems 4, 1.10 — the same closed form Unity's SmoothDamp uses.)
 */
function smoothDamp(
  current: number,
  target: number,
  velocity: number,
  smoothTime: number,
  dt: number,
): [number, number] {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  return [target + (change + temp) * decay, (velocity - omega * temp) * decay];
}

export class FollowCamera {
  private started = false;
  private lastBall = { x: 0, z: 0 };
  private velocity = { x: 0, z: 0 };
  /** Where the dead zone is centred: the aim the spring is chasing. */
  private anchor = { x: 0, z: 0 };
  private look = { x: 0, z: 0 };
  private lookVelocity = { x: 0, z: 0 };
  private facing = 1;
  private pull = 0;
  private wasAbsent = false;

  constructor(private readonly bounds: FollowBounds) {}

  /** Forget everything: the next update cuts straight to the ball. */
  reset(): void {
    this.started = false;
  }

  /**
   * One frame. `ball` is where the ball is drawn, metres; `absent` when it is
   * off the field being carried; `height` is the height to look at (the ball's
   * resting centre, so a bounce does not tilt the shot); `dt` is real seconds
   * since the last frame.
   */
  update(ball: { x: number; z: number; absent?: boolean }, height: number, dt: number): FollowShot {
    const step = Math.max(1e-3, Math.min(dt, 0.1));
    let cut = false;

    if (ball.absent && this.started) {
      // A ball off the field leaves the camera where it last saw it, rather
      // than swinging to wherever the hidden ball happens to sit.
      this.wasAbsent = true;
      return this.shot(height, false);
    }

    if (this.wasAbsent) {
      // Put down near where the camera already is: carry on from here, with
      // no speed carried over from where it was picked up. Put down anywhere
      // else: cut to it.
      const far = Math.hypot(ball.x - this.look.x, ball.z - this.look.z) > CUT_DISTANCE;
      if (far) this.started = false;
      this.lastBall = { x: ball.x, z: ball.z };
      this.velocity = { x: 0, z: 0 };
    }
    const jump = Math.hypot(ball.x - this.lastBall.x, ball.z - this.lastBall.z);
    if (!this.started || jump / step > CUT_SPEED) {
      this.started = true;
      this.velocity = { x: 0, z: 0 };
      this.anchor = this.clamp(ball);
      this.look = { ...this.anchor };
      this.lookVelocity = { x: 0, z: 0 };
      this.facing = this.facingFor(this.look.x);
      this.pull = 0;
      cut = true;
    } else {
      const k = 1 - Math.exp(-step / VELOCITY_TAU);
      this.velocity.x += ((ball.x - this.lastBall.x) / step - this.velocity.x) * k;
      this.velocity.z += ((ball.z - this.lastBall.z) / step - this.velocity.z) * k;
    }
    this.lastBall = { x: ball.x, z: ball.z };
    this.wasAbsent = false;

    if (!cut) {
      // Lead room, capped so the ball is never left out of shot.
      let leadX = this.velocity.x * LEAD_TIME;
      let leadZ = this.velocity.z * LEAD_TIME;
      const lead = Math.hypot(leadX, leadZ);
      if (lead > LEAD_MAX) {
        leadX *= LEAD_MAX / lead;
        leadZ *= LEAD_MAX / lead;
      }
      const aim = this.clamp({ x: ball.x + leadX, z: ball.z + leadZ });

      // The dead zone: the anchor is dragged only by an aim that leaves it.
      const off = Math.hypot(aim.x - this.anchor.x, aim.z - this.anchor.z);
      if (off > DEAD_ZONE) {
        const pull = (off - DEAD_ZONE) / off;
        this.anchor.x += (aim.x - this.anchor.x) * pull;
        this.anchor.z += (aim.z - this.anchor.z) * pull;
      }

      [this.look.x, this.lookVelocity.x] = smoothDamp(this.look.x, this.anchor.x, this.lookVelocity.x, SMOOTH_TIME, step);
      [this.look.z, this.lookVelocity.z] = smoothDamp(this.look.z, this.anchor.z, this.lookVelocity.z, SMOOTH_TIME, step);

      // Face whichever goal play is heading for, slowly: a swing of the
      // whole shot is the most noticeable thing a camera can do.
      const facingTarget = this.facingFor(this.look.x + this.velocity.x * 0.3);
      this.facing += (facingTarget - this.facing) * (1 - Math.exp(-1.8 * step));

      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const pullTarget = Math.min(1, speed / PULL_BACK_SPEED);
      this.pull += (pullTarget - this.pull) * (1 - Math.exp(-1.2 * step));
    }

    return this.shot(height, cut);
  }

  private shot(height: number, cut: boolean): FollowShot {
    const scale = 1 + PULL_BACK * this.pull;
    return {
      // Offset along x by facing: toward Yellow (+1) sits at -x, looking +x.
      position: {
        x: this.look.x - SIDE * this.facing * scale,
        y: HEIGHT * scale,
        z: this.look.z + BACK * scale,
      },
      target: { x: this.look.x, y: height, z: this.look.z },
      cut,
    };
  }

  private facingFor(x: number): number {
    return Math.max(-1, Math.min(1, x / FACING_SPAN));
  }

  private clamp(p: { x: number; z: number }): { x: number; z: number } {
    return {
      x: Math.max(-this.bounds.halfX, Math.min(this.bounds.halfX, p.x)),
      z: Math.max(-this.bounds.halfZ, Math.min(this.bounds.halfZ, p.z)),
    };
  }
}
