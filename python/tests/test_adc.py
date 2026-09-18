"""Unit tests for machine.ADC and virtual sensor reading."""

from __future__ import annotations

import math
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import machine
from machine import ADC, Pin
from machine._backend import Runtime


class TestADC(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime.get()
        self.rt.connected = True
        self.rt.last_frame = {
            "lines": [{"value": 0.5}, {"value": 1.0}],
            "ball": {"strength": 0.75, "bearing": 0.0},
            "compass": {"heading": 0.0},
            "gyro": {"rate": 0.0},
            "range": {"front": 1200},
        }

    def test_adc_line_reading(self) -> None:
        adc0 = ADC(Pin(32))
        adc1 = ADC(Pin(33))

        self.assertAlmostEqual(adc0.read_u16(), int(0.5 * 65535), delta=10)
        self.assertEqual(adc1.read_u16(), 65535)

    def test_adc_ball_strength_and_bearing(self) -> None:
        strength_adc = ADC(Pin(4))
        bearing_adc = ADC(Pin(5))

        self.assertAlmostEqual(strength_adc.read_u16(), int(0.75 * 65535), delta=10)
        # Bearing 0.0 rad -> normalized (0 + pi) / (2pi) = 0.5 -> ~32767
        self.assertAlmostEqual(bearing_adc.read_u16(), 32767, delta=10)

    def test_adc_ultrasonic_distance(self) -> None:
        # Default front ultrasonic is Pin 2
        front_adc = ADC(Pin(2))
        # 1200mm / 2400mm = 0.5 -> ~32767
        self.assertAlmostEqual(front_adc.read_u16(), 32767, delta=10)


if __name__ == "__main__":
    unittest.main()
