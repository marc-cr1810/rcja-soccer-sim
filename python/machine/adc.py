"""MicroPython ADC class implementation for the simulator."""

from __future__ import annotations

from typing import Any

from . import constants
from ._backend import Runtime
from .pin import Pin


class ADC:
    """Analog to Digital Converter on a virtual pin."""

    ATTN_0DB = constants.ATTN_0DB
    ATTN_2_5DB = constants.ATTN_2_5DB
    ATTN_6DB = constants.ATTN_6DB
    ATTN_11DB = constants.ATTN_11DB

    WIDTH_9BIT = constants.WIDTH_9BIT
    WIDTH_10BIT = constants.WIDTH_10BIT
    WIDTH_11BIT = constants.WIDTH_11BIT
    WIDTH_12BIT = constants.WIDTH_12BIT

    def __init__(self, pin: int | Pin, *, atten: int = 0) -> None:
        self._pin_id = pin.id if isinstance(pin, Pin) else int(pin)
        self._atten = atten
        self._width = constants.WIDTH_12BIT

    def atten(self, value: int) -> None:
        """Set attenuation level."""
        self._atten = value

    def width(self, value: int) -> None:
        """Set ADC resolution bit width."""
        self._width = value

    def read_u16(self) -> int:
        """Read 16-bit analog value, normalized to 0-65535."""
        return Runtime.get().read_adc(self._pin_id)

    def read_uv(self) -> int:
        """Read analog voltage in microvolts based on attenuation setting."""
        raw_u16 = self.read_u16()
        # Full scale voltage depending on attenuation:
        # ATTN_0DB: 1.1V -> 1,100,000 uV
        # ATTN_2_5DB: 1.5V -> 1,500,000 uV
        # ATTN_6DB: 2.2V -> 2,200,000 uV
        # ATTN_11DB: 3.3V -> 3,300,000 uV
        max_uv = {
            constants.ATTN_0DB: 1_100_000,
            constants.ATTN_2_5DB: 1_500_000,
            constants.ATTN_6DB: 2_200_000,
            constants.ATTN_11DB: 3_300_000,
        }.get(self._atten, 3_300_000)

        return int((raw_u16 / 65535.0) * max_uv)

    def __repr__(self) -> str:
        return f"ADC(Pin({self._pin_id}), atten={self._atten})"
