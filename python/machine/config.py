"""Robot hardware configuration and pin mapping loader."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from . import constants


class PinConfig:
    """Hardware pinout mapping for a robot."""

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        data = data or {}
        self.motors = data.get("motors", constants.DEFAULT_MOTOR_PINS)
        self.kicker = data.get("kicker", constants.DEFAULT_KICKER_PIN)
        self.dribbler = data.get("dribbler", constants.DEFAULT_DRIBBLER_PIN)
        self.lines = data.get("lines", constants.DEFAULT_LINE_PINS)
        self.ball_strength = data.get("ball_strength", constants.DEFAULT_BALL_STRENGTH_PIN)
        self.ball_bearing = data.get("ball_bearing", constants.DEFAULT_BALL_BEARING_PIN)
        self.ir_ring = data.get("ir_ring", constants.DEFAULT_IR_RING_PINS)
        self.compass = data.get("compass", constants.DEFAULT_COMPASS_PIN)
        self.gyro = data.get("gyro", constants.DEFAULT_GYRO_PIN)
        self.ultrasonics = data.get("ultrasonics", constants.DEFAULT_ULTRASONIC_PINS)


_config: PinConfig | None = None


def get_config() -> PinConfig:
    """Retrieve or load the current robot pin configuration."""
    global _config
    if _config is not None:
        return _config

    config_path = Path(os.getcwd()) / "robot_config.py"
    if config_path.is_file():
        try:
            import importlib.util

            spec = importlib.util.spec_from_file_location("robot_config", str(config_path))
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                pins = getattr(mod, "PINS", {})
                _config = PinConfig(pins)
                return _config
        except Exception as e:
            print(f"[machine.config] Warning: Failed to load robot_config.py: {e}", file=sys.stderr)

    _config = PinConfig()
    return _config


def set_config(config: PinConfig) -> None:
    """Explicitly override the pin configuration (useful for testing)."""
    global _config
    _config = config
