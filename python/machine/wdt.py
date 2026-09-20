"""MicroPython WDT - the watchdog.

A board that stops feeding its watchdog resets. The nearest honest equivalent
here is what `machine.reset()` already does: exit the process. The match
carries on either way, holding the last command that was sent, so a robot with
a hung control loop goes quiet rather than driving into a wall on stale
motors - which is the behaviour a team fits a watchdog to get.

Timed in simulation milliseconds, so it fires on the same tick in a replay as
it did in the run being replayed.
"""

from __future__ import annotations

from . import _sched, _timebase

#: The shortest timeout a real ESP32 WDT accepts.
MIN_TIMEOUT_MS = 1


class WDT:
    def __init__(self, id: int = 0, timeout: int = 5000) -> None:
        if timeout < MIN_TIMEOUT_MS:
            raise ValueError("timeout too short")
        self.id = int(id)
        self._entry = {
            "wdt": self,
            "timeout": float(timeout),
            "fed": _timebase.sim_ms(),
        }
        _sched.register_watchdog(self._entry)

    def feed(self) -> None:
        self._entry["fed"] = _timebase.sim_ms()

    def deinit(self) -> None:
        """Stop the watchdog. A real ESP32 cannot; the simulator lets tests."""
        _sched.unregister_watchdog(self._entry)

    def __repr__(self) -> str:
        return f"WDT({self.id}, timeout={self._entry['timeout']:.0f}ms)"
