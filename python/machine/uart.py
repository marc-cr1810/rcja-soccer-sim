"""MicroPython UART, with a camera on one port and the team radio on the other.

This used to be an honest no-op: the simulator modelled one robot on a field
and nothing plugged into its serial ports, so writes were discarded and reads
returned nothing. That was true, and it was also the reason a robot written
against hardware alone could not see the goals - the camera existed only in a
full-frame read that no board has.

So the ports now have something on them. Two of them do:

* **UART 0, the camera.** A 360 degree view is a smart camera - an OpenMV or a
  Pi looking into a mirror - running the team's own vision code and sending
  framed packets down a serial line. `machine` does not parse them; it puts
  the bytes in the buffer and the robot does the rest, the same as on a board.
  See `_backend._feed_camera` for the format, and `examples/camera.py` for one
  way to read it.
* **UART 1, the team radio.** A transparent link, so whatever you write comes
  out of your team mate's UART unchanged. Lines of JSON, because that is what
  a team would put on it, and nothing here insists.

Every other id keeps the old behaviour, and keeps it deliberately: a UART that
invented plausible bytes would read like a working sensor and mean nothing.
"""

from __future__ import annotations

from typing import Any

from ._backend import Runtime


class UART:
    RTS = 1
    CTS = 2
    INV_TX = 4
    INV_RX = 8

    def __init__(self, id: int = 0, baudrate: int = 9600, **kwargs: Any) -> None:
        self.id = int(id)
        self.baudrate = int(baudrate)
        self._open = True
        Runtime.get().uart_open(self.id)

    def init(self, baudrate: int = 9600, **kwargs: Any) -> None:
        self.baudrate = int(baudrate)
        self._open = True
        Runtime.get().uart_open(self.id)

    def deinit(self) -> None:
        self._open = False

    def any(self) -> int:
        """How many bytes are waiting.

        Zero on the camera port means the camera had nothing new this tick,
        which is the only way a board finds out its 30fps camera has not kept
        up with a 50Hz loop.
        """
        if not self._open:
            return 0
        return Runtime.get().uart_any(self.id)

    def read(self, nbytes: int | None = None) -> bytes | None:
        if not self._open:
            return None
        return Runtime.get().uart_read(self.id, nbytes)

    def readline(self) -> bytes | None:
        if not self._open:
            return None
        return Runtime.get().uart_readline(self.id)

    def readinto(self, buf: Any, nbytes: int | None = None) -> int | None:
        if not self._open:
            return None
        want = len(buf) if nbytes is None else min(nbytes, len(buf))
        data = Runtime.get().uart_read(self.id, want)
        if not data:
            return None
        buf[: len(data)] = data
        return len(data)

    def write(self, buf: Any) -> int | None:
        if not self._open:
            return None
        data = bytes(buf) if not isinstance(buf, (bytes, bytearray)) else bytes(buf)
        return Runtime.get().uart_write(self.id, data)

    def sendbreak(self) -> None:
        pass

    def flush(self) -> None:
        pass

    def txdone(self) -> bool:
        return True

    def irq(self, *args: Any, **kwargs: Any) -> None:
        """Not wired up. Nothing here delivers a byte outside a tick anyway."""
        pass

    def __repr__(self) -> str:
        return f"UART({self.id}, baudrate={self.baudrate})"
