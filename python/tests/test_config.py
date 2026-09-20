"""Regression guard against pin-number collisions in the default pinout.

Two kinds of collision, both of which have actually shipped here:

**Sensor against sensor.** `Runtime.read_adc()` checks categories in a fixed
order and returns on the first match, so two of them sharing a number silently
shadows one - the loser returns a plausible-looking value from the wrong
category instead of erroring. `ADC(Pin(21))` labelled "compass" once returned
IR-ring data this way.

**Sensor against actuator.** A number claimed by both a motor direction pin and
an ultrasonic describes a board nobody can build: one physical pin cannot be a
digital output and a sensor input at once. It stayed invisible in the simulator
because ADC reads and digital writes take different code paths, so neither
returned a wrong number - and the earlier version of this test could not see it
either, because it only compared ADC categories against each other. Ultrasonic
`back` was Motor 1's direction pin and ultrasonic `right` was Motor 0's.

So this enumerates *every* named pin, actuators included, and fails on any
overlap at all.
"""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine.config import PinConfig


def named_pins(cfg: PinConfig) -> dict[str, list[int]]:
    """Every pin the config names, by the category that claims it."""
    categories: dict[str, list[int]] = {}
    for i, motor in enumerate(cfg.motors):
        for role in ("pwm", "dir", "in1", "in2"):
            if motor.get(role) is not None:
                categories[f"motor{i}.{role}"] = [motor[role]]
    categories["kicker"] = [cfg.kicker]
    categories["dribbler"] = [cfg.dribbler]
    categories["ball_gate"] = [cfg.ball_gate]
    categories["lines"] = list(cfg.lines)
    categories["ball_strength"] = [cfg.ball_strength]
    categories["ball_bearing"] = [cfg.ball_bearing]
    categories["ir_ring"] = list(cfg.ir_ring)
    categories["compass"] = [cfg.compass]
    categories["gyro"] = [cfg.gyro]
    categories["ultrasonics"] = list(cfg.ultrasonics.values())
    return categories


class TestDefaultPinoutHasNoCollisions(unittest.TestCase):
    def test_no_two_categories_share_a_pin(self) -> None:
        seen: dict[int, str] = {}
        for category, pins in named_pins(PinConfig()).items():
            for pin in pins:
                self.assertNotIn(
                    pin,
                    seen,
                    f"pin {pin} is claimed by both '{seen.get(pin)}' and '{category}' - "
                    "one physical pin cannot do both jobs, and read_adc() will "
                    "silently return whichever it checks first",
                )
                seen[pin] = category

    def test_the_guard_would_actually_catch_one(self) -> None:
        """A test this shape is worthless if it silently enumerates nothing."""
        cfg = PinConfig()
        self.assertGreaterEqual(sum(len(p) for p in named_pins(cfg).values()), 30)

        collided = PinConfig({"ultrasonics": {"back": cfg.motors[1]["dir"]}})
        with self.assertRaises(AssertionError):
            seen: dict[int, str] = {}
            for category, pins in named_pins(collided).items():
                for pin in pins:
                    self.assertNotIn(pin, seen)
                    seen[pin] = category


if __name__ == "__main__":
    unittest.main()
