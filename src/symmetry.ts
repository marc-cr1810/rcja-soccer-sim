/**
 * Asking a robot program whether it plays the same game at both ends.
 *
 * The question is exact, and it does not need a scoreline to answer. Under a
 * 180-degree rotation of the world
 *
 *     x -> -x,   z -> -z,   heading -> heading + PI
 *
 * the field maps onto itself, and every robot-frame reading a sensor produces
 * is carried along with the robot and comes back IDENTICAL. Only two things
 * move, and `tests/symmetry.test.ts` asserts that the simulator holds to it:
 * the compass, by exactly PI, and the two goal sightings, which swap labels
 * because the paint stays where it is.
 *
 * That is what `rotateFrame` does, and why this works on a recording rather
 * than on a running world. Nothing here needs access to the match, the robot
 * poses or the ball: given the frames a program actually received, the frames
 * its mirrored twin would have received are a pure function of them. So the
 * same check runs against a TypeScript agent in this process and against a
 * team's Python program over a socket, and asks both the same question.
 *
 * Why not just count goals. Asked of a scoreline this needs tens of matches,
 * takes half an hour and still comes back ambiguous: goals inside one match are
 * not independent, so a single runaway match contributes five correlated goals
 * and the count lies about how much evidence there is. The bug this file was
 * written for read 82 goals to 33 - and the fix moved it to 54:69, which is not
 * a number anyone can tell from parity without a great many more matches.
 * Asked at the tick, the same question is exact, runs in a second, and names
 * the branch.
 *
 * WHICH IS ONLY WORTH ANYTHING IF THE BRANCH IS REACHED. The suite that missed
 * the 82:33 bug passed 106,459 assertions while never once entering the state
 * the bug was in; it spent 61% of its ticks in a search stance, because the
 * poses it invented rarely put the ball where the robot could see it. So the
 * frames here come from real matches, and `SymmetryReport.intents` reports what
 * was actually exercised. A pass with thin coverage is not a pass, and the
 * report is built to make that visible rather than to be read as a tick.
 */

import { wrapAngle } from './drive';
import type { Agent } from './agent';
import type { ActuatorFrame, SensorFrame, TeamMessage } from './protocol';

/**
 * The frames this seat received, in order, and who it was.
 *
 * `number` is the robot number the radio addresses it by, which replay needs
 * in order to put a teammate's message back in the right envelope.
 */
export interface SeatRecording {
  id: string;
  number: number;
  frames: SensorFrame[];
}

/** One place two runs that should have agreed did not. */
export interface SymmetryDivergence {
  seat: string;
  /** Index into the recorded sequence. */
  tick: number;
  /** What the program said it was doing, when it says. This names the branch. */
  intent?: string;
  what: string;
  upright: number;
  rotated: number;
}

export interface SymmetryReport {
  seats: number;
  ticks: number;
  /** How many ticks were spent in each broadcast intent, upright run. */
  intents: Record<string, number>;
  divergences: SymmetryDivergence[];
  get ok(): boolean;
}

/**
 * The frame this robot would have been handed in the rotated world.
 *
 * Everything in a `SensorFrame` is either in the robot's own frame - the IR
 * bearing, the sonar ring, the line sensors, the encoders, the camera's ball -
 * or is not a direction at all, and a rotation that carries the robot with it
 * leaves all of that alone. The exceptions are the two absolutes: where the
 * compass thinks zero is, and which goal is which colour.
 *
 * `attackDirection` flips with them. That is not a third exception: it is the
 * same swap said out loud, and it is what makes this a HALF-TIME transform
 * rather than an abstract one. The rotated frame is the frame this robot would
 * get playing the same situation up the other end, which is the thing a team
 * actually wants to know is the same.
 */
export function rotateFrame(frame: SensorFrame): SensorFrame {
  const camera = frame.camera;
  return {
    ...frame,
    attackDirection: frame.attackDirection > 0 ? -1 : 1,
    compass: { ...frame.compass, heading: wrapAngle(frame.compass.heading + Math.PI) },
    camera: {
      ...camera,
      goals: { cyan: camera.goals.yellow, yellow: camera.goals.cyan },
      goalBlobs: { cyan: camera.goalBlobs.yellow, yellow: camera.goalBlobs.cyan },
    },
  };
}

/**
 * Wrap a program so the frames it is given are kept.
 *
 * Deliberately a wrapper and not a hook inside the match: the recording has to
 * be of what the PROGRAM saw, which is after the sensor model, the noise draw
 * and the radio have all had their turn. Anything reconstructed later from
 * robot poses would be a different set of frames that happened to describe the
 * same moment.
 */
export class RecordingAgent implements Agent {
  readonly frames: SensorFrame[] = [];

  constructor(private readonly inner: Agent) {}

  get name(): string {
    return this.inner.name;
  }

