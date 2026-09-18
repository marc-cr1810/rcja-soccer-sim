/**
 * The champion's shared decision brain.
 *
 * Both robots on a team run the same brain; which job it is doing is a
 * parameter, not a separate file. The two role files this replaces duplicated
 * the same skeleton — the kick-off stance, the out-of-bounds recovery, the
 * ball-lost fallback, the spot-holding `hold`, the radio `broadcast` — and
 * each carried its own half of the tuning. Here there is one pipeline, and
 * the difference between striker and keeper is the set of parameters each
 * behaviour reads (where the goal is, how far off the line to guard, which
 * spot to screen) plus which behaviours a role may invoke.
 *
 * Parameterising roles instead of copying them buys one thing the two-copy
 * design structurally cannot have: the striker can fold into the goal when
 * the keeper is taken off the field. A partner off under rule 5.7 stops
 * being polled, so its radio falls silent — the only teammate signal a robot
 * has — and a team playing shorthanded with an empty net is conceding. See
 * `keeperSilent`.
 */

import { mixOmni, wrapAngle, type DriveSpec } from '../drive';
import {
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_DEPTH,
  PENALTY_WIDTH,
} from '../field';
import type { ActuatorFrame, SensorFrame } from '../protocol';
import {
  BALL_RADIUS,
  CONTACT_RANGE,
  type ChampionRadioMessage,
  type ChampionRole,
  type FramedBall,
  type FramedPose,
} from './types';
import type { WheelEffort } from './estimator';
import type { GoalFrame } from '../frame';
import {
  BALL_STOP_X,
  BALL_STOP_Z,
  EDGE_STOP_X,
  EDGE_STOP_Z,
  backInside,
  calculateIntercept,
  obstacleRange,
  passIsOpen,
  spinTowards,
  steerBallInside,
  steerClearOfEdges,
  tangentApproach,
  widestOpening,
} from './geometry';
import {
  KICK_SCORE_MIN,
  approachHesitation,
  estimateStale,
  evaluateShot,
} from './utility';

/**
 * The goal being attacked, in attack-relative coordinates: always this one.
 *
 * That it is a constant rather than a sign on `HALF_LENGTH` IS the fix. See
 * `src/frame.ts` - past `GoalFrame` there is no attack direction in scope, so
 * there is none to forget to multiply by.
 */
const GOAL_LINE = HALF_LENGTH;
/** And the goal being defended: always the other one. */
const OWN_LINE = -HALF_LENGTH;

/**
 * The constants that tell a robot which job it is doing.
 *
 * Everything a behaviour reads is here. The values are the same ones the two
 * role files were tuned with; the point of collecting them is that a single
 * robot can then change jobs mid-match without recompiling a second brain.
 */
export interface ChampionBrainParams {
  role: ChampionRole;
  /** Which post the kicker aims at when the camera gap is untrusted, mm. */
  aimPost: number;
  /** How far either side of goal centre a screening striker may stand. */
  postScreen: number;
  /** Where the striker receives a keeper's pass: depth and wing. */
  receiveDepth: number;
  receiveWing: number;
  /** How far off the goal line the keeper guards. */
  guardDist: number;
  /** Keeper's lateral clamp on the mouth, mm. */
  postClamp: number;
  /** Keeper never backs onto the goal line closer than this, mm. */
  depthDist: number;
  /** How long the keeper holds the ball waiting for a receiver, ticks. */
  passPatience: number;
  /** Keeper's leash up the field and across it. */
  leashX: number;
  leashZ: number;
}

export const strikerParams: Omit<ChampionBrainParams, 'role'> = {
  aimPost: 155.0,
  postScreen: 190.0,
  receiveDepth: PENALTY_DEPTH + 520.0,
  receiveWing: HALF_WIDTH * 0.55,
  guardDist: 175.0,
  postClamp: 180.0,
  depthDist: 120.0,
  passPatience: 75,
  leashX: HALF_LENGTH - 40.0,
  leashZ: 430.0,
};

