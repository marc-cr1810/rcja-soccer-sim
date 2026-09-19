/**
 * Assembling one robot's view of the match.
 *
 * This is the only place the world is allowed to become a SensorFrame. Nothing
 * downstream of here gets to look at the world again, which is what makes the
 * boundary real rather than a convention people agree to respect.
 *
 * Deliberately decoupled from the match itself: it asks for a `MatchView`, not
 * a `World`. That keeps every sensor testable against a handful of literals,
 * and it means the rule detectors and the perception layer can be worked on
 * without either one dragging the other along.
 */

import {
  CameraState,
  CompassState,
  EncoderState,
  GyroState,
  Noise,
  readIr,
  readLines,
  readRange,
  type Pose,
} from './sensors';
import { streamSeed, toSeed, type SeedInput } from './rand';
import type { KickoffReading, SensorFrame, TeamMessage } from '../match/protocol';

export interface SensedRobot extends Pose {
  /** Stable id, e.g. 'c1'. */
  id: string;
  team: string;
  /** 1 or 2. */
  number: number;
}

/** Everything perception is allowed to know. */
export interface MatchView {
  clock: number;
  /** False at a kick-off, a stoppage, or before the whistle. */
  playing: boolean;
  ball: { x: number; z: number };
  robots: readonly SensedRobot[];
  /** Which team, if any, has a kick-off under way, and how long until it is live. */
  kickoff: { pending: boolean; team: string | null; countdown: number };
}

export interface SenseInput {
  view: MatchView;
  self: SensedRobot;
  /** Per-motor surface speed from the last drive step, mm/s. */
  wheelSpeeds: readonly number[];
  /** True angular velocity from the last drive step, rad/s. What the gyro measures, before its own error. */
  omega: number;
  /** Whether the dribbler currently holds the ball. */
  held: boolean;
  /** Messages already filtered for age and sender by the radio link. */
  messages: TeamMessage[];
  /** Rule 1.4/5.4: which goal this robot currently attacks. See protocol.ts. */
  attackDirection: 1 | -1;
  dt: number;
  /** True on the one frame after this robot was put back on. See protocol.ts. */
  returned?: boolean;
  /**
   * Whether play is stopped, so the sensors' *error* must not move.
   *
   * A robot on the field during a stoppage is still read — it can see, and the
   * protocol has always had `playing: false` to tell it not to expect to move.
   * But compass drift and gyro bias are random walks stepped on every read, and
   * a robot polled through a five-minute wait for a referee would arrive at
   * kick-off carrying a half's worth of drift. Worse, the match's result would
   * then depend on how long the referee took, and a match has to replay as
   * itself.
   *
   * So the error state is frozen while play is stopped and everything else is
   * not: the camera keeps producing frames of a static scene at its own rate,
   * and the encoders keep reading wheels that are not turning.
   */
  frozen?: boolean;
}

/**
 * Separate noise streams per sensor.
 *
 * If every sensor drew from one stream, adding a sensor would shift the numbers
 * every other sensor sees, and a replay recorded against last season's build
 * would diverge. Deriving a stream per sensor from the match seed keeps each
 * one independent.
 */
const enum Stream {
  Ir = 0x1f,
  Compass = 0x2d,
  Lines = 0x3b,
  Range = 0x47,
  Camera = 0x59,
  Gyro = 0x65,
}

export class Senses {
  private readonly ir: Noise;
  private readonly compassNoise: Noise;
  private readonly lineNoise: Noise;
  private readonly rangeNoise: Noise;
  private readonly cameraNoise: Noise;
  private readonly gyroNoise: Noise;

  private readonly compass = new CompassState();
  private readonly camera: CameraState;
  private readonly encoders: EncoderState;
  private readonly gyro = new GyroState();
  readonly idealSensors: boolean;

