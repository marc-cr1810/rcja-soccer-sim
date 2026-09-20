"""Write a robot for the RCJA Soccer Simulation league.

    import time
    from machine import Runtime
    from rcja_soccer import coast, drive

    rt = Runtime.get()

    while True:
        s = rt.sensors()
        if s.ball is None:
            rt.send_command(motors=coast())
        else:
            rt.send_command(motors=drive(bearing=s.ball.bearing, speed=0.8))
        time.sleep_ms(20)

No dependencies of its own, on purpose: the schools this league exists to
reach are the ones where pip is behind a proxy, offline, or not something a
student is allowed to run, and a dependency is a reason a team cannot enter.
Nothing here is required. ``machine`` is a complete robot API on its own and
a program that imports none of this is a perfectly good submission; what this
adds is the arithmetic that is tedious to get right - wheel mixing, knowing
where you are, which way you are attacking - as ordinary code you could paste
anywhere.

Three modules, in the order a team meets them:

``drive``   four wheel powers from a direction. Needed on day one.
``field``   the rulebook's own dimensions. Facts, not help.
``sense``   turning readings into where you are and where the ball is.

Everything here is ordinary readable code with no privileged access to
anything. Read it, copy it, and replace the parts you want to beat somebody
with.
"""

from .drive import WHEEL_AXES, clamp, coast, drive, wrap_angle
from .frame import GoalFrame
from .memory import Memory
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

__all__ = [
    "BallTracker",
    "GoalFrame",
    "GyroRate",
    "Locator",
    "Memory",
    "WHEEL_AXES",
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
    "wrap_angle",
]

__version__ = "0.2.0"
