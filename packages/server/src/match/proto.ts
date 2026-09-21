/**
 * High-performance, zero-dependency Protobuf wire encoder and decoder for RCJA Soccer.
 *
 * Implements the schema in `proto/soccer.proto` using pure typed arrays and DataView.
 * Provides binary serialization for SensorFrame, ActuatorFrame, and ServerMessage.
 */

import type {
  ActuatorFrame,
  BallReading,
  Blob,
  CameraReading,
  DisabledMessage,
  LineReading,
  RangeReading,
  SensorFrame,
  Sighting,
  Surface,
  TeamMessage,
} from './protocol';

// ------------------------------------------------------------------- Wire Writer

export class ProtoWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buffer.buffer);
  }

  private ensure(additional: number): void {
    const needed = this.offset + additional;
    if (needed > this.buffer.length) {
      let cap = this.buffer.length * 2;
      while (cap < needed) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buffer);
      this.buffer = next;
      this.view = new DataView(this.buffer.buffer);
    }
  }

  reset(): void {
    this.offset = 0;
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.offset);
  }

  tag(fieldNumber: number, wireType: number): void {
    this.varint((fieldNumber << 3) | wireType);
  }

  varint(value: number | bigint): void {
    this.ensure(10);
    if (typeof value === 'bigint') {
      let v = BigInt.asUintN(64, value);
      while (v > 127n) {
        this.buffer[this.offset++] = Number((v & 0x7fn) | 0x80n);
        v >>= 7n;
      }
      this.buffer[this.offset++] = Number(v & 0x7fn);
      return;
    }

    let v = value >>> 0;
    while (v > 127) {
      this.buffer[this.offset++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buffer[this.offset++] = v & 0x7f;
  }

  int32(fieldNumber: number, value: number): void {
    this.tag(fieldNumber, 0);
    if (value < 0) {
      // In proto3, negative int32 is serialized as 10-byte 64-bit two's complement
      this.varint(BigInt(value));
    } else {
      this.varint(value);
    }
  }

  bool(fieldNumber: number, value: boolean): void {
    this.tag(fieldNumber, 0);
    this.ensure(1);
    this.buffer[this.offset++] = value ? 1 : 0;
  }

  float(fieldNumber: number, value: number): void {
    this.tag(fieldNumber, 5);
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  double(fieldNumber: number, value: number): void {
    this.tag(fieldNumber, 1);
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  string(fieldNumber: number, value: string): void {
    this.tag(fieldNumber, 2);
    // Encode UTF-8
    const encoded = new TextEncoder().encode(value);
    this.varint(encoded.length);
    this.ensure(encoded.length);
    this.buffer.set(encoded, this.offset);
    this.offset += encoded.length;
  }

  bytes(fieldNumber: number, value: Uint8Array): void {
    this.tag(fieldNumber, 2);
    this.varint(value.length);
    this.ensure(value.length);
    this.buffer.set(value, this.offset);
    this.offset += value.length;
  }

  packedFloats(fieldNumber: number, values: readonly number[]): void {
    if (values.length === 0) return;
    this.tag(fieldNumber, 2);
    const byteLen = values.length * 4;
    this.varint(byteLen);
    this.ensure(byteLen);
    for (let i = 0; i < values.length; i++) {
      this.view.setFloat32(this.offset, values[i]!, true);
      this.offset += 4;
    }
  }
}

// ------------------------------------------------------------------- Wire Reader

export class ProtoReader {
  private view: DataView;
  private offset = 0;
  private readonly end: number;

  constructor(private readonly buffer: Uint8Array, offset = 0, length = buffer.length - offset) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = offset;
    this.end = offset + length;
  }

  hasMore(): boolean {
    return this.offset < this.end;
  }

  nextTag(): { fieldNumber: number; wireType: number } | null {
    if (this.offset >= this.end) return null;
    const key = this.varint();
    return {
      fieldNumber: key >>> 3,
      wireType: key & 0x07,
    };
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.offset < this.end) {
      const b = this.buffer[this.offset++]!;
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) {
        // Skip remaining varint bytes if 64-bit
        while (this.offset < this.end && (this.buffer[this.offset++]! & 0x80) !== 0);
        return result >>> 0;
      }
    }
    return result >>> 0;
  }

  int32(): number {
    const raw = this.varint();
    return (raw | 0);
  }

  bool(): boolean {
    return this.varint() !== 0;
  }

  float(): number {
    if (this.offset + 4 > this.end) return 0;
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  double(): number {
    if (this.offset + 8 > this.end) return 0;
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  string(): string {
    const len = this.varint();
    if (this.offset + len > this.end) return '';
    const slice = this.buffer.subarray(this.offset, this.offset + len);
    this.offset += len;
    return new TextDecoder().decode(slice);
  }

  bytes(): Uint8Array {
    const len = this.varint();
    if (this.offset + len > this.end) return new Uint8Array(0);
    const slice = this.buffer.subarray(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  subReader(): ProtoReader {
    const len = this.varint();
    const reader = new ProtoReader(this.buffer, this.offset, Math.min(len, this.end - this.offset));
    this.offset += len;
    return reader;
  }

  packedFloats(): number[] {
    const len = this.varint();
    const count = Math.floor(len / 4);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(this.float());
    }
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.offset += 8;
        break;
      case 2:
        const len = this.varint();
        this.offset += len;
        break;
      case 5:
        this.offset += 4;
        break;
      default:
        throw new Error(`Unsupported wire type ${wireType}`);
    }
  }
}

// ------------------------------------------------------------------- Encoders

function encodeBallReading(writer: ProtoWriter, ball: BallReading): void {
  const sub = new ProtoWriter(32);
  sub.float(1, ball.bearing);
  sub.float(2, ball.strength);
  writer.bytes(8, sub.finish());
}

function encodeLineReading(writer: ProtoWriter, line: LineReading): void {
  const sub = new ProtoWriter(32);
  sub.float(1, line.bearing);
  const surfaceEnum = line.surface === 'marking' ? 2 : line.surface === 'line' ? 1 : 0;
  if (surfaceEnum !== 0) sub.int32(2, surfaceEnum);
  sub.float(3, line.value);
  writer.bytes(11, sub.finish());
}

function encodeRangeReading(writer: ProtoWriter, r: RangeReading): void {
  const sub = new ProtoWriter(32);
  if (r.front !== null) sub.float(1, r.front);
  if (r.back !== null) sub.float(2, r.back);
  if (r.left !== null) sub.float(3, r.left);
  if (r.right !== null) sub.float(4, r.right);
  writer.bytes(12, sub.finish());
}

function encodeSighting(s: Sighting): Uint8Array {
  const sub = new ProtoWriter(16);
  sub.float(1, s.bearing);
  sub.float(2, s.range);
  return sub.finish();
}

function encodeBlob(b: Blob): Uint8Array {
  const sub = new ProtoWriter(24);
  sub.float(1, b.start);
  sub.float(2, b.end);
  sub.float(3, b.height);
  return sub.finish();
}

function encodeCameraReading(writer: ProtoWriter, c: CameraReading): void {
  const sub = new ProtoWriter(128);

  // goals
  if (c.goals.cyan || c.goals.yellow) {
    const gSub = new ProtoWriter(48);
    if (c.goals.cyan) gSub.bytes(1, encodeSighting(c.goals.cyan));
    if (c.goals.yellow) gSub.bytes(2, encodeSighting(c.goals.yellow));
    sub.bytes(1, gSub.finish());
  }

  // goalBlobs
  if (c.goalBlobs.cyan.length > 0 || c.goalBlobs.yellow.length > 0) {
    const gbSub = new ProtoWriter(64);
    for (const b of c.goalBlobs.cyan) gbSub.bytes(1, encodeBlob(b));
    for (const b of c.goalBlobs.yellow) gbSub.bytes(2, encodeBlob(b));
    sub.bytes(2, gbSub.finish());
  }

  // ball
  if (c.ball) sub.bytes(3, encodeSighting(c.ball));

  // fresh
  if (c.fresh) sub.bool(4, true);

  writer.bytes(14, sub.finish());
}

function encodeTeamMessage(writer: ProtoWriter, m: TeamMessage): void {
  const sub = new ProtoWriter(64);
  sub.int32(1, m.from);
  sub.string(2, JSON.stringify(m.body));
  sub.float(3, m.age);
  writer.bytes(16, sub.finish());
}

export function encodeSensorFrame(frame: SensorFrame): Uint8Array {
  const writer = new ProtoWriter(512);

  writer.double(17, frame.time);
  if (frame.start) writer.bool(18, true);
  writer.int32(2, frame.robot);
  writer.string(3, frame.team);
  writer.int32(4, frame.attackDirection);

  if (frame.ball) encodeBallReading(writer, frame.ball);

  // compass
  const compSub = new ProtoWriter(16);
  compSub.float(1, frame.compass.heading);
  writer.bytes(9, compSub.finish());

  // gyro
  const gyroSub = new ProtoWriter(16);
  gyroSub.float(1, frame.gyro.rate);
  writer.bytes(10, gyroSub.finish());

  // lines
  for (let i = 0; i < frame.lines.length; i++) {
    encodeLineReading(writer, frame.lines[i]!);
  }

  // range
  encodeRangeReading(writer, frame.range);

  // encoders
  writer.packedFloats(13, frame.encoders);

  // camera
  encodeCameraReading(writer, frame.camera);

  // ballGate
  if (frame.ballGate.held) {
    const bgSub = new ProtoWriter(8);
    bgSub.bool(1, true);
    writer.bytes(15, bgSub.finish());
  }

  // messages
  for (let i = 0; i < frame.messages.length; i++) {
    encodeTeamMessage(writer, frame.messages[i]!);
  }

  return writer.finish();
}

export function encodeDisabledMessage(msg: DisabledMessage): Uint8Array {
  const writer = new ProtoWriter(64);
  writer.string(1, msg.rule);
  writer.string(2, msg.reason);
  return writer.finish();
}

/** Encode ServerMessage: tag 1 = sensors (SensorFrame), tag 2 = disabled (DisabledMessage). */
export function encodeServerMessage(msg: { type: 'sensors'; frame: SensorFrame } | DisabledMessage): Uint8Array {
  const writer = new ProtoWriter(512);
  if ('type' in msg && msg.type === 'disabled') {
    writer.bytes(2, encodeDisabledMessage(msg));
  } else {
    writer.bytes(1, encodeSensorFrame(msg.frame));
  }
  return writer.finish();
}

export function encodeActuatorFrame(frame: ActuatorFrame): Uint8Array {
  const writer = new ProtoWriter(64);
  writer.packedFloats(1, frame.motors);
  if (frame.dribbler) writer.float(2, frame.dribbler);
  if (frame.kicker) writer.bool(3, true);
  if (frame.say !== undefined) writer.string(4, JSON.stringify(frame.say));
  return writer.finish();
}

/** Encode ClientMessage: tag 1 = command (ActuatorFrame). */
export function encodeClientMessage(frame: ActuatorFrame): Uint8Array {
  const writer = new ProtoWriter(64);
  writer.bytes(1, encodeActuatorFrame(frame));
  return writer.finish();
}

// ------------------------------------------------------------------- Decoders

export function decodeActuatorFrame(buffer: Uint8Array): ActuatorFrame {
  const reader = new ProtoReader(buffer);
  const out: ActuatorFrame = { motors: [] };

  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1:
        if (tag.wireType === 2) {
          out.motors = reader.packedFloats();
        } else if (tag.wireType === 5) {
          out.motors.push(reader.float());
        } else {
          reader.skip(tag.wireType);
        }
        break;
      case 2:
        out.dribbler = reader.float();
        break;
      case 3:
        out.kicker = reader.bool();
        break;
      case 4:
        try {
          out.say = JSON.parse(reader.string());
        } catch {
          out.say = undefined;
        }
        break;
      default:
        reader.skip(tag.wireType);
        break;
    }
  }
  return out;
}

