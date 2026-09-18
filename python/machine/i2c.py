"""MicroPython I2C and SoftI2C class implementations for simulated sensors."""

from __future__ import annotations

from typing import Any

from ._backend import Runtime
from .pin import Pin


class I2C:
    """Two-wire serial I2C bus controller."""

    def __init__(
        self,
        id: int = -1,
        *,
        scl: Any = None,
        sda: Any = None,
        freq: int = 400000,
    ) -> None:
        self._id = id
        self._scl = scl
        self._sda = sda
        self._freq = freq

    def scan(self) -> list[int]:
        """Scan I2C bus and return list of valid 7-bit device addresses found."""
        return Runtime.get().i2c_scan()

    def readfrom(self, addr: int, nbytes: int, stop: bool = True) -> bytes:
        """Read nbytes from device at addr."""
        # By convention for simple registerless reads, read starting at register 0
        return Runtime.get().i2c_read_mem(addr, 0, nbytes)

    def readfrom_into(self, addr: int, buf: bytearray, stop: bool = True) -> None:
        """Read bytes into existing buffer."""
        data = self.readfrom(addr, len(buf), stop=stop)
        buf[: len(data)] = data

    def writeto(self, addr: int, buf: bytes | bytearray, stop: bool = True) -> int:
        """Write buffer to device at addr."""
        # Simulated sensor registers are generally read-only or self-configuring
        return len(buf)

    def readfrom_mem(self, addr: int, memaddr: int, nbytes: int, *, addrsize: int = 8) -> bytes:
        """Read nbytes from register memaddr on device at addr."""
        return Runtime.get().i2c_read_mem(addr, memaddr, nbytes)

    def readfrom_mem_into(
        self, addr: int, memaddr: int, buf: bytearray, *, addrsize: int = 8
    ) -> None:
        """Read bytes from register memaddr into buffer."""
        data = self.readfrom_mem(addr, memaddr, len(buf), addrsize=addrsize)
        buf[: len(data)] = data

    def writeto_mem(
        self, addr: int, memaddr: int, buf: bytes | bytearray, *, addrsize: int = 8
    ) -> None:
        """Write buffer to register memaddr on device at addr."""
        pass


class SoftI2C(I2C):
    """Software bit-banged I2C controller."""

    def __init__(
        self,
        scl: Any,
        sda: Any,
        *,
        freq: int = 400000,
        timeout: int = 50000,
    ) -> None:
        super().__init__(id=-1, scl=scl, sda=sda, freq=freq)
        self._timeout = timeout
