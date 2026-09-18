"""MicroPython utime module compatibility for RCJA Soccer Sim."""

from __future__ import annotations

import time as _time
from time import *  # noqa: F403

# Ensure machine has initialized the time patches
import machine  # noqa: F401

sleep_ms = getattr(_time, "sleep_ms")
sleep_us = getattr(_time, "sleep_us")
ticks_ms = getattr(_time, "ticks_ms")
ticks_us = getattr(_time, "ticks_us")
ticks_diff = getattr(_time, "ticks_diff")
ticks_add = getattr(_time, "ticks_add")
