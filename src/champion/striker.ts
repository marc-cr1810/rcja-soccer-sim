/**
 * Championship Striker Agent Behavior Tree & State Machine.
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
  shotIsOpen,
  shotRange,
  spinTowards,
  steerBallInside,
  steerClearOfEdges,
  tangentApproach,
  widestOpening,
} from './geometry';

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

const AIM_POST = 155.0;
const POST_SCREEN = 190.0;
const RECEIVE_DEPTH = PENALTY_DEPTH + 520.0;
const RECEIVE_WING = HALF_WIDTH * 0.55;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class ChampionStriker {
  private stallCount = 0;
  private breakoutTicks = 0;
  private breakoutSide = 1.0;
  private track: { clock: number; x: number; z: number }[] = [];

  constructor(
    private readonly drive: DriveSpec,
    private readonly skill = 1.0,
  ) {}

  reset(): void {
    this.stallCount = 0;
    this.breakoutTicks = 0;
    this.breakoutSide = 1.0;
    this.track = [];
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
            : Math.sign(Math.abs(me.z) > 1.0 ? -me.z : 1);
        aim = clamp(Math.atan2(postSide * AIM_POST, GOAL_LINE), -0.5, 0.5);
      }
      if (holding) {
        if (Math.abs(aim) < 0.12) {
          return {
            motors: mixOmni(this.drive, 0, 0, 0),
            dribbler: 1,
            kicker: true,
            say: this.broadcast('KICKOFF', me.x, me.z, holding, ball, 0, false),
          };
        }
        return {
          motors: mixOmni(this.drive, 0, 0, spinTowards(wrapAngle(aim), yawRate)),
          dribbler: 1,
          say: this.broadcast('KICKOFF', me.x, me.z, holding, ball, 0, false),
        };
      }
      // Creep dead-straight with dribbler off until the gate triggers, then fire strike
      return {
        motors: mixOmni(this.drive, 0, 0.18, 0),
        dribbler: 0,
        kicker: true,
        say: this.broadcast('KICKOFF', me.x, me.z, false, ball, 0, false),
      };
    }

    const meX = me.x;
    const meZ = me.z;

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
      const cx = OWN_LINE + RECEIVE_DEPTH;
      const wing = Math.sign(Math.abs(meZ) > 60 ? meZ : 1) * RECEIVE_WING;
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
      aimZ = clamp(postSide * AIM_POST, -HALF_GOAL_WIDTH + 70, HALF_GOAL_WIDTH - 70);

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
      const waitZ = clamp(bz * 0.55, keeperOffLine ? -POST_SCREEN : -300.0, keeperOffLine ? POST_SCREEN : 300.0);
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
      speed = (approach.aligned ? 1.0 : clamp(1.15 - Math.abs(approach.swing) * 0.35, 0.6, 1.0)) * this.skill;
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

    // 9. Raycast Finishing / Shooting Window
    const blocker = obstacleRange(frame, heading, meX, meZ);
    const laneClear = blocker === null || blocker > 430.0;
    const reach = shotRange(bx, bz, heading, GOAL_LINE);
    const closeEnough = reach !== null && reach < (blocker === null ? 1100.0 : 800.0);
    const mouthOpen = shotIsOpen(attackingBlobs);
    const shotOn = reach !== null && laneClear && closeEnough && mouthOpen;
    let kick = holding && shotOn;
    let dribbler = kick ? 0.0 : 1.0;

    // 10. Blocked Lane Obstacle Avoidance (Dribble Round)
    if (holding && !shotOn) {
      if (reach !== null && !laneClear) {
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
  ): ChampionRadioMessage {
    return {
      role: 'striker',
      pos: [Math.round(x), Math.round(z)],
      ball: ball && ball.seen ? [Math.round(ball.x), Math.round(ball.z)] : undefined,
      confidence: 1.0,
      held,
      intent,
      claim: claim !== undefined ? Math.round(claim) : undefined,
      ready,
    };
  }
}
