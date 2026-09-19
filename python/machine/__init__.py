"""MicroPython hardware compatibility package for RCJA Soccer Sim."""

from __future__ import annotations

import sys
import time
from typing import Any

from . import constants
from ._backend import Runtime
from .adc import ADC
from .i2c import I2C, SoftI2C
from .pin import Pin
from .pwm import PWM
from .reading import Reading


def _patch_time_module() -> None:
    """Augment the standard Python 'time' module with MicroPython functions."""
    time_mod = sys.modules.get("time")
    if time_mod is None:
        return

    def sleep_ms(ms: int | float) -> None:
        Runtime.get().sync_tick(float(ms))

    def sleep_us(us: int | float) -> None:
        Runtime.get().sync_tick(float(us) / 1000.0)

    def ticks_ms() -> int:
        rt = Runtime.get()
        if rt.connected:
            return int(rt.clock * 1000.0)
        return int(time.monotonic() * 1000.0)

    def ticks_us() -> int:
        rt = Runtime.get()
        if rt.connected:
            return int(rt.clock * 1_000_000.0)
        return int(time.monotonic() * 1_000_000.0)

    def ticks_diff(ticks1: int, ticks2: int) -> int:
        # MicroPython ticks wrap at 2**30
        diff = (ticks1 - ticks2) & 0x3FFFFFFF
        if diff & 0x20000000:
            diff -= 0x40000000
        return diff

    def ticks_add(ticks: int, delta: int) -> int:
        return (ticks + delta) & 0x3FFFFFFF

    if not hasattr(time_mod, "sleep_ms"):
        setattr(time_mod, "sleep_ms", sleep_ms)
    if not hasattr(time_mod, "sleep_us"):
        setattr(time_mod, "sleep_us", sleep_us)
    if not hasattr(time_mod, "ticks_ms"):
        setattr(time_mod, "ticks_ms", ticks_ms)
    if not hasattr(time_mod, "ticks_us"):
        setattr(time_mod, "ticks_us", ticks_us)
    if not hasattr(time_mod, "ticks_diff"):
        setattr(time_mod, "ticks_diff", ticks_diff)
    if not hasattr(time_mod, "ticks_add"):
        setattr(time_mod, "ticks_add", ticks_add)


_patch_time_module()


def reset() -> None:
    """Reset the virtual microcontroller."""
    sys.exit(0)


def freq(hz: int | None = None) -> int:
    """Get or set CPU frequency in Hz (virtual ESP32 runs at 240MHz)."""
    return 240_000_000


def idle() -> None:
    """Yield processor execution."""
    Runtime.get().sync_tick(1.0)


def unique_id() -> bytes:
    """Return 6-byte unique identifier (MAC-like)."""
    rt = Runtime.get()
    return f"RCJA{rt.number:02d}".encode("ascii")


__all__ = [
    "Pin",
    "PWM",
    "ADC",
    "I2C",
    "SoftI2C",
    "Reading",
    "Runtime",
    "reset",
    "freq",
    "idle",
    "unique_id",
    "constants",
]