  /**
   * @param seed  Match seed mixed with the robot's identity, so the two robots
   *              on a team do not receive identical noise and accidentally look
   *              better coordinated than they are.
   */
  constructor(seed: SeedInput, motorCount: number, idealSensors = false) {
    const s = toSeed(seed);
    this.ir = new Noise(streamSeed(s, Stream.Ir));
    this.compassNoise = new Noise(streamSeed(s, Stream.Compass));
    this.lineNoise = new Noise(streamSeed(s, Stream.Lines));
    this.rangeNoise = new Noise(streamSeed(s, Stream.Range));
    this.cameraNoise = new Noise(streamSeed(s, Stream.Camera));
    this.gyroNoise = new Noise(streamSeed(s, Stream.Gyro));
    // The camera owns its blob stream, kept apart from `cameraNoise` so that
    // adding the blobs did not shift the sightings that were already there.
    this.camera = new CameraState(s);
    this.encoders = new EncoderState(motorCount);
    this.idealSensors = idealSensors;
  }

  read(input: SenseInput): SensorFrame {
    const { view, self, wheelSpeeds, omega, held, messages, attackDirection, dt } = input;
    const ideal = this.idealSensors;
    // See `SenseInput.frozen`: the error walks stop, the rest of the sensors
    // carry on. Nothing about a match may depend on how long it waited.
    const errorDt = input.frozen ? 0 : dt;

    this.compass.step(errorDt, this.compassNoise, ideal);
    this.encoders.step(wheelSpeeds, dt);
    this.gyro.step(errorDt, this.gyroNoise, ideal);
    const fresh = this.camera.step(dt, ideal);

    // Every robot but this one can get in the way of the infrared, including
    // the robot's own team mate — which is the coordination problem in a
    // sentence, and the reason 4.2.5 communication is worth having.
    const blockers = view.robots.filter((r) => r.id !== self.id);

    return {
      clock: view.clock,
      robot: self.number,
      team: self.team,
      attackDirection,
      playing: view.playing,
      returned: input.returned === true,
      kickoff: {
        pending: view.kickoff.pending,
        // The countdown belongs to whoever the restart belongs to: a robot that
        // must not approach the ball until the whistle needs `ours` to say true
        // for the whole wait, not just the live part.
        ours: (view.kickoff.pending || view.kickoff.countdown > 0) && view.kickoff.team === self.team,
        countdown: view.kickoff.countdown,
      } satisfies KickoffReading,
      ball: readIr(self, view.ball, { blockers, ideal }, this.ir),
      compass: { heading: this.compass.read(self.heading, this.compassNoise, ideal) },
      gyro: { rate: this.gyro.read(omega, this.gyroNoise, ideal) },
      lines: readLines(self, this.lineNoise, ideal),
      range: readRange(self, this.rangeNoise, blockers, ideal),
      encoders: this.encoders.read(ideal),
      camera: this.camera.read(self, view.ball, blockers, this.cameraNoise, fresh, ideal),
      ballGate: { held },
      messages,
    };
  }
}

/**
 * The team radio (rule 4.2.5).
 *
 * Messages are held briefly and delivered to the other robot on the team, never
 * to an opponent and never back to the sender. The staleness window matches the
 * lab's: a packet older than this is dropped rather than delivered late, so a
 * program cannot quietly rely on a message from five seconds ago.
 */
const MESSAGE_TTL = 0.4;

export class TeamRadio {
  private queue: { from: number; body: unknown; at: number }[] = [];

  send(from: number, body: unknown, clock: number): void {
    this.queue.push({ from, body, at: clock });
    // A bounded mailbox, so a program that shouts every tick cannot grow one.
    if (this.queue.length > 16) this.queue.shift();
  }

  /** What robot `to` can hear right now. */
  deliver(to: number, clock: number): TeamMessage[] {
    this.queue = this.queue.filter((m) => clock - m.at <= MESSAGE_TTL);
    return this.queue
      .filter((m) => m.from !== to)
      .map((m) => ({ from: m.from, body: m.body, age: clock - m.at }));
  }

  clear(): void {
    this.queue = [];
  }
}
