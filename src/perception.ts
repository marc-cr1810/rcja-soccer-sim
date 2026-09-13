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
import type { KickoffReading, SensorFrame, TeamMessage } from './protocol';

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
  /** Which team, if any, has a kick-off to take. */
  kickoff: { pending: boolean; team: string | null };
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
  constructor(seed: number, motorCount: number, idealSensors = false) {
    this.ir = new Noise(seed ^ Stream.Ir);
    this.compassNoise = new Noise(seed ^ Stream.Compass);
    this.lineNoise = new Noise(seed ^ Stream.Lines);
    this.rangeNoise = new Noise(seed ^ Stream.Range);
    this.cameraNoise = new Noise(seed ^ Stream.Camera);
    this.gyroNoise = new Noise(seed ^ Stream.Gyro);
    // The camera owns its blob stream, kept apart from `cameraNoise` so that
    // adding the blobs did not shift the sightings that were already there.
    this.camera = new CameraState(seed);
    this.encoders = new EncoderState(motorCount);
    this.idealSensors = idealSensors;
  }

  read(input: SenseInput): SensorFrame {
    const { view, self, wheelSpeeds, omega, held, messages, attackDirection, dt } = input;
    const ideal = this.idealSensors;

    this.compass.step(dt, this.compassNoise, ideal);
    this.encoders.step(wheelSpeeds, dt);
    this.gyro.step(dt, this.gyroNoise, ideal);
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
      kickoff: {
        pending: view.kickoff.pending,
        ours: view.kickoff.pending && view.kickoff.team === self.team,
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
