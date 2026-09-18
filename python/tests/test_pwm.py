"""Unit tests for machine.PWM and motor driver decoding."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import machine
from machine import Pin, PWM
from machine._backend import Runtime


class TestPWM(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime.get()
        self.rt.connected = True
        self.rt.pwm_duties.clear()
        self.rt.pin_values.clear()

    def test_pwm_duty_and_freq(self) -> None:
        pwm = PWM(Pin(12), freq=1000, duty_u16=32768)
        self.assertEqual(pwm.freq(), 1000)
        self.assertEqual(pwm.duty_u16(), 32768)
        self.assertEqual(self.rt.pwm_duties[12], 32768)

        pwm.duty_u16(65535)
        self.assertEqual(pwm.duty_u16(), 65535)

        pwm.duty_u16(70000)  # Clamping
        self.assertEqual(pwm.duty_u16(), 65535)

        pwm.deinit()
        self.assertEqual(pwm.duty_u16(), 0)

    def test_dir_pwm_motor_mode(self) -> None:
        # Default Motor 0: PWM=12, DIR=13
        pwm0 = PWM(Pin(12), duty_u16=32768)
        dir0 = Pin(13, Pin.OUT)

        dir0.value(0)  # Forward
        frame = self.rt.build_actuator_frame()
        self.assertAlmostEqual(frame["motors"][0], 0.5, places=2)

        dir0.value(1)  # Reverse
        frame = self.rt.build_actuator_frame()
        self.assertAlmostEqual(frame["motors"][0], -0.5, places=2)


if __name__ == "__main__":
    unittest.main()
