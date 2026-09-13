/**
 * The reference opponent.
 *
 * This is not a port of the lab's AI, and it could not have been. That one
 * reads exact ball coordinates out of the world, runs potential-field avoidance
 * over the known positions of every opponent, and checks shot lanes with
 * geometry no robot has. Rewriting it to work from sensors is not porting, it
 * is writing a different program — so this is that program, written the way a
 * good team would write it, and its job is to answer the question the boundary
 * was built to ask: can a robot that only sees what a sensor sees still play?
 *
 * It also ships as the worked example. Everything here is code a student could
 * have written, using only the library the league gives them, and it is meant
 * to be read, argued with and beaten.
 */

import { MOUNT_RADIUS, mixOmni, openDrive, wrapAngle, type DriveSpec } from './drive';
import { WHEEL_RADIUS } from './sensors';
import { HALF_LENGTH, HALF_WIDTH, WALL_X, WALL_Z } from './field';
import { IR_REFERENCE_RANGE } from './sensors';
import type { ActuatorFrame, SensorFrame } from './protocol';
import type { Agent } from './agent';

const ROBOT_RADIUS = 110;

export type Role = 'striker' | 'goalie';

interface Estimate {
  x: number;
  z: number;
  /** 0..1. Falls off when the sonars stop agreeing or stop answering. */
  confidence: number;
}

/**
 * Where am I?
 *
 * Nothing tells the robot its position, so it works it out: the compass gives
 * heading, and a sonar pointing mostly along an axis is almost certainly
 * looking at that axis's wall. Pick the beam most aligned with each direction,
 * assume it found the obvious wall, and solve.
 *
 * It is wrong near a corner, wrong when a beam grazes and returns nothing, and
 * wrong whenever another robot is in the way — all of which is why the estimate
 * carries a confidence and why nothing here bets the match on it.
 */
export function locate(frame: SensorFrame): Estimate {
  const heading = frame.compass.heading;
  const beams: { angle: number; range: number }[] = [];
  const push = (offset: number, range: number | null) => {
    if (range !== null) beams.push({ angle: wrapAngle(heading + offset), range });
  };
  push(0, frame.range.front);
  push(Math.PI / 2, frame.range.left);
  push(Math.PI, frame.range.back);
  push(-Math.PI / 2, frame.range.right);

  /*
   * Solve one axis, and check the answer against the opposite beam.
   *
   * A sonar can only ever read SHORT — an obstruction returns an echo early,
   * nothing makes one arrive late. So a robot standing in front of a beam makes
   * this robot believe it is closer to that wall than it is, with no hint that
   * anything is wrong.
   *
   * The check is that opposite beams have to add up: front + back + the
   * robot's own width is the length of the field, and if it comes out short
   * then one of them is blocked. Trust the longer one, because that is the one
   * an obstruction cannot have produced, and drop the confidence so nothing
   * downstream bets on it.
   *
   * Without this, a striker would confidently locate itself against a
   * team mate's flank and attack the wrong way. In a ladder run that showed up
   * as a robot which spins on the spot finishing third, on 166 goals it did not
   * score: everyone else was scoring them for it.
   */
  const solve = (
    component: (b: { angle: number }) => number,
    wall: number,
  ): { value: number; sure: boolean } | null => {
    let plus: { value: number; range: number } | null = null;
    let minus: { value: number; range: number } | null = null;

    for (const b of beams) {
      const c = component(b);
      if (Math.abs(c) < 0.6) continue;
      // centre + (range + radius) * direction = wall
      const value = Math.sign(c) * wall - (b.range + ROBOT_RADIUS) * c;
      const slot = c > 0 ? 'plus' : 'minus';
      const held = slot === 'plus' ? plus : minus;
      if (!held || b.range > held.range) {
        if (slot === 'plus') plus = { value, range: b.range };
        else minus = { value, range: b.range };
      }
    }

    if (plus && minus) {
      const span = plus.range + minus.range + 2 * ROBOT_RADIUS;
      const agree = Math.abs(span - 2 * wall) < 150;
      // Longer beam wins: an obstruction can only shorten a reading.
      const better = plus.range >= minus.range ? plus : minus;
      return { value: better.value, sure: agree };
    }
    const only = plus ?? minus;
    // A single beam cannot be checked against anything, so it is never sure.
    return only ? { value: only.value, sure: false } : null;
  };

  const x = solve((b) => Math.cos(b.angle), WALL_X);
  const z = solve((b) => Math.sin(b.angle), WALL_Z);

  return {
    x: clamp(x?.value ?? 0, -HALF_LENGTH, HALF_LENGTH),
    z: clamp(z?.value ?? 0, -HALF_WIDTH, HALF_WIDTH),
    confidence: (x?.sure ? 0.5 : 0) + (z?.sure ? 0.5 : 0),
  };
}

