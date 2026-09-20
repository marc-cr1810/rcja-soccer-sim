"""The `micropython` module - the compiler hints and the interrupt-safe queue.

On a board these mean something to the compiler and the runtime. Here most of
them have nothing to do, and that is the point: a program written for real
hardware imports them and runs, rather than failing on a line that was only
ever an optimisation.

`schedule()` is the exception, and it does real work - see `machine/_sched.py`.
"""

from __future__ import annotations

import gc
import sys
from typing import Any, Callable, TypeVar

_F = TypeVar("_F")

#: Optimisation level, as `opt_level()` reports it.
_opt_level = 0


def const(value: _F) -> _F:
    """Declare a compile-time constant.

    MicroPython's compiler inlines these and keeps them out of the module
    dict. CPython has no equivalent and does not need one, so this returns the
    value unchanged - `_FOO = const(12)` behaves identically either way.
    """
    return value


def native(func: _F) -> _F:
    """Compile to native code. No-op off a board."""
    return func


def viper(func: _F) -> _F:
    """Compile with the viper code emitter. No-op off a board."""
    return func


def asm_thumb(func: _F) -> _F:
    """Inline Thumb assembler. There is no Thumb here; returns the function."""
    return func


def opt_level(level: int | None = None) -> int:
    """Get or set the compiler optimisation level."""
    global _opt_level
    if level is not None:
        _opt_level = int(level)
    return _opt_level


def alloc_emergency_exception_buf(size: int) -> None:
    """Reserve a buffer for exceptions raised in an interrupt.

    Nothing here raises from an interrupt context - `Timer` callbacks run on
    the main loop between ticks - so there is nothing to reserve.
    """
    return None


def mem_info(verbose: Any = None) -> None:
    """Print heap information, the way a board does."""
    print(f"mem: python objects tracked={len(gc.get_objects())}", file=sys.stderr)


def qstr_info(verbose: Any = None) -> None:
    """Print interned-string information. CPython interns differently."""
    print("qstr: not modelled", file=sys.stderr)


def stack_use() -> int:
    """Current stack usage in bytes. Not measurable here; reported as 0."""
    return 0


def heap_lock() -> int:
    """Forbid allocation. CPython cannot, so this only counts the nesting."""
    return 0


def heap_unlock() -> int:
    return 0


def heap_locked() -> bool:
    return False


def kbd_intr(chr: int) -> None:
    """Set the interrupt character. The simulator leaves Ctrl-C alone."""
    return None


def schedule(func: Callable[[Any], Any], arg: Any = None) -> None:
    """Run `func(arg)` at the next opportunity, off the interrupt.

    On a board this defers work out of an interrupt handler into the main
    loop. Here it defers to the next tick boundary, which is the same
    guarantee: the callback will not run in the middle of something else.
    Raises when the queue is full, as MicroPython's does.
    """
    from machine import _sched

    _sched.schedule(func, arg)
