"""The files a team owns: `board.py`, `camera.py`, `radio.py`.

These live in the robot's own folder rather than in a library, because that is
where they live on a real robot - the file that knows your pin numbers is
yours, and the first thing you change when you build the robot differently.

The guard at the bottom is the important one. The moment one of these reaches
for `rcja_soccer` it has stopped being a file you could put on a board, which
is the entire reason it exists.
"""

from __future__ import annotations

import ast
import math
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "examples"))

from board import Board
from support import connected_singleton, sensor_frame, teardown

TEAM_FILES = ("board.py", "camera.py", "radio.py")

#: Everything a board has. `machine` is firmware; the rest ship with
#: MicroPython itself.
PORTABLE = {
    "machine",
    "math",
    "time",
    "struct",
    "ustruct",
    "json",
    "ujson",
    "sys",
    "usys",
    "array",
}


def imported_by(path: Path) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            modules.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module.split(".")[0])
    return modules


class TestPortability(unittest.TestCase):
    def test_the_team_files_import_only_what_a_board_has(self) -> None:
        siblings = {name[:-3] for name in TEAM_FILES}
        for name in TEAM_FILES:
            modules = imported_by(ROOT / "examples" / name)
            stray = modules - PORTABLE - siblings
            self.assertEqual(
                stray,
                set(),
                f"{name} imports {sorted(stray)}, which a real board does not have - "
                "these three files are the ones that have to run unchanged on one",
            )

    def test_the_guard_would_actually_catch_one(self) -> None:
        """Worthless if it silently enumerates nothing."""
        self.assertIn("machine", imported_by(ROOT / "examples" / "board.py"))


class TestBoardReadings(unittest.TestCase):
    def tearDown(self) -> None:
        teardown()

    def test_it_reads_the_shape_the_library_expects(self) -> None:
        connected_singleton(
            [
                sensor_frame(0.0, compass={"heading": 0.75}, gyro={"rate": -1.5})["frame"],
                sensor_frame(0.02, compass={"heading": 0.75}, gyro={"rate": -1.5})["frame"],
            ]
        )
        board = Board()
        s = board.read()

        self.assertAlmostEqual(s.compass.heading, 0.75, places=2)
        self.assertAlmostEqual(s.gyro.rate, -1.5, places=2)
        self.assertEqual(s.team, "violet")
        self.assertEqual(s.robot, 1)
        self.assertEqual(s.attack_direction, 1)
        self.assertTrue(s.playing)
        self.assertAlmostEqual(s.range.front, 500.0, delta=2.0)
        self.assertIsNone(s.range.back)
        self.assertFalse(s.ball_gate.held)

    def test_the_ring_points_at_the_ball(self) -> None:
        # The ring is eight photodiodes; the bearing is a vector sum you do
        # yourself, not a number the hardware hands over.
        for bearing in (0.0, 0.8, -1.9, 3.0):
            with self.subTest(bearing=bearing):
                connected_singleton(
                    [sensor_frame(0.0, ball={"bearing": bearing, "strength": 0.6})["frame"]]
                )
                s = Board().read()
                self.assertAlmostEqual(
                    math.atan2(
                        math.sin(s.ball.bearing - bearing),
                        math.cos(s.ball.bearing - bearing),
                    ),
                    0.0,
                    delta=0.05,
                )
                teardown()

    def test_no_ball_is_none_rather_than_a_faint_one(self) -> None:
        connected_singleton([sensor_frame(0.0, ball=None)["frame"]])
        self.assertIsNone(Board().read().ball)

    def test_the_line_ring_reports_where_each_sensor_is(self) -> None:
        lines = [{"value": 0.9 if i == 2 else 0.1} for i in range(8)]
        connected_singleton([sensor_frame(0.0, lines=lines)["frame"]])
        s = Board().read()

        surfaces = [sensor.surface for sensor in s.lines]
        self.assertEqual(surfaces.count("line"), 1)
        self.assertEqual(surfaces.index("line"), 2)
        self.assertAlmostEqual(s.lines[2].bearing, math.pi / 2, places=3)

    def test_the_button_is_the_whistle_and_the_restart(self) -> None:
        connected_singleton(
            [
                sensor_frame(0.0, start=False)["frame"],
                sensor_frame(0.02, start=True)["frame"],
                sensor_frame(0.04, start=True)["frame"],
            ]
        )
        board = Board()

        before = board.read()
        self.assertFalse(before.playing)
        self.assertFalse(before.returned)

        time.sleep_ms(20)
        restart = board.read()
        self.assertTrue(restart.playing)
        self.assertTrue(restart.returned)
        self.assertTrue(restart.kickoff.pending)

        time.sleep_ms(20)
        after = board.read()
        self.assertFalse(after.returned)
        self.assertTrue(after.kickoff.pending)

    def test_a_camera_frame_reaches_the_reading_and_then_goes_stale(self) -> None:
        seen = {
            "goals": {"cyan": {"bearing": 1.1, "range": 900.0}, "yellow": None},
            "goalBlobs": {"cyan": [{"start": 1.0, "end": 1.2, "height": 0.15}], "yellow": []},
            "ball": None,
            "fresh": True,
        }
        stale = dict(seen, fresh=False)
        connected_singleton(
            [
                sensor_frame(0.0)["frame"],
                sensor_frame(0.02, camera=seen)["frame"],
                sensor_frame(0.04, camera=stale)["frame"],
            ]
        )
        board = Board()

        time.sleep_ms(20)
        s = board.read()
        self.assertTrue(s.camera.fresh)
        self.assertAlmostEqual(s.camera.goals.cyan.bearing, 1.1, places=2)
        self.assertEqual(len(s.camera.goal_blobs.cyan), 1)

        time.sleep_ms(20)
        s = board.read()
        # The last picture is still the best one you have; what changed is that
        # it is not news.
        self.assertFalse(s.camera.fresh)
        self.assertAlmostEqual(s.camera.goals.cyan.bearing, 1.1, places=2)

    def test_a_message_arrives_shaped_the_way_sense_reads_one(self) -> None:
        connected_singleton(
            [
                sensor_frame(0.0)["frame"],
                sensor_frame(
                    0.02, messages=[{"from": 2, "body": {"ball": [1.0, 2.0]}, "age": 0.0}]
                )["frame"],
            ]
        )
        board = Board()
        time.sleep_ms(20)
        s = board.read()

        self.assertEqual(len(s.messages), 1)
        message = s.messages[0]
        self.assertEqual(message.__getattr__("from"), 2)
        self.assertIn("ball", message.body)
        self.assertEqual(message.body.ball, [1.0, 2.0])

    def test_motors_and_dribbler_reach_the_actuator_frame(self) -> None:
        _, channel = connected_singleton()
        board = Board()
        board.apply(motors=[1.0, -1.0, 0.5, 0.0], dribbler=1.0, kicker=True)
        time.sleep_ms(20)

        command = channel.sent[-1]["frame"]
        self.assertAlmostEqual(command["motors"][0], 1.0, places=2)
        self.assertAlmostEqual(command["motors"][1], -1.0, places=2)
        self.assertAlmostEqual(command["motors"][2], 0.5, places=2)
        self.assertAlmostEqual(command["dribbler"], 1.0, places=2)
        self.assertTrue(command["kicker"])


if __name__ == "__main__":
    unittest.main()