/**
 * Where the ball is, including for the moment after it disappears.
 *
 * The infrared ring returns nothing at all when a robot stands in the way, and
 * a robot that stops the instant it loses sight of the ball is useless. So the
 * last sighting is kept in FIELD bearing rather than robot bearing — the robot
 * keeps turning, and a remembered bearing that does not turn with it is worse
 * than no memory at all.
 */
class BallMemory {
  private fieldBearing = 0;
  private range = 500;
  private age = Infinity;
  private started = false;

  update(frame: SensorFrame, dt: number): void {
    if (frame.ball) {
      const measured = wrapAngle(frame.compass.heading + frame.ball.bearing);
      const measuredRange = IR_REFERENCE_RANGE / Math.sqrt(Math.max(frame.ball.strength, 1e-4));
      if (!this.started) {
        this.fieldBearing = measured;
        this.range = measuredRange;
        this.started = true;
      } else {
        /*
         * Low-pass the bearing before anything acts on it.
         *
         * The ring quantises to 22.5 degrees and jitters across the boundary
         * between two sectors, so the raw reading steps back and forth by a
         * full sector several times a second even when the ball is still. A
         * robot that drives at it directly weaves the whole way down the field.
         *
         * Filtered in the FIELD frame, so turning does not smear the estimate.
         * The time constant is short enough to track a moving ball and long
         * enough to swallow the stepping.
         */
        const k = 1 - Math.exp(-dt / BEARING_TAU);
        this.fieldBearing = wrapAngle(
          this.fieldBearing + wrapAngle(measured - this.fieldBearing) * k,
        );
        this.range += (measuredRange - this.range) * (1 - Math.exp(-dt / RANGE_TAU));
      }
      this.age = 0;
    } else {
      this.age += dt;
    }
  }

  /** Null once the memory is too old to act on. */
  seen(frame: SensorFrame, maxAge = 1.2): { bearing: number; range: number } | null {
    if (this.age > maxAge) return null;
    return {
      bearing: wrapAngle(this.fieldBearing - frame.compass.heading),
      range: this.range,
    };
  }

  get fresh(): boolean {
    return this.age === 0;
  }

  reset(): void {
    this.age = Infinity;
    this.started = false;
  }
}

/** Filter time constants, seconds. */
const BEARING_TAU = 0.2;
const RANGE_TAU = 0.2;

/**
 * Yaw rate from the wheel encoders.
 *
 * Differencing the compass would work and would be much noisier - 0.012 rad of
 * noise over a 20 ms cycle is 0.6 rad/s of rubbish. The encoders are better:
 * on a tangential four-omni drive the mean wheel speed is the robot's own
 * rotation, and it is the only clean rate signal on the robot.
 */
class YawRate {
  private last: number[] | null = null;
  private rate = 0;

  update(encoders: number[], dt: number): number {
    if (this.last && this.last.length === encoders.length && dt > 0) {
      let sum = 0;
      for (let i = 0; i < encoders.length; i++) {
        sum += (encoders[i]! - this.last[i]!) / dt;
      }
      const meanWheel = sum / encoders.length;
      const omega = (meanWheel * WHEEL_RADIUS) / MOUNT_RADIUS;
      this.rate += (omega - this.rate) * Math.min(1, dt * 20);
    }
    this.last = [...encoders];
    return this.rate;
  }

  reset(): void {
    this.last = null;
    this.rate = 0;
  }
}

/**
 * Heading control: proportional, with a derivative term to stop the overshoot.
 *
 * Tuned by playing the robot against a slowed-down copy of itself, which turns
 * out to be a sharp instrument. If thinking *less often* makes a robot better,
 * the controller is over-reacting - and at the first values here a 0.6-rate
 * copy beat the full-rate one by 17 goals across 24 matches. Raising the
 * filter and the derivative term together turned that into +14 the other way.
 *
 * That test is worth keeping as the damping check it turned out to be, rather
 * than only as a check on the skill dial.
 */
const SPIN_KP = 0.9;
const SPIN_KD = 0.5;