export const goalieParams: Omit<ChampionBrainParams, 'role'> = {
  ...strikerParams,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class ChampionBrain {
  private stallCount = 0;
  private breakoutTicks = 0;
  private breakoutSide = 1.0;
  private track: { clock: number; x: number; z: number }[] = [];
  private passWait = 0;

  /** Has this robot ever heard its partner? Gates the role fold below. */
  private everHeard = false;
  /** Ticks the partner has stayed silent, while the fold conditions held. */
  private silentTicks = 0;

  constructor(
    private readonly drive: DriveSpec,
    private readonly params: ChampionBrainParams,
    private readonly skill = 1.0,
  ) {}

  /** Swap which job this robot is doing. Mid-match, by the fold below. */
  setRole(role: ChampionRole): void {
    this.params.role = role;
    this.passWait = 0;
    this.stallCount = 0;
    this.breakoutTicks = 0;
    this.track = [];
  }

  get role(): ChampionRole {
    return this.params.role;
  }

  reset(): void {
    this.stallCount = 0;
    this.breakoutTicks = 0;
    this.breakoutSide = 1.0;
    this.track = [];
    this.passWait = 0;
    this.everHeard = false;
    this.silentTicks = 0;
  }

  decide(
    frame: SensorFrame,
    goalFrame: GoalFrame,
    me: FramedPose,
    ball: FramedBall,
    heading: number,
    yawRate: number,
    effort: WheelEffort,
    mateMsg: ChampionRadioMessage | null,
  ): ActuatorFrame {
    if (!frame.playing) return { motors: [0, 0, 0, 0] };
    if (frame.kickoff.countdown > 0) return { motors: [0, 0, 0, 0] };

    const holding = Boolean(frame.ballGate?.held);

    if (mateMsg && !this.everHeard) this.everHeard = true;

    // A striker whose keeper has fallen silent takes over the goal - see
    // `foldedRole`. The keeper never abandons its line for a silent
    // striker, so the fold only ever goes one way.
    const active = this.everHeard ? this.foldedRole(frame, ball, mateMsg) : this.params.role;

    if (active === 'goalie') {
      return this.goalDecide(frame, me, ball, heading, yawRate, effort, mateMsg, holding);
    }
    return this.strikeDecide(
      frame,
      goalFrame,
      me,
      ball,
      heading,
      yawRate,
      effort,
      mateMsg,
      holding,
    );
  }

  // --------------------------------------------------------------- striker

  private strikeDecide(
    frame: SensorFrame,
    goalFrame: GoalFrame,
    me: FramedPose,
    ball: FramedBall,
    heading: number,
    yawRate: number,
    effort: WheelEffort,
    mateMsg: ChampionRadioMessage | null,
    holding: boolean,
  ): ActuatorFrame {
    const p = this.params;
    const meX = me.x;
    const meZ = me.z;
    const attackingBlobs = goalFrame.blobs(frame).attacking;

    // 1. Rule 5.4.7: Legal Kick-off Strike
    if (frame.kickoff.pending) {
      if (!frame.kickoff.ours) {
        return { motors: [0, 0, 0, 0], dribbler: 0 };
      }
      // Aim the strike at the widest opening the camera can see rather than
      // dead down the middle, where the defending keeper camps. 5.4.7 demands
      // a clear strike, not a straight one. Spinning in place while holding
      // keeps the ball within 120 mm of the spot, so until the kicker fires
      // the referee reads it as legal.
      const open = widestOpening(attackingBlobs);
      let aim: number;
      if (open && open.width > BALL_RADIUS * 3) {
        aim = clamp(open.bearing, -0.5, 0.5);
      } else {
        // No trustworthy camera gap: pick the far post, so the keeper parked
        // centrally is beaten to whichever edge the ball is not already on.
        const postSide =
          Math.abs(ball.z) > 45
            ? Math.sign(-ball.z)
            : Math.sign(Math.abs(meZ) > 1.0 ? -meZ : 1);
        aim = clamp(Math.atan2(postSide * p.aimPost, GOAL_LINE), -0.5, 0.5);
      }
      if (holding) {
        if (Math.abs(aim) < 0.12) {
          return {
            motors: mixOmni(this.drive, 0, 0, 0),
            dribbler: 1,
            kicker: true,
            say: this.broadcast('KICKOFF', meX, meZ, holding, ball, 0, false),
          };
        }
        return {
          motors: mixOmni(this.drive, 0, 0, spinTowards(wrapAngle(aim), yawRate)),
          dribbler: 1,
          say: this.broadcast('KICKOFF', meX, meZ, holding, ball, 0, false),
        };
      }
      // Creep dead-straight with dribbler off until the gate triggers, then fire strike
      return {
        motors: mixOmni(this.drive, 0, 0.18, 0),
        dribbler: 0,
        kicker: true,
        say: this.broadcast('KICKOFF', meX, meZ, false, ball, 0, false),
      };
    }

    // 2. Out-of-bounds recovery (Rule 5.7.1.6)
    if (Math.abs(meX) > HALF_LENGTH + 25 || Math.abs(meZ) > HALF_WIDTH + 25) {
      const [homeX, homeZ] = backInside(meX, meZ, 170.0);
      const travel = wrapAngle(Math.atan2(homeZ - meZ, homeX - meX) - heading);
      return {
        motors: mixOmni(this.drive, travel, 1.0 * this.skill, 0),
        dribbler: 1,
        say: this.broadcast('RECOVER', meX, meZ, holding, ball),
      };
    }

    // 3. Receive outlet pass from Goalie
    const goalieIsPassing =
      mateMsg &&
      mateMsg.role === 'goalie' &&
      mateMsg.held &&
      mateMsg.intent === 'PASS';

    if (!holding && goalieIsPassing && mateMsg.pos) {
      const [gx, gz] = mateMsg.pos;
      const cx = OWN_LINE + p.receiveDepth;
      const wing = Math.sign(Math.abs(meZ) > 60 ? meZ : 1) * p.receiveWing;
      const [spotX, spotZ] = backInside(cx, wing, 200.0);

      const gap = Math.hypot(spotX - meX, spotZ - meZ);
      const travel = Math.atan2(spotZ - meZ, spotX - meX);
      const faceAngle = Math.atan2(gz - meZ, gx - meX);
      const spin = spinTowards(wrapAngle(faceAngle - heading), yawRate);
      const ready = gap < 150.0 && Math.abs(wrapAngle(faceAngle - heading)) < 0.35;

      const speed = (gap < 70.0 ? 0.0 : clamp(gap / 260.0, 0.3, 1.0)) * this.skill;
      return {
        motors: mixOmni(this.drive, wrapAngle(travel - heading), speed, spin),
        dribbler: 1,
        say: this.broadcast('RECEIVE', meX, meZ, false, ball, gap, ready),
      };
    }

    // 4. Determine Ball Position
    let bx = ball.x;
    let bz = ball.z;
    if (!ball.seen) {
      if (mateMsg && mateMsg.ball) {
        [bx, bz] = mateMsg.ball;
      } else {
        // Search stance in our own half, facing the goal we are attacking
        const homeX = OWN_LINE + HALF_LENGTH * 0.45;
        const travel = wrapAngle(Math.atan2(0 - meZ, homeX - meX) - heading);
        const spin = spinTowards(wrapAngle(-heading), yawRate);
        return {
          motors: mixOmni(this.drive, travel, 0.5 * this.skill, spin),
          dribbler: 1,
          say: this.broadcast('SEARCH', meX, meZ, false, ball),
        };
      }
    }

    // 5. Tactical Aim Point Selection
    let aimX = GOAL_LINE;
    let aimZ = 0;
    const depthInField = bx - OWN_LINE;

    if (depthInField < HALF_LENGTH * 0.55) {
      // In defensive half: clear up the safe wing rather than across own goal mouth
      const wing = Math.sign(Math.abs(bz) > 60 ? bz : 1) * (HALF_WIDTH * 0.55);
      aimX = GOAL_LINE;
      aimZ = wing;
    } else {
      // Attacking: choose post based on goalie placement or camera blobs
      let postSide: number;
      if (bz > 45) postSide = -1;
      else if (bz < -45) postSide = 1;
      else {
        const trustMeZ = Math.abs(meZ) > 1.0 && me.confidence >= 1.0;
        postSide = Math.sign(trustMeZ ? -meZ : 1);
      }
      aimX = GOAL_LINE;
      aimZ = clamp(postSide * p.aimPost, -HALF_GOAL_WIDTH + 70, HALF_GOAL_WIDTH - 70);

      // Camera opening detection override - only in attacking territory
      if (depthInField >= HALF_LENGTH * 0.55) {
        const open = widestOpening(attackingBlobs);
        if (open && open.width > BALL_RADIUS * 3) {
          aimX = meX + Math.cos(heading + open.bearing) * open.range;
          aimZ = meZ + Math.sin(heading + open.bearing) * open.range;
        }
      }
    }

    let push = Math.atan2(aimZ - bz, aimX - bx);
    push = steerBallInside(bx, bz, push, GOAL_LINE);

    // 6. Penalty Box Screening (Rule 5.11 Multiple Defense Avoidance)
    const inOurBox =
      depthInField > 0 &&
      depthInField < PENALTY_DEPTH + 60 &&
      Math.abs(bz) < PENALTY_WIDTH / 2 + 40;

    const keeperActive = mateMsg && mateMsg.role === 'goalie';
    const keeperOffLine = Boolean(mateMsg?.offLine);

    if (keeperActive && inOurBox && !holding) {
      const waitX = OWN_LINE + PENALTY_DEPTH + (keeperOffLine ? 40.0 : 90.0);
      const waitZ = clamp(
        bz * 0.55,
        keeperOffLine ? -p.postScreen : -300.0,
        keeperOffLine ? p.postScreen : 300.0,
      );
      const gap = Math.hypot(waitX - meX, waitZ - meZ);
      const travel = Math.atan2(waitZ - meZ, waitX - meX);
      const spin = spinTowards(wrapAngle(push - heading), yawRate);
      const speed = (gap > 35 ? clamp(gap / 150.0, 0.3, 1.0) : 0.0) * this.skill;
      const intent = keeperOffLine ? 'COVER_MOUTH' : 'COVER';

      return {
        motors: mixOmni(this.drive, wrapAngle(travel - heading), speed, spin),
        dribbler: 1,
        say: this.broadcast(intent, meX, meZ, false, ball),
      };
    }

    // 7. Interception, Approach & Ball Carrying
    let travelField = push;
    let speed = 1.0 * this.skill;
    let spin = spinTowards(wrapAngle(push - heading), yawRate);
    let state: ChampionRadioMessage['intent'] = 'APPROACH';

    if (holding) {
      travelField = push;
      speed = 1.0 * this.skill;
      state = 'CARRY';
    } else {
      const intercept = calculateIntercept(meX, meZ, ball);
      const approach = tangentApproach(meX, meZ, intercept.x, intercept.z, push);
      travelField = approach.travel;
      const hesitant = approachHesitation(me.confidence);
      speed =
        ((approach.aligned ? 1.0 : clamp(1.15 - Math.abs(approach.swing) * 0.35, 0.6, 1.0)) * this.skill) *
        hesitant;
      state = approach.aligned ? 'APPROACH' : 'INTERCEPT';
    }

    // 8. Edge Safety Force Field
    travelField = steerClearOfEdges(
      travelField,
      meX,
      meZ,
      holding ? 190.0 : 160.0,
      holding ? BALL_STOP_X : EDGE_STOP_X,
      holding ? BALL_STOP_Z : EDGE_STOP_Z,
      holding ? CONTACT_RANGE : 0.0,
      heading,
      GOAL_LINE,
    );

    // 9. Model-Based Finishing
    //
    // The decision to shoot is a score, not a pile of cutoffs. Distance, the
    // lane in front, the goal mouth on the camera and the freshness of the
    // estimate multiply together (see `evaluateShot`), and one knob decides
    // when the lot of them smell good enough to fire.
    const blocker = obstacleRange(frame, heading, meX, meZ);
    const shot = evaluateShot({ ball, heading, goalLine: GOAL_LINE, blobs: attackingBlobs, blocker });
    let kick = holding && shot.score >= KICK_SCORE_MIN;
    let dribbler = kick ? 0.0 : 1.0;

    // 10. Blocked Lane Obstacle Avoidance (Dribble Round)
    if (holding && !kick) {
      if (shot.reach !== null && shot.nearBlock) {
        // Choose the side of the obstacle that the camera says opens the goal
        // mouth, rather than a fixed hinge: a keeper camped on one post makes
        // the wider gap the other way, and carrying round the near side into
        // their body sells the ball.
        let side = meZ > 0 ? -1.0 : 1.0;
        const gap = widestOpening(attackingBlobs);
        if (gap && gap.width > BALL_RADIUS * 3) {
          side = Math.sign(gap.bearing);
        }
        travelField = wrapAngle(push + side * 1.15);
        travelField = steerClearOfEdges(
          travelField,
          meX,
          meZ,
          190.0,
          BALL_STOP_X,
          BALL_STOP_Z,
          CONTACT_RANGE,
          heading,
          GOAL_LINE,
        );
        speed = 0.9 * this.skill;
        state = 'DRIBBLE_ROUND';
      }
    }

    // 11. Anti-Stall / Scrum Breakout
    this.updateTracking(frame.clock, meX, meZ);
    const isStalled = this.checkStall(effort.value);
    if (isStalled) {
      this.breakoutTicks = 16;
      this.breakoutSide = -this.breakoutSide;
    }

    if (this.breakoutTicks > 0) {
      this.breakoutTicks--;
      state = 'BREAKOUT';
      if (holding) {
        spin = spinTowards(wrapAngle(push - heading + this.breakoutSide * 0.8), yawRate);
        speed = 0.5 * this.skill;
      } else {
        travelField = wrapAngle(push + this.breakoutSide * (Math.PI / 2));
        speed = 1.0 * this.skill;
      }
    }

    const rangeToBall = Math.hypot(bx - meX, bz - meZ);
    return {
      motors: mixOmni(this.drive, wrapAngle(travelField - heading), speed, spin),
      dribbler,
      kicker: kick,
      say: this.broadcast(state, meX, meZ, holding, ball, rangeToBall),
    };
  }

  // ----------------------------------------------------------------- goalie

  private goalDecide(
    frame: SensorFrame,
    me: FramedPose,
    ball: FramedBall,
    heading: number,
    yawRate: number,
    _effort: WheelEffort,
    mateMsg: ChampionRadioMessage | null,
    holding: boolean,
  ): ActuatorFrame {
    const p = this.params;
    const meX = me.x;
    const meZ = me.z;
    const guardX = OWN_LINE + p.guardDist;
    // Squared up means facing the goal being attacked, which is 0 in this
    // frame in both halves - the whole reason the frame exists.
    const squareSpin = spinTowards(wrapAngle(-heading), yawRate);

    // 1. Kickoff Stance
    if (frame.kickoff.pending) {
      return this.hold(meX, meZ, guardX, 0, squareSpin, heading, 'KICKOFF', me.confidence);
    }

    // 2. Out of Bounds Recovery (Rule 5.7.1.6)
    if (Math.abs(meX) > HALF_LENGTH + 25 || Math.abs(meZ) > HALF_WIDTH + 25) {
      const [homeX, homeZ] = backInside(meX, meZ, 170.0);
      const travel = wrapAngle(Math.atan2(homeZ - meZ, homeX - meX) - heading);
      return {
        motors: mixOmni(this.drive, travel, 1.0 * this.skill, 0),
        dribbler: 0,
        say: this.broadcast('RECOVER', meX, meZ, holding, ball),
      };
    }

    // 3. Shoved onto the Goal Line Recovery (Rule 5.7.1.2 Goal Area Avoidance)
    const depthFromGoalLine = meX - OWN_LINE;
    if (depthFromGoalLine < p.depthDist) {
      const awayTravel = steerClearOfEdges(
        Math.atan2(-meZ * 0.3, guardX - meX),
        meX,
        meZ,
        210.0,
        p.leashX,
        p.leashZ,
      );
      return {
        motors: mixOmni(this.drive, wrapAngle(awayTravel - heading), 1.0 * this.skill, squareSpin),
        dribbler: 1,
        say: this.broadcast('OFF_THE_LINE', meX, meZ, holding, ball),
      };
    }

    // 4. Lost Ball Fallback
    if (!ball.seen) {
      if (mateMsg && mateMsg.ball) {
        const [, toldZ] = mateMsg.ball;
        const targetZ = clamp(toldZ * 0.7, -p.postClamp, p.postClamp);
        return this.hold(meX, meZ, guardX, targetZ, squareSpin, heading, 'GUARD', me.confidence);
      }
      return this.hold(meX, meZ, guardX, 0, squareSpin, heading, 'GUARD', me.confidence);
    }

    const bx = ball.x;
    const bz = ball.z;
    const depth = bx - OWN_LINE;
    const inBox = depth < PENALTY_DEPTH + 60 && Math.abs(bz) < PENALTY_WIDTH / 2 + 40;

    // 5. Holding Ball: Set-Piece Passing & Tactical Clearance
    if (holding) {
      const outlet = mateMsg?.pos;
      let passing =
        Boolean(outlet) && outlet![0] - meX > 250.0 && mateMsg?.role === 'striker';

      const mateReady = Boolean(mateMsg?.ready);
      this.passWait = passing ? this.passWait + 1 : 0;
      if (passing && !mateReady && this.passWait > p.passPatience) {
        passing = false; // Striker took too long, fallback to wing clearance
      }

      let aim: number;
      let safe: boolean;
      let state: ChampionRadioMessage['intent'];

      if (passing && outlet) {
        aim = Math.atan2(outlet[1] - meZ, outlet[0] - meX);
        const blocker = obstacleRange(frame, heading, meX, meZ);
        safe = passIsOpen(heading, meX, meZ, outlet[0], outlet[1], blocker) && mateReady;
        state = 'PASS';
      } else {
        // Clearance to uncrowded wing
        const wing = -Math.sign(Math.abs(meZ) > 40 ? meZ : 1) * (HALF_WIDTH * 0.62);
        const clearX = OWN_LINE + HALF_LENGTH * 0.55;
        aim = Math.atan2(wing - meZ, clearX - meX);
        const blocker = obstacleRange(frame, heading, meX, meZ);
        const aimError = Math.abs(wrapAngle(aim - heading));
        safe = (blocker === null || blocker > 380.0) && aimError < 0.25;
        state = 'CLEAR';
      }

      const spin = spinTowards(wrapAngle(aim - heading), yawRate);
      // Drift back towards guard line while turning
      const homeZ = clamp(meZ, -p.postClamp, p.postClamp);
      const gap = Math.hypot(guardX - meX, homeZ - meZ);
      const travel = steerClearOfEdges(
        Math.atan2(homeZ - meZ, guardX - meX),
        meX,
        meZ,
        210.0,
        p.leashX,
        p.leashZ,
        CONTACT_RANGE,
        heading,
        GOAL_LINE,
      );

      return {
        motors: mixOmni(
          this.drive,
          wrapAngle(travel - heading),
          clamp(gap / 200.0, 0.0, 0.5) * this.skill,
          spin,
        ),
        dribbler: safe ? 0.0 : 1.0,
        kicker: safe,
        say: this.broadcast(state, meX, meZ, true, ball),
      };
    }

    // 6. Loose Ball in Box Smother (Rule 5.8.2 / 5.8.3 Forward Motion Requirement)
    //
    // Deliberately narrow: only go get a ball that is already on the goal
    // mouth. Charging a slower ball that is merely reachable in the box used to
    // commit the keeper away from the line, and an attacker dribbling it could
    // then push it past the stranded keeper — a poke-through goal that just
    // gets scored into the net the keeper has left.
    const distToBall = Math.hypot(bx - meX, bz - meZ);
    const reachable = distToBall < 520.0;
    if (inBox && reachable && depth < 150 && !estimateStale(ball)) {
      const chaseX = OWN_LINE + clamp(depth, 0.0, PENALTY_DEPTH);
      const chaseZ = clamp(bz, -420.0, 420.0);
      const travel = steerClearOfEdges(
        Math.atan2(chaseZ - meZ, chaseX - meX),
        meX,
        meZ,
        210.0,
        p.leashX,
        p.leashZ,
      );

      return {
        motors: mixOmni(this.drive, wrapAngle(travel - heading), 1.0 * this.skill, squareSpin),
        dribbler: 1,
        // Crucial: broadcast offLine: true so the striker immediately covers the net!
        say: this.broadcast('SMOTHER', meX, meZ, false, ball, distToBall, undefined, true),
      };
    }

    // 7. Shot Trajectory Interception & Goal Line Tracking
    const targetZ = this.calculateTargetZ(ball, guardX);
    const step = clamp((1.0 - Math.abs(targetZ) / p.postClamp) * 70.0, 0.0, 70.0);
    const targetX = OWN_LINE + (p.guardDist + step);
    const intent: ChampionRadioMessage['intent'] = 'GUARD';
    return this.hold(meX, meZ, targetX, targetZ, squareSpin, heading, intent, me.confidence, ball, distToBall);
  }

  private calculateTargetZ(ball: FramedBall, guardX: number): number {
    if (ball.speed() > 220.0 && !estimateStale(ball)) {
      // Closing speed towards defending goal line
      const closing = -ball.vx;
      if (closing > 60.0) {
        const timeToLine = (ball.x - guardX) / closing;
        const [, futureZ] = ball.predict(clamp(timeToLine, 0.0, 1.4));
        return clamp(futureZ, -this.params.postClamp, this.params.postClamp);
      }
    }

    // Slow ball: shadow on line between ball and goal mouth center
    const span = OWN_LINE - ball.x;
    if (Math.abs(span) < 1.0) {
      return clamp(ball.z, -this.params.postClamp, this.params.postClamp);
    }
    const guardProj = guardX - ball.x;
    const shadow = ball.z + (guardProj / span) * -ball.z;
    return clamp(shadow, -this.params.postClamp, this.params.postClamp);
  }

  private hold(
    meX: number,
    meZ: number,
    targetX: number,
    targetZ: number,
    spin: number,
    heading: number,
    intent: ChampionRadioMessage['intent'],
    _confidence: number,
    ball?: FramedBall,
    claimDist?: number,
  ): ActuatorFrame {
    const p = this.params;
    const dx = targetX - meX;
    const dz = targetZ - meZ;
    const gap = Math.hypot(dx, dz);
    const msg = this.broadcast(intent, meX, meZ, false, ball, claimDist, false);

    if (gap < 18.0) {
      return {
        motors: mixOmni(this.drive, 0, 0, spin),
        dribbler: 0,
        say: msg,
      };
    }

    const travel = steerClearOfEdges(Math.atan2(dz, dx), meX, meZ, 210.0, p.leashX, p.leashZ);
    const speed = clamp(gap / 90.0, 0.3, 1.0) * this.skill;

    return {
      motors: mixOmni(this.drive, wrapAngle(travel - heading), speed, spin),
      dribbler: 0,
      say: msg,
    };
  }

  // ---------------------------------------------------------------- shared

  /**
   * Whether this striker should stop attacking and guard the goal.
   *
   * A partner taken off the field under 5.7 stops being polled, and a robot
   * that is not polled does not broadcast, so the keeper's radio going silent
   * -- for a good while, with the ball meanwhile in our own half -- is the
   * only teammate signal the rules leave a robot. The fold waits for
   * sustained silence rather than one missed frame, so a restarted kick-off
   * or a broadcast that slipped past 0.45 s of age does not drag the striker
   * off the ball for no reason. A striker who has never once heard its keeper
   * also waits: the keepers are on the wire from the first tick, so silence
   * from the very start means "not yet", not "gone".
   *
   * It is also the one decision the symmetry test must leave unreachable:
   * champion-vs-champion, no robot is ever off the field long enough for the
   * window to close, so the folded branch never fires in a recording.
   */
  private foldedRole(
    frame: SensorFrame,
    ball: FramedBall,
    mateMsg: ChampionRadioMessage | null,
  ): ChampionRole {
    if (this.params.role !== 'striker') return 'goalie';
    if (mateMsg) {
      this.silentTicks = 0;
      return 'striker';
    }
    if (frame.kickoff.pending) {
      this.silentTicks = 0;
      return 'striker';
    }
    // Count up only while the ball is seen in our half, so a striker in the
    // middle of an attack is not recalled by a keeper that is momentarily out
    // of sight behind the play.
    if (!ball.seen || ball.x >= 0) {
      this.silentTicks = 0;
      return 'striker';
    }
    this.silentTicks += 1;
    if (this.silentTicks >= 40) return 'goalie'; // 0.8 s and counting
    return 'striker';
  }

  private updateTracking(clock: number, x: number, z: number): void {
    this.track.push({ clock, x, z });
    while (this.track.length > 0 && clock - this.track[0]!.clock > 0.45) {
      this.track.shift();
    }
  }

  private checkStall(effortVal: number): boolean {
    if (this.track.length < 8) return false;
    const moved = Math.hypot(
      this.track[this.track.length - 1]!.x - this.track[0]!.x,
      this.track[this.track.length - 1]!.z - this.track[0]!.z,
    );
    const trying = effortVal > 180.0;
    const stalled = moved < 22.0 && trying;
    if (stalled) {
      this.stallCount++;
      return this.stallCount >= 8;
    }
    this.stallCount = Math.max(0, this.stallCount - 1);
    return false;
  }

  private broadcast(
    intent: ChampionRadioMessage['intent'],
    x: number,
    z: number,
    held: boolean,
    ball?: FramedBall,
    claim?: number,
    ready?: boolean,
    offLine = false,
  ): ChampionRadioMessage {
    return {
      role: this.params.role as ChampionRadioMessage['role'],
      pos: [Math.round(x), Math.round(z)],
      ball: ball && ball.seen ? [Math.round(ball.x), Math.round(ball.z)] : undefined,
      confidence: 1.0,
      held,
      intent,
      claim: claim !== undefined ? Math.round(claim) : undefined,
      ready,
      offLine,
    };
  }
}