export function decodeClientMessage(buffer: Uint8Array): ActuatorFrame | null {
  const reader = new ProtoReader(buffer);
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) {
      return decodeActuatorFrame(reader.bytes());
    }
    reader.skip(tag.wireType);
  }
  // If not wrapped in ClientMessage, attempt direct ActuatorFrame decode
  return decodeActuatorFrame(buffer);
}

function decodeBallReading(reader: ProtoReader): BallReading {
  let bearing = 0;
  let strength = 0;
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) bearing = reader.float();
    else if (tag.fieldNumber === 2) strength = reader.float();
    else reader.skip(tag.wireType);
  }
  return { bearing, strength };
}

function decodeLineReading(reader: ProtoReader): LineReading {
  let bearing = 0;
  let surface: Surface = 'carpet';
  let value = 0;
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) bearing = reader.float();
    else if (tag.fieldNumber === 2) {
      const e = reader.int32();
      surface = e === 2 ? 'marking' : e === 1 ? 'line' : 'carpet';
    } else if (tag.fieldNumber === 3) value = reader.float();
    else reader.skip(tag.wireType);
  }
  return { bearing, surface, value };
}

function decodeRangeReading(reader: ProtoReader): RangeReading {
  let front: number | null = null;
  let back: number | null = null;
  let left: number | null = null;
  let right: number | null = null;
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) front = reader.float();
    else if (tag.fieldNumber === 2) back = reader.float();
    else if (tag.fieldNumber === 3) left = reader.float();
    else if (tag.fieldNumber === 4) right = reader.float();
    else reader.skip(tag.wireType);
  }
  return { front, back, left, right };
}