/**
 * How close to the edge of the playing area the ball has to be before the
 * push is steered back inwards.
 *
 * Taken from the lab's AI, which had the same constant for the same reason and
 * which this agent should have copied from the start. Without it the striker
 * aims at the goal and pushes, a shot that misses runs straight off the field,
 * and under 5.9.1 that is a restart: 176 of them in a ten-minute match, one
 * every three and a half seconds, which is not a game anyone would watch.
 *
 * Real robots do this too - a ball against a wall gets taken off it before it
 * gets taken forward, because a push with no component away from the wall just
 * scrapes the ball along it.
 */
const EDGE_MARGIN = 260;
/** How hard a close wall bends the aim. Tuned on out-of-play counts. */
const WALL_REPULSION = 1.4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Get off the line.
 *
 * The first version of this agent ignored the line sensors entirely and it
 * showed: robots drove fully into the out area between nine and forty times a
 * match, which under 5.7.1.6 is a removal every time, and the ball went out
 * thirty-odd times because nobody stopped chasing it over the edge.
 *
 * The white line is 50 mm wide and sits just outside the playing area, so by
 * the time a rim sensor sees it the robot has one wheel out. Returning a
 * bearing to run in, rather than just stopping, is what keeps a robot that
 * arrives at speed from coasting out anyway.
 */
export function escapeLine(frame: SensorFrame): number | null {
  let ex = 0;
  let ez = 0;
  let hits = 0;
  for (const sensor of frame.lines) {
    if (sensor.surface !== 'line') continue;
    hits++;
    // Run opposite whichever sensor found it.
    ex -= Math.cos(sensor.bearing);
    ez -= Math.sin(sensor.bearing);
  }
  if (hits === 0) return null;
  // Every sensor lit at once means the robot is square on a corner and the
  // vectors cancel; back out the way it came rather than dithering.
  if (Math.hypot(ex, ez) < 0.2) return Math.PI;
  return Math.atan2(ez, ex);
}

export interface ReferenceOptions {
  /**
   * Identity only - radio, name, scoreboard. NOT which goal to shoot at: ends
   * swap at half-time (rule 1.4/5.4), so attack direction is read fresh from
   * `frame.attackDirection` every tick instead.
   */
  team: 'violet' | 'lime';
  number: 1 | 2;
  role?: Role;
  drive?: DriveSpec;
  /** Slows and blunts the robot, for building a ladder of practice opponents. */
  skill?: number;
  name?: string;
}

export class ReferenceAgent implements Agent {
  readonly name: string;
  private readonly drive: DriveSpec;
  private readonly ball = new BallMemory();
  private readonly yaw = new YawRate();
  private yawRate = 0;
  private readonly role: Role;
  private readonly skill: number;
  private lastClock = 0;
  private thinkCredit = 0;
  private lastCommand: ActuatorFrame = { motors: [0, 0, 0, 0] };
  /** Refreshed every tick from the frame; see `attackX`. */
  private attackDirection: 1 | -1 = 1;

  constructor(opts: ReferenceOptions) {
    this.drive = opts.drive ?? openDrive();
    this.role = opts.role ?? (opts.number === 2 ? 'goalie' : 'striker');
    this.skill = opts.skill ?? 1;
    this.name = opts.name ?? `reference-${opts.team}${opts.number}-${this.role}`;
  }

  reset(): void {
    this.ball.reset();
    this.yaw.reset();
    this.yawRate = 0;
    this.lastClock = 0;
    this.thinkCredit = 0;
    this.lastCommand = { motors: [0, 0, 0, 0] };
  }

  /**
   * Turn a heading error into a spin command.
   *
   * Proportional alone overshoots and rings: the chassis has real rotational
   * inertia, so by the time the error reaches zero the robot is still turning.
   * The derivative term is what stops it, and it is why the encoders are worth
   * reading.
   */
  private spinTo(error: number): number {
    return clamp(error * SPIN_KP - this.yawRate * SPIN_KD, -1, 1);
  }

  /** Which way is the opponent's goal, in field radians. */
  private get attackX(): number {
    return this.attackDirection > 0 ? HALF_LENGTH : -HALF_LENGTH;
  }

  private get defendX(): number {
    return -this.attackX;
  }

