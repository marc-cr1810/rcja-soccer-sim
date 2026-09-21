/**
 * Playing the server's frames back smoothly.
 *
 * Every client used to draw the world by blending the last two frames it had,
 * timed by when they arrived. That put two kinds of unevenness straight on the
 * screen. Network arrival is lumpy: two frames land together, then nothing
 * for 60 ms, so the blend raced, froze, and snapped back a step whenever a
 * frame came early. The frames themselves are lumpy too, because the server
 * steps whole physics steps per timer tick: a frame can be 30 ms of football
 * after the last or 40, while arriving a steady 33 ms later. Every view
 * stuttered; the follow camera, which moves the whole field with the ball,
 * just made it impossible to miss.
 *
 * This keeps a short queue and plays it back a little behind the newest
 * frame, on a clock of its own that advances with real time and is only ever
 * nudged, never jumped, to keep pace with the stream. Positions are blended
 * between the two frames either side of that clock, by the server's stamp of
 * when each was true (`ViewFrame.t`) rather than when it turned up.
 *
 * The delay is as small as the stream allows: one frame interval plus however
 * much the arrivals have wobbled lately, so a quiet local network costs about
 * two frames and bad venue wifi buys itself the headroom it needs.
 */
import type { ViewFrame } from './view';

/** How long arrivals are remembered when judging how much they wobble. */
const WINDOW = 2;
/** Never play back closer than this to the newest frame, in seconds. */
const MIN_DELAY = 0.03;
/** Nor further behind than this: past it, a late frame is just late. */
const MAX_DELAY = 0.25;
/** How fast the playback clock may be sped up or slowed to catch up: 8%. */
const SLEW = 0.08;
/** A clock this far out is not caught up with, it is reset. */
const SNAP = 0.5;
/** A stream that jumps back this far, or forward this far, has restarted. */
const RESTART_BACK = 0.5;
const RESTART_FORWARD = 3;

interface Entry {
  t: number;
  frame: ViewFrame;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest way round the circle, so a robot crossing pi does not spin back. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Positions part of the way from one frame to the next; everything else from the later one. */
export function blend(from: ViewFrame, to: ViewFrame, t: number): ViewFrame {
  const byId = new Map(from.robots.map((r) => [r.id, r]));
  return {
    ...to,
    ball: {
      ...to.ball,
      // A ball that has just been put down arrives where it was put, rather
      // than gliding there from wherever it was picked up.
      x: from.ball.absent ? to.ball.x : lerp(from.ball.x, to.ball.x, t),
      z: from.ball.absent ? to.ball.z : lerp(from.ball.z, to.ball.z, t),
      y: to.ball.y === undefined ? undefined : lerp(from.ball.y ?? 0, to.ball.y, t),
    },
    robots: to.robots.map((r) => {
      const was = byId.get(r.id);
      if (!was) return r;
      return {
        ...r,
        x: lerp(was.x, r.x, t),
        z: lerp(was.z, r.z, t),
        heading: lerpAngle(was.heading, r.heading, t),
      };
    }),
  };
}

export class Playout {
  private entries: Entry[] = [];
  /**
   * For recent frames: when each arrived locally, its server time less that
   * (the skew), and how much server time it came after the one before (gap).
   */
  private arrivals: { at: number; skew: number; gap: number }[] = [];
  /** Server time = local time + this, for the playback clock. Null until the first frame. */
  private offset: number | null = null;
  private lastSampleAt: number | null = null;

  /** The newest frame received: what a scoreboard or a banner should show. */
  get latest(): ViewFrame | null {
    return this.entries.at(-1)?.frame ?? null;
  }

  /** How far behind the newest frame playback is currently aiming, in seconds. */
  get delay(): number {
    return this.targetDelay();
  }

  /**
   * Take a frame from the stream. `now` is local seconds.
   *
   * A frame from a server too old to stamp its frames is stamped with its
   * arrival, which is exactly the old behaviour, only buffered.
   */
  push(frame: ViewFrame, now = performance.now() / 1000): void {
    const newest = this.entries.at(-1);
    let t = frame.t ?? now;
    if (newest && (t < newest.t - RESTART_BACK || t > newest.t + RESTART_FORWARD)) {
      // A different server process, or a stream that stalled for seconds:
      // there is nothing sensible to blend across, so start again from here.
      this.reset();
    } else if (newest && t <= newest.t) {
      // Same moment (or a hair before, from a stamp rounded differently): the
      // newer news wins, but time does not run backwards.
      t = newest.t + 1e-6;
    }
    const gap = newest && this.entries.at(-1) === newest ? t - newest.t : 0;
    this.entries.push({ t, frame });
    this.arrivals.push({ at: now, skew: t - now, gap });
    while (this.arrivals.length > 2 && this.arrivals[0]!.at < now - WINDOW) this.arrivals.shift();
  }

  reset(): void {
    this.entries = [];
    this.arrivals = [];
    this.offset = null;
    this.lastSampleAt = null;
  }

  /**
   * The world as it should be drawn at local time `now`, or null before the
   * first frame. Holds at the newest frame if the stream runs dry, rather than
   * guessing where things went.
   */
  sample(now = performance.now() / 1000): ViewFrame | null {
    const newest = this.entries.at(-1);
    if (!newest) return null;

    // The least-delayed recent frame shows how close to the server this
    // client can be; aim that far back, less the delay.
    let best = -Infinity;
    for (const a of this.arrivals) best = Math.max(best, a.skew);
    const target = best - this.targetDelay();

    if (this.offset === null || Math.abs(this.offset - target) > SNAP) {
      this.offset = target;
    } else {
      const dt = this.lastSampleAt === null ? 0 : Math.max(0, now - this.lastSampleAt);
      const step = SLEW * dt;
      this.offset += Math.max(-step, Math.min(step, target - this.offset));
    }
    this.lastSampleAt = now;

    const at = now + this.offset;

    // Drop everything before the frame at or just before the playback time;
    // it has been drawn past and will not be needed again.
    while (this.entries.length > 2 && this.entries[1]!.t <= at) this.entries.shift();

    const [a, b] = this.entries;
    if (!a) return null;
    if (!b || at <= a.t) return a.frame;
    if (at >= b.t) return b.frame;
    return blend(a.frame, b.frame, (at - a.t) / (b.t - a.t));
  }

  /** One frame interval plus the recent wobble in arrivals, within bounds. */
  private targetDelay(): number {
    if (this.arrivals.length < 2) return MIN_DELAY;
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of this.arrivals) {
      lo = Math.min(lo, a.skew);
      hi = Math.max(hi, a.skew);
    }
    let interval = 0;
    for (const a of this.arrivals) interval = Math.max(interval, a.gap);
    // A few milliseconds spare, so a frame arriving exactly on time is not a
    // frame arriving just too late.
    return Math.max(MIN_DELAY, Math.min(MAX_DELAY, hi - lo + interval + 0.005));
  }
}
