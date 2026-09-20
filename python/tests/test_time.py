"""Unit tests for time/utime MicroPython compatibility.

The four behaviours pinned here were each a live defect, confirmed against a
running match server before they were fixed:

* `time.sleep()` in seconds set the motors and sent nothing;
* `from time import sleep_ms` raised ImportError unless `machine` happened to
  be imported first;
* `ticks_ms()` jumped backwards from host time to the match clock on connect;
* a `ticks_diff` busy-wait could never exit.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import support

import time
import utime
from machine import _timebase
from machine._backend import Runtime

PYTHON_DIR = Path(__file__).resolve().parents[1]


class TestTimeApi(unittest.TestCase):
    def test_utime_is_time(self) -> None:
        # Not cosmetic. `utime` used to copy `sleep` from `time` *before* the
        # patch was installed, so `utime.sleep()` stayed CPython's blocking
        # one and silently advanced no simulation at all.
        self.assertIs(utime, time)
        self.assertIs(utime.sleep, time.sleep)

    def test_the_micropython_names_are_installed(self) -> None:
        for name in ("sleep_ms", "sleep_us", "ticks_ms", "ticks_us", "ticks_diff", "ticks_add"):
            self.assertTrue(callable(getattr(time, name, None)), name)

    def test_ticks_diff_and_add(self) -> None:
        self.assertEqual(time.ticks_diff(1050, 1000), 50)
        self.assertEqual(time.ticks_add(1000, 50), 1050)

    def test_ticks_wrap_at_two_to_the_thirty(self) -> None:
        # `ticks_diff` undoes a 2**30 wrap, so `ticks_ms` has to produce one.
        # Unmasked values made the pair disagree for any long-running program.
        self.assertLess(time.ticks_ms(), 2 ** 30)
        self.assertLess(time.ticks_us(), 2 ** 30)


class TestTicksAcrossConnect(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_ticks_ms_does_not_jump_backwards_on_connect(self) -> None:
        Runtime._instance = None
        before = time.ticks_ms()
        rt, _ = support.connected_singleton()
        after = time.ticks_ms()
        # Measured going from 254,950,074 to 0 before the tick epoch existed.
        self.assertGreaterEqual(time.ticks_diff(after, before), 0)

    def test_ticks_ms_advances_with_frames_not_with_the_match_clock(self) -> None:
        rt, _ = support.connected_singleton()
        start = time.ticks_ms()
        time.sleep_ms(20)
        time.sleep_ms(20)
        moved = time.ticks_diff(time.ticks_ms(), start)
        # Two frames is 40ms of simulation; sub-tick host interpolation can
        # add up to 19ms on either reading, never a whole tick.
        self.assertGreaterEqual(moved, 40 - 19)
        self.assertLessEqual(moved, 40 + 19)

    def test_ticks_ms_advances_between_frames_so_a_busy_wait_can_end(self) -> None:
        # 20ms, not something smaller: the sub-tick term used to be capped
        # just under one tick, which passed a 5ms version of this test and
        # still hung a live robot on the 20ms idiom every book writes.
        rt, _ = support.connected_singleton()
        start = time.ticks_ms()
        spins = 0
        while time.ticks_diff(time.ticks_ms(), start) < 20:
            spins += 1
            if spins > 5_000_000:
                self.fail("ticks_ms() never advanced; a busy-wait cannot exit")
        self.assertGreater(spins, 0)


class TestSleepFlushesTheActuatorFrame(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_sleep_in_seconds_sends_commands_like_sleep_ms(self) -> None:
        rt, channel = support.connected_singleton()
        before = len(channel.sent)
        for _ in range(5):
            time.sleep(0.02)
        seconds_form = len(channel.sent) - before

        before = len(channel.sent)
        for _ in range(5):
            time.sleep_ms(20)
        ms_form = len(channel.sent) - before

        # This was 0 against 5 live: a loop pacing on `time.sleep(0.02)` set
        # its PWM duties every iteration and sent the server nothing.
        self.assertEqual(seconds_form, 5)
        self.assertEqual(ms_form, 5)

    def test_sleep_does_not_connect_when_nothing_is_connected(self) -> None:
        # `sitecustomize` installs this into every interpreter that can see
        # python/, so an unrelated `time.sleep(...)` must not go looking for a
        # match server. Every real robot program has touched hardware - which
        # connects - long before it sleeps.
        support.teardown()
        Runtime._instance = None
        time.sleep(0.001)
        self.assertFalse(Runtime.get().connected)

    def test_sub_tick_sleeps_carry_their_remainder(self) -> None:
        rt, channel = support.connected_singleton()
        rt._sleep_accum_ms = 0.0
        time.sleep_ms(30)
        # 30ms rounds to one tick and leaves 10ms owing; zeroing it here made
        # a program pacing off 20ms drift further every iteration.
        self.assertAlmostEqual(rt._sleep_accum_ms, 10.0, places=6)


class TestImportOrderDoesNotMatter(unittest.TestCase):
    def test_from_time_import_sleep_ms_works_on_the_first_line(self) -> None:
        """The whole point of `sitecustomize.py`, checked in a real interpreter."""
        program = (
            "from time import sleep_ms, ticks_ms, ticks_diff\n"
            "print('ok', callable(sleep_ms), callable(ticks_ms))\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", program],
            cwd=str(PYTHON_DIR),
            env={"PYTHONPATH": ".", "PATH": "/usr/bin:/bin"},
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ok True True", result.stdout)


if __name__ == "__main__":
    unittest.main()
