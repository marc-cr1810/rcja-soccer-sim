"""Write a robot for the RCJA Soccer Simulation league.

    from rcja_soccer import Robot, drive

    robot = Robot(team="cyan", number=1, name="ACT-01")

    @robot.tick
    def think(s, me):
        if s.ball is None:
            return robot.coast()
        return robot.motors(drive(bearing=s.ball.bearing, speed=0.8))

    robot.run()

No dependencies, on purpose: the schools this league exists to reach are the
ones where pip is behind a proxy, offline, or not something a student is
allowed to run, and a dependency is a reason a team cannot enter.
"""

from ._ws import WebSocketError
from .drive import WHEEL_AXES, clamp, coast, drive, wrap_angle
from .robot import DEFAULT_URL, PROTOCOL_VERSION, Memory, Reading, Robot

__all__ = [
    "DEFAULT_URL",
    "PROTOCOL_VERSION",
    "Memory",
    "Reading",
    "Robot",
    "WHEEL_AXES",
    "WebSocketError",
    "clamp",
    "coast",
    "drive",
    "wrap_angle",
]

__version__ = "0.1.0"
