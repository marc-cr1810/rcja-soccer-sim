/**
 * The viewer's playback buffer and the follow camera.
 *
 * Both exist to stop the picture stuttering, so the tests drive them the way
 * the real stream does - frames whose content advances by uneven amounts
 * (whole physics steps per timer tick) arriving at uneven times - and measure
 * the smoothness of what comes out, not just that something does.
 */
import { describe, expect, it } from 'bun:test';

import { Playout } from '@rcja/shared/playout';
import { FollowCamera } from '@rcja/shared/follow-camera';
import type { ViewFrame } from '@rcja/shared/view';

function frame(t: number | undefined, ballX: number, extra: Partial<ViewFrame> = {}): ViewFrame {
  return {
    ...(t === undefined ? {} : { t }),
    clock: 0,
    half: 1,
    running: true,
    kickoff: { countdown: 0, team: 'violet' },
    score: { violet: 0, lime: 0 },
    ball: { x: ballX, z: 0, radius: 21 },
    robots: [],
    commsEnabled: false,
    commsActivity: { violet: 0, lime: 0 },
    events: [],
    teams: { violet: 'V', lime: 'L' },
    ...extra,
  } as ViewFrame;
}

/** A tiny seeded generator, so a failure is the same failure every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * The real server's stream: a 30 Hz timer that oversleeps by 0-8 ms, whole
 * 10 ms physics steps per tick, a ball rolling at 1000 mm/s, and a network
 * that delays each frame by 5-45 ms. Returns what a 144 Hz screen draws.
 */
function playStream(seed: number, stamped: boolean): { at: number; x: number }[] {
  const random = rng(seed);
  const arrivals: { at: number; f: ViewFrame }[] = [];
  let wall = 0;
  let owed = 0;
  let world = 0;
  for (let i = 0; i < 300; i++) {
    const slept = 1 / 30 + random() * 0.008;
    wall += slept;
    owed += slept;
    while (owed >= 0.01) {
      world += 0.01;
      owed -= 0.01;
    }
    const f = frame(stamped ? wall - owed : undefined, world * 1000);
    // A socket delivers in order: a delayed frame holds up the ones behind it.
    const at = Math.max(arrivals.at(-1)?.at ?? 0, wall + 0.005 + random() * 0.04);
    arrivals.push({ at, f });
  }

  const playout = new Playout();
  const drawn: { at: number; x: number }[] = [];
  let next = 0;
  for (let now = 0; now < wall; now += 1 / 144) {
    while (next < arrivals.length && arrivals[next]!.at <= now) {
      playout.push(arrivals[next]!.f, arrivals[next]!.at);
      next++;
    }
    const f = playout.sample(now);
    if (f) drawn.push({ at: now, x: f.ball.x });
  }
  return drawn;
}

/** How far the drawn speed strays from the true 1000 mm/s, as a fraction, once settled. */
function worstSpeedError(drawn: { at: number; x: number }[]): number {
  let worst = 0;
  // Skip the first two seconds while the delay estimate settles.
  for (let i = 1; i < drawn.length; i++) {
    if (drawn[i]!.at < 2) continue;
    const speed = (drawn[i]!.x - drawn[i - 1]!.x) / (drawn[i]!.at - drawn[i - 1]!.at);
    worst = Math.max(worst, Math.abs(speed - 1000) / 1000);
  }
  return worst;
}

