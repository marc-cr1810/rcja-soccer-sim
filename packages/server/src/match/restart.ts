/**
 * What a robot can work out about a restart from its own button and sensors.
 *
 * The frame does not say a kick-off is on, or whose it is, because nobody
 * tells a real robot either (see `SensorFrame`). A real team tells it with
 * their hands: they put the robot down where the restart wants it and press
 * start. So:
 *
 * - **A restart happened** when the start button goes down. A kick-off, the
 *   start of a half and being put back after a removal all look the same from
 *   here, because on a field they are the same.
 * - **It is ours to take** when we were put down against the ball. The taker
 *   is placed a few centimetres behind it (rule 5.4); everybody else is
 *   outside the centre circle. The infrared ring reads that difference with a
 *   factor of five to spare: strength clamps at 1.0 from ~130 mm in, and is
 *   under 0.2 from 300 mm out.
 * - **5.4.7 is live** for the rulebook's three seconds, on our own clock.
 *   Nobody announces that the kick-off is over; a robot that needs to know
 *   sooner watches for its own kick to go.
 */
import type { SensorFrame } from './protocol';

/** Rule 5.4.7's strike window, seconds. */
export const KICKOFF_WINDOW = 3;

/** IR strength that means "put down against the ball". See the file comment. */
export const TAKER_STRENGTH = 0.6;

export class RestartWatch {
  private wasStart = false;
  private startedAt: number | null = null;
  private decided: boolean | null = null;
  private now = 0;
  /** True on the one frame the button went down. */
  justStarted = false;

  update(frame: SensorFrame): void {
    this.now = frame.time;
    this.justStarted = frame.start && !this.wasStart;
    this.wasStart = frame.start;
    if (this.justStarted) {
      this.startedAt = frame.time;
      this.decided = null;
    }
    // Decided on the first sighting after the button, not the first frame:
    // the ball can be shadowed for a tick, and a robot that has already
    // started moving has left the place that answers the question.
    if (this.pending && this.decided === null && frame.ball) {
      this.decided = frame.ball.strength >= TAKER_STRENGTH;
    }
  }

  /** Seconds since the button last went down, or null if it never has. */
  get since(): number | null {
    return this.startedAt === null ? null : this.now - this.startedAt;
  }

  /** Inside the 5.4.7 window after a restart. */
  get pending(): boolean {
    const since = this.since;
    return since !== null && since < KICKOFF_WINDOW;
  }

  /** Whether the restart in progress is ours to take. False when unsure. */
  get ours(): boolean {
    return this.pending && this.decided === true;
  }

  /** Stop treating this restart as live - our kick went, or it is no longer ours to take. */
  finish(): void {
    this.startedAt = null;
  }

  /** Forget everything, including the button - a new half starts from here. */
  reset(): void {
    this.wasStart = false;
    this.startedAt = null;
    this.decided = null;
    this.justStarted = false;
  }
}
