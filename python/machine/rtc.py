"""MicroPython RTC.

The date comes from the host, because a match has one and the simulator is not
going to invent a different one. The sub-second field comes from the robot's
own clock - never the match clock, which no board has.
"""

from __future__ import annotations

import time as _time
from typing import Any

from ._backend import Runtime
from . import _timebase


class RTC:
    def __init__(self, id: int = 0) -> None:
        self.id = int(id)
        self._offset: tuple[int, ...] | None = None

    def datetime(self, value: tuple[int, ...] | None = None) -> tuple[int, ...] | None:
        """Get or set (year, month, day, weekday, hour, minute, second, subsecond)."""
        if value is not None:
            self._offset = tuple(value)
            return None
        if self._offset is not None:
            return self._offset
        lt = _time.localtime(_time.time())
        rt = Runtime.get()
        subsecond = int((rt.robot_time % 1.0) * 1000.0)
        # MicroPython's weekday is Monday=0, matching `struct_time.tm_wday`.
        return (
            lt.tm_year,
            lt.tm_mon,
            lt.tm_mday,
            lt.tm_wday,
            lt.tm_hour,
            lt.tm_min,
            lt.tm_sec,
            subsecond,
        )

    def now(self) -> tuple[int, ...] | None:
        return self.datetime()

    def init(self, datetime: tuple[int, ...] | None = None) -> None:
        if datetime is not None:
            self.datetime(datetime)

    def memory(self, data: Any = None) -> Any:
        """RTC user memory. Survives a soft reset on a board; here, nothing does."""
        if data is None:
            return getattr(self, "_mem", b"")
        self._mem = data
        return None
