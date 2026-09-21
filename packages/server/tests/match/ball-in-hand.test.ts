/**
 * A ball in somebody's hand is not a ball any robot can sense.
 *
 * While the referee carries it to a neutral point, every seat reads what it
 * would with the ball out of sight: no infrared, no camera sighting, nothing
 * held. Nothing new on the wire - a robot cannot tell "being carried" from
 * "somewhere I cannot see", which is the point.
 */
import { describe, expect, it } from 'bun:test';

import { Match } from '../../src/match/match';
import { referenceTeam } from '../../src/infra/reference';
import type { Transport } from '../../src/match/agent';
import type { ActuatorFrame, DisabledMessage, SensorFrame } from '../../src/match/protocol';

const DT = 1 / 120;

/** A program that stands still and records what it was told. */
class Recorder implements Transport {
  readonly name = 'recorder';
  connected = true;
  frames: SensorFrame[] = [];

  send(frame: SensorFrame): void {
    this.frames.push(frame);
  }
  disabled(_state: DisabledMessage): void {}
  take(): ActuatorFrame | null {
    return { motors: [0, 0, 0, 0] };
  }
  reset(): void {}
  close(): void {
    this.connected = false;
  }
}

function playing(opts: { ballPlacementSeconds?: { min: number; max: number } } = {}) {
  const seats = { 'violet-1': new Recorder(), 'violet-2': new Recorder() };
  const m = new Match({
    agents: { ...referenceTeam('violet'), ...referenceTeam('lime') },
    transports: seats,
    halfSeconds: 300,
    seed: 5,
    ...opts,
  });
  m.world.kickOff('violet');
  m.world.running = true;
  return { m, seats: Object.values(seats) };
}

function run(m: Match, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) m.step(DT);
}

describe('a ball being carried to a neutral point', () => {
  it('is sensed by nobody until it is put down', () => {
    const { m, seats } = playing({ ballPlacementSeconds: { min: 1.5, max: 1.5 } });
    run(m, 0.5);
    // Standing at kick-off, both violet robots can see the ball on the spot.
    expect(seats.some((s) => s.frames.at(-1)!.ball !== null)).toBe(true);

    m.world.callLackOfProgress();
    const at = seats.map((s) => s.frames.length);
    run(m, 1.3);

    for (const [i, seat] of seats.entries()) {
      const during = seat.frames.slice(at[i]);
      expect(during.length).toBeGreaterThan(10);
      expect(during.every((f) => f.ball === null)).toBe(true);
      // A stale camera frame may still show what it saw before; a fresh one
      // must not.
      expect(during.filter((f) => f.camera.fresh).every((f) => f.camera.ball === null)).toBe(true);
      expect(during.every((f) => f.ballGate.held === false)).toBe(true);
    }
    expect(m.snapshot().ball.absent).toBe(true);

    run(m, 0.5);
    expect(m.world.ballInPlay).toBe(true);
    expect(m.snapshot().ball.absent).toBeUndefined();
    expect(seats.some((s) => s.frames.at(-1)!.ball !== null)).toBe(true);
  });
});
