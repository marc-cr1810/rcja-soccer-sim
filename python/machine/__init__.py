"""MicroPython hardware compatibility package for RCJA Soccer Sim.

The `machine` module a real ESP32 or RP2040 gives you, over a simulated robot
on a simulated field. A program written against this runs unmodified on a
board, which is the whole point of the package: `Pin`, `PWM`, `ADC`, `I2C`,
`Timer`, `time_pulse_us` and the rest mean here what they mean there.

Where the simulator cannot honestly provide something it says so rather than
inventing it - see `uart.py` and `spi.py`, which present their real APIs with
nothing attached, and the note in `_sched.py` about why a `Timer` callback
fires between ticks instead of preempting the main loop.
"""

from __future__ import annotations

import sys
from typing import Any

from . import _sched, _timebase, constants
from ._backend import Runtime
from .adc import ADC
from .i2c import I2C, SoftI2C
from .pin import Pin
from .pwm import PWM
from .reading import Reading
from .rtc import RTC
from .signal import Signal
from .spi import SPI, SoftSPI
from .timer import Timer
from .uart import UART
from .wdt import WDT

# A board has `time.sleep_ms` and friends built in, available on a program's
# first line. `sitecustomize.py` normally installs them before any user code
# runs; this call is what covers an interpreter that reached `machine` some
# other way. It is idempotent, so both paths together cost nothing.
_timebase.install()


def reset() -> None:
    """Reset the virtual microcontroller."""
    sys.exit(0)


def soft_reset() -> None:
    """Soft reset. The simulator draws no distinction from a hard one."""
    sys.exit(0)


def reset_cause() -> int:
    """Why the board last started. Always a power-on reset here."""
    return constants.PWRON_RESET


def bootloader(value: Any = None) -> None:
    """Enter the bootloader. There is no firmware to flash, so this just stops."""
    sys.exit(0)


def freq(hz: int | None = None) -> int:
    """Get or set CPU frequency in Hz (virtual ESP32 runs at 240MHz)."""
    return 240_000_000


def idle() -> None:
    """Yield processor execution."""
    Runtime.get().sync_tick(1.0)


def lightsleep(ms: int | None = None) -> None:
    """Sleep the processor. Wakes with everything still where it was."""
    Runtime.get().sync_tick(float(ms) if ms else 1.0)


def deepsleep(ms: int | None = None) -> None:
    """Deep sleep. A board wakes from this by resetting, so this one exits."""
    if ms:
        Runtime.get().sync_tick(float(ms))
    sys.exit(0)


def disable_irq() -> int:
    """Disable interrupts, returning the previous state to hand `enable_irq`.

    Nothing preempts the main loop here - `Timer` callbacks fire from inside
    the tick, between one frame and the next - so there is no window for this
    to close. It exists so that code written to guard one still runs.
    """
    return 0


def enable_irq(state: int = 0) -> None:
    """Restore the interrupt state `disable_irq()` returned."""
    return None


def time_pulse_us(pin: Pin | int, pulse_level: int = 1, timeout_us: int = 1_000_000) -> int:
    """Time a pulse on a pin, in microseconds - how an HC-SR04 is really read.

    Returns -2 when nothing echoes inside `timeout_us`, as the real function
    does. See `Runtime.pulse_us()` for the distance-to-microseconds model.
    """
    pin_id = pin.id if isinstance(pin, Pin) else int(pin)
    return Runtime.get().pulse_us(pin_id, timeout_us)


def unique_id() -> bytes:
    """Return 6-byte unique identifier (MAC-like)."""
    rt = Runtime.get()
    return f"RCJA{rt.number:02d}".encode("ascii")


__all__ = [
    "ADC",
    "I2C",
    "PWM",
    "RTC",
    "SPI",
    "UART",
    "WDT",
    "Pin",
    "Reading",
    "Runtime",
    "Signal",
    "SoftI2C",
    "SoftSPI",
    "Timer",
    "bootloader",
    "constants",
    "deepsleep",
    "disable_irq",
    "enable_irq",
    "freq",
    "idle",
    "lightsleep",
    "reset",
    "reset_cause",
    "soft_reset",
    "time_pulse_us",
    "unique_id",
]
