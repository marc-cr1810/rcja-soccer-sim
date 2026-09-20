"""The one owner of the clock a program sees.

A real MicroPython board has `time.sleep_ms`, `time.ticks_ms` and friends
built in, so a program may use them on its very first line. Here they have to
be installed onto CPython's `time` module, and the question of *when* that
happens is the whole reason this module exists separately from
`machine/__init__.py`:

* `sitecustomize.py` installs the patch at interpreter startup, before any
  student line runs, so `from time import sleep_ms` works the way it does on
  a board rather than only if `import machine` happened to come first.
* That means `_backend` can no longer count on being imported *before* the
  patch, which is the only reason its reconnect backoff used to reach the
  real `time.sleep`. So the real functions are captured here, once, and
  handed out explicitly - `_real_sleep` is not an optimisation, it is what
  stops `ensure_connected` -> `time.sleep` -> `sync_tick` ->
  `ensure_connected` recursing forever.

Nothing here connects to anything on its own. Everything defers to the
`Runtime` singleton, and reads it lazily, so importing this module from a
startup hook costs an interpreter nothing.
"""

from __future__ import annotations

import time as _time
from typing import Any, Callable

#: Captured before anything is patched, and the only way back to CPython's own
#: implementations once `install()` has run.
_real_sleep: Callable[[float], None] = _time.sleep
_real_monotonic: Callable[[], float] = _time.monotonic

#: One physics step of the simulator, in milliseconds (50 Hz).
TICK_MS = 20.0

#: MicroPython's tick counters wrap at 2**30 on every port that matters, and
#: `ticks_diff()` below is written to undo exactly that wrap. Returning an
#: unmasked number would make `ticks_diff` wrong for any program left running
#: long enough - which is why this is a fidelity fix rather than decoration.
TICK_MASK = 0x3FFFFFFF

_program_start = _real_monotonic()

_installed = False


def _runtime() -> Any:
    from ._backend import Runtime

    return Runtime.get()


def _host_ms() -> float:
    return (_real_monotonic() - _program_start) * 1000.0


def sim_ms() -> float:
    """Milliseconds of simulation, counted in frames. No host time in it.

    This is the deterministic clock - `Timer` and `WDT` run off it, so two
    identical headless runs fire their callbacks on identical ticks.
    """
    rt = _runtime()
    return rt.frames * TICK_MS


def _elapsed_ms() -> float:
    rt = _runtime()
    if rt.connected and rt.tick_epoch_ms is not None:
        # Frames, plus however long the program has spent inside the current
        # one. The host term is what lets a
        # `while ticks_diff(ticks_ms(), start) < 20: pass` busy-wait finish on
        # its own, the way it would on a board: the frame counter alone leaves
        # it spinning forever, because nothing in that loop ever sleeps.
        #
        # It is deliberately *not* capped below one tick. Capping it at 19ms
        # was tried and is worse than useless: the idiom above waits for 20,
        # so a capped reading turns the hang into a subtler hang. A unit test
        # asking for 5ms passed it; a live robot asking for 20 did not.
        within = (_real_monotonic() - rt.last_frame_at) * 1000.0
        raw = rt.tick_epoch_ms + rt.frames * TICK_MS + max(0.0, within)
    else:
        raw = _host_ms()

    # Uncapped, `raw` can overshoot the next frame's own base and so appear to
    # go backwards when that frame lands. A floor is what buys monotonicity
    # instead: after a long busy-wait the clock simply sits still until the
    # simulation catches up with the wall time the program really did spend.
    # `Timer` and `WDT` are unaffected - they run off `sim_ms()`, which is
    # frames and nothing else.
    if raw < rt.ticks_floor_ms:
        return rt.ticks_floor_ms
    rt.ticks_floor_ms = raw
    return raw


# -----------------------------------------------------------------------------
# The MicroPython time API
# -----------------------------------------------------------------------------


def ticks_ms() -> int:
    return int(_elapsed_ms()) & TICK_MASK


def ticks_us() -> int:
    return int(_elapsed_ms() * 1000.0) & TICK_MASK


def ticks_cpu() -> int:
    return ticks_us()


def ticks_diff(ticks1: int, ticks2: int) -> int:
    diff = (ticks1 - ticks2) & TICK_MASK
    if diff & 0x20000000:
        diff -= 0x40000000
    return diff


def ticks_add(ticks: int, delta: int) -> int:
    return (ticks + delta) & TICK_MASK


def sleep_ms(ms: int | float) -> None:
    _runtime().sync_tick(float(ms))


def sleep_us(us: int | float) -> None:
    _runtime().sync_tick(float(us) / 1000.0)


def sleep(seconds: int | float) -> None:
    """`time.sleep()`, in seconds - legal MicroPython, and what a textbook writes.

    On a board this blocks while the motors keep doing whatever they were last
    told, so here it has to advance the simulation exactly as `sleep_ms` does.
    Before this existed, a loop pacing itself on `time.sleep(0.02)` set its
    PWM duties every iteration and sent the server nothing at all: connected,
    apparently alive, and motionless.

    The one difference from `sleep_ms`: this does *not* open a connection.
    `sleep` is a name that already existed and that unrelated code calls, and
    `sitecustomize` now installs this into every interpreter that can see
    `python/` - so `python3 -c "import time; time.sleep(1)"` run from that
    directory must not go looking for a match server. Any real robot program
    has already touched hardware (or `sensors()`) by the time it sleeps, and
    all of those connect for themselves.
    """
    rt = _runtime()
    if rt.connected:
        rt.sync_tick(float(seconds) * 1000.0)
    else:
        _real_sleep(float(seconds))


def install() -> None:
    """Put the MicroPython time API onto CPython's `time` module. Idempotent."""
    global _installed
    if _installed:
        return
    # `sleep` is assigned unconditionally: the `if not hasattr(...)` guard the
    # rest of these can use is a no-op for a name the stdlib already defines,
    # which is how the seconds form went unpatched in the first place.
    _time.sleep = sleep  # type: ignore[assignment]
    for name in (
        "sleep_ms",
        "sleep_us",
        "ticks_ms",
        "ticks_us",
        "ticks_cpu",
        "ticks_diff",
        "ticks_add",
    ):
        setattr(_time, name, globals()[name])
    _installed = True