function decodeSighting(reader: ProtoReader): Sighting {
  let bearing = 0;
  let range = 0;
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) bearing = reader.float();
    else if (tag.fieldNumber === 2) range = reader.float();
    else reader.skip(tag.wireType);
  }
  return { bearing, range };
}

function decodeBlob(reader: ProtoReader): Blob {
  let start = 0;
  let end = 0;
  let height = 0;
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) start = reader.float();
    else if (tag.fieldNumber === 2) end = reader.float();
    else if (tag.fieldNumber === 3) height = reader.float();
    else reader.skip(tag.wireType);
  }
  return { start, end, height };
}

function decodeCameraReading(reader: ProtoReader): CameraReading {
  const out: CameraReading = {
    goals: { cyan: null, yellow: null },
    goalBlobs: { cyan: [], yellow: [] },
    ball: null,
    fresh: false,
  };

  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: {
        const gReader = reader.subReader();
        while (gReader.hasMore()) {
          const gTag = gReader.nextTag();
          if (!gTag) break;
          if (gTag.fieldNumber === 1) out.goals.cyan = decodeSighting(gReader.subReader());
          else if (gTag.fieldNumber === 2) out.goals.yellow = decodeSighting(gReader.subReader());
          else gReader.skip(gTag.wireType);
        }
        break;
      }
      case 2: {
        const gbReader = reader.subReader();
        while (gbReader.hasMore()) {
          const gbTag = gbReader.nextTag();
          if (!gbTag) break;
          if (gbTag.fieldNumber === 1) out.goalBlobs.cyan.push(decodeBlob(gbReader.subReader()));
          else if (gbTag.fieldNumber === 2) out.goalBlobs.yellow.push(decodeBlob(gbReader.subReader()));
          else gbReader.skip(gbTag.wireType);
        }
        break;
      }
      case 3:
        out.ball = decodeSighting(reader.subReader());
        break;
      case 4:
        out.fresh = reader.bool();
        break;
      default:
        reader.skip(tag.wireType);
        break;
    }
  }
  return out;
}

