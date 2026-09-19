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
from machine.config import PinConfig, set_config


class TestADC(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime.get()
        self.rt.connected = True
        self.rt.last_frame = {
            "lines": [{"value": 0.5}, {"value": 1.0}],
            "ball": {"strength": 0.75, "bearing": 0.0},
            "compass": {"heading": 1.5},
            "gyro": {"rate": 5.0},
            "range": {"front": 1200, "back": 2000, "left": 300, "right": 1800},
        }
        set_config(PinConfig())

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

    def test_adc_ultrasonic_left_is_not_shadowed_by_ball_strength(self) -> None:
        # Left ultrasonic (Pin 9) used to share Pin 4 with ball_strength, so it
        # always read back the ball reading instead of the 300mm distance.
        left_adc = ADC(Pin(9))
        self.assertAlmostEqual(left_adc.read_u16(), int(300 / 2400 * 65535), delta=10)

    def test_adc_compass_is_not_shadowed_by_ir_ring(self) -> None:
        # Compass (Pin 21) used to share its pin with ir_ring zone 2, so it
        # always read back a directional IR response instead of the heading.
        compass_adc = ADC(Pin(21))
        expected = int(((1.5 + math.pi) / (2 * math.pi)) * 65535)
        self.assertAlmostEqual(compass_adc.read_u16(), expected, delta=10)

    def test_adc_gyro_is_not_shadowed_by_ir_ring(self) -> None:
        # Gyro (Pin 22) used to share its pin with ir_ring zone 3, so it
        # always read back a directional IR response instead of the rate.
        gyro_adc = ADC(Pin(22))
        expected = int(((5.0 + 10.0) / 20.0) * 65535)
        self.assertAlmostEqual(gyro_adc.read_u16(), expected, delta=10)

    def test_adc_ir_ring_zones_read_directional_response_not_ball(self) -> None:
        # ir_ring zones 0 and 1 (now Pins 0, 6) used to share their pins with
        # ball_strength/ball_bearing (Pins 4, 5), so they always read back the
        # raw ball reading instead of a per-zone directional response. Ball is
        # dead ahead (bearing 0.0), so zone 0 (0 deg) should see it in full and
        # zone 2 (90 deg) should see nothing.
        zone0 = ADC(Pin(0))
        zone2 = ADC(Pin(7))
        self.assertAlmostEqual(zone0.read_u16(), int(0.75 * 65535), delta=10)
        self.assertEqual(zone2.read_u16(), 0)


if __name__ == "__main__":
    unittest.main()
