import { describe, expect, test } from 'bun:test';
import {
  encodeSensorFrame,
  decodeSensorFrame,
  encodeActuatorFrame,
  decodeActuatorFrame,
  encodeServerMessage,
  decodeServerMessage,
  encodeClientMessage,
  decodeClientMessage,
} from '../../src/match/proto';
import type { SensorFrame, ActuatorFrame } from '../../src/match/protocol';

describe('Protobuf wire encoder/decoder', () => {
  test('SensorFrame roundtrip', () => {
    const frame: SensorFrame = {
      clock: 12.345,
      robot: 2,
      team: 'lime',
      attackDirection: -1,
      playing: true,
      returned: false,
      kickoff: { pending: true, ours: false, countdown: 4.5 },
      ball: { bearing: 1.23, strength: 0.85 },
      compass: { heading: -0.45 },
      gyro: { rate: 2.5 },
      lines: [
        { bearing: 0.1, surface: 'carpet', value: 0.05 },
        { bearing: 0.8, surface: 'line', value: 0.92 },
        { bearing: 1.5, surface: 'marking', value: 0.5 },
      ],
      range: { front: 250, back: null, left: 120, right: 300 },
      encoders: [10.5, -20.25, 30.125, -40.0],
      camera: {
        goals: {
          cyan: { bearing: -0.5, range: 1200 },
          yellow: { bearing: 2.1, range: 1500 },
        },
        goalBlobs: {
          cyan: [{ start: -0.6, end: -0.4, height: 0.15 }],
          yellow: [{ start: 2.0, end: 2.2, height: 0.12 }],
        },
        ball: { bearing: 1.2, range: 450 },
        fresh: true,
      },
      ballGate: { held: true },
      messages: [
        { from: 1, body: { role: 'striker', target: [100, 200] }, age: 0.1 },
      ],
    };

    const encoded = encodeSensorFrame(frame);
    expect(encoded.length).toBeGreaterThan(0);
    const decoded = decodeSensorFrame(encoded);

    expect(decoded.clock).toBeCloseTo(frame.clock, 4);
    expect(decoded.robot).toBe(frame.robot);
    expect(decoded.team).toBe(frame.team);
    expect(decoded.attackDirection).toBe(frame.attackDirection);
    expect(decoded.playing).toBe(frame.playing);
    expect(decoded.returned).toBe(frame.returned);
    expect(decoded.kickoff.pending).toBe(frame.kickoff.pending);
    expect(decoded.kickoff.ours).toBe(frame.kickoff.ours);
    expect(decoded.kickoff.countdown).toBeCloseTo(frame.kickoff.countdown, 2);

    expect(decoded.ball).not.toBeNull();
    expect(decoded.ball!.bearing).toBeCloseTo(frame.ball!.bearing, 2);
    expect(decoded.ball!.strength).toBeCloseTo(frame.ball!.strength, 2);

    expect(decoded.compass.heading).toBeCloseTo(frame.compass.heading, 2);
    expect(decoded.gyro.rate).toBeCloseTo(frame.gyro.rate, 2);

    expect(decoded.lines.length).toBe(3);
    expect(decoded.lines[0]!.surface).toBe('carpet');
    expect(decoded.lines[1]!.surface).toBe('line');
    expect(decoded.lines[2]!.surface).toBe('marking');

    expect(decoded.range.front).toBeCloseTo(250, 1);
    expect(decoded.range.back).toBeNull();
    expect(decoded.range.left).toBeCloseTo(120, 1);

    expect(decoded.encoders.length).toBe(4);
    expect(decoded.encoders[0]!).toBeCloseTo(10.5, 2);
    expect(decoded.encoders[1]!).toBeCloseTo(-20.25, 2);

    expect(decoded.camera.goals.cyan!.bearing).toBeCloseTo(-0.5, 2);
    expect(decoded.camera.goalBlobs.cyan.length).toBe(1);
    expect(decoded.camera.fresh).toBe(true);

    expect(decoded.ballGate.held).toBe(true);
    expect(decoded.messages.length).toBe(1);
    expect(decoded.messages[0]!.from).toBe(1);
    expect(decoded.messages[0]!.body).toEqual({ role: 'striker', target: [100, 200] });
  });

  test('ActuatorFrame roundtrip', () => {
    const frame: ActuatorFrame = {
      motors: [0.5, -0.75, 1.0, -0.25],
      dribbler: 0.8,
      kicker: true,
      say: { strategy: 'defend' },
    };

    const encoded = encodeActuatorFrame(frame);
    const decoded = decodeActuatorFrame(encoded);

    expect(decoded.motors.length).toBe(4);
    expect(decoded.motors[0]!).toBeCloseTo(0.5, 2);
    expect(decoded.motors[1]!).toBeCloseTo(-0.75, 2);
    expect(decoded.dribbler).toBeCloseTo(0.8, 2);
    expect(decoded.kicker).toBe(true);
    expect(decoded.say).toEqual({ strategy: 'defend' });
  });

  test('ServerMessage and ClientMessage wrappers', () => {
    const frame: SensorFrame = {
      clock: 1.0,
      robot: 1,
      team: 'violet',
      attackDirection: 1,
      playing: true,
      returned: false,
      kickoff: { pending: false, ours: true, countdown: 0 },
      ball: null,
      compass: { heading: 0 },
      gyro: { rate: 0 },
      lines: [],
      range: { front: null, back: null, left: null, right: null },
      encoders: [],
      camera: { goals: { cyan: null, yellow: null }, goalBlobs: { cyan: [], yellow: [] }, ball: null, fresh: false },
      ballGate: { held: false },
      messages: [],
    };

    const serverEncoded = encodeServerMessage({ type: 'sensors', frame });
    const serverDecoded = decodeServerMessage(serverEncoded);
    expect(serverDecoded).not.toBeNull();
    if (serverDecoded && serverDecoded.type === 'sensors') {
      expect(serverDecoded.frame.robot).toBe(1);
    }

    const actFrame: ActuatorFrame = { motors: [0.1, 0.2, 0.3, 0.4] };
    const clientEncoded = encodeClientMessage(actFrame);
    const clientDecoded = decodeClientMessage(clientEncoded);
    expect(clientDecoded).not.toBeNull();
    expect(clientDecoded!.motors.length).toBe(4);
  });
});
