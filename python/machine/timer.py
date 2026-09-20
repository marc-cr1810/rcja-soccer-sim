"""MicroPython Timer, fired from the tick loop.

See `_sched.py` for why the callback does not preempt the main loop the way a
hardware interrupt does, and for the resolution that costs.
"""

from __future__ import annotations

from typing import Any, Callable

from . import _sched, _timebase


class Timer:
    """A periodic or one-shot callback, timed in simulation milliseconds."""

    ONE_SHOT = _sched.ONE_SHOT
    PERIODIC = _sched.PERIODIC

    def __init__(
        self,
        id: int = -1,
        *,
        mode: int = _sched.PERIODIC,
        period: int = -1,
        freq: float | None = None,
        callback: Callable[[Timer], None] | None = None,
    ) -> None:
        self.id = int(id)
        self._entry: dict[str, Any] = {
            "timer": self,
            "mode": mode,
            "period": 0.0,
            "next": 0.0,
            "callback": None,
        }
        if callback is not None or period > 0 or freq is not None:
            self.init(mode=mode, period=period, freq=freq, callback=callback)

    def init(
        self,
        *,
        mode: int = _sched.PERIODIC,
        period: int = -1,
        freq: float | None = None,
        callback: Callable[[Timer], None] | None = None,
    ) -> None:
        """Start (or retune) the timer. `freq` is in Hz and wins over `period`."""
        if freq is not None and freq > 0:
            period_ms = 1000.0 / float(freq)
        else:
            period_ms = float(period)
        if period_ms <= 0:
            raise ValueError("timer needs a positive period or freq")

        self._entry["mode"] = mode
        self._entry["period"] = period_ms
        self._entry["callback"] = callback
        self._entry["next"] = _timebase.sim_ms() + period_ms
        _sched.register_timer(self._entry)

    def deinit(self) -> None:
        """Stop the timer. Safe to call on one that was never started."""
        self._entry["callback"] = None
        _sched.unregister_timer(self._entry)

    def value(self) -> int:
        """Milliseconds remaining before the next callback."""
        remaining = self._entry["next"] - _timebase.sim_ms()
        return int(max(0.0, remaining))

    def __repr__(self) -> str:
        return f"Timer({self.id}, period={self._entry['period']:.0f}ms)"
