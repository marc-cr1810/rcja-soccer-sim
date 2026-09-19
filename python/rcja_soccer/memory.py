"""Somewhere to keep things between ticks."""

from __future__ import annotations

from typing import Any


class Memory:
    """Somewhere to keep things between ticks.

    A `while True` loop's own local variables already do this, so `Memory` is
    a convenience rather than a requirement: attribute-style storage with a
    helpful error on a name that was never set, instead of a plain dict's
    silent `KeyError` or a stray `None`.

    Nothing clears this automatically. A tick-callback framework used to wipe
    it on kick-off for you; a real MicroPython program manages its own state
    explicitly, the same as `sense.Locator`/`sense.BallTracker`/
    `frame.GoalFrame` already require an explicit `.reset()` call - so if a
    program wants a kick-off to mean "forget what I knew", it does
    ``if s.kickoff.pending: mem.clear()`` itself.
    """

    def __init__(self) -> None:
        self.__dict__["_store"] = {}

    def __getattr__(self, name: str) -> Any:
        try:
            return self.__dict__["_store"][name]
        except KeyError:
            raise AttributeError(
                f"nothing remembered under {name!r}. Set me.{name} first, or use "
                f"me.get({name!r}, default)"
            ) from None

    def __setattr__(self, name: str, value: Any) -> None:
        self.__dict__["_store"][name] = value

    def get(self, name: str, default: Any = None) -> Any:
        """What was remembered, or a default if this is the first time."""
        return self.__dict__["_store"].get(name, default)

    def __contains__(self, name: str) -> bool:
        return name in self.__dict__["_store"]

    def clear(self) -> None:
        self.__dict__["_store"].clear()
