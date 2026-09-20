"""The camera is a device on a serial port, not a field in a frame.

A 360 degree view means a smart camera running the team's own vision code and
sending the answer down a wire. These tests pin the wire: the framing, the
checksum, the units, and the one behaviour that carries the lesson - that a
30fps camera against a 50Hz loop leaves the line quiet on most ticks, and that
silence is how a board finds out.
"""

from __future__ import annotations

import struct
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine import UART
from machine._backend import CAMERA_SYNC, _crc8
from support import connected_singleton, sensor_frame, teardown


def parse(packet: bytes) -> dict:
    """The robot half of the protocol, written out so the test proves both."""
    assert packet[:2] == CAMERA_SYNC, "no sync bytes"
    length = packet[2]
    payload = packet[3 : 3 + length]
    assert packet[3 + length] == _crc8(payload), "checksum mismatch"

    flags, n_blobs, present = struct.unpack_from("<BBB", payload, 0)
    cb, cr, yb, yr, bb, br = struct.unpack_from("<hHhHhH", payload, 3)
    blobs = []
    for i in range(n_blobs):
        colour, start, end, height = struct.unpack_from("<BhhH", payload, 15 + i * 7)
        blobs.append(
            {
                "colour": "cyan" if colour == 0 else "yellow",
                "start": start / 1000.0,
                "end": end / 1000.0,
                "height": height / 1000.0,
            }
        )
    return {
        "truncated": bool(flags & 0x01),
        "cyan": {"bearing": cb / 1000.0, "range": float(cr)} if present & 0x01 else None,
        "yellow": {"bearing": yb / 1000.0, "range": float(yr)} if present & 0x02 else None,
        "ball": {"bearing": bb / 1000.0, "range": float(br)} if present & 0x04 else None,
        "blobs": blobs,
        "size": 4 + length,
    }


def camera(fresh: bool, **parts) -> dict:
    reading = {
        "goals": {"cyan": None, "yellow": None},
        "goalBlobs": {"cyan": [], "yellow": []},
        "ball": None,
        "fresh": fresh,
    }
    reading.update(parts)
    return reading


class TestCameraPackets(unittest.TestCase):
    def tearDown(self) -> None:
        teardown()

    def test_a_fresh_frame_arrives_as_one_checksummed_packet(self) -> None:
        seen = camera(
            True,
            goals={"cyan": {"bearing": -1.25, "range": 1830.0}, "yellow": None},
            ball={"bearing": 0.4, "range": 620.0},
        )
        rt, _ = connected_singleton(
            [sensor_frame(0.0)["frame"], sensor_frame(0.02, camera=seen)["frame"]]
        )
        uart = UART(0, baudrate=115200)
        time.sleep_ms(20)

        packet = parse(uart.read())
        self.assertAlmostEqual(packet["cyan"]["bearing"], -1.25, places=3)
        self.assertEqual(packet["cyan"]["range"], 1830.0)
        self.assertIsNone(packet["yellow"])
        self.assertAlmostEqual(packet["ball"]["bearing"], 0.4, places=3)
        self.assertEqual(packet["ball"]["range"], 620.0)

    def test_goal_blobs_survive_the_wire_including_an_end_past_pi(self) -> None:
        # `end` is deliberately `start` plus the width rather than wrapped, so
        # it can exceed pi. Milliradians in an int16 reach 32.7, which is the
        # reason that contract still holds once it is bytes.
        blobs = {
            "cyan": [{"start": 2.9, "end": 3.4, "height": 0.078}],
            "yellow": [{"start": -0.4, "end": -0.1, "height": 0.052}],
        }
        rt, _ = connected_singleton(
            [sensor_frame(0.0)["frame"], sensor_frame(0.02, camera=camera(True, goalBlobs=blobs))["frame"]]
        )
        uart = UART(0)
        time.sleep_ms(20)

        packet = parse(uart.read())
        self.assertEqual(len(packet["blobs"]), 2)
        cyan = packet["blobs"][0]
        self.assertEqual(cyan["colour"], "cyan")
        self.assertAlmostEqual(cyan["end"], 3.4, places=3)
        self.assertGreater(cyan["end"], 3.14159)
        self.assertAlmostEqual(cyan["height"], 0.078, places=3)
        self.assertEqual(packet["blobs"][1]["colour"], "yellow")

    def test_nothing_arrives_on_a_stale_frame(self) -> None:
        # The whole point. A camera at 30fps has no picture for roughly two
        # ticks in five, and on a board what you get is a quiet serial line -
        # not a flag somebody set for you.
        fresh = camera(True, ball={"bearing": 0.0, "range": 500.0})
        stale = camera(False, ball={"bearing": 0.0, "range": 500.0})
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0)["frame"],
                sensor_frame(0.02, camera=fresh)["frame"],
                sensor_frame(0.04, camera=stale)["frame"],
                sensor_frame(0.06, camera=stale)["frame"],
            ]
        )
        uart = UART(0)

        time.sleep_ms(20)
        self.assertGreater(uart.any(), 0)
        uart.read()

        time.sleep_ms(20)
        self.assertEqual(uart.any(), 0)
        self.assertIsNone(uart.read())

        time.sleep_ms(20)
        self.assertEqual(uart.any(), 0)

    def test_a_port_nobody_opened_is_never_filled(self) -> None:
        rt, _ = connected_singleton(
            [sensor_frame(0.0)["frame"], sensor_frame(0.02, camera=camera(True))["frame"]]
        )
        time.sleep_ms(20)
        self.assertEqual(rt._uart_rx.get(0, b""), b"")

    def test_too_many_blobs_are_capped_and_flagged(self) -> None:
        many = {"cyan": [{"start": i / 100, "end": i / 100 + 0.05, "height": 0.05} for i in range(20)],
                "yellow": []}
        rt, _ = connected_singleton(
            [sensor_frame(0.0)["frame"], sensor_frame(0.02, camera=camera(True, goalBlobs=many))["frame"]]
        )
        uart = UART(0)
        time.sleep_ms(20)

        packet = parse(uart.read())
        self.assertEqual(len(packet["blobs"]), 16)
        self.assertTrue(packet["truncated"])
        # `len` is one byte, and this is what that buys.
        self.assertLessEqual(packet["size"], 259)


if __name__ == "__main__":
    unittest.main()
