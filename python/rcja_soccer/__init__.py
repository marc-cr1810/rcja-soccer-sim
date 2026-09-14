"""Write a robot for the RCJA Soccer Simulation league.

    from rcja_soccer import Robot, drive

    robot = Robot(team="violet", number=1, name="ACT")

    @robot.tick
    def think(s, me):
        if s.ball is None:
            return robot.coast()
        return robot.motors(drive(bearing=s.ball.bearing, speed=0.8))

    robot.run()

No dependencies, on purpose: the schools this league exists to reach are the
ones where pip is behind a proxy, offline, or not something a student is
allowed to run, and a dependency is a reason a team cannot enter.

Three modules, in the order a team meets them:

``drive``   four wheel powers from a direction. Needed on day one.
``field``   the rulebook's own dimensions. Facts, not help.
``sense``   turning readings into where you are and where the ball is.

Everything outside ``robot`` is ordinary readable code with no privileged
access to anything. Read it, copy it, and replace the parts you want to beat
somebody with.
"""

from ._ws import WebSocketError
from .drive import WHEEL_AXES, clamp, coast, drive, wrap_angle
from .robot import DEFAULT_URL, PROTOCOL_VERSION, Memory, Reading, Robot
from .sense import (
    BallTracker,
    GyroRate,
    Locator,
    YawRate,
    approach_point,
    back_inside,
    goal_blobs,
    keep_inside,
    line_bearing,
    obstacle_range,
    opening,
    pass_is_open,
    relay_ball,
    relay_position,
    shot_is_open,
    spin_towards,
    steer_ball_inside,
    steer_clear_of_edges,
    teammate_ball,
    teammate_position,
    teammate_says,
    teleported,
)
from .transport import Channel, TransportError, use_transport

__all__ = [
    "DEFAULT_URL",
    "PROTOCOL_VERSION",
    "BallTracker",
    "Channel",
    "GyroRate",
    "Locator",
    "Memory",
    "Reading",
    "Robot",
    "TransportError",
    "WHEEL_AXES",
    "WebSocketError",
    "YawRate",
    "approach_point",
    "goal_blobs",
    "opening",
    "shot_is_open",
    "back_inside",
    "clamp",
    "coast",
    "drive",
    "keep_inside",
    "line_bearing",
    "obstacle_range",
    "pass_is_open",
    "relay_ball",
    "relay_position",
    "spin_towards",
    "steer_ball_inside",
    "steer_clear_of_edges",
    "teammate_ball",
    "teammate_position",
    "teammate_says",
    "teleported",
    "use_transport",
    "wrap_angle",
]

__version__ = "0.2.0"
