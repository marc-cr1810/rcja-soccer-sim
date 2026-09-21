/**
 * A robot that is off the field comes back on — once.
 *
 * Rule 5.7 takes a damaged robot off for thirty seconds. Until Phase 9 the
 * simulator expressed that as silence: the seat was skipped before it was
 * polled, so a program on a socket heard nothing at all for the whole
 * stand-down. A client that waits ten seconds for a frame concluded the server
 * had gone and dropped — and a drop during play is itself a 5.7.1 removal, so
 * the robot was taken off again the instant it came back, for a disconnection
 * the server had caused by not talking to it.
 *
 * Measured against the old code on a real server: the penalty reached zero at
 * t=35 and immediately read 29 again, round and round, for the rest of the
 * match. Every automatic removal did it — out of bounds, too long in the goal
 * area, multiple defence — in any match including a tournament fixture. The
 * whole suite was green because an in-process agent has no `connected` at all,
 * so `?? true` made it immune; it only ever bit a robot on a socket, which is
 * every pushed submission in every real match.
 *
 * So these tests use a transport that can go away, which is the only kind that
 * could ever have shown it.
 */

import { describe, expect, it } from 'bun:test';

import { Match } from '../../src/match/match';
import { referenceTeam } from '../../src/infra/reference';
import type { Transport } from '../../src/match/agent';
import type { ActuatorFrame, DisabledMessage, SensorFrame } from '../../src/match/protocol';

const PHYSICS_HZ = 120;
const DT = 1 / PHYSICS_HZ;

/**
 * A program on a socket, as far as the match can tell.
 *
 * The one thing that matters here is `connected`, which an in-process agent
 * does not have — and its absence is exactly what hid this for so long.
 */
class SocketLike implements Transport {
  readonly name = 'socket';
  connected = true;
  /** Frames it was sent. */
  frames: SensorFrame[] = [];
  /** "You are off the field" messages it was sent. */
  told: DisabledMessage[] = [];
  private pending: ActuatorFrame | null = null;

  send(frame: SensorFrame): void {
    if (!this.connected) return;
    this.frames.push(frame);
    this.pending = { motors: [0, 0, 0, 0] };
  }

  disabled(state: DisabledMessage): void {
    if (!this.connected) return;
    this.told.push(state);
  }

  take(): ActuatorFrame | null {
    const out = this.pending;
    this.pending = null;
    return out;
  }

  reset(): void {
    this.pending = null;
  }

  close(): void {
    this.connected = false;
  }
}

function playing(): { match: Match; socket: SocketLike } {
  const socket = new SocketLike();
  const match = new Match({
    agents: { ...referenceTeam('violet'), ...referenceTeam('lime') },
    transports: { 'violet-1': socket },
    // Not 600: a half of ten minutes or more doubles the stand-down to sixty
    // seconds (rule 5.7.2 as `World` reads it), and these tests are about what
    // happens at the end of one, not about how long it is.
    halfSeconds: 300,
    seed: 7,
  });
  match.world.kickOff('violet');
  match.world.running = true;
  return { match, socket };
}

function run(match: Match, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) match.step(DT);
}

