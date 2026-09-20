"""What runs between one tick and the next.

A hardware timer on a real board is an interrupt: it preempts whatever the
main loop was doing. There is no honest way to do that here. The simulator is
a lockstep 50 Hz conversation over one socket, and a callback that fired from
a host thread could set a pin halfway through the frame being built, or touch
the socket while `sync_tick` was reading it.

So callbacks fire from inside the tick loop instead, at the point `sync_tick`
has just taken delivery of a sensor frame. That gives a callback the same two
things the main loop has - this tick's readings, and a write that lands on the
next frame - rather than a half-built view of either. The cost is resolution:
the clock this runs off only moves in 20 ms steps, so a `period=5` timer fires
once per tick rather than four times.

An exception out of a callback is printed and the tick carries on, which is
what MicroPython does with one raised in an interrupt or a scheduled call. A
robot whose timer is broken should be loud, not dead.

The clock is `_timebase.sim_ms()` - frames, with no host time mixed in - so
two identical headless runs fire identical callbacks on identical ticks.
"""

from __future__ import annotations

import sys
from typing import Any, Callable

from . import _timebase

ONE_SHOT = 0
PERIODIC = 1

#: Live timers, in creation order. Entries are mutable dicts rather than a
#: class so `Timer.init()` can retune one in place without re-registering.
_timers: list[dict[str, Any]] = []

#: Watchdogs. A board resets when one is not fed; here that is a process exit,
#: which is what `machine.reset()` does too.
_watchdogs: list[dict[str, Any]] = []

#: `micropython.schedule()` queue - work handed off to be run "soon, but not
#: inside this interrupt". Soon here means the next tick.
_scheduled: list[tuple[Callable[[Any], Any], Any]] = []

#: Guard against a callback that sleeps, which would re-enter `sync_tick` and
#: from there re-enter this. A real interrupt cannot nest on itself either.
_servicing = False


def register_timer(entry: dict[str, Any]) -> None:
    if entry not in _timers:
        _timers.append(entry)


def unregister_timer(entry: dict[str, Any]) -> None:
    if entry in _timers:
        _timers.remove(entry)


def register_watchdog(entry: dict[str, Any]) -> None:
    _watchdogs.append(entry)


def unregister_watchdog(entry: dict[str, Any]) -> None:
    if entry in _watchdogs:
        _watchdogs.remove(entry)


def schedule(func: Callable[[Any], Any], arg: Any = None) -> None:
    """`micropython.schedule()` - run `func(arg)` at the next tick boundary."""
    if len(_scheduled) >= 8:
        # MicroPython's queue is small and fixed, and raises when it fills.
        raise RuntimeError("schedule queue full")
    _scheduled.append((func, arg))


def reset() -> None:
    """Drop every registration. For tests; nothing in a robot program calls it."""
    _timers.clear()
    _watchdogs.clear()
    _scheduled.clear()


def _run(func: Callable[[Any], Any], arg: Any) -> None:
    """Call a callback, printing anything it raises rather than propagating it.

    MicroPython prints the traceback from a failing interrupt or scheduled
    callback and keeps going; letting it out here would instead kill the
    program from inside somebody's `time.sleep_ms()`, several frames from
    anything that looks like the cause.
    """
    try:
        func(arg)
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - deliberately as broad as a board's
        import traceback

        traceback.print_exc()


def service(now_ms: float | None = None) -> None:
    """Fire anything due. Called by `Runtime.sync_tick()` once per tick."""
    global _servicing
    if _servicing:
        return
    now = _timebase.sim_ms() if now_ms is None else now_ms

    _servicing = True
    try:
        pending = list(_scheduled)
        _scheduled.clear()
        for func, arg in pending:
            _run(func, arg)

        for entry in list(_timers):
            if entry["callback"] is None or entry["period"] <= 0:
                continue
            if now < entry["next"]:
                continue
            _run(entry["callback"], entry["timer"])
            if entry["mode"] == ONE_SHOT:
                unregister_timer(entry)
                continue
            entry["next"] += entry["period"]
            if entry["next"] <= now:
                # Sub-tick period, or a callback that took several ticks. Fire
                # once per tick from here rather than burst to catch up: the
                # burst would arrive with nothing in between it, which is less
                # like a board than simply being slow is.
                entry["next"] = now + entry["period"]

        for dog in list(_watchdogs):
            if now - dog["fed"] >= dog["timeout"]:
                print(
                    f"[machine.WDT] watchdog not fed for {dog['timeout']:.0f}ms; resetting",
                    file=sys.stderr,
                )
                raise SystemExit(0)
    finally:
        _servicing = False
