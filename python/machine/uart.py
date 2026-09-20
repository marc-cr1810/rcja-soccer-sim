"""MicroPython UART, with nothing on the other end.

The simulator models one robot on a field. It does not model the serial
device a team might have plugged into theirs, so this presents the real API
and is honest about being unconnected: writes are accepted and discarded,
reads return nothing, `any()` is always 0.

That is deliberately not a fake. A UART that invented plausible bytes would
read like a working sensor and mean nothing - the failure mode this module
family has already been bitten by once.
"""

from __future__ import annotations

from typing import Any


class UART:
    RTS = 1
    CTS = 2
    INV_TX = 4
    INV_RX = 8

    def __init__(self, id: int = 0, baudrate: int = 9600, **kwargs: Any) -> None:
        self.id = int(id)
        self.baudrate = int(baudrate)
        self._open = True

    def init(self, baudrate: int = 9600, **kwargs: Any) -> None:
        self.baudrate = int(baudrate)
        self._open = True

    def deinit(self) -> None:
        self._open = False

    def any(self) -> int:
        return 0

    def read(self, nbytes: int | None = None) -> bytes | None:
        return None

    def readline(self) -> bytes | None:
        return None

    def readinto(self, buf: Any, nbytes: int | None = None) -> int | None:
        return None

    def write(self, buf: Any) -> int:
        return len(buf) if buf is not None else 0

    def sendbreak(self) -> None:
        pass

    def flush(self) -> None:
        pass

    def txdone(self) -> bool:
        return True

    def irq(self, *args: Any, **kwargs: Any) -> None:
        pass

    def __repr__(self) -> str:
        return f"UART({self.id}, baudrate={self.baudrate})"
