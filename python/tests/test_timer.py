"""Timer, WDT and micropython.schedule - the things that run between ticks.

See `machine/_sched.py` for why a callback fires from inside the tick loop
rather than preempting it the way a hardware interrupt would.
"""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import support

import time
import micropython
from machine import Timer, WDT


class TestTimer(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_periodic_timer_fires_once_per_period(self) -> None:
        support.connected_singleton()
        fired: list[object] = []
        Timer(0, mode=Timer.PERIODIC, period=100, callback=fired.append)

        for _ in range(25):          # 500ms of simulation
            time.sleep_ms(20)

        self.assertEqual(len(fired), 5)

    def test_one_shot_fires_exactly_once(self) -> None:
        support.connected_singleton()
        fired: list[object] = []
        Timer(1, mode=Timer.ONE_SHOT, period=40, callback=fired.append)

        for _ in range(10):
            time.sleep_ms(20)

        self.assertEqual(len(fired), 1)

    def test_freq_is_accepted_in_place_of_period(self) -> None:
        support.connected_singleton()
        fired: list[object] = []
        Timer(2, freq=10, callback=fired.append)   # 10Hz == every 100ms

        for _ in range(20):          # 400ms
            time.sleep_ms(20)

        self.assertEqual(len(fired), 4)

    def test_a_sub_tick_period_fires_once_per_tick_not_in_bursts(self) -> None:
        # The documented limit of running off the tick loop: the clock only
        # moves in 20ms steps, so a 5ms timer cannot fire four times between
        # two frames. It fires once, and the docs say so.
        support.connected_singleton()
        fired: list[object] = []
        Timer(3, period=5, callback=fired.append)

        for _ in range(5):
            time.sleep_ms(20)

        self.assertEqual(len(fired), 5)

    def test_a_failing_callback_is_loud_but_not_fatal(self) -> None:
        # A board prints the traceback from a broken interrupt handler and
        # keeps going. Letting it out would instead kill the program from
        # inside somebody's `time.sleep_ms()`, frames from the real cause.
        import contextlib
        import io

        support.connected_singleton()
        fired: list[object] = []

        def boom(timer: object) -> None:
            fired.append(timer)
            raise ValueError("callback is broken")

        Timer(6, period=20, callback=boom)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            for _ in range(3):
                time.sleep_ms(20)

        self.assertEqual(len(fired), 3, "a failing callback stopped being called")
        self.assertIn("callback is broken", stderr.getvalue())

    def test_deinit_stops_a_timer(self) -> None:
        support.connected_singleton()
        fired: list[object] = []
        timer = Timer(4, period=20, callback=fired.append)
        time.sleep_ms(20)
        timer.deinit()
        before = len(fired)

        for _ in range(5):
            time.sleep_ms(20)

        self.assertEqual(len(fired), before)

    def test_a_callback_that_sets_a_pin_lands_on_the_next_frame(self) -> None:
        from machine import Pin

        rt, channel = support.connected_singleton()
        kicker = Pin(27, Pin.OUT)
        Timer(5, mode=Timer.ONE_SHOT, period=20, callback=lambda t: kicker.value(1))

        time.sleep_ms(20)    # the callback runs at the end of this tick
        time.sleep_ms(20)    # this is the frame that carries it

        kicked = [c for c in channel.sent if c.get("frame", {}).get("kicker")]
        self.assertTrue(kicked, "the pin a timer set never reached the server")


class TestSchedule(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_scheduled_work_runs_at_the_next_tick(self) -> None:
        support.connected_singleton()
        ran: list[int] = []
        micropython.schedule(ran.append, 7)

        self.assertEqual(ran, [], "schedule() must not run its callback inline")
        time.sleep_ms(20)
        self.assertEqual(ran, [7])

    def test_the_queue_is_bounded_like_a_boards(self) -> None:
        support.connected_singleton()
        for _ in range(8):
            micropython.schedule(lambda a: None, None)
        with self.assertRaises(RuntimeError):
            micropython.schedule(lambda a: None, None)


class TestWatchdog(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_an_unfed_watchdog_resets_the_program(self) -> None:
        support.connected_singleton()
        WDT(timeout=60)

        with self.assertRaises(SystemExit):
            for _ in range(10):
                time.sleep_ms(20)

    def test_a_fed_watchdog_stays_quiet(self) -> None:
        support.connected_singleton()
        dog = WDT(timeout=60)

        for _ in range(10):
            time.sleep_ms(20)
            dog.feed()


if __name__ == "__main__":
    unittest.main()
