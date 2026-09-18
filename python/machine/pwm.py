"""MicroPython PWM class implementation for the simulator."""

from __future__ import annotations

from typing import Any

from ._backend import Runtime
from .pin import Pin


class PWM:
    """Pulse Width Modulation controller on a pin."""

    def __init__(
        self,
        dest: int | Pin,
        *,
        freq: int = 1000,
        duty_u16: int = 0,
        duty_ns: int = 0,
    ) -> None:
        self._pin_id = dest.id if isinstance(dest, Pin) else int(dest)
        self._freq = freq
        self._duty_u16 = duty_u16

        backend = Runtime.get()
        if duty_ns > 0:
            # Convert duty_ns to duty_u16 based on freq (period_ns = 1_000_000_000 / freq)
            period_ns = 1_000_000_000 / max(1, self._freq)
            self._duty_u16 = int((duty_ns / period_ns) * 65535)

        backend.set_pwm(self._pin_id, freq=self._freq, duty_u16=self._duty_u16)

    def freq(self, value: int | None = None) -> int:
        """Get or set the PWM frequency in Hz."""
        if value is not None:
            self._freq = value
            Runtime.get().set_pwm(self._pin_id, freq=self._freq)
        return self._freq

    def duty_u16(self, value: int | None = None) -> int:
        """Get or set the PWM duty cycle as a 16-bit unsigned integer (0-65535)."""
        if value is not None:
            self._duty_u16 = max(0, min(65535, int(value)))
            Runtime.get().set_pwm(self._pin_id, duty_u16=self._duty_u16)
        return self._duty_u16

    def duty_ns(self, value: int | None = None) -> int:
        """Get or set the PWM duty cycle in nanoseconds."""
        period_ns = 1_000_000_000 / max(1, self._freq)
        if value is not None:
            duty_frac = value / period_ns
            self._duty_u16 = max(0, min(65535, int(duty_frac * 65535)))
            Runtime.get().set_pwm(self._pin_id, duty_u16=self._duty_u16)
        return int((self._duty_u16 / 65535.0) * period_ns)

    def deinit(self) -> None:
        """Disable PWM on the pin."""
        self._duty_u16 = 0
        Runtime.get().deinit_pwm(self._pin_id)

    def __repr__(self) -> str:
        return f"PWM(Pin({self._pin_id}), freq={self._freq}, duty_u16={self._duty_u16})"
