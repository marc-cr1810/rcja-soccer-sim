/**
 * Champion Soccer Agent.
 *
 * Implements the full 5-pillar autonomous soccer agent with strict rotational symmetry,
 * robust sensor fusion, and multi-agent radio coordination.
 */

import { openDrive, type DriveSpec } from '../sim/drive';
import { GoalFrame } from '../sim/frame';
import type { Agent } from '../match/agent';
import { RestartWatch } from '../match/restart';
import type { ActuatorFrame, SensorFrame, TeamMessage } from '../match/protocol';
import type {
  ChampionOptions,
  ChampionRadioMessage,
  ChampionRole,
  FramedBall,
  FramedPose,
} from './types';
import {
  BallEstimator,
  CompassBias,
  LeastSquaresLocator,
  teleported,
  WheelEffort,
  YawEstimator,
} from './estimator';
import { ChampionBrain, goalieParams, strikerParams } from './brain';

/** Seconds after the button before the ball estimate is trusted to say the kick-off is over. */
const KICKOFF_SETTLE = 0.2;
/** How far off the centre spot, mm, the ball has to be for the kick-off to be over. */
const KICKOFF_BALL_GONE = 200;

export class ChampionAgent implements Agent {
  readonly name: string;
  readonly role: ChampionRole;
  private readonly drive: DriveSpec;
  private readonly skill: number;

  private readonly locator = new LeastSquaresLocator();
  private readonly ballEst = new BallEstimator();
  private readonly compassBias = new CompassBias();
  private readonly yawEst = new YawEstimator();
  private readonly effort = new WheelEffort();
  /**
   * The line between the two halves of this agent.
   *
   * Above it, everything is in the field's own coordinates, because that is
   * where the sensors put it: the goals are painted cyan and yellow, they stay
   * where they are, and the estimator anchors on them. Below it, `+x` is
   * whichever goal this robot is attacking right now, and the second half is
   * the first half again.
   */
  private readonly goalFrame = new GoalFrame();

  private readonly brain: ChampionBrain;

  private readonly restart = new RestartWatch();

  constructor(opts: ChampionOptions) {
    this.drive = opts.drive ?? openDrive();
    this.role = opts.role ?? (opts.number === 2 ? 'goalie' : 'striker');
    this.skill = opts.skill ?? 1.0;
    this.name = opts.name ?? `champion-${opts.team}${opts.number}-${this.role}`;

    const params = {
      role: this.role,
      ...(this.role === 'goalie' ? goalieParams : strikerParams),
    };
    this.brain = new ChampionBrain(this.drive, params, this.skill);
  }

  reset(): void {
    this.locator.reset();
    this.ballEst.reset();
    this.compassBias.reset();
    this.yawEst.reset();
    this.effort.reset();
    this.brain.reset();
    this.goalFrame.reset();
    this.restart.reset();
  }

  tick(frame: SensorFrame): ActuatorFrame {
    // 1. Restart & Teleportation Resets
    //
    // The start button going down is every restart there is - a kick-off, a
    // new half, being put back after a removal - and they look the same from
    // here. Where the robot was put down is what `teleported` below is for.
    this.restart.update(frame);
    if (this.restart.justStarted) {
      this.ballEst.reset();
      this.yawEst.reset();
      this.effort.reset();
    }

    // 2. Heading with Goal-Sightings Calibration
    let heading = frame.compass.heading;
    this.compassBias.update(this.locator.x, this.locator.z, heading, frame);
    heading = this.compassBias.corrected(heading);

    // 3. Robot Position Estimate
    const prevX = this.locator.x;
    const prevZ = this.locator.z;
    const prevConf = this.locator.confidence;
    this.locator.update(frame, heading);

    if (teleported(prevX, prevZ, prevConf, this.locator.x, this.locator.z)) {
      this.ballEst.reset();
      this.yawEst.reset();
      this.effort.reset();
    }

    // 4. Ball Tracking & Kinematics
    this.ballEst.update(frame, heading, this.locator.x, this.locator.z);

    // Nobody announces that a kick-off is over. Every robot on the field can
    // see it, though: the ball leaves the centre spot.
    const since = this.restart.since ?? 0;
    if (this.restart.pending && since > KICKOFF_SETTLE && this.ballEst.seen && Math.hypot(this.ballEst.x, this.ballEst.z) > KICKOFF_BALL_GONE) {
      this.restart.finish();
    }

    // 5. Rates & Effort
    const yawRate = this.yawEst.update(frame);
    this.effort.update(frame);

    // 6. Radio Telemetry from Partner
    //
    // Left in the frame it was sent in. Both robots on a team attack the same
    // goal - `attackDirection` is a property of the team, not of the seat - so
    // the sender's attack-relative coordinates are already the receiver's, and
    // a transform here and back again would only be two chances to get a sign
    // wrong for no gain.
    const mateMsg = this.readTeammate(frame);

    // 7. Into the attacking half of the world model
    this.goalFrame.update(frame);
    const framedHeading = this.goalFrame.heading(heading);
    const [meX, meZ] = this.goalFrame.toFrame(this.locator.x, this.locator.z);
    const pose: FramedPose = { x: meX, z: meZ, confidence: this.locator.confidence };
    const ball = this.framedBall();

    // 8. Role Execution
    //
    // Nothing below this point can tell which end of the field it is playing
    // towards, which is the point: there is no attack direction in scope to
    // multiply by, so there is none to forget. The motor command comes back
    // needing no inverse - `mixOmni` is handed `travel - heading`, and both
    // were shifted by the same angle.
    return this.brain.decide(
      frame,
      { pending: this.restart.pending, ours: this.restart.ours },
      this.goalFrame,
      pose,
      ball,
      framedHeading,
      yawRate,
      this.effort,
      mateMsg,
    );
  }

  /** The ball estimate, rotated into the attacking frame. */
  private framedBall(): FramedBall {
    const gf = this.goalFrame;
    const est = this.ballEst;
    const [x, z] = gf.toFrame(est.x, est.z);
    const [vx, vz] = gf.toFrameVelocity(est.vx, est.vz);
    return {
      x,
      z,
      vx,
      vz,
      seen: est.seen,
      age: est.age,
      speed: () => est.speed(),
      predict: (seconds: number) => gf.toFrame(...est.predict(seconds)),
    };
  }

  private readTeammate(frame: SensorFrame): ChampionRadioMessage | null {
    if (!frame.messages || frame.messages.length === 0) return null;
    let newest: TeamMessage | null = null;
    for (const m of frame.messages) {
      if (!newest || m.age < newest.age) {
        newest = m;
      }
    }
    if (!newest || newest.age > 0.45) return null;

    const body = newest.body as Partial<ChampionRadioMessage>;
    if (!body || typeof body !== 'object') return null;
    return body as ChampionRadioMessage;
  }
}

/**
 * Factory creating a full championship team of two robots (striker + goalie).
 */
export function championTeam(
  team: 'violet' | 'lime',
  skill = 1.0,
): Record<string, ChampionAgent> {
  return {
    [`${team}-1`]: new ChampionAgent({ team, number: 1, role: 'striker', skill }),
    [`${team}-2`]: new ChampionAgent({ team, number: 2, role: 'goalie', skill }),
  };
}
