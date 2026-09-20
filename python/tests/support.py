"""Shared rig for tests that need a connected `Runtime`.

Not named `test_*`, so `unittest discover` ignores it.

The thing these tests have to work around: `_timebase` and `_sched` both read
the `Runtime` **singleton**, because that is what a student's `time.sleep_ms()`
reaches. The older tests in `test_runtime.py` build a bare `Runtime()` and
never touch the singleton, so they need none of this.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine import _sched, _timebase
from machine._backend import Runtime
from machine.config import PinConfig, set_config
from machine._transport import TransportError, clear_join, use_transport


def sensor_frame(clock: float = 0.0, **overrides: Any) -> dict[str, Any]:
    """One frame, shaped like the server's. `overrides` replace top-level keys."""
    frame: dict[str, Any] = {
        "clock": clock,
        "team": "violet",
        "robot": 1,
        "attackDirection": 1,
        "playing": True,
        "returned": False,
        "kickoff": {"pending": False, "ours": False, "countdown": 0.0},
        "ball": {"strength": 0.5, "bearing": 0.0},
        "compass": {"heading": 0.0},
        "gyro": {"rate": 0.0},
        "lines": [],
        "range": {"front": 500.0, "back": None, "left": 1200.0, "right": None},
        "encoders": [0.0, 0.0, 0.0, 0.0],
        "camera": {
            "goals": {"cyan": None, "yellow": None},
            "goalBlobs": {"cyan": [], "yellow": []},
            "ball": None,
            "fresh": False,
        },
        "ballGate": {"held": False},
        "messages": [],
    }
    frame.update(overrides)
    return {"type": "sensors", "frame": frame}


class ScriptedChannel:
    """A `Channel` that answers every send with the next frame, forever.

    `test_runtime.py`'s `FakeChannel` runs off a fixed script and raises at the
    end, which is what its reconnect tests need. These tests pace a loop
    instead, so this one never runs out.
    """

    def __init__(self, frames: list[dict[str, Any]] | None = None) -> None:
        self.sent: list[dict[str, Any]] = []
        self.frames = 0
        self.welcomed = False
        #: Specific frames to serve, in order. The last one repeats once the
        #: list runs out, so a test can describe the interesting part and stop.
        self.script = frames

    def send(self, payload: Any) -> None:
        if isinstance(payload, (bytes, bytearray)):
            self.sent.append({"type": "command"})
        else:
            self.sent.append(json.loads(payload))

    def recv(self) -> str:
        if not self.welcomed:
            self.welcomed = True
            return json.dumps({"type": "welcome", "robot": "violet-1", "motors": 4})
        self.frames += 1
        if self.script:
            index = min(self.frames - 1, len(self.script) - 1)
            return json.dumps({"type": "sensors", "frame": self.script[index]})
        return json.dumps(sensor_frame(0.02 * self.frames))

    def close(self) -> None:
        pass


def connected_singleton(frames: list[dict[str, Any]] | None = None) -> tuple[Runtime, ScriptedChannel]:
    """Install a fresh, connected `Runtime` as the singleton and return it."""
    set_config(PinConfig())
    clear_join()
    _sched.reset()

    channel = ScriptedChannel(frames)
    use_transport(lambda url: channel)

    Runtime._instance = None
    rt = Runtime.get()
    rt.reconnect_for = 0.0
    rt.ensure_connected()
    return rt, channel


def teardown() -> None:
    use_transport(None)
    _sched.reset()
    Runtime._instance = None
