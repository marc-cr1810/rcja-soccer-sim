"""Wheel encoders, as counts on two pins rather than a number in a frame.

The simulator knows accumulated rotation exactly. An encoder does not hand you
that - it hands you edges, and you count them. These tests pin that the count
is right, that the direction is recoverable from the two lines the way a real
quadrature decoder recovers it, and that nothing is lost to rounding on a wheel
turning slowly.
"""

from __future__ import annotations

import math
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine import Pin
from machine.constants import DEFAULT_ENCODER_CPR
from support import connected_singleton, sensor_frame, teardown

TURN = 2.0 * math.pi


def spinning(*rotations: float) -> list[dict]:
    """Frames whose first wheel has turned through each of these, in radians."""
    return [
        sensor_frame(0.02 * i, encoders=[r, 0.0, 0.0, 0.0])["frame"]
        for i, r in enumerate(rotations)
    ]


class Decoder:
    """What a team writes: count edges on A, read B to know which way."""

    def __init__(self, a: int, b: int) -> None:
        self.count = 0
        self.b = Pin(b, Pin.IN)
        Pin(a, Pin.IN).irq(self._edge, Pin.IRQ_RISING | Pin.IRQ_FALLING)

    def _edge(self, pin: Pin) -> None:
        self.count += 1 if pin.value() != self.b.value() else -1


class TestEncoders(unittest.TestCase):
    def tearDown(self) -> None:
        teardown()

    def test_one_revolution_is_half_the_cpr_in_edges_on_one_line(self) -> None:
        # A full cycle of the two lines is four counts and toggles each line
        # twice, so a handler watching A alone sees half of them. That is 2x
        # decoding, and it is what most teams actually run.
        rt, _ = connected_singleton(spinning(0.0, TURN))
        decoder = Decoder(43, 44)
        time.sleep_ms(20)

        self.assertEqual(abs(decoder.count), DEFAULT_ENCODER_CPR // 2)

    def test_direction_comes_out_of_the_two_lines(self) -> None:
        rt, _ = connected_singleton(spinning(0.0, TURN, 0.0))
        forward = Decoder(43, 44)
        time.sleep_ms(20)
        went_out = forward.count
        time.sleep_ms(20)
        came_back = forward.count - went_out

        self.assertGreater(went_out, 0)
        self.assertLess(came_back, 0)
        self.assertEqual(forward.count, 0)

    def test_a_slow_wheel_is_carried_rather_than_rounded_away(self) -> None:
        # A tenth of a count per frame is not zero counts forever. Without the
        # carry a wheel creeping along reads as stopped, which is the silent
        # kind of wrong.
        step = TURN / DEFAULT_ENCODER_CPR / 10.0
        rt, _ = connected_singleton(spinning(*[step * i for i in range(41)]))
        decoder = Decoder(43, 44)
        for _ in range(40):
            time.sleep_ms(20)

        # 40 frames x 0.1 counts = 4 counts, half of them on A.
        self.assertEqual(decoder.count, 2)

    def test_the_lines_can_be_read_without_an_interrupt(self) -> None:
        rt, _ = connected_singleton(spinning(0.0, TURN / 4))
        a, b = Pin(43, Pin.IN), Pin(44, Pin.IN)
        time.sleep_ms(20)

        self.assertIn(a.value(), (0, 1))
        self.assertIn(b.value(), (0, 1))

    def test_a_new_match_is_a_fresh_baseline_not_a_wheel_spinning_back(self) -> None:
        # The server's totals restart at zero with each match. Read as motion,
        # that is the whole last match replayed backwards - one callback per
        # edge, all in one frame - and a robot busy with those answers nothing.
        frames = spinning(0.0, 50 * TURN, 50 * TURN)
        frames.append(sensor_frame(0.01, encoders=[0.0, 0.0, 0.0, 0.0])["frame"])
        frames.append(sensor_frame(0.03, encoders=[TURN, 0.0, 0.0, 0.0])["frame"])
        rt, _ = connected_singleton(frames)
        decoder = Decoder(43, 44)
        for _ in range(2):
            time.sleep_ms(20)
        before = decoder.count

        time.sleep_ms(20)
        self.assertEqual(decoder.count, before)

        time.sleep_ms(20)
        self.assertEqual(decoder.count - before, DEFAULT_ENCODER_CPR // 2)

    def test_no_handler_means_no_work(self) -> None:
        # Several hundred callbacks a second for a program that never asked is
        # pure cost, and most programs never ask.
        rt, _ = connected_singleton(spinning(0.0, TURN))
        time.sleep_ms(20)

        from machine import _sched

        self.assertEqual(_sched._edges, [])


if __name__ == "__main__":
    unittest.main()