  tick(frame: SensorFrame): ActuatorFrame {
    this.attackDirection = frame.attackDirection;
    const dt = Math.max(1e-3, frame.clock - this.lastClock);
    this.lastClock = frame.clock;
    this.ball.update(frame, dt);
    this.yawRate = this.yaw.update(frame.encoders, dt);

    /*
     * A weaker opponent thinks less often, as well as moving more slowly.
     *
     * Scaling speed alone turned out not to make a ladder: a slower robot
     * overshoots the ball less and plays about as well, and a 0.45-skill team
     * beat a full-strength one half the time. Running the decision loop at a
     * fraction of the rate is a handicap that actually costs something, and it
     * is also the honest way a cheaper robot is worse - its control loop is
     * slower, so it acts on staler information.
     *
     * The rate is carried as a fractional credit rather than a whole number of
     * ticks to hold for, because rounding made most of the dial do nothing.
     * `Math.round(1 / skill)` is 1 for every skill above 0.67 - so a 0.8 robot
     * was not handicapped at all, only slowed, and being slowed on its own can
     * make a robot BETTER. It measured -7 goals over 48 matches: the weaker
     * setting winning. Between 0.6 and 0.45 the rounding collapsed two
     * settings onto the same 2-tick hold, so they were the same robot under
     * two names. A credit gives a think rate of exactly skill x CONTROL_HZ,
     * and every turn of the dial changes something.
     */
    if (this.skill < 1) {
      this.thinkCredit += this.skill;
      if (this.thinkCredit < 1) return this.lastCommand;
      this.thinkCredit -= 1;
    }
    const command = this.decide(frame);
    this.lastCommand = command;
    return command;
  }

  private decide(frame: SensorFrame): ActuatorFrame {

    if (!frame.playing) return { motors: [0, 0, 0, 0] };

    /*
     * Rule 5.4.7: a kick-off has to be a strike, not a carry.
     *
     * The obvious reading of that - roller off, drive through the ball, let it
     * run - does not work, and measuring it was the only way to find out. A
     * robot and a ball separate by position in this world, not by impulse, so
     * a shoved ball travels along with the robot that is shoving it and the
     * 50 mm gap the rule asks for never opens at all. The referee awarded the
     * kick-off to the other side at every restart: 10.6 of 10.6 in a run of
     * five matches.
     *
     * The only thing that makes the ball leave is the kicker. So: come up to
     * the ball, then STOP, and hold the kicker request until it fires.
     *
     * The stopping is the part that is easy to miss. The kicker is usually
     * still charging at a restart, because the goal that caused the restart
     * was scored by firing it, and a robot that keeps driving while it waits
     * has carried the ball off the spot and given the kick-off away before the
     * solenoid is ready. Standing still is legal for the three seconds the
     * rule allows; carrying is not.
     */
    if (frame.kickoff.pending && frame.kickoff.ours) {
      if (frame.ballGate.held) {
        return { motors: [0, 0, 0, 0], dribbler: 1, kicker: true };
      }
      if (frame.ball) {
        return {
          motors: mixOmni(this.drive, frame.ball.bearing, 0.55, 0),
          dribbler: 1,
          kicker: true,
        };
      }
    }

    // Nothing else matters while a wheel is over the line. 5.7.1.6 takes a
    // robot wholly in the out area off the field for thirty seconds, which
    // costs far more than any ball ever chased over the edge.
    const escape = escapeLine(frame);
    if (escape !== null) {
      return { motors: mixOmni(this.drive, escape, 1, 0), dribbler: 1 };
    }

    const me = locate(frame);
    const seen = this.ball.seen(frame);

    if (!seen) return this.hunt(frame);
    return this.role === 'goalie' ? this.keep(frame, me, seen) : this.strike(frame, me, seen);
  }

  /**
   * Lost the ball: turn on the spot and look for it.
   *
   * Turning rather than driving is deliberate. The ring covers every direction,
   * so a robot that cannot see the ball is almost always being blocked rather
   * than facing the wrong way, and driving blind is how robots end up in the
   * out area under 5.7.1.6.
   */
  private hunt(frame: SensorFrame): ActuatorFrame {
    const towardsOwnHalf = wrapAngle(
      Math.atan2(0, this.defendX) - frame.compass.heading,
    );
    return {
      motors: mixOmni(this.drive, towardsOwnHalf, 0.25 * this.skill, 0.45),
      dribbler: 1,
    };
  }

