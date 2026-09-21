"""Pure-Python, zero-dependency Protobuf wire encoder and decoder for RCJA Soccer.

Implements the protobuf schema in ``proto/soccer.proto`` using standard library
``struct`` and ``json``. Ensures the built ``rcja-soccer`` wheel has zero external
dependencies (dependencies = []) while providing high-performance binary IPC.
"""

from __future__ import annotations

import json
import struct
from typing import Any


class ProtoWriter:
    """Encodes protobuf wire format into a bytearray."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def finish(self) -> bytes:
        return bytes(self._buf)

    def tag(self, field_number: int, wire_type: int) -> None:
        self.varint((field_number << 3) | wire_type)

    def varint(self, value: int) -> None:
        if value < 0:
            value = (1 << 64) + value
        v = value
        while v > 0x7F:
            self._buf.append((v & 0x7F) | 0x80)
            v >>= 7
        self._buf.append(v & 0x7F)

    def int32(self, field_number: int, value: int) -> None:
        self.tag(field_number, 0)
        self.varint(value)

    def bool(self, field_number: int, value: bool) -> None:
        self.tag(field_number, 0)
        self._buf.append(1 if value else 0)

    def float(self, field_number: int, value: float) -> None:
        self.tag(field_number, 5)
        self._buf.extend(struct.pack("<f", value))

    def double(self, field_number: int, value: float) -> None:
        self.tag(field_number, 1)
        self._buf.extend(struct.pack("<d", value))

    def string(self, field_number: int, value: str) -> None:
        self.tag(field_number, 2)
        raw = value.encode("utf-8")
        self.varint(len(raw))
        self._buf.extend(raw)

    def bytes(self, field_number: int, value: bytes) -> None:
        self.tag(field_number, 2)
        self.varint(len(value))
        self._buf.extend(value)

    def packed_floats(self, field_number: int, values: list[float]) -> None:
        if not values:
            return
        self.tag(field_number, 2)
        raw = struct.pack(f"<{len(values)}f", *values)
        self.varint(len(raw))
        self._buf.extend(raw)


class ProtoReader:
    """Decodes protobuf wire format from bytes or memoryview."""

    def __init__(self, data: bytes | bytearray | memoryview, offset: int = 0, length: int | None = None) -> None:
        self._view = memoryview(data)
        self._offset = offset
        self._end = offset + (len(data) if length is None else length)

    def has_more(self) -> bool:
        return self._offset < self._end

    def next_tag(self) -> tuple[int, int] | None:
        if self._offset >= self._end:
            return None
        key = self.varint()
        return key >> 3, key & 0x07

    def varint(self) -> int:
        result = 0
        shift = 0
        while self._offset < self._end:
            b = self._view[self._offset]
            self._offset += 1
            result |= (b & 0x7F) << shift
            if (b & 0x80) == 0:
                return result
            shift += 7
            if shift > 64:
                while self._offset < self._end and (self._view[self._offset] & 0x80) != 0:
                    self._offset += 1
                return result
        return result

    def int32(self) -> int:
        """A proto3 `int32`, which is sign-extended to *64* bits on the wire.

        Sign-extending from 32 here instead is wrong for every negative value
        and was: `attackDirection: -1` arrived as 18446744069414584319, and it
        went unnoticed for as long as nothing in Python read the field. The
        first thing that did - an end switch a human flips at half time - got a
        large positive number, never saw the end change, and attacked its own
        goal for the whole second half.
        """
        val = self.varint()
        if val >= (1 << 63):
            val -= 1 << 64
        return val

    def bool(self) -> bool:
        return self.varint() != 0

    def float(self) -> float:
        if self._offset + 4 > self._end:
            return 0.0
        val = struct.unpack_from("<f", self._view, self._offset)[0]
        self._offset += 4
        return val

    def double(self) -> float:
        if self._offset + 8 > self._end:
            return 0.0
        val = struct.unpack_from("<d", self._view, self._offset)[0]
        self._offset += 8
        return val

    def string(self) -> str:
        length = self.varint()
        if self._offset + length > self._end:
            return ""
        s = bytes(self._view[self._offset : self._offset + length]).decode("utf-8", errors="replace")
        self._offset += length
        return s

    def bytes(self) -> bytes:
        length = self.varint()
        if self._offset + length > self._end:
            return b""
        raw = bytes(self._view[self._offset : self._offset + length])
        self._offset += length
        return raw

    def sub_reader(self) -> ProtoReader:
        length = self.varint()
        end = min(self._offset + length, self._end)
        sub = ProtoReader(self._view, self._offset, end - self._offset)
        self._offset = end
        return sub

    def packed_floats(self) -> list[float]:
        length = self.varint()
        count = length // 4
        if count == 0:
            return []
        floats = list(struct.unpack_from(f"<{count}f", self._view, self._offset))
        self._offset += count * 4
        return floats

    def skip(self, wire_type: int) -> None:
        if wire_type == 0:
            self.varint()
        elif wire_type == 1:
            self._offset += 8
        elif wire_type == 2:
            length = self.varint()
            self._offset += length
        elif wire_type == 5:
            self._offset += 4
        else:
            raise ValueError(f"Unsupported wire type {wire_type}")


# -----------------------------------------------------------------------------
# Encoding
# -----------------------------------------------------------------------------

def encode_actuator_frame(frame: dict[str, Any]) -> bytes:
    """Encode ActuatorFrame into Protobuf bytes."""
    writer = ProtoWriter()
    motors = frame.get("motors", [])
    if motors:
        writer.packed_floats(1, [float(m) for m in motors])
    dribbler = frame.get("dribbler", 0.0)
    if dribbler:
        writer.float(2, float(dribbler))
    if frame.get("kicker"):
        writer.bool(3, True)
    if "say" in frame and frame["say"] is not None:
        writer.string(4, json.dumps(frame["say"]))
    return writer.finish()


def encode_client_message(frame: dict[str, Any]) -> bytes:
    """Encode ClientMessage with command = ActuatorFrame."""
    writer = ProtoWriter()
    writer.bytes(1, encode_actuator_frame(frame))
    return writer.finish()


# -----------------------------------------------------------------------------
# Decoding
# -----------------------------------------------------------------------------

def _decode_sighting(reader: ProtoReader) -> dict[str, float]:
    bearing = 0.0
    s_range = 0.0
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            bearing = reader.float()
        elif fn == 2:
            s_range = reader.float()
        else:
            reader.skip(wt)
    return {"bearing": bearing, "range": s_range}


def _decode_blob(reader: ProtoReader) -> dict[str, float]:
    start = 0.0
    end = 0.0
    height = 0.0
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            start = reader.float()
        elif fn == 2:
            end = reader.float()
        elif fn == 3:
            height = reader.float()
        else:
            reader.skip(wt)
    return {"start": start, "end": end, "height": height}


def _decode_camera(reader: ProtoReader) -> dict[str, Any]:
    out: dict[str, Any] = {
        "goals": {"cyan": None, "yellow": None},
        "goalBlobs": {"cyan": [], "yellow": []},
        "ball": None,
        "fresh": False,
    }
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            g_sub = reader.sub_reader()
            while g_sub.has_more():
                gt = g_sub.next_tag()
                if not gt:
                    break
                g_fn, g_wt = gt
                if g_fn == 1:
                    out["goals"]["cyan"] = _decode_sighting(g_sub.sub_reader())
                elif g_fn == 2:
                    out["goals"]["yellow"] = _decode_sighting(g_sub.sub_reader())
                else:
                    g_sub.skip(g_wt)
        elif fn == 2:
            gb_sub = reader.sub_reader()
            while gb_sub.has_more():
                gbt = gb_sub.next_tag()
                if not gbt:
                    break
                gb_fn, gb_wt = gbt
                if gb_fn == 1:
                    out["goalBlobs"]["cyan"].append(_decode_blob(gb_sub.sub_reader()))
                elif gb_fn == 2:
                    out["goalBlobs"]["yellow"].append(_decode_blob(gb_sub.sub_reader()))
                else:
                    gb_sub.skip(gb_wt)
        elif fn == 3:
            out["ball"] = _decode_sighting(reader.sub_reader())
        elif fn == 4:
            out["fresh"] = reader.bool()
        else:
            reader.skip(wt)
    return out


def _decode_line(reader: ProtoReader) -> dict[str, Any]:
    bearing = 0.0
    surface = "carpet"
    value = 0.0
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            bearing = reader.float()
        elif fn == 2:
            s_enum = reader.int32()
            surface = "marking" if s_enum == 2 else "line" if s_enum == 1 else "carpet"
        elif fn == 3:
            value = reader.float()
        else:
            reader.skip(wt)
    return {"bearing": bearing, "surface": surface, "value": value}


def _decode_range(reader: ProtoReader) -> dict[str, float | None]:
    out: dict[str, float | None] = {"front": None, "back": None, "left": None, "right": None}
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            out["front"] = reader.float()
        elif fn == 2:
            out["back"] = reader.float()
        elif fn == 3:
            out["left"] = reader.float()
        elif fn == 4:
            out["right"] = reader.float()
        else:
            reader.skip(wt)
    return out


def _decode_ball(reader: ProtoReader) -> dict[str, float]:
    bearing = 0.0
    strength = 0.0
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            bearing = reader.float()
        elif fn == 2:
            strength = reader.float()
        else:
            reader.skip(wt)
    return {"bearing": bearing, "strength": strength}


def _decode_team_message(reader: ProtoReader) -> dict[str, Any]:
    from_id = 0
    body: Any = None
    age = 0.0
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            from_id = reader.int32()
        elif fn == 2:
            try:
                body = json.loads(reader.string())
            except Exception:
                body = None
        elif fn == 3:
            age = reader.float()
        else:
            reader.skip(wt)
    return {"from": from_id, "body": body, "age": age}


def decode_sensor_frame(data: bytes | bytearray | memoryview) -> dict[str, Any]:
    """Decode Protobuf bytes into a SensorFrame dictionary."""
    reader = ProtoReader(data)
    out: dict[str, Any] = {
        "time": 0.0,
        "start": False,
        "robot": 1,
        "team": "violet",
        "attackDirection": 1,
        "ball": None,
        "compass": {"heading": 0.0},
        "gyro": {"rate": 0.0},
        "lines": [],
        "range": {"front": None, "back": None, "left": None, "right": None},
        "encoders": [],
        "camera": {
            "goals": {"cyan": None, "yellow": None},
            "goalBlobs": {"cyan": [], "yellow": []},
            "ball": None,
            "fresh": False,
        },
        "ballGate": {"held": False},
        "messages": [],
    }

    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 17:
            out["time"] = reader.double()
        elif fn == 18:
            out["start"] = reader.bool()
        elif fn == 2:
            out["robot"] = reader.int32()
        elif fn == 3:
            out["team"] = reader.string()
        elif fn == 4:
            out["attackDirection"] = reader.int32()
        elif fn == 8:
            out["ball"] = _decode_ball(reader.sub_reader())
        elif fn == 9:
            c_sub = reader.sub_reader()
            while c_sub.has_more():
                ct = c_sub.next_tag()
                if not ct:
                    break
                if ct[0] == 1:
                    out["compass"]["heading"] = c_sub.float()
                else:
                    c_sub.skip(ct[1])
        elif fn == 10:
            g_sub = reader.sub_reader()
            while g_sub.has_more():
                gt = g_sub.next_tag()
                if not gt:
                    break
                if gt[0] == 1:
                    out["gyro"]["rate"] = g_sub.float()
                else:
                    g_sub.skip(gt[1])
        elif fn == 11:
            out["lines"].append(_decode_line(reader.sub_reader()))
        elif fn == 12:
            out["range"] = _decode_range(reader.sub_reader())
        elif fn == 13:
            if wt == 2:
                out["encoders"] = reader.packed_floats()
            elif wt == 5:
                out["encoders"].append(reader.float())
            else:
                reader.skip(wt)
        elif fn == 14:
            out["camera"] = _decode_camera(reader.sub_reader())
        elif fn == 15:
            bg_sub = reader.sub_reader()
            while bg_sub.has_more():
                bgt = bg_sub.next_tag()
                if not bgt:
                    break
                if bgt[0] == 1:
                    out["ballGate"]["held"] = bg_sub.bool()
                else:
                    bg_sub.skip(bgt[1])
        elif fn == 16:
            out["messages"].append(_decode_team_message(reader.sub_reader()))
        else:
            reader.skip(wt)

    return out


def decode_disabled_message(data: bytes | bytearray | memoryview) -> dict[str, Any]:
    """Decode Protobuf bytes into a DisabledMessage dictionary."""
    reader = ProtoReader(data)
    out: dict[str, Any] = {"type": "disabled", "rule": "", "reason": ""}
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1:
            out["rule"] = reader.string()
        elif fn == 2:
            out["reason"] = reader.string()
        else:
            reader.skip(wt)
    return out


def decode_server_message(data: bytes | bytearray | memoryview) -> dict[str, Any] | None:
    """Decode ServerMessage: tag 1 = sensors, tag 2 = disabled."""
    reader = ProtoReader(data)
    while reader.has_more():
        tag = reader.next_tag()
        if not tag:
            break
        fn, wt = tag
        if fn == 1 and wt == 2:
            return {"type": "sensors", "frame": decode_sensor_frame(reader.bytes())}
        if fn == 2 and wt == 2:
            return decode_disabled_message(reader.bytes())
        reader.skip(wt)
    return None