describe('Playout', () => {
  it('draws a steadily rolling ball at a steady speed through a lumpy stream', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      // Only the playback clock's slewing (at most 8%) may show.
      expect(worstSpeedError(playStream(seed, true))).toBeLessThan(0.1);
    }
  });

  it('is what the old arrival-timed blend could not do', () => {
    // The same stream without stamps is timed by arrival, as before: the
    // content lumps and network wobble come straight through. This is the
    // baseline the test above is beating, kept so the comparison stays honest.
    const unstamped = Math.max(...[1, 2, 3].map((s) => worstSpeedError(playStream(s, false))));
    expect(unstamped).toBeGreaterThan(0.5);
  });

  it('holds the newest frame when the stream runs dry', () => {
    const p = new Playout();
    p.push(frame(10, 0), 0);
    p.push(frame(10.033, 33), 0.033);
    expect(p.sample(5)!.ball.x).toBe(33);
  });

  it('starts again when the stream comes from a different server', () => {
    const p = new Playout();
    p.push(frame(1000, 0), 0);
    p.push(frame(1000.033, 33), 0.033);
    p.push(frame(5, 500), 0.066);
    expect(p.latest!.ball.x).toBe(500);
    expect(p.sample(0.07)!.ball.x).toBe(500);
  });

  it('never runs time backwards for a frame stamped the same as the last', () => {
    const p = new Playout();
    p.push(frame(1, 0), 0);
    p.push(frame(1, 10), 0.01);
    expect(p.latest!.ball.x).toBe(10);
    expect(p.sample(1)!.ball.x).toBe(10);
  });
});

describe('FollowCamera', () => {
  const bounds = { halfX: 1.2, halfZ: 0.9 };

  it('stays put while the ball jostles inside the dead zone', () => {
    const cam = new FollowCamera(bounds);
    const first = cam.update({ x: 0.2, z: 0 }, 0.021, 1 / 60);
    let last = first;
    for (let i = 0; i < 240; i++) {
      last = cam.update({ x: 0.2 + 0.01 * Math.sin(i * 0.7), z: 0.01 * Math.cos(i * 1.3) }, 0.021, 1 / 60);
    }
    expect(Math.abs(last.target.x - first.target.x)).toBeLessThan(0.02);
    expect(Math.abs(last.target.z - first.target.z)).toBeLessThan(0.02);
  });

  it('follows a rolling ball without jerks, and leads it', () => {
    const cam = new FollowCamera(bounds);
    const dt = 1 / 60;
    const xs: number[] = [];
    let ball = -0.8;
    for (let i = 0; i < 90; i++) {
      ball += 1.0 * dt;
      xs.push(cam.update({ x: ball, z: 0 }, 0.021, dt).target.x);
    }
    // No frame-to-frame change in camera speed bigger than a smooth start could make.
    let worstAccel = 0;
    for (let i = 2; i < xs.length; i++) {
      const accel = (xs[i]! - 2 * xs[i - 1]! + xs[i - 2]!) / (dt * dt);
      worstAccel = Math.max(worstAccel, Math.abs(accel));
    }
    expect(worstAccel).toBeLessThan(20);
    // Settled: moving with the ball, and ahead of it.
    const speed = (xs.at(-1)! - xs.at(-2)!) / dt;
    expect(speed).toBeGreaterThan(0.9);
    expect(xs.at(-1)!).toBeGreaterThan(ball);
  });

  it('cuts to a ball that jumps across the field', () => {
    const cam = new FollowCamera(bounds);
    cam.update({ x: -0.8, z: 0 }, 0.021, 1 / 60);
    cam.update({ x: -0.79, z: 0 }, 0.021, 1 / 60);
    const shot = cam.update({ x: 0, z: 0 }, 0.021, 1 / 60);
    expect(shot.cut).toBe(true);
    expect(shot.target.x).toBe(0);
  });

  it('holds while the ball is carried, and cuts to where it is put down far away', () => {
    const cam = new FollowCamera(bounds);
    const before = cam.update({ x: 0.5, z: 0.2 }, 0.021, 1 / 60);
    const carried = cam.update({ x: 0, z: 0, absent: true }, 0.021, 1 / 60);
    expect(carried.target).toEqual(before.target);
    const down = cam.update({ x: -0.3, z: -0.3 }, 0.021, 1 / 60);
    expect(down.cut).toBe(true);
    expect(down.target.x).toBeCloseTo(-0.3);
  });

  it('eases rather than cuts to a ball put down close by', () => {
    const cam = new FollowCamera(bounds);
    cam.update({ x: 0.5, z: 0.2 }, 0.021, 1 / 60);
    cam.update({ x: 0, z: 0, absent: true }, 0.021, 1 / 60);
    const down = cam.update({ x: 0.6, z: 0.2 }, 0.021, 1 / 60);
    expect(down.cut).toBe(false);
    expect(down.target.x).toBeLessThan(0.55);
  });
});
