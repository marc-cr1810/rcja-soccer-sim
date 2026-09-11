"""An attacking robot.

This is a worked example, not a robot to be proud of. It is meant to be read,
argued with, and beaten — everything it does is something you could have
written, and most of it could be done better.

Run it:

    python striker.py --team cyan --number 1 --name ACT-01

Four ideas here are worth taking, whatever else you change:

1. The ball vanishes. The infrared ring sees nothing at all when a robot is
   between you and the ball, so ``s.ball`` is ``None`` several times a match
   for reasons that have nothing to do with where the ball is. A robot that
   stops dead every time is a robot that stands still while it is defended.

2. Do not drive straight at it. Pushing the ball means pushing it wherever you
   happen to be pointing, and as often as not that is your own net. Come round
   the side first. This is the single biggest difference between a robot that
   scores and one that does not.

3. You know which way is forward without knowing where you are. The compass
   gives your heading in field terms, and your goal is at a fixed field
   bearing, so you can always work out which way to push — even when you have
   no idea whereabouts on the field you are standing.

4. A kick-off is a strike, not a carry. Rule 5.4.7 wants the ball to roll 50 mm
   clear. Leave the dribbler off until it has.
"""

from __future__ import annotations

import argparse
import math

from rcja_soccer import Robot, clamp, drive, wrap_angle

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default="cyan", choices=["cyan", "yellow"])
parser.add_argument("--number", type=int, default=1, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
args = parser.parse_args()

robot = Robot(team=args.team, number=args.number, name=args.name)

#: Which way their goal is, as a field bearing. Cyan attacks +x (0 radians),
#: yellow attacks -x (pi). Nothing else in this file needs to know where the
#: robot is standing.
TOWARDS_THEIR_GOAL = 0.0 if args.team == "cyan" else math.pi

#: The goal the camera should be looking at when we shoot.
THEIR_GOAL = "yellow" if args.team == "cyan" else "cyan"

#: How long to keep chasing a ball we can no longer see, in ticks. The server
#: calls us 50 times a second, so this is about a second and a half.
MEMORY_TICKS = 75


@robot.tick
def think(s, me):
    # Nothing to do before the whistle.
    if not s.playing:
        return robot.coast()

    # A wheel over the white line is worth more than any ball. Rule 5.7.1.6
    # takes a robot that gets wholly into the out area off the field for thirty
    # seconds, and a team playing a robot short loses far more than one chase
    # was ever going to win.
    escape = off_the_line(s)
    if escape is not None:
        return robot.motors(drive(bearing=escape, speed=1.0))

    # Rule 5.4.7: strike the ball clear rather than carrying it off the spot.
    # The dribbler stays off until the kick-off is over.
    if s.kickoff.pending and s.kickoff.ours and s.ball is not None:
        return robot.motors(drive(bearing=s.ball.bearing, speed=1.0))

    seen = remember_ball(s, me)
    if seen is None:
        # Lost it. Turning is better than driving: the ring covers every
        # direction, so if we cannot see the ball we are almost certainly
        # blocked rather than facing the wrong way, and driving blind is how
        # robots end up in the out area.
        return robot.motors(drive(bearing=0.0, speed=0.2, spin=0.5), dribbler=1.0)

    bearing, strength = seen

    # Where their goal is, from here. We do not know our position, but we know
    # our heading, and that is enough.
    goal_bearing = wrap_angle(TOWARDS_THEIR_GOAL - s.compass.heading)

    # Aim for a point behind the ball, on the line from the ball to their goal,
    # so that when we arrive we are already pointing the right way. Everything
    # below is in our own frame: the ball is at this bearing, this far away.
    distance = range_of(strength)
    standoff = clamp(distance * 0.8, 120.0, 260.0)
    ball_x = math.cos(bearing) * distance
    ball_z = math.sin(bearing) * distance
    target_x = ball_x - math.cos(goal_bearing) * standoff
    target_z = ball_z - math.sin(goal_bearing) * standoff

    behind_it = math.hypot(target_x, target_z) < 90
    approach = bearing if behind_it else math.atan2(target_z, target_x)

    # Turn to face their goal while travelling, so the dribbler and the kicker
    # point somewhere useful when the ball arrives.
    spin = clamp(goal_bearing * 0.9, -1.0, 1.0)

    # Shoot only when the camera can actually see the goal ahead of us. It
    # runs at 30 frames a second against this loop's 50, so the same sighting
    # arrives twice about half the time - s.camera.fresh says which.
    goal = getattr(s.camera.goals, THEIR_GOAL)
    lined_up = goal is not None and abs(goal.bearing) < 0.2
    shoot = s.ball_gate.held and lined_up

    return robot.motors(
        drive(bearing=approach, speed=1.0 if behind_it else 0.85, spin=spin),
        dribbler=1.0,
        kicker=shoot,
        say={"role": "striker", "ball": round(bearing, 2)},
    )


def remember_ball(s, me):
    """The ball's bearing and strength, including just after it disappears.

    Kept as a FIELD bearing rather than a robot one. The robot keeps turning
    while the ball is hidden, and a remembered bearing that does not turn with
    it points somewhere worse every tick.
    """
    if s.ball is not None:
        me.field_bearing = wrap_angle(s.compass.heading + s.ball.bearing)
        me.strength = s.ball.strength
        me.age = 0
        return s.ball.bearing, s.ball.strength

    age = me.get("age", MEMORY_TICKS + 1) + 1
    me.age = age
    if age > MEMORY_TICKS:
        return None
    return wrap_angle(me.field_bearing - s.compass.heading), me.strength


def range_of(strength):
    """Roughly how far the ball is, in millimetres.

    Signal strength falls off with the square of distance and reads 1.0 at
    200 mm. It is a decent guess close in and a poor one far out, which is what
    an infrared ring gives you.
    """
    return 200.0 / math.sqrt(max(strength, 1e-4))


def off_the_line(s):
    """A bearing to run in, if any line sensor can see the white line."""
    x = 0.0
    z = 0.0
    hits = 0
    for sensor in s.lines:
        if sensor.surface != "line":
            continue
        hits += 1
        # Run opposite whichever sensor found it.
        x -= math.cos(sensor.bearing)
        z -= math.sin(sensor.bearing)
    if hits == 0:
        return None
    if math.hypot(x, z) < 0.2:
        # Every sensor lit at once: square on a corner, and the directions
        # cancel. Back out the way we came rather than dithering.
        return math.pi
    return math.atan2(z, x)


if __name__ == "__main__":
    robot.run(args.url)
