"""Unit tests for time/utime MicroPython compatibility."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import utime
import time
from machine._backend import Runtime


class TestTime(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime.get()
        self.rt.connected = True
        self.rt.clock = 12.345  # 12.345 seconds into match

    def test_ticks_ms_tied_to_match_clock(self) -> None:
        self.assertEqual(time.ticks_ms(), 12345)
        self.assertEqual(utime.ticks_ms(), 12345)

    def test_ticks_diff_and_add(self) -> None:
        t0 = 1000
        t1 = 1050
        self.assertEqual(time.ticks_diff(t1, t0), 50)
        self.assertEqual(time.ticks_add(t0, 50), 1050)

    def test_sleep_ms_present(self) -> None:
        self.assertTrue(callable(getattr(time, "sleep_ms", None)))
        self.assertTrue(callable(getattr(utime, "sleep_ms", None)))


if __name__ == "__main__":
    unittest.main()
