"""Unit tests for machine.Pin and virtual GPIO."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

# Ensure python directory is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import machine
from machine import Pin
from machine._backend import Runtime


class TestPin(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime.get()
        # Mock connection so it doesn't try opening a real socket
        self.rt.connected = True
        self.rt.last_frame = {
            "lines": [{"value": 0.1}, {"value": 0.8}],
            "ballGate": {"held": True},
        }

    def test_pin_modes_and_constants(self) -> None:
        self.assertEqual(Pin.IN, 0)
        self.assertEqual(Pin.OUT, 1)
        self.assertEqual(Pin.OPEN_DRAIN, 2)

    def test_pin_output_write_read(self) -> None:
        p = Pin(13, Pin.OUT)
        p.value(1)
        self.assertEqual(p.value(), 1)
        self.assertEqual(self.rt.pin_values[13], 1)

        p.off()
        self.assertEqual(p.value(), 0)
        self.assertEqual(self.rt.pin_values[13], 0)

        p.on()
        self.assertEqual(p.value(), 1)
        self.assertEqual(self.rt.pin_values[13], 1)

    def test_pin_line_threshold(self) -> None:
        # Default line pins: 32 is line 0 (val 0.1), 33 is line 1 (val 0.8)
        p0 = Pin(32, Pin.IN)
        p1 = Pin(33, Pin.IN)

        self.assertEqual(p0.value(), 0)  # 0.1 < 0.45
        self.assertEqual(p1.value(), 1)  # 0.8 > 0.45

    def test_ball_gate_pin(self) -> None:
        p_gate = Pin(28, Pin.IN)
        self.assertEqual(p_gate.value(), 1)


if __name__ == "__main__":
    unittest.main()
