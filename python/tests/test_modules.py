"""The module surface a program written for a real board expects to find.

A file that runs on an ESP32 imports `ustruct`, calls `micropython.const()`
and reads its rangefinders with `machine.time_pulse_us()`. None of that
existed here, so "the same file runs on both" was only true of files that
happened to stay inside Pin/PWM/ADC/I2C.
"""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import support

import machine

#: Every `u*` alias this package ships, and the standard-library module each
#: one *is*. Kept in step with `pyproject.toml`'s `py-modules` and with
#: `ALLOWED_EXTRA` in `packages/server/src/accounts/submission.ts`.
ALIASES = {
    "uasyncio": "asyncio",
    "ubinascii": "binascii",
    "ucollections": "collections",
    "uerrno": "errno",
    "uhashlib": "hashlib",
    "uheapq": "heapq",
    "uio": "io",
    "ujson": "json",
    "uos": "os",
    "urandom": "random",
    "ure": "re",
    "uselect": "select",
    "usocket": "socket",
    "ustruct": "struct",
    "usys": "sys",
    "utime": "time",
    "uzlib": "zlib",
}


class TestModuleAliases(unittest.TestCase):
    def test_every_alias_is_its_standard_library_module(self) -> None:
        import importlib

        for alias, std in ALIASES.items():
            with self.subTest(alias=alias):
                # Identity, not a re-export: a copy would drift, and would
                # only carry the names a `from ... import *` happens to take.
                self.assertIs(importlib.import_module(alias), importlib.import_module(std))

    def test_every_alias_is_declared_for_packaging(self) -> None:
        # A module that exists in the tree but is not in `py-modules` works in
        # a checkout and vanishes from the wheel, which is the worst of both.
        pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
        for alias in ALIASES:
            with self.subTest(alias=alias):
                self.assertIn(f'"{alias}"', pyproject)


class TestMicropythonModule(unittest.TestCase):
    def test_const_returns_its_argument(self) -> None:
        import micropython

        self.assertEqual(micropython.const(12), 12)

    def test_the_compiler_decorators_are_transparent(self) -> None:
        import micropython

        @micropython.native
        def doubled(x: int) -> int:
            return x * 2

        @micropython.viper
        def tripled(x: int) -> int:
            return x * 3

        self.assertEqual(doubled(4), 8)
        self.assertEqual(tripled(4), 12)


class TestMachineSurface(unittest.TestCase):
    def test_the_classes_a_board_program_reaches_for_all_exist(self) -> None:
        for name in ("Pin", "PWM", "ADC", "I2C", "SoftI2C", "SPI", "SoftSPI",
                     "UART", "RTC", "WDT", "Timer", "Signal"):
            with self.subTest(name=name):
                self.assertTrue(hasattr(machine, name), name)

    def test_the_module_level_functions_exist(self) -> None:
        for name in ("reset", "soft_reset", "reset_cause", "freq", "idle",
                     "lightsleep", "deepsleep", "disable_irq", "enable_irq",
                     "time_pulse_us", "unique_id", "bootloader"):
            with self.subTest(name=name):
                self.assertTrue(callable(getattr(machine, name, None)), name)

    def test_disable_irq_round_trips(self) -> None:
        machine.enable_irq(machine.disable_irq())


class TestSignal(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_invert_flips_both_directions(self) -> None:
        rt, _ = support.connected_singleton()
        plain = machine.Signal(machine.Pin(26, machine.Pin.OUT))
        inverted = machine.Signal(machine.Pin(27, machine.Pin.OUT), invert=True)

        plain.on()
        inverted.on()

        self.assertEqual(rt.pin_values[26], 1)
        self.assertEqual(rt.pin_values[27], 0)   # active-low, driven low for "on"
        self.assertEqual(inverted.value(), 1)    # and it reads back as on


class TestTimePulseUs(unittest.TestCase):
    def tearDown(self) -> None:
        support.teardown()

    def test_an_ultrasonic_echo_is_timed_from_its_distance(self) -> None:
        support.connected_singleton()
        # The support frame puts a wall 500mm in front. Sound covers a
        # millimetre and back in about 5.83us.
        self.assertEqual(machine.time_pulse_us(machine.Pin(2)), int(500 * 5.83))

    def test_out_of_range_reports_no_echo(self) -> None:
        support.connected_singleton()
        # `back` is None in the support frame - nothing within range. Pin 10,
        # not 15: 15 is Motor 1's direction pin, and asking it for a distance
        # would return -2 for the wrong reason entirely.
        from machine.config import PinConfig

        self.assertEqual(machine.time_pulse_us(machine.Pin(PinConfig().ultrasonics["back"])), -2)

    def test_an_echo_longer_than_the_timeout_reports_no_echo(self) -> None:
        support.connected_singleton()
        self.assertEqual(machine.time_pulse_us(machine.Pin(2), 1, 100), -2)


if __name__ == "__main__":
    unittest.main()