  /**
   * Attack: come at the ball from the side away from our own goal.
   *
   * Driving straight at the ball pushes it wherever the robot happens to be
   * pointing, which as often as not is our own net. The offset is what turns
   * chasing into attacking, and it is the first thing a team discovers.
   */
  private strike(
    frame: SensorFrame,
    me: Estimate,
    seen: { bearing: number; range: number },
  ): ActuatorFrame {
    const heading = frame.compass.heading;

    /*
     * Which way is their goal, in field radians.
     *
     * This used to be worked out from an estimated position, and it was the
     * worst bug in the agent: `locate` falls back to the centre of the field
     * when the sonars cannot solve - grazing beams, or another robot in the
     * way - and a striker that believes it is at the centre circle when it is
     * not will happily push the ball into its own net. Against an opponent
     * that stood still it scored eleven own goals in two minutes.
     *
     * The fix is to stop needing the position. The attacking direction is a
     * fixed field bearing, the compass gives heading, and everything else can
     * be done relative to the ball - so the striker now works in its own frame
     * and only refines the aim when it is confident of where it is.
     */
    const straightAtGoal = this.attackX > 0 ? 0 : Math.PI;
    let toGoal = straightAtGoal;
    if (me.confidence >= 1) {
      const bx = me.x + Math.cos(heading + seen.bearing) * seen.range;
      const bz = me.z + Math.sin(heading + seen.bearing) * seen.range;
      // Bend the aim towards the middle of the goal rather than its near post.
      toGoal = Math.atan2(-bz * 0.35, this.attackX - bx);
    }

    // Everything from here is in the robot's own frame: where the ball is,
    // and which way round it the robot has to come.
    const toGoalLocal = this.offTheWall(frame, wrapAngle(toGoal - heading));
    /*
     * How far round the ball the robot is from where it ought to be.
     *
     * Zero means directly behind the ball on the line to their goal, so that
     * driving straight at it pushes it straight at the target. A right angle
     * means beside it, where driving at it knocks it sideways.
     *
     * Steering off the line to the ball by a fraction of this angle turns the
     * two cases into one continuous path: there is always some component
     * towards the ball, so the robot spirals in rather than orbiting forever,
     * and always some component round it, so it never arrives from the wrong
     * side.
     *
     * This replaced a threshold - "is the standoff point within 90 mm yet?" -
     * and the threshold was a defect rather than a rough edge. It sat on a
     * noisy quantity, so it chattered between two different plans several
     * times a second and the robot spent its time switching rather than
     * arriving. It showed up from a long way off, too: a copy of this agent
     * with its decision loop slowed to two thirds BEAT the full-rate original
     * by 22 goals over 48 matches, because running at half the rate is a
     * low-pass filter on the chatter. A controller that gets better when you
     * slow it down is over-reacting somewhere, and this was the somewhere.
     */
    const swing = wrapAngle(seen.bearing - toGoalLocal);
    // Wider arcs close in, where there is no room left to correct.
    const gain = clamp(0.6 + 120 / Math.max(seen.range, 100), 0.6, 1.4);
    const bearing = this.offTheWall(
      frame,
      wrapAngle(seen.bearing + clamp(swing * gain, -1.9, 1.9)),
    );
    const aligned = Math.abs(swing) < 0.35;

    // Face the goal while doing it, so the dribbler and kicker point the right
    // way when the ball arrives.
    const spin = this.spinTo(toGoalLocal);
    // Full power down the line, a little less while swinging round, so the
    // robot does not arrive at the ball still travelling sideways.
    const speed = (aligned ? 1 : clamp(1.15 - Math.abs(swing) * 0.35, 0.6, 1)) * this.skill;

    const goal = frame.camera.goals[this.attackDirection > 0 ? 'yellow' : 'cyan'];
    const lined = goal !== null && Math.abs(goal.bearing) < 0.2;

    return {
      motors: mixOmni(this.drive, bearing, speed, spin),
      dribbler: 1,
      kicker: frame.ballGate.held && lined,
      say: { role: 'striker' as const, sure: me.confidence >= 1 },
    };
  }

