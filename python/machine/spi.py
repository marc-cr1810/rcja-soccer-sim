"""MicroPython SPI and SoftSPI, with nothing on the other end.

Same bargain as `uart.py`: the real API, no invented device. Reads come back
as the bus idles - all ones, which is what a MISO line with no slave pulling
it down actually looks like.
"""

from __future__ import annotations

from typing import Any


class SPI:
    MSB = 0
    LSB = 1
    CONTROLLER = 0

    def __init__(self, id: int = 0, baudrate: int = 1_000_000, **kwargs: Any) -> None:
        self.id = int(id)
        self.baudrate = int(baudrate)

    def init(self, baudrate: int = 1_000_000, **kwargs: Any) -> None:
        self.baudrate = int(baudrate)

    def deinit(self) -> None:
        pass

    def read(self, nbytes: int, write: int = 0x00) -> bytes:
        return b"\xff" * int(nbytes)

    def readinto(self, buf: Any, write: int = 0x00) -> None:
        for i in range(len(buf)):
            buf[i] = 0xFF

    def write(self, buf: Any) -> None:
        pass

    def write_readinto(self, write_buf: Any, read_buf: Any) -> None:
        for i in range(len(read_buf)):
            read_buf[i] = 0xFF

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.id}, baudrate={self.baudrate})"


class SoftSPI(SPI):
    """Bit-banged SPI. Same story, no hardware peripheral behind it."""

    def __init__(self, baudrate: int = 500_000, **kwargs: Any) -> None:
        super().__init__(-1, baudrate, **kwargs)
