"""Regression guard against ADC pin-number collisions in the default pinout.

`Runtime.read_adc()` checks sensor categories in a fixed order (lines, ball
strength/bearing, ir_ring, compass, gyro, ultrasonics) and returns on the
first match. Two categories sharing a pin number silently shadow one of them
- the shadowed sensor returns a plausible-looking value from the wrong
category instead of erroring. This test enumerates every ADC pin the default
`PinConfig` names and fails if any two categories claim the same pin.
"""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine.config import PinConfig


class TestDefaultPinoutHasNoCollisions(unittest.TestCase):
    def test_no_two_adc_categories_share_a_pin(self) -> None:
        cfg = PinConfig()

        categories: dict[str, list[int]] = {
            "lines": list(cfg.lines),
            "ball_strength": [cfg.ball_strength],
            "ball_bearing": [cfg.ball_bearing],
            "ir_ring": list(cfg.ir_ring),
            "compass": [cfg.compass],
            "gyro": [cfg.gyro],
            "ultrasonics": list(cfg.ultrasonics.values()),
        }

        seen: dict[int, str] = {}
        for category, pins in categories.items():
            for pin in pins:
                self.assertNotIn(
                    pin,
                    seen,
                    f"pin {pin} is claimed by both '{seen.get(pin)}' and '{category}' - "
                    "read_adc() will silently return the first one for both",
                )
                seen[pin] = category


if __name__ == "__main__":
    unittest.main()