  tick(frame: SensorFrame): ActuatorFrame | null | undefined {
    this.frames.push(structuredClone(frame));
    return this.inner.tick(frame);
  }

  reset(): void {
    this.inner.reset?.();
  }
}

function intentOf(command: ActuatorFrame | null | undefined): string | undefined {
  const say = command?.say as { intent?: unknown } | undefined;
  return typeof say?.intent === 'string' ? say.intent : undefined;
}

/**
 * Play a recording back through fresh programs, optionally rotated.
 *
 * The seats go round together, tick for tick, and each one is handed what its
 * teammate said on the previous tick rather than what the teammate said during
 * the recording. That matters: a team's radio traffic is its own business and
 * may well carry field coordinates, so a message replayed verbatim into the
 * rotated run would be a message from the wrong world. Generating it live
 * means whatever convention the team uses is applied consistently on both
 * sides, and the comparison stays a comparison about the program.
 *
 * One tick of delay is not the real radio's delivery model. It does not have
 * to be - both runs get the same approximation, and what is being asserted is
 * that they agree with each other, not that either reproduces the recording.
 */
function replay(
  seats: SeatRecording[],
  make: (seat: SeatRecording) => Agent,
  rotated: boolean,
): { commands: (ActuatorFrame | null | undefined)[][]; intents: string[][] } {
  const agents = seats.map(make);
  const commands: (ActuatorFrame | null | undefined)[][] = seats.map(() => []);
  const intents: string[][] = seats.map(() => []);
  let said: (unknown | undefined)[] = seats.map(() => undefined);

  const ticks = Math.min(...seats.map((s) => s.frames.length));
  for (let t = 0; t < ticks; t++) {
    const saying: (unknown | undefined)[] = [];
    for (let i = 0; i < seats.length; i++) {
      const base = seats[i]!.frames[t]!;
      const frame = rotated ? rotateFrame(base) : { ...base };

      const messages: TeamMessage[] = [];
      for (let j = 0; j < seats.length; j++) {
        if (j === i || said[j] === undefined) continue;
        messages.push({ from: seats[j]!.number, body: said[j], age: 0.02 });
      }
      frame.messages = messages;

      const command = agents[i]!.tick(frame);
      commands[i]!.push(command);
      intents[i]!.push(intentOf(command) ?? '(silent)');
      saying.push(command?.say);
    }
    said = saying;
  }
  return { commands, intents };
}

/**
 * Run a recording upright and rotated through fresh programs, and compare.
 *
 * `make` is called once per seat per run and must hand back a program with no
 * memory of anything - the two runs have to start from the same place or the
 * comparison is between two different robots.
 */
export function checkSymmetry(
  seats: SeatRecording[],
  make: (seat: SeatRecording) => Agent,
  tolerance = 1e-9,
): SymmetryReport {
  const upright = replay(seats, make, false);
  const rotated = replay(seats, make, true);

  const divergences: SymmetryDivergence[] = [];
  const intents: Record<string, number> = {};
  let ticks = 0;

  for (let i = 0; i < seats.length; i++) {
    const a = upright.commands[i]!;
    const b = rotated.commands[i]!;
    for (let t = 0; t < a.length; t++) {
      ticks++;
      const name = upright.intents[i]![t]!;
      intents[name] = (intents[name] ?? 0) + 1;

      const note = (what: string, x: number, y: number): void => {
        if (divergences.length < 200) {
          divergences.push({ seat: seats[i]!.id, tick: t, intent: name, what, upright: x, rotated: y });
        }
      };

      const ca = a[t];
      const cb = b[t];
      if (!ca || !cb) {
        if (Boolean(ca) !== Boolean(cb)) note('command', ca ? 1 : 0, cb ? 1 : 0);
        continue;
      }
      for (let m = 0; m < ca.motors.length; m++) {
        const x = ca.motors[m] ?? 0;
        const y = cb.motors[m] ?? 0;
        if (Math.abs(x - y) > tolerance) note(`motors[${m}]`, x, y);
      }
      const da = ca.dribbler ?? 0;
      const db = cb.dribbler ?? 0;
      if (Math.abs(da - db) > tolerance) note('dribbler', da, db);
      if ((ca.kicker === true) !== (cb.kicker === true)) {
        note('kicker', ca.kicker === true ? 1 : 0, cb.kicker === true ? 1 : 0);
      }
    }
  }

  return {
    seats: seats.length,
    ticks,
    intents,
    divergences,
    get ok(): boolean {
      return divergences.length === 0;
    },
  };
}

/**
 * The intents a report never saw.
 *
 * The argument a coverage floor settles is not "did the check pass" but "was
 * there anything for it to pass ON". Handed the states a program is known to
 * have, this names the ones the recording never entered - and those are
 * exactly the ones a green result says nothing about.
 */
export function unreached(report: SymmetryReport, expected: readonly string[]): string[] {
  return expected.filter((name) => (report.intents[name] ?? 0) === 0);
}
