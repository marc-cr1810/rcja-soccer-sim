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
export const PROTOCOL_VERSION = 6;

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
 * Angular velocity from the gyroscope, radians/second. Positive turns the
 * same way a positive heading change does - towards the robot's left.
 *
 * A direct rate measurement, not an angle: it does not drift the way a
 * heading does, because nothing is ever integrated on the sensor itself.
 * It still has a bias that wanders (see `GyroState` in sensors.ts), and that
 * bias only costs a program anything once the program integrates the rate
 * into a heading of its own - which is a worse bet than it looks.
 */
export interface GyroReading {
  rate: number;
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

/**
 * One unbroken patch of goal colour, the way a blob detector reports it.
 *
 * A Pixy or an OpenMV does not hand a team a target, it hands them blobs, and
 * this is the same thing in the one dimension an omnidirectional camera has:
 * an arc of the horizon that came back the colour of a goal. Anything standing
 * in front of the goal is not that colour, so it cuts the arc — which is why a
 * goal with a keeper in the middle of it arrives here as TWO blobs with a gap
 * between them, and a goal with nothing in front of it arrives as one.
 *
 * Nothing decides for the program what any of that means. Where the opening
 * is, whether it is wide enough to shoot through, whether a narrow blob is a
 * post or a keeper's elbow — all of it is the program's to work out, because
 * on real hardware all of it is the team's to work out.
 *
 * `start` is wrapped to −π..π and `end` is always `start` plus the width, so
 * `end` can exceed π rather than wrapping behind it. That way the two things a
 * program actually wants are subtraction:
 *
 *     width  = blob.end - blob.start
 *     centre = wrapAngle((blob.start + blob.end) / 2)
 *
 * They are `start`/`end` rather than the more natural `from`/`to` because
 * `from` is a reserved word in Python, and half the programs that read this
 * protocol are Python. `blob.from` is not an expression a team can write.
 */
export interface Blob {
  /** The edge at the lower bearing, robot-frame radians, −π..π. */
  start: number;
  /** The other edge. Always greater than `start`; may exceed π. */
  end: number;
  /**
   * How tall the patch looks, radians.
   *
   * The honest way to get a range out of a blob. A goal seen from the side is
   * foreshortened across its width but not up its height, so the crossbar
   * subtends `CROSSBAR_HEIGHT / range` from anywhere — and a blob that a robot
   * has cut in half is narrower than the goal but no shorter. Range off the
   * width of a blob is wrong twice over; range off its height is
   *
   *     range ≈ 140 / blob.height
   */
  height: number;
}

export interface CameraReading {
  /** Null when the goal is outside the field of view or was not resolved. */
  goals: { cyan: Sighting | null; yellow: Sighting | null };
  /**
   * The same two goals as raw colour blobs, occluded by whatever is standing
   * in front of them. Empty when the goal is completely hidden.
   *
   * `goals` above is a convenience laid over this: one bearing, one range, the
   * whole mouth treated as a point. It is the easier reading and it is the one
   * that cannot answer "is there a gap", because a point has no width to lose.
   */
  goalBlobs: { cyan: Blob[]; yellow: Blob[] };
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
 * Everything in a frame is something a robot on a real field could know.
 *
 * Nothing the referee knows is in here: not the match clock, not the score,
 * not whether a kick-off is still live under 5.4.7, not whose kick-off it is.
 * A real robot learns about a restart the way a real team tells it - somebody
 * puts it down where the kick-off wants it and presses start - so that is all
 * this says: a button (`start`), the switches a person sets before a half
 * (`team`, `robot`, `attackDirection`), the robot's own clock (`time`), and its
 * sensors. Whose kick-off it is is where you were put; how long 5.4.7 lasts is
 * the rulebook's three seconds on your own clock.
 *
 * Versions up to 5 also carried `clock`, `playing`, `returned` and a `kickoff`
 * block straight from the referee. Anything that read them could see what no
 * robot can, and so could anything that reached past a board's pins to the
 * frame underneath; the only way to make that impossible was to stop sending
 * it. `what-a-robot-knows.test.ts` pins the field list so it cannot creep back.
 */
export interface SensorFrame {
  /**
   * The robot's own clock, seconds since it was switched on for this match.
   *
   * A board's `millis()`, not match time: it keeps running through stoppages,
   * because the robot does not stop existing when the referee blows a whistle.
   */
  time: number;
  /** Which robot this is, 1 or 2. */
  robot: number;
  /**
   * 'violet' or 'lime' — the colour of your robot. Your identity, your radio
   * channel, your name on the scoreboard - but NOT which goal to shoot at.
   * The goals are painted cyan and yellow and stay where they are; rule
   * 1.4/5.4 swaps which end each team defends at half-time, so the goal your
   * team defends is only fixed until the whistle. Use `attackDirection` for
   * where to shoot, not this.
   */
  team: string;
  /**
   * Rule 1.4/5.4: which goal this robot is currently attacking, independent
   * of `team`. +1 means the yellow goal (+x); -1 means the cyan goal (-x).
   * Fixed for the current half, and flips at half-time. A switch somebody
   * sets, like `team` and `robot`.
   */
  attackDirection: 1 | -1;
  /**
   * The start button: down while the robot is meant to be playing.
   *
   * A person presses it at the whistle and lets go when play stops, so it is
   * up through a stoppage and through the wait before a kick-off. Its going
   * down is every restart there is - a kick-off, the start of a half, being
   * put back after a removal - and from here they look the same, because on a
   * field they are the same: somebody put the robot down and pressed start.
   */
  start: boolean;

  ball: BallReading | null;
  compass: CompassReading;
  gyro: GyroReading;
  lines: LineReading[];
  range: RangeReading;
  /** Accumulated wheel rotation per motor, radians. Drifts, by design. */
  encoders: number[];
  camera: CameraReading;
  ballGate: BallGateReading;
  messages: TeamMessage[];
}

/**
 * What a robot that is off the field is told, and all it is told.
 *
 * Rule 5.7 takes a damaged robot off for thirty seconds. Until Phase 9 the
 * simulator expressed that as *silence* — the seat was skipped before it was
 * polled — and silence is indistinguishable from a server that has gone away.
 * A program with a ten-second read timeout dropped, and a drop during play is
 * itself a 5.7.1 removal, so one stand-down became an endless one.
 *
 * So being off the field is something the server says, about once a second,
 * for as long as it is true. There are no sensors in it: a robot in a
 * student's hands beside the pitch cannot see, and a control loop has nothing
 * to decide. It is the *stop* half of a start/stop button.
 *
 * Nothing needs a `PROTOCOL_VERSION` bump for this. Every robot already
 * written ignores a message type it does not know — `robot.py`'s loop has
 * always read `if message.get("type") != "sensors": continue` — so an old
 * program simply keeps waiting, which is exactly the behaviour wanted.
 */
export interface DisabledMessage {
  type: 'disabled';
  /** The rule it came off under, e.g. `5.7.1`. */
  rule: string;
  /** Said so a person can read it. */
  reason: string;
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
