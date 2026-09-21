/**
 * A robot is told only what a robot on a real field could know.
 *
 * Up to protocol 5 every frame carried the referee's clock, whether play was
 * live, whether a kick-off was still pending under 5.4.7 and whose it was.
 * Anything could read that - the built-in robots did, and so did a submission
 * that reached past its board's pins to the frame underneath - and it was an
 * advantage no robot on a real field has. These tests pin what replaced it:
 * the start button, the robot's own clock, and nothing from the referee.
 */

import { describe, expect, it } from 'bun:test';

import { Match } from '../../src/match/match';
import { referenceTeam } from '../../src/infra/reference';
import { RestartWatch, KICKOFF_WINDOW } from '../../src/match/restart';
import type { Transport } from '../../src/match/agent';
import type { ActuatorFrame, DisabledMessage, SensorFrame } from '../../src/match/protocol';

const DT = 1 / 120;

/** A program on the other end of a socket that records what it was told. */
class Recorder implements Transport {
  readonly name = 'recorder';
  connected = true;
  frames: SensorFrame[] = [];
  say: unknown = undefined;

  send(frame: SensorFrame): void {
    this.frames.push(frame);
  }
  disabled(_state: DisabledMessage): void {}
  take(): ActuatorFrame | null {
    const out: ActuatorFrame = { motors: [0, 0, 0, 0], say: this.say };
    this.say = undefined;
    return out;
  }
  reset(): void {}
  close(): void {
    this.connected = false;
  }
}

function match(opts: { kickoffCountdown?: number } = {}) {
  const violet1 = new Recorder();
  const violet2 = new Recorder();
  const m = new Match({
    agents: { ...referenceTeam('violet'), ...referenceTeam('lime') },
    transports: { 'violet-1': violet1, 'violet-2': violet2 },
    halfSeconds: 300,
    seed: 3,
    ...opts,
  });
  return { m, violet1, violet2 };
}

function run(m: Match, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) m.step(DT);
}

describe('the sensor frame', () => {
  it('carries exactly the fields a real robot could have, and nothing new unannounced', () => {
    const { m, violet1 } = match();
    m.world.kickOff('violet');
    m.world.running = true;
    run(m, 0.5);

    // Adding to this list is a decision about what a robot is allowed to
    // know. Make it on purpose, in protocol.ts, not by passing a field along.
    expect(Object.keys(violet1.frames.at(-1)!).sort()).toEqual(
      [
        'attackDirection',
        'ball',
        'ballGate',
        'camera',
        'compass',
        'encoders',
        'gyro',
        'lines',
        'messages',
        'range',
        'robot',
        'start',
        'team',
        'time',
      ].sort(),
    );
  });

  it('has a clock of the robot own that keeps running when the referee stops play', () => {
    const { m, violet1 } = match();
    m.world.kickOff('violet');
    m.world.running = true;
    run(m, 1);
    m.world.running = false;
    const stoppedAt = m.world.clock;
    const before = violet1.frames.at(-1)!.time;
    run(m, 2);

    expect(m.world.clock).toBe(stoppedAt);
    expect(violet1.frames.at(-1)!.time).toBeGreaterThan(before + 1.9);
  });
});

describe('the start button', () => {
  it('goes up for a moment at every kick-off, the way a team lifts and restarts its robot', () => {
    const { m, violet1 } = match();
    m.world.kickOff('violet');
    m.world.running = true;
    run(m, 1);
    const atRestart = violet1.frames.length;
    m.world.kickOff('lime');
    run(m, 1);

    const after = violet1.frames.slice(atRestart).map((f) => f.start);
    expect(after.slice(0, 2)).toEqual([false, false]);
    expect(after.slice(2).every(Boolean)).toBe(true);
  });

  it('stays up through a kick-off countdown - nobody presses start before the whistle', () => {
    const { m, violet1 } = match({ kickoffCountdown: 2 });
    m.world.kickOff('violet');
    m.world.running = true;
    run(m, 1);

    expect(m.world.countdownActive).toBe(true);
    expect(violet1.frames.length).toBeGreaterThan(10);
    expect(violet1.frames.every((f) => f.start === false)).toBe(true);
  });

  it('is up at a stoppage', () => {
    const { m, violet1 } = match();
    m.world.kickOff('violet');
    m.world.running = true;
    run(m, 1);
    m.world.running = false;
    const at = violet1.frames.length;
    run(m, 1);

    expect(violet1.frames.slice(at).every((f) => f.start === false)).toBe(true);
  });
});

describe('the team radio', () => {
  it('ages a message by the link, not by the match clock', () => {
    const { m, violet1, violet2 } = match();
    m.world.kickOff('violet');
    m.world.running = true;
    run(m, 0.5);
    m.world.running = false;
    violet2.say = { hello: true };
    const at = violet1.frames.length;
    run(m, 0.3);

    const ages = violet1.frames
      .slice(at)
      .flatMap((f) => f.messages)
      .map((msg) => msg.age);
    // Play is stopped the whole time, and the message still gets older.
    expect(ages.length).toBeGreaterThan(3);
    expect(ages.at(-1)!).toBeGreaterThan(ages[0]! + 0.1);
  });
});

describe('RestartWatch', () => {
  const frame = (time: number, start: boolean, strength: number | null): SensorFrame =>
    ({ time, start, ball: strength === null ? null : { bearing: 0, strength } }) as unknown as SensorFrame;

  it('reads a restart off the button and whose it is off where it was put down', () => {
    const taker = new RestartWatch();
    taker.update(frame(0, false, 1));
    taker.update(frame(0.02, true, 1));
    expect(taker.justStarted).toBe(true);
    expect(taker.pending).toBe(true);
    expect(taker.ours).toBe(true);

    const defender = new RestartWatch();
    defender.update(frame(0, false, 0.15));
    defender.update(frame(0.02, true, 0.15));
    expect(defender.pending).toBe(true);
    expect(defender.ours).toBe(false);
  });

  it('lasts the rulebook three seconds on its own clock, or until it is finished', () => {
    const watch = new RestartWatch();
    watch.update(frame(10, true, 1));
    watch.update(frame(10 + KICKOFF_WINDOW - 0.02, true, 1));
    expect(watch.pending).toBe(true);
    watch.update(frame(10 + KICKOFF_WINDOW + 0.02, true, 1));
    expect(watch.pending).toBe(false);

    watch.update(frame(20, false, 1));
    watch.update(frame(20.02, true, 1));
    expect(watch.ours).toBe(true);
    watch.finish();
    expect(watch.pending).toBe(false);
    expect(watch.ours).toBe(false);
  });

  it('waits for a sighting before deciding, rather than guessing from a shadowed ring', () => {
    const watch = new RestartWatch();
    watch.update(frame(0, true, null));
    expect(watch.ours).toBe(false);
    watch.update(frame(0.02, true, 1));
    expect(watch.ours).toBe(true);
  });
});
