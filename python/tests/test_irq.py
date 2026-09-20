"""Pin interrupts, and the pins a human operates.

`Pin.irq()` used to take a handler, store nothing and fire never - a program
that did its counting in an interrupt counted nothing and was told so nowhere.
These tests are the regression for that, and for the pins that only exist
because somebody is standing beside the field: the start button and the
switches set between halves.
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine import Pin
from machine.config import PinConfig
from support import connected_singleton, sensor_frame, teardown

CFG = PinConfig()


class TestPinIrq(unittest.TestCase):
    def tearDown(self) -> None:
        teardown()

    def test_a_handler_fires_on_the_edge_it_asked_for(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0, ballGate={"held": False})["frame"],
                sensor_frame(0.02, ballGate={"held": True})["frame"],
                sensor_frame(0.04, ballGate={"held": False})["frame"],
            ]
        )
        rising, falling = [], []
        Pin(CFG.ball_gate, Pin.IN).irq(rising.append, Pin.IRQ_RISING)
        Pin(CFG.ball_gate, Pin.IN).irq(falling.append, Pin.IRQ_FALLING)

        time.sleep_ms(20)
        time.sleep_ms(20)

        # Second registration replaced the first, the way a board's does.
        self.assertEqual(len(rising), 0)
        self.assertEqual(len(falling), 1)

    def test_catching_the_ball_arriving(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0, ballGate={"held": False})["frame"],
                sensor_frame(0.02, ballGate={"held": True})["frame"],
            ]
        )
        caught = []
        Pin(CFG.ball_gate, Pin.IN).irq(lambda pin: caught.append(pin.value()), Pin.IRQ_RISING)
        time.sleep_ms(20)

        self.assertEqual(caught, [1])

    def test_registering_on_a_pin_that_is_already_high_is_not_an_edge(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0, ballGate={"held": True})["frame"],
                sensor_frame(0.02, ballGate={"held": True})["frame"],
            ]
        )
        fired = []
        Pin(CFG.ball_gate, Pin.IN).irq(fired.append, Pin.IRQ_RISING | Pin.IRQ_FALLING)
        time.sleep_ms(20)

        self.assertEqual(fired, [])

    def test_a_handler_of_none_removes_it(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0, ballGate={"held": False})["frame"],
                sensor_frame(0.02, ballGate={"held": True})["frame"],
            ]
        )
        fired = []
        pin = Pin(CFG.ball_gate, Pin.IN)
        pin.irq(fired.append, Pin.IRQ_RISING)
        pin.irq(None)
        time.sleep_ms(20)

        self.assertEqual(fired, [])

    def test_a_failing_handler_is_loud_but_not_fatal(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0, ballGate={"held": False})["frame"],
                sensor_frame(0.02, ballGate={"held": True})["frame"],
                sensor_frame(0.04, ballGate={"held": True})["frame"],
            ]
        )

        def explode(pin):
            raise ValueError("bang")

        Pin(CFG.ball_gate, Pin.IN).irq(explode, Pin.IRQ_RISING)
        import io
        import contextlib

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            time.sleep_ms(20)
            time.sleep_ms(20)

        self.assertIn("bang", stderr.getvalue())


class TestHumanPins(unittest.TestCase):
    """The pins that exist because somebody is standing beside the field."""

    def tearDown(self) -> None:
        teardown()

    def test_the_start_button_is_down_while_play_is_live(self) -> None:
        rt, _ = connected_singleton([sensor_frame(0.0, playing=True)["frame"]])
        self.assertEqual(Pin(CFG.start, Pin.IN).value(), 1)

    def test_the_button_is_up_at_a_stoppage(self) -> None:
        rt, _ = connected_singleton([sensor_frame(0.0, playing=False)["frame"]])
        self.assertEqual(Pin(CFG.start, Pin.IN).value(), 0)

    def test_the_button_is_up_through_the_pre_whistle_countdown(self) -> None:
        # The load-bearing one. The server keeps `playing` true *through* the
        # countdown at a restart, and a human does not press start until the
        # whistle. Map the raw flag and every robot encroaches at every
        # kick-off.
        rt, _ = connected_singleton(
            [
                sensor_frame(
                    0.0,
                    playing=True,
                    kickoff={"pending": True, "ours": True, "countdown": 2.4},
                )["frame"]
            ]
        )
        self.assertEqual(Pin(CFG.start, Pin.IN).value(), 0)

    def test_the_button_is_up_while_the_robot_is_off_the_field(self) -> None:
        rt, _ = connected_singleton([sensor_frame(0.0, playing=True)["frame"]])
        rt.off_field = True
        self.assertEqual(Pin(CFG.start, Pin.IN).value(), 0)

    def test_the_switches_say_which_robot_this_is_and_which_way_it_attacks(self) -> None:
        rt, _ = connected_singleton(
            [sensor_frame(0.0, team="lime", robot=2, attackDirection=-1)["frame"]]
        )
        self.assertEqual(Pin(CFG.team_switch, Pin.IN).value(), 1)
        self.assertEqual(Pin(CFG.robot_switch, Pin.IN).value(), 1)
        self.assertEqual(Pin(CFG.side_switch, Pin.IN).value(), 0)

    def test_the_whistle_is_a_rising_edge_on_the_button(self) -> None:
        rt, _ = connected_singleton(
            [
                sensor_frame(0.0, playing=False)["frame"],
                sensor_frame(0.02, playing=True)["frame"],
            ]
        )
        whistles = []
        Pin(CFG.start, Pin.IN).irq(lambda pin: whistles.append(True), Pin.IRQ_RISING)
        time.sleep_ms(20)

        self.assertEqual(len(whistles), 1)


if __name__ == "__main__":
    unittest.main()
