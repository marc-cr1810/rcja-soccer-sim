import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  decodeClientMessage,
  encodeServerMessage,
} from '../../src/match/proto';
import type { SensorFrame } from '../../src/match/protocol';

describe('Cross-language Protobuf compatibility (TS <-> Python)', () => {
  test('a negative attackDirection survives the wire', () => {
    /*
     * The one that was wrong for as long as nothing read it. proto3 writes a
     * negative int32 as a *64-bit* two's complement varint, and the Python
     * reader sign-extended from 32 - so `-1` arrived as 18446744069414584319.
     * Every robot in the league had a garbage attack direction in whichever
     * half it attacked -x, and nothing noticed, because `GoalFrame` works the
     * direction out from the camera and never reads the field.
     *
     * The first thing that did read it was a board's end switch, which a human
     * flips at half time. It saw a large positive number, concluded the ends
     * had not swapped, and attacked its own goal for the whole second half.
     */
    const minimal: SensorFrame = {
      time: 0,
      robot: 2,
      team: 'lime',
      attackDirection: -1,
      start: true,
      ball: null,
      compass: { heading: 0 },
      gyro: { rate: 0 },
      lines: [],
      range: { front: null, back: null, left: null, right: null },
      encoders: [],
      camera: {
        goals: { cyan: null, yellow: null },
        goalBlobs: { cyan: [], yellow: [] },
        ball: null,
        fresh: false,
      },
      ballGate: { held: false },
      messages: [],
    };
    const b64 = Buffer.from(encodeServerMessage({ type: 'sensors', frame: minimal })).toString(
      'base64',
    );
    const script = `
import base64
from machine._proto import decode_server_message

frame = decode_server_message(base64.b64decode('${b64}'))["frame"]
assert frame["attackDirection"] == -1, frame["attackDirection"]
assert frame["robot"] == 2
print("OK")
`;
    const run = spawnSync('python3', ['-c', script], {
      cwd: `${import.meta.dirname}/../../../../python`,
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('OK');
  });

  test('TypeScript encodes SensorFrame -> Python decodes correctly', () => {
    const frame: SensorFrame = {
      time: 42.125,
      robot: 1,
      team: 'violet',
      attackDirection: 1,
      start: true,
      ball: { bearing: -0.75, strength: 0.65 },
      compass: { heading: 1.57 },
      gyro: { rate: -0.25 },
      lines: [
        { bearing: 0.0, surface: 'carpet', value: 0.1 },
        { bearing: 1.57, surface: 'line', value: 0.9 },
      ],
      range: { front: 500, back: 200, left: null, right: 350 },
      encoders: [1.2, 3.4, 5.6, 7.8],
      camera: {
        goals: { cyan: { bearing: 0.1, range: 800 }, yellow: null },
        goalBlobs: {
          cyan: [{ start: 0.05, end: 0.15, height: 0.2 }],
          yellow: [],
        },
        ball: { bearing: -0.75, range: 350 },
        fresh: true,
      },
      ballGate: { held: false },
      messages: [],
    };

    const encoded = encodeServerMessage({ type: 'sensors', frame });
    const b64 = Buffer.from(encoded).toString('base64');

    const pyScript = `
import base64
import json
import sys
from machine._proto import decode_server_message

raw = base64.b64decode('${b64}')
msg = decode_server_message(raw)
assert msg is not None, "Failed to decode server message"
assert msg["type"] == "sensors"
f = msg["frame"]
assert abs(f["time"] - 42.125) < 1e-4
assert f["robot"] == 1
assert f["team"] == "violet"
assert f["attackDirection"] == 1
assert f["start"] is True
for gone in ("clock", "playing", "returned", "kickoff"):
    assert gone not in f, gone
assert abs(f["ball"]["bearing"] - (-0.75)) < 1e-3
assert abs(f["ball"]["strength"] - 0.65) < 1e-3
assert abs(f["compass"]["heading"] - 1.57) < 1e-3
assert abs(f["gyro"]["rate"] - (-0.25)) < 1e-3
assert len(f["lines"]) == 2
assert f["lines"][0]["surface"] == "carpet"
assert f["lines"][1]["surface"] == "line"
assert abs(f["range"]["front"] - 500.0) < 1e-2
assert f["range"]["left"] is None
assert len(f["encoders"]) == 4
assert abs(f["encoders"][0] - 1.2) < 1e-3
assert abs(f["camera"]["goals"]["cyan"]["bearing"] - 0.1) < 1e-3
assert f["camera"]["goals"]["yellow"] is None
assert len(f["camera"]["goalBlobs"]["cyan"]) == 1
assert f["camera"]["fresh"] is True
print("OK")
`;

    const res = spawnSync('python3', ['-c', pyScript], {
      cwd: '/home/marc/programming/typescript/rcja-soccer-sim/python',
      encoding: 'utf-8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('OK');
  });

  test('Python encodes ActuatorFrame -> TypeScript decodes correctly', () => {
    const pyScript = `
import base64
from machine._proto import encode_client_message

cmd = {
    "motors": [0.25, -0.5, 0.75, -1.0],
    "dribbler": 0.6,
    "kicker": True,
    "say": {"msg": "cross_test"}
}
encoded = encode_client_message(cmd)
print(base64.b64encode(encoded).decode("ascii"))
`;

    const res = spawnSync('python3', ['-c', pyScript], {
      cwd: '/home/marc/programming/typescript/rcja-soccer-sim/python',
      encoding: 'utf-8',
    });

    expect(res.status).toBe(0);
    const b64 = res.stdout.trim();
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const decoded = decodeClientMessage(bytes);

    expect(decoded).not.toBeNull();
    expect(decoded!.motors.length).toBe(4);
    expect(decoded!.motors[0]!).toBeCloseTo(0.25, 2);
    expect(decoded!.motors[1]!).toBeCloseTo(-0.5, 2);
    expect(decoded!.motors[2]!).toBeCloseTo(0.75, 2);
    expect(decoded!.motors[3]!).toBeCloseTo(-1.0, 2);
    expect(decoded!.dribbler).toBeCloseTo(0.6, 2);
    expect(decoded!.kicker).toBe(true);
    expect(decoded!.say).toEqual({ msg: 'cross_test' });
  });
});
