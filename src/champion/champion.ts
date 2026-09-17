/**
 * Champion Soccer Agent.
 *
 * Implements the full 5-pillar autonomous soccer agent with strict rotational symmetry,
 * robust sensor fusion, and multi-agent radio coordination.
 */

import { openDrive, type DriveSpec } from '../drive';
import { GoalFrame } from '../frame';
import type { Agent } from '../agent';
import type { ActuatorFrame, SensorFrame, TeamMessage } from '../protocol';
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
import { ChampionStriker } from './striker';
import { ChampionGoalie } from './goalie';

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

  private readonly striker: ChampionStriker;
  private readonly goalie: ChampionGoalie;

  private restarted = false;

  constructor(opts: ChampionOptions) {
    this.drive = opts.drive ?? openDrive();
    this.role = opts.role ?? (opts.number === 2 ? 'goalie' : 'striker');
    this.skill = opts.skill ?? 1.0;
    this.name = opts.name ?? `champion-${opts.team}${opts.number}-${this.role}`;

    this.striker = new ChampionStriker(this.drive, this.skill);
    this.goalie = new ChampionGoalie(this.drive, this.skill);
  }

  reset(): void {
    this.locator.reset();
    this.ballEst.reset();
    this.compassBias.reset();
    this.yawEst.reset();
    this.effort.reset();
    this.striker.reset();
    this.goalie.reset();
    this.goalFrame.reset();
    this.restarted = false;
  }

  tick(frame: SensorFrame): ActuatorFrame {
    // 1. Kickoff & Teleportation Resets
    if (frame.returned) {
      this.reset();
    }

    if (frame.kickoff?.pending && !this.restarted) {
      this.restarted = true;
      this.ballEst.reset();
      this.yawEst.reset();
      this.effort.reset();
    } else if (!frame.kickoff?.pending) {
      this.restarted = false;
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
    if (this.role === 'goalie') {
      return this.goalie.decide(
        frame,
        pose,
        ball,
        framedHeading,
        yawRate,
        this.effort,
        mateMsg,
      );
    }
    return this.striker.decide(
      frame,
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
