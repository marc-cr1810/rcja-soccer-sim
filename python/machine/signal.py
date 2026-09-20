"""MicroPython Signal - a Pin with the polarity folded in.

Pure Python over `Pin`; the simulator backend never sees a Signal, only the
pin writes it makes. `invert=True` is the whole point of the class: an
active-low line reads and writes as if it were active-high, so the rest of a
program stops caring which way round the hardware wired it.
"""

from __future__ import annotations

from typing import Any

from .pin import Pin


class Signal:
    def __init__(self, pin: Pin | int, *args: Any, invert: bool = False, **kwargs: Any) -> None:
        self._pin = pin if isinstance(pin, Pin) else Pin(pin, *args, **kwargs)
        self._invert = bool(invert)

    def value(self, x: Any = None) -> int:
        if x is None:
            raw = self._pin.value()
            return 1 - raw if self._invert else raw
        val = 1 if x else 0
        self._pin.value(1 - val if self._invert else val)
        return val

    def on(self) -> None:
        self.value(1)

    def off(self) -> None:
        self.value(0)

    def __repr__(self) -> str:
        return f"Signal({self._pin!r}, invert={self._invert})"