function decodeTeamMessage(reader: ProtoReader): TeamMessage {
  let from = 0;
  let body: unknown = null;
  let age = 0;
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) from = reader.int32();
    else if (tag.fieldNumber === 2) {
      try {
        body = JSON.parse(reader.string());
      } catch {
        body = null;
      }
    } else if (tag.fieldNumber === 3) age = reader.float();
    else reader.skip(tag.wireType);
  }
  return { from, body, age };
}

export function decodeSensorFrame(buffer: Uint8Array): SensorFrame {
  const reader = new ProtoReader(buffer);
  const out: SensorFrame = {
    time: 0,
    start: false,
    robot: 1,
    team: 'violet',
    attackDirection: 1,
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

  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 17:
        out.time = reader.double();
        break;
      case 18:
        out.start = reader.bool();
        break;
      case 2:
        out.robot = reader.int32();
        break;
      case 3:
        out.team = reader.string();
        break;
      case 4:
        out.attackDirection = reader.int32() as 1 | -1;
        break;
      case 8:
        out.ball = decodeBallReading(reader.subReader());
        break;
      case 9: {
        const sub = reader.subReader();
        while (sub.hasMore()) {
          const sTag = sub.nextTag();
          if (!sTag) break;
          if (sTag.fieldNumber === 1) out.compass.heading = sub.float();
          else sub.skip(sTag.wireType);
        }
        break;
      }
      case 10: {
        const sub = reader.subReader();
        while (sub.hasMore()) {
          const sTag = sub.nextTag();
          if (!sTag) break;
          if (sTag.fieldNumber === 1) out.gyro.rate = sub.float();
          else sub.skip(sTag.wireType);
        }
        break;
      }
      case 11:
        out.lines.push(decodeLineReading(reader.subReader()));
        break;
      case 12:
        out.range = decodeRangeReading(reader.subReader());
        break;
      case 13:
        if (tag.wireType === 2) {
          out.encoders = reader.packedFloats();
        } else if (tag.wireType === 5) {
          out.encoders.push(reader.float());
        } else {
          reader.skip(tag.wireType);
        }
        break;
      case 14:
        out.camera = decodeCameraReading(reader.subReader());
        break;
      case 15: {
        const sub = reader.subReader();
        while (sub.hasMore()) {
          const sTag = sub.nextTag();
          if (!sTag) break;
          if (sTag.fieldNumber === 1) out.ballGate.held = sub.bool();
          else sub.skip(sTag.wireType);
        }
        break;
      }
      case 16:
        out.messages.push(decodeTeamMessage(reader.subReader()));
        break;
      default:
        reader.skip(tag.wireType);
        break;
    }
  }

  return out;
}

export function decodeDisabledMessage(buffer: Uint8Array): DisabledMessage {
  const reader = new ProtoReader(buffer);
  const out: DisabledMessage = {
    type: 'disabled',
    rule: '',
    reason: '',
  };
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1) out.rule = reader.string();
    else if (tag.fieldNumber === 2) out.reason = reader.string();
    else reader.skip(tag.wireType);
  }
  return out;
}

export function decodeServerMessage(
  buffer: Uint8Array,
): { type: 'sensors'; frame: SensorFrame } | DisabledMessage | null {
  const reader = new ProtoReader(buffer);
  while (reader.hasMore()) {
    const tag = reader.nextTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) {
      return { type: 'sensors', frame: decodeSensorFrame(reader.bytes()) };
    }
    if (tag.fieldNumber === 2 && tag.wireType === 2) {
      return decodeDisabledMessage(reader.bytes());
    }
    reader.skip(tag.wireType);
  }
  return null;
}
