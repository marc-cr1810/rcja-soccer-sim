"""Unit tests for machine.Runtime's full-frame reads, direct commands, and
reconnect-with-timeout behaviour - the simulator's own back door, which is
firmware's business and not a robot program's."""

from __future__ import annotations

import json
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine._backend import Runtime
from rcja_soccer.reading import Reading
from machine.config import PinConfig, set_config
from machine._transport import TransportError, clear_join, use_transport


def _welcome() -> dict:
    return {"type": "welcome", "robot": "violet-1", "motors": 4}


def _sensor_frame(clock: float = 0.0) -> dict:
    return {
        "type": "sensors",
        "frame": {
            "clock": clock,
            "team": "violet",
            "attackDirection": 1,
            "playing": True,
            "returned": False,
            "kickoff": {"pending": False},
            "ball": {"strength": 0.5, "bearing": 0.0},
            "compass": {"heading": 0.0},
            "gyro": {"rate": 0.0},
            "lines": [],
            "range": {"front": None, "back": None, "left": None, "right": None},
            "encoders": [1.0, 2.0, 3.0, 4.0],
            "camera": {"goals": {}, "goal_blobs": {}, "fresh": True},
            "ballGate": {"held": False},
            "messages": [{"body": {"ball": [100, 200]}, "age": 0.01}],
        },
    }


class FakeChannel:
    """A `Channel` driven from a canned script, the same shape the wire tests use."""

    def __init__(self, script: list[dict]) -> None:
        self.script = list(script)
        self.sent: list[dict] = []
        self.closed = False

    def send(self, text: str) -> None:
        self.sent.append(json.loads(text))

    def recv(self) -> str:
        if not self.script:
            raise TransportError("end of script")
        item = self.script.pop(0)
        return json.dumps(item)

    def close(self) -> None:
        self.closed = True


class TestRuntimeFullFrame(unittest.TestCase):
    def setUp(self) -> None:
        set_config(PinConfig())
        clear_join()

    def tearDown(self) -> None:
        use_transport(None)

    def _connected_runtime(self, extra_frames: int = 0) -> tuple[Runtime, list[FakeChannel]]:
        connections: list[FakeChannel] = []

        def connect(url: str) -> FakeChannel:
            script = [_welcome(), _sensor_frame(0.0)]
            script += [_sensor_frame(0.02 * (i + 1)) for i in range(extra_frames)]
            channel = FakeChannel(script)
            connections.append(channel)
            return channel

        use_transport(connect)
        rt = Runtime()
        rt.ensure_connected()
        return rt, connections

    def test_the_raw_frame_carries_what_no_pin_can(self) -> None:
        rt, _ = self._connected_runtime()
        s = Reading(rt.raw_frame())
        # What `rcja_soccer.simulator.frame()` is for. Two of these a robot
        # genuinely cannot know - whose kick-off it is, and how long until the
        # whistle - and the rest it knows only by doing the work: the camera
        # through a UART parser, the radio through another, the encoders by
        # counting edges. Debugging is the honest use of this.
        self.assertEqual(s.attack_direction, 1)
        self.assertEqual(len(s.encoders), 4)
        self.assertEqual(s.messages[0].body.ball, [100, 200])
        self.assertTrue(s.camera.fresh)

    def test_send_command_is_sent_verbatim_on_the_next_tick_only(self) -> None:
        rt, connections = self._connected_runtime(extra_frames=1)
        rt.send_command(motors=[0.1, 0.2, 0.3, 0.4], dribbler=0.5, kicker=True, say={"role": "striker"})

        frame = rt.build_actuator_frame()
        self.assertEqual(frame, {
            "motors": [0.1, 0.2, 0.3, 0.4],
            "dribbler": 0.5,
            "kicker": True,
            "say": {"role": "striker"},
        })

        # Consumed - a second call with no new send_command() falls back to
        # the (empty) pin-derived frame rather than repeating the last one.
        second = rt.build_actuator_frame()
        self.assertEqual(second["motors"], [0.0, 0.0, 0.0, 0.0])


class TestRuntimeReconnect(unittest.TestCase):
    def setUp(self) -> None:
        set_config(PinConfig())
        clear_join()

    def tearDown(self) -> None:
        use_transport(None)

    def test_sync_tick_reconnects_once_after_a_dropped_connection(self) -> None:
        connections: list[FakeChannel] = []

        def connect(url: str) -> FakeChannel:
            # The handshake's own "wait for the first sensor frame" step
            # consumes both of these, so nothing is left in `connections[0]`
            # once `ensure_connected()` returns.
            channel = FakeChannel([_welcome(), _sensor_frame(0.0)])
            connections.append(channel)
            return channel

        def connect_after_reconnect(url: str) -> FakeChannel:
            # The reconnect gets its own handshake plus one live frame for
            # the tick that triggered it.
            channel = FakeChannel([_welcome(), _sensor_frame(0.0), _sensor_frame(0.02)])
            connections.append(channel)
            return channel

        use_transport(connect)
        rt = Runtime()
        rt.reconnect_for = 5.0
        rt.ensure_connected()
        self.assertEqual(len(connections), 1)
        # Nothing left in the first channel's script, so the next recv()
        # inside sync_tick() raises - simulating the far end going away right
        # after the join completed.
        self.assertEqual(connections[0].script, [])

        use_transport(connect_after_reconnect)
        rt.sync_tick(20.0)

        # sync_tick() caught the drop, reconnected onto a second channel, and
        # completed the tick there - the caller never sees an exception.
        self.assertEqual(len(connections), 2)
        self.assertGreaterEqual(len(connections[1].sent), 1)

    def test_ensure_connected_gives_up_once_reconnect_for_is_spent(self) -> None:
        def connect(url: str) -> FakeChannel:
            raise TransportError("nothing is listening")

        use_transport(connect)
        rt = Runtime()
        rt.reconnect_for = 0.0  # any attempt has already used up the budget

        with self.assertRaises(TransportError):
            rt.ensure_connected()


if __name__ == "__main__":
    unittest.main()
