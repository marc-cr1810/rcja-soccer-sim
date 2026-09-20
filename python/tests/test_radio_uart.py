"""The team radio is a transparent serial link, and rule 4.2.5 is what it carries.

Whatever a robot writes comes out of its team mate's UART unchanged. That makes
the two interesting cases the ones a real link has: what arrives, exactly once,
and what a write turns into.
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine import UART
from support import connected_singleton, sensor_frame, teardown


def said(body, sender: int = 2, age: float = 0.0) -> list[dict]:
    return [{"from": sender, "body": body, "age": age}]


class TestRadio(unittest.TestCase):
    def tearDown(self) -> None:
        teardown()

    def test_a_message_arrives_as_one_json_line(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0)["frame"],
                sensor_frame(0.02, messages=said({"ball": [120.0, -40.0]}))["frame"],
            ]
        )
        uart = UART(1, baudrate=9600)
        time.sleep_ms(20)

        line = uart.readline()
        self.assertEqual(json.loads(line), {"from": 2, "body": {"ball": [120.0, -40.0]}})
        self.assertIsNone(uart.readline())

    def test_a_message_that_lives_for_its_whole_ttl_arrives_once(self) -> None:
        # `messages` is redelivered every tick for the 0.4s a message lives, so
        # a naive copy would put the same sentence on the wire twenty times.
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0)["frame"],
                sensor_frame(0.02, messages=said("KICK_OFF_WAIT", age=0.0))["frame"],
                sensor_frame(0.04, messages=said("KICK_OFF_WAIT", age=0.02))["frame"],
                sensor_frame(0.06, messages=said("KICK_OFF_WAIT", age=0.04))["frame"],
            ]
        )
        uart = UART(1)
        for _ in range(3):
            time.sleep_ms(20)

        lines = [line for line in uart.read().split(b"\n") if line]
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["body"], "KICK_OFF_WAIT")

    def test_a_frozen_clock_does_not_resend_the_same_message(self) -> None:
        """The one an age-based rule gets wrong, and it gets it wrong live.

        At a stoppage the match clock stops, so every frame reports the same
        message as `age == 0.0`. Deduplicating on age calls each of those new;
        a single `write()` was measured arriving ninety times before this was
        keyed on `clock - age` instead.
        """
        rt, _ = connected_singleton(
            [
                sensor_frame(4.0)["frame"],
                sensor_frame(4.0, messages=said("HELD", age=0.0))["frame"],
                sensor_frame(4.0, messages=said("HELD", age=0.0))["frame"],
                sensor_frame(4.0, messages=said("HELD", age=0.0))["frame"],
            ]
        )
        uart = UART(1)
        for _ in range(3):
            time.sleep_ms(20)

        lines = [line for line in (uart.read() or b"").split(b"\n") if line]
        self.assertEqual(len(lines), 1)

    def test_a_second_message_from_the_same_robot_arrives_too(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0)["frame"],
                sensor_frame(0.20, messages=said("FIRST", age=0.10))["frame"],
                sensor_frame(0.22, messages=said("SECOND", age=0.0))["frame"],
            ]
        )
        uart = UART(1)
        time.sleep_ms(20)
        time.sleep_ms(20)

        bodies = [json.loads(line)["body"] for line in uart.read().split(b"\n") if line]
        self.assertEqual(bodies, ["FIRST", "SECOND"])

    def test_writing_a_json_line_becomes_this_tick_s_say(self) -> None:
        rt, channel = connected_singleton()
        uart = UART(1)

        uart.write(json.dumps({"ball": [10.0, 20.0]}).encode() + b"\n")
        time.sleep_ms(20)

        command = channel.sent[-1]["frame"]
        self.assertEqual(command["say"], {"ball": [10.0, 20.0]})

    def test_a_half_written_line_waits_for_its_newline(self) -> None:
        # A serial write is bytes, not a message. Half a line is half a line.
        rt, channel = connected_singleton()
        uart = UART(1)

        uart.write(b'{"half": ')
        time.sleep_ms(20)
        self.assertNotIn("say", channel.sent[-1]["frame"])

        uart.write(b'true}\n')
        time.sleep_ms(20)
        self.assertEqual(channel.sent[-1]["frame"]["say"], {"half": True})

    def test_rubbish_on_the_radio_is_not_a_crash(self) -> None:
        rt, channel = connected_singleton()
        uart = UART(1)

        uart.write(b"not json at all\n")
        time.sleep_ms(20)
        self.assertNotIn("say", channel.sent[-1]["frame"])


if __name__ == "__main__":
    unittest.main()