  /**
   * Bend a push away from any wall that is close.
   *
   * The first attempt at this worked off the estimated position and made the
   * problem worse, because position is only trustworthy 42% of the time - so
   * the steering was off for most of the match, and on for a scattered minority
   * of cycles, which is worse than either.
   *
   * The robot does not need to know where it is to know a wall is 200 mm to its
   * left. The sonars say so directly, they are in the robot's own frame already,
   * and they are there whether or not the position solved. Each close wall
   * pushes the aim away from itself, in proportion to how close it is.
   */
  private offTheWall(frame: SensorFrame, desired: number): number {
    const beams: [number, number | null][] = [
      [0, frame.range.front],
      [Math.PI / 2, frame.range.left],
      [Math.PI, frame.range.back],
      [-Math.PI / 2, frame.range.right],
    ];
    let rx = Math.cos(desired);
    let rz = Math.sin(desired);
    for (const [angle, range] of beams) {
      if (range === null || range > EDGE_MARGIN) continue;
      const urgency = 1 - range / EDGE_MARGIN;
      rx -= Math.cos(angle) * urgency * WALL_REPULSION;
      rz -= Math.sin(angle) * urgency * WALL_REPULSION;
    }
    if (Math.hypot(rx, rz) < 1e-6) return desired;
    return wrapAngle(Math.atan2(rz, rx));
  }

  /**
   * Keep goal: hold the line, track the ball across it, clear when it arrives.
   *
   * Staying on the line rather than chasing is also what keeps the goalie out
   * of 5.11 multiple defence — two robots of one team inside their own penalty
   * area is a removal, so the keeper has a reason beyond tactics to stay put.
   */
  private keep(
    frame: SensorFrame,
    me: Estimate,
    seen: { bearing: number; range: number },
  ): ActuatorFrame {
    const heading = frame.compass.heading;
    const bx = me.x + Math.cos(heading + seen.bearing) * seen.range;
    const bz = me.z + Math.sin(heading + seen.bearing) * seen.range;

    // Sit just off the goal line, shadowing the ball across it.
    const holdX = this.defendX + (this.attackX > 0 ? 180 : -180);
    const holdZ = clamp(bz * 0.7, -190, 190);

    /*
     * Only charge the ball from the goal side of it.
     *
     * The first version charged whenever the ball was close, and scored 25 own
     * goals in a match where the opposition stood still: a keeper that drives
     * at a ball sitting between itself and its own net pushes it in. Which
     * side of the ball the keeper is on matters more than how near it is, and
     * this is the bug every team writes once.
     */
    const upfield = Math.sign(this.attackX);
    const goalSide = upfield * (bx - me.x) > 0;
    const ballIsClose = seen.range < 320;

    if (ballIsClose && goalSide) {
      // Clear it: drive through the ball, away from our goal.
      const away = wrapAngle(Math.atan2(-bz * 0.3, this.attackX - bx) - heading);
      return {
        motors: mixOmni(this.drive, seen.bearing, 1 * this.skill, clamp(away * 0.8, -1, 1)),
        dribbler: 1,
        kicker: frame.ballGate.held,
        say: { role: 'goalie' as const, active: true },
      };
    }

    if (!goalSide) {
      /*
       * The ball is behind us, between the keeper and its own net. Getting back
       * past it is the only priority — but not straight back, which was the
       * second version of this bug: driving at the goal line with the ball in
       * the way simply carries it in. Go round, by aiming at a point offset
       * across the field from the ball, on whichever side we are already
       * nearer, and only then come back to the line.
       */
      const detourSide = me.z >= bz ? 1 : -1;
      const detourZ = clamp(bz + detourSide * 300, -HALF_WIDTH + 140, HALF_WIDTH - 140);
      const detourX = this.defendX + upfield * 120;
      const away = wrapAngle(Math.atan2(detourZ - me.z, detourX - me.x) - heading);
      return {
        motors: mixOmni(this.drive, away, 1 * this.skill, 0),
        dribbler: 0,
        say: { role: 'goalie' as const, active: false },
      };
    }

    const toHold = wrapAngle(Math.atan2(holdZ - me.z, holdX - me.x) - heading);
    const distance = Math.hypot(holdX - me.x, holdZ - me.z);
    const speed = clamp(distance / 300, 0, 1) * this.skill;
    // Face up the field so a save deflects forwards rather than inwards.
    const spin = this.spinTo(wrapAngle(Math.atan2(0, this.attackX - me.x) - heading));

    return {
      motors: mixOmni(this.drive, toHold, speed, spin),
      dribbler: 1,
      say: { role: 'goalie' as const, active: false },
    };
  }
}

/** A full team of two: a striker and a keeper. */
export function referenceTeam(team: 'violet' | 'lime', skill = 1) {
  return {
    [`${team}-1`]: new ReferenceAgent({ team, number: 1, role: 'striker', skill }),
    [`${team}-2`]: new ReferenceAgent({ team, number: 2, role: 'goalie', skill }),
  } as Record<string, ReferenceAgent>;
}