describe('a robot taken off for damage', () => {
  it('comes back when its stand-down is served, and stays back', () => {
    const { match } = playing();
    run(match, 1);

    match.removeRobot('violet-1', '5.7.1', 'damaged');
    expect(match.world.robots.find((r) => r.id === 'violet-1')?.removed).toBe(true);

    // Past the thirty seconds, with plenty of room either side.
    run(match, 45);

    const robot = match.world.robots.find((r) => r.id === 'violet-1');
    expect(robot?.removed).toBe(false);
    // The old failure was not "never returns" — it was returning and being
    // taken straight back off, so a penalty that had just reached zero read
    // thirty again. Checking the robot is on the field is what catches it.
    expect(robot?.penaltyRemaining).toBe(0);
  });

  it('is told it is off, instead of hearing nothing', () => {
    const { match, socket } = playing();
    run(match, 1);
    const before = socket.told.length;

    match.removeRobot('violet-1', '5.7.1', 'damaged');
    run(match, 10);

    // Something arrived during the stand-down. That is the whole point: ten
    // seconds of silence is what a client reads as a dead server.
    expect(socket.told.length).toBeGreaterThan(before);
    const last = socket.told.at(-1)!;
    expect(last.type).toBe('disabled');
    expect(last.rule).toBe('5.7.1');
    expect(last.reason).toContain('damaged');
    // Not when it will be back: a robot in somebody's hands has no way to know.
    expect('returnsIn' in last).toBe(false);
  });

  it('sends no sensors while it is off', () => {
    const { match, socket } = playing();
    run(match, 1);

    match.removeRobot('violet-1', '5.7.1', 'damaged');
    const atRemoval = socket.frames.length;
    run(match, 10);

    // No sensors, no tick, nothing to decide: a robot in a student's hands
    // beside the pitch cannot see the field.
    expect(socket.frames.length).toBe(atRemoval);
  });

  it('comes back with its start button being pressed, like a robot put back by hand', () => {
    const { match, socket } = playing();
    run(match, 1);

    match.removeRobot('violet-1', '5.7.1', 'damaged');
    const atRemoval = socket.frames.length;
    run(match, 45);

    // Nothing says "you were removed": a robot cannot tell that from any
    // other restart. What it gets is what a real one gets - the button up as
    // it goes back on, then down.
    const after = socket.frames.slice(atRemoval);
    expect(after.length).toBeGreaterThan(3);
    // Only the first return is checked: any later restart in these 45 seconds
    // lifts the button again, as it does for every robot.
    expect(after[0]!.start).toBe(false);
    expect(after[1]!.start).toBe(false);
    expect(after[2]!.start).toBe(true);
  });

  it('does not serve a second stand-down for dropping out while already off', () => {
    // The program goes away during its stand-down — which is exactly what the
    // old code caused, and what a genuinely crashing program still does. It
    // must be judged once, when the robot comes back, not handed a fresh
    // thirty seconds for a disconnection nobody could have answered.
    const { match, socket } = playing();
    run(match, 1);

    match.removeRobot('violet-1', '5.7.1', 'damaged');
    run(match, 5);
    socket.close();
    run(match, 26);
    // Back in the seat just before the stand-down ends, as a retrying client is.
    socket.connected = true;
    run(match, 20);

    const robot = match.world.robots.find((r) => r.id === 'violet-1');
    expect(robot?.removed).toBe(false);
  });
});

describe('a match that is not running', () => {
  it('still polls its seats, and acts on none of it', () => {
    const socket = new SocketLike();
    const match = new Match({
      agents: { ...referenceTeam('violet'), ...referenceTeam('lime') },
      transports: { 'violet-1': socket },
      halfSeconds: 600,
      seed: 7,
    });
    match.world.kickOff('violet');
    // Not running: a referee has not blown the whistle yet.
    match.world.running = false;

    const ball = { ...match.world.ball };
    for (let i = 0; i < Math.round(3 / DT); i++) match.poll(DT);

    // Frames flow, so the socket never goes quiet waiting for a referee.
    expect(socket.frames.length).toBeGreaterThan(0);
    expect(socket.frames.every((f) => f.start === false)).toBe(true);
    // And nothing moved: no clock, no ball, no robot.
    expect(match.world.clock).toBe(0);
    expect(match.world.ball.x).toBe(ball.x);
    expect(match.world.ball.z).toBe(ball.z);
  });

  it('does not let the sensors drift while it waits', () => {
    // A compass drifts and a gyro's bias wanders, both stepped on every read.
    // Polled through a long pre-game they would arrive at kick-off already
    // wrong — and the result would depend on how long the referee took, which
    // is the one thing a seeded match may never do.
    const make = (): { match: Match; socket: SocketLike } => {
      const socket = new SocketLike();
      const match = new Match({
        agents: { ...referenceTeam('violet'), ...referenceTeam('lime') },
        transports: { 'violet-1': socket },
        halfSeconds: 300,
        seed: 11,
      });
      match.world.kickOff('violet');
      match.world.running = false;
      return { match, socket };
    };

    const quick = make();
    for (let i = 0; i < Math.round(0.5 / DT); i++) quick.match.poll(DT);
    quick.match.world.running = true;
    run(quick.match, 5);

    const slow = make();
    for (let i = 0; i < Math.round(120 / DT); i++) slow.match.poll(DT);
    slow.match.world.running = true;
    run(slow.match, 5);

    // Two minutes of waiting against half a second, and the football is
    // identical. That is what "a match replays as itself" has to mean.
    expect(slow.match.world.clock).toBeCloseTo(quick.match.world.clock, 6);
    expect(slow.match.world.score).toEqual(quick.match.world.score);
    const heading = (m: Match): number =>
      m.world.robots.find((r) => r.id === 'violet-1')!.heading;
    expect(heading(slow.match)).toBeCloseTo(heading(quick.match), 9);
  });
});
