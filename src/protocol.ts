/**
 * The wire contract between a robot program and the match server.
 *
 * This file is the whole agreement. A program receives a SensorFrame and
 * returns an ActuatorFrame; there is nothing else it can see and nothing else
 * it can do. Everything here is plain JSON — no classes, no methods, nothing
 * that only survives inside one process — because the same frames have to cross
 * a socket to a Python program and be readable by a student who opens the
 * network tab to find out what their robot was told.
 *
 * Angles are radians in the ROBOT frame unless a field says otherwise: 0 is
 * straight ahead, positive turns towards the robot's left. Distances are
 * millimetres. Both match the rulebook's own units.
 */

/** Protocol version. Bumped when a frame changes shape; the server refuses a mismatch. */
export const PROTOCOL_VERSION = 1;

/** What the infrared ring can see of the ball. Null when nothing is detected. */
export interface BallReading {
  /** Bearing to the ball, quantised to the ring's sectors. */
  bearing: number;
  /**
   * Signal strength, 0..1, falling off with the square of distance. Useful as
   * a rough range and useless as a precise one, which is true of the real thing.
   */
  strength: number;
}

/** Heading from the compass, in FIELD radians: 0 faces the yellow goal. */
export interface CompassReading {
  heading: number;
}

/**
 * One downward-facing reflectance sensor. Rule 2.1.1 puts 50 mm white lines
 * around the playing area and 25 mm black markings inside it, so a robot has
 * three surfaces to tell apart.
 */
export type Surface = 'carpet' | 'line' | 'marking';

export interface LineReading {
  /** Where this sensor sits on the chassis, robot-frame radians. */
  bearing: number;
  surface: Surface;
  /** Raw reflectance 0..1, for teams that would rather threshold it themselves. */
  value: number;
}

export interface RangeReading {
  /** Distance to whatever the cone found, mm. Null when nothing came back. */
  front: number | null;
  back: number | null;
  left: number | null;
  right: number | null;
}

/** One object the camera has resolved this frame. */
export interface Sighting {
  bearing: number;
  /** Estimated range, mm. Cameras estimate range badly; this one does too. */
  range: number;
}

export interface CameraReading {
  /** Null when the goal is outside the field of view or was not resolved. */
  goals: { cyan: Sighting | null; yellow: Sighting | null };
  /** Open League's passive orange ball, when the camera can pick it out. */
  ball: Sighting | null;
  /** True only on the frames the camera actually updated. */
  fresh: boolean;
}

export interface BallGateReading {
  /** Whether the dribbler currently has the ball against it. */
  held: boolean;
}

/** A message from the other robot on the team (rule 4.2.5). */
export interface TeamMessage {
  from: number;
  /** Whatever the sending program put in it, as JSON. */
  body: unknown;
  /** Seconds since it was sent. Packets older than the link's memory are dropped. */
  age: number;
}

/**
 * The restart the referee is part way through, if any.
 *
 * Rule 5.4.7 requires the kicking-off robot to strike the ball at least 50 mm
 * clear rather than carrying it away, so a robot has to know a kick-off is in
 * progress to play one legally. A real team is told by the referee; so is this
 * one. Leaving it out was not a simplification, it was withholding something
 * the rules assume the robot knows - and every agent written against the first
 * version of this protocol committed an illegal kick-off at every restart.
 */
export interface KickoffReading {
  /** A kick-off is under way and 5.4.7 is live. */
  pending: boolean;
  /** Whether it is ours to take. */
  ours: boolean;
}

export interface SensorFrame {
  /** Seconds since the match started. */
  clock: number;
  /** Which robot this is, 1 or 2. */
  robot: number;
  /** 'cyan' or 'yellow'. Your goal is the one with your name on it. */
  team: string;
  /** True when the referee has the game running; false at a kick-off or stoppage. */
  playing: boolean;
  kickoff: KickoffReading;

  ball: BallReading | null;
  compass: CompassReading;
  lines: LineReading[];
  range: RangeReading;
  /** Accumulated wheel rotation per motor, radians. Drifts, by design. */
  encoders: number[];
  camera: CameraReading;
  ballGate: BallGateReading;
  messages: TeamMessage[];
}

export interface ActuatorFrame {
  /** One power per motor, −1..1. Anything else is clamped. */
  motors: number[];
  /** Dribbler roller speed, 0..1. */
  dribbler?: number;
  /** Fire the kicker. Ignored while it is still charging. */
  kicker?: boolean;
  /** Broadcast to the other robot on the team. Kept small by the link. */
  say?: unknown;
}

/** A robot that returns nothing, or crashes, coasts on its last command. */
export const COAST: ActuatorFrame = { motors: [0, 0, 0, 0] };
