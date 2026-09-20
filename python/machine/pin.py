"""MicroPython Pin class implementation for the simulator."""

from __future__ import annotations

from typing import Any, Callable

from . import _sched, constants
from ._backend import Runtime


class Pin:
    """Control a digital GPIO pin."""

    IN = constants.IN
    OUT = constants.OUT
    OPEN_DRAIN = constants.OPEN_DRAIN
    ALT = constants.ALT

    PULL_NONE = constants.PULL_NONE
    PULL_UP = constants.PULL_UP
    PULL_DOWN = constants.PULL_DOWN

    IRQ_RISING = _sched.IRQ_RISING
    IRQ_FALLING = _sched.IRQ_FALLING

    def __init__(
        self,
        id: int | Pin,
        mode: int = -1,
        pull: int = -1,
        *,
        value: Any = None,
        alt: int = -1,
    ) -> None:
        self._id = id._id if isinstance(id, Pin) else int(id)
        self._mode = mode if mode != -1 else constants.IN
        self._pull = pull
        self._alt = alt

        if value is not None:
            self.value(value)

    @property
    def id(self) -> int:
        return self._id

    def init(
        self,
        mode: int = -1,
        pull: int = -1,
        *,
        value: Any = None,
        alt: int = -1,
    ) -> None:
        if mode != -1:
            self._mode = mode
        if pull != -1:
            self._pull = pull
        if alt != -1:
            self._alt = alt
        if value is not None:
            self.value(value)

    def value(self, x: Any = None) -> int:
        """Get or set the digital pin value (0 or 1)."""
        backend = Runtime.get()
        if x is None:
            return backend.get_pin_value(self._id)
        else:
            val = 1 if x else 0
            backend.set_pin_value(self._id, val)
            return val

    def on(self) -> None:
        """Set pin output to digital high (1)."""
        self.value(1)

    def off(self) -> None:
        """Set pin output to digital low (0)."""
        self.value(0)

    def irq(
        self,
        handler: Callable[[Pin], None] | None = None,
        trigger: int = IRQ_RISING | IRQ_FALLING,
        *,
        priority: int = 1,
        wake: Any = None,
        hard: bool = False,
    ) -> Callable[[Pin], None] | None:
        """Call `handler(pin)` when this pin changes.

        Real, and the one thing on this class that used to be a lie: it took a
        handler, stored nothing and fired never, so a program that did its
        counting in an interrupt simply counted nothing and said so nowhere.

        **Edges arrive at the tick boundary, batched.** Nothing here can
        preempt the main loop - see `_sched`'s docstring for why - so every
        edge that happened during a frame is delivered together once that
        frame lands. For a wheel encoder, which is what most of these are, the
        count and the order are exact and only the timing inside the 20 ms is
        not; a handler that counts gets the right answer, a handler that
        timestamps does not.

        `priority`, `wake` and `hard` are accepted and ignored: there is no
        interrupt controller to prioritise against and no sleep to wake from.
        """
        _sched.register_irq(self._id, self, handler, trigger)
        Runtime.get().watch_pin(self._id, _sched.wants_edge(self._id))
        return handler

    def __repr__(self) -> str:
        mode_str = "OUT" if self._mode == constants.OUT else "IN"
        return f"Pin({self._id}, mode={mode_str})"
