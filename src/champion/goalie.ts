/**
 * Championship Goalkeeper Agent Behavior Tree & State Machine.
 */

import { mixOmni, wrapAngle, type DriveSpec } from '../drive';
import {
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_DEPTH,
  PENALTY_WIDTH,
} from '../field';
import type { ActuatorFrame, SensorFrame } from '../protocol';
import {
  CONTACT_RANGE,
  type ChampionRadioMessage,
  type FramedBall,
  type FramedPose,
} from './types';
import type { WheelEffort } from './estimator';
import {
  backInside,
  obstacleRange,
  passIsOpen,
  spinTowards,
  steerClearOfEdges,
} from './geometry';

/**
 * In attack-relative coordinates the goal this keeper defends is always here,
 * in both halves. See `src/frame.ts`.
 */
const OWN_LINE = -HALF_LENGTH;
/** And the one it is clearing towards is always this one. */
const GOAL_LINE = HALF_LENGTH;

const GUARD_DIST = 175.0;
const POST_CLAMP = 180.0;
const DEPTH_DIST = 120.0;
const PASS_PATIENCE = 75; // ~1.5s at 50 Hz
const LEASH_Z = 430.0;
const LEASH_X = HALF_LENGTH - 40.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class ChampionGoalie {
  private passWait = 0;

  constructor(
    private readonly drive: DriveSpec,
    private readonly skill = 1.0,
  ) {}

  reset(): void {
    this.passWait = 0;
  }

  decide(
    frame: SensorFrame,
    me: FramedPose,
    ball: FramedBall,
    heading: number,
    yawRate: number,
    _effort: WheelEffort,
    mateMsg: ChampionRadioMessage | null,
  ): ActuatorFrame {
    if (!frame.playing) return { motors: [0, 0, 0, 0] };
    if (frame.kickoff.countdown > 0) return { motors: [0, 0, 0, 0] };

    const holding = Boolean(frame.ballGate?.held);

    const meX = me.x;
    const meZ = me.z;
    const guardX = OWN_LINE + GUARD_DIST;
    // Squared up means facing the goal being attacked, which is 0 in this
    // frame in both halves - the whole reason the frame exists.
    const squareSpin = spinTowards(wrapAngle(-heading), yawRate);

    // 1. Kickoff Stance
    if (frame.kickoff.pending) {
      return this.hold(
        meX,
        meZ,
        guardX,
        0,
        squareSpin,
        heading,
        'KICKOFF',
        me.confidence,
      );
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
    if (depthFromGoalLine < DEPTH_DIST) {
      const awayTravel = steerClearOfEdges(
        Math.atan2(-meZ * 0.3, guardX - meX),
        meX,
        meZ,
        210.0,
        LEASH_X,
        LEASH_Z,
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
        const targetZ = clamp(toldZ * 0.7, -POST_CLAMP, POST_CLAMP);
        return this.hold(
          meX,
          meZ,
          guardX,
          targetZ,
          squareSpin,
          heading,
          'GUARD',
          me.confidence,
        );
      }
      return this.hold(
        meX,
        meZ,
        guardX,
        0,
        squareSpin,
        heading,
        'GUARD',
        me.confidence,
      );
    }

    const bx = ball.x;
    const bz = ball.z;
    const depth = bx - OWN_LINE;
    const inBox = depth < PENALTY_DEPTH + 60 && Math.abs(bz) < PENALTY_WIDTH / 2 + 40;

    // 5. Holding Ball: Set-Piece Passing & Tactical Clearance
    if (holding) {
      const outlet = mateMsg?.pos;
      let passing =
        Boolean(outlet) &&
        outlet![0] - meX > 250.0 &&
        mateMsg?.role === 'striker';

      const mateReady = Boolean(mateMsg?.ready);
      this.passWait = passing ? this.passWait + 1 : 0;
      if (passing && !mateReady && this.passWait > PASS_PATIENCE) {
        passing = false; // Striker took too long, fallback to wing clearance
      }

      let aim: number;
      let safe: boolean;
      let state: ChampionRadioMessage['intent'];

      if (passing && outlet) {
        aim = Math.atan2(outlet[1] - meZ, outlet[0] - meX);
        const blocker = obstacleRange(frame, heading, meX, meZ);
        safe = passIsOpen(heading, meX, meZ, outlet[0], outlet[1], blocker) && mateReady;
        state = safe ? 'PASS' : 'PASS';
      } else {
        // Clearance to uncrowded wing
        const wing = -Math.sign(Math.abs(meZ) > 40 ? meZ : 1) * (HALF_WIDTH * 0.62);
        const clearX = OWN_LINE + (HALF_LENGTH * 0.55);
        aim = Math.atan2(wing - meZ, clearX - meX);
        const blocker = obstacleRange(frame, heading, meX, meZ);
        const aimError = Math.abs(wrapAngle(aim - heading));
        safe = (blocker === null || blocker > 380.0) && aimError < 0.25;
        state = safe ? 'CLEAR' : 'CLEAR';
      }

      const spin = spinTowards(wrapAngle(aim - heading), yawRate);
      // Drift back towards guard line while turning
      const homeZ = clamp(meZ, -POST_CLAMP, POST_CLAMP);
      const gap = Math.hypot(guardX - meX, homeZ - meZ);
      const travel = steerClearOfEdges(
        Math.atan2(homeZ - meZ, guardX - meX),
        meX,
        meZ,
        210.0,
        LEASH_X,
        LEASH_Z,
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
    if (inBox && reachable && depth < 150) {
      const chaseX = OWN_LINE + clamp(depth, 0.0, PENALTY_DEPTH);
      const chaseZ = clamp(bz, -420.0, 420.0);
      const travel = steerClearOfEdges(
        Math.atan2(chaseZ - meZ, chaseX - meX),
        meX,
        meZ,
        210.0,
        LEASH_X,
        LEASH_Z,
      );

      return {
        motors: mixOmni(this.drive, wrapAngle(travel - heading), 1.0 * this.skill, squareSpin),
        dribbler: 1,
        // Crucial: broadcast offLine: true so the striker immediately covers the net!
        say: this.broadcast('SMOTHER', meX, meZ, false, ball, distToBall, true),
      };
    }

    // 7. Shot Trajectory Interception & Goal Line Tracking
    const targetZ = this.calculateTargetZ(ball, guardX);
    const step = clamp((1.0 - Math.abs(targetZ) / POST_CLAMP) * 70.0, 0.0, 70.0);
    const targetX = OWN_LINE + (GUARD_DIST + step);

    const intent = ball.speed() < 350 ? 'GUARD' : 'GUARD';
    return this.hold(
      meX,
      meZ,
      targetX,
      targetZ,
      squareSpin,
      heading,
      intent,
      me.confidence,
      ball,
      distToBall,
    );
  }

  private calculateTargetZ(ball: FramedBall, guardX: number): number {
    if (ball.speed() > 220.0) {
      // Closing speed towards defending goal line
      const closing = -ball.vx;
      if (closing > 60.0) {
        const timeToLine = (ball.x - guardX) / closing;
        const [, futureZ] = ball.predict(clamp(timeToLine, 0.0, 1.4));
        return clamp(futureZ, -POST_CLAMP, POST_CLAMP);
      }
    }

    // Slow ball: shadow on line between ball and goal mouth center
    const span = OWN_LINE - ball.x;
    if (Math.abs(span) < 1.0) {
      return clamp(ball.z, -POST_CLAMP, POST_CLAMP);
    }
    const guardProj = guardX - ball.x;
    const shadow = ball.z + (guardProj / span) * -ball.z;
    return clamp(shadow, -POST_CLAMP, POST_CLAMP);
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

    const travel = steerClearOfEdges(Math.atan2(dz, dx), meX, meZ, 210.0, LEASH_X, LEASH_Z);
    const speed = clamp(gap / 90.0, 0.3, 1.0) * this.skill;

    return {
      motors: mixOmni(this.drive, wrapAngle(travel - heading), speed, spin),
      dribbler: 0,
      say: msg,
    };
  }

  private broadcast(
    intent: ChampionRadioMessage['intent'],
    x: number,
    z: number,
    held: boolean,
    ball?: FramedBall,
    claim?: number,
    offLine = false,
  ): ChampionRadioMessage {
    return {
      role: 'goalie',
      pos: [Math.round(x), Math.round(z)],
      ball: ball && ball.seen ? [Math.round(ball.x), Math.round(ball.z)] : undefined,
      confidence: 1.0,
      held,
      intent,
      claim: claim !== undefined ? Math.round(claim) : undefined,
      offLine,
    };
  }
}
