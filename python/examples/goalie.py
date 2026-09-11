"""A goalkeeper.

Run it:

    python goalie.py --team cyan --number 2 --name ACT-01

Two things here are worth more than the rest of the file.

**Which side of the ball you are on matters more than how near it is.** A
keeper that drives at a ball sitting between itself and its own net pushes it
in. The reference version of this robot scored twenty-five own goals in a
single match before that check was added, and then scored more when the fix
drove it *back through* the ball instead of around it. Get goal-side first, and
go round.

**Staying home is a rule, not just tactics.** Rule 5.11 removes a robot when
two of a team are in their own penalty area and it affects play, so a keeper
that chases upfield can cost you the striker as well as the goal.
"""

from __future__ import annotations

import argparse
import math

from rcja_soccer import Robot, clamp, drive, wrap_angle

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default="cyan", choices=["cyan", "yellow"])
parser.add_argument("--number", type=int, default=2, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
args = parser.parse_args()

robot = Robot(team=args.team, number=args.number, name=args.name)

#: Field bearings. Ours is the goal we defend; theirs is where a clearance goes.
TOWARDS_OUR_GOAL = math.pi if args.team == "cyan" else 0.0
TOWARDS_THEIR_GOAL = 0.0 if args.team == "cyan" else math.pi

#: Close enough to go for the ball rather than hold position.
CLEARING_RANGE = 320.0

#: How near the back wall to sit. Too deep and a shot is in before you move;
#: too far and you have left the goal open behind you.
HOME_RANGE = 260.0


@robot.tick
def think(s, me):
    if not s.playing:
        return robot.coast()

    escape = off_the_line(s)
    if escape is not None:
        return robot.motors(drive(bearing=escape, speed=1.0))

    # The keeper does not take the kick-off, so it simply holds its ground.
    if s.kickoff.pending:
        return robot.coast()

    if s.ball is None:
        return hold(s, me)

    bearing = s.ball.bearing
    distance = 200.0 / math.sqrt(max(s.ball.strength, 1e-4))

    # Are we between the ball and our own net? Work it out from the bearings
    # alone: the ball is goal-side of us if it lies in the same half of the
    # compass as our own goal does.
    to_our_goal = wrap_angle(TOWARDS_OUR_GOAL - s.compass.heading)
    ball_is_behind_us = abs(wrap_angle(bearing - to_our_goal)) < math.pi / 2

    if ball_is_behind_us:
        # Wrong side. Get back past it without touching it, by aiming at a
        # point off to one side rather than straight at the goal line - which
        # would simply carry the ball in with us.
        detour = wrap_angle(to_our_goal + (math.pi / 3 if bearing > 0 else -math.pi / 3))
        return robot.motors(drive(bearing=detour, speed=1.0), say={"role": "goalie"})

    if distance < CLEARING_RANGE:
        # Close, and on the right side of it: go through the ball, up the field.
        upfield = wrap_angle(TOWARDS_THEIR_GOAL - s.compass.heading)
        return robot.motors(
            drive(bearing=bearing, speed=1.0, spin=clamp(upfield * 0.8, -1.0, 1.0)),
            dribbler=1.0,
            kicker=s.ball_gate.held,
            say={"role": "goalie", "active": True},
        )

    return hold(s, me, shadow=bearing)


def hold(s, me, shadow=None):
    """Sit in front of the goal, tracking the ball across it.

    Uses the sonar to the wall behind rather than a position estimate: the
    keeper spends its whole match near one wall, which is exactly where a
    single range reading is reliable, and it never has to know where it is on
    the field at all.
    """
    to_our_goal = wrap_angle(TOWARDS_OUR_GOAL - s.compass.heading)
    upfield = wrap_angle(TOWARDS_THEIR_GOAL - s.compass.heading)
    behind = nearest_wall_behind(s, to_our_goal)

    if behind is not None and behind < HOME_RANGE - 40:
        # Too deep. Come off the line a little.
        bearing = upfield
        speed = 0.5
    elif behind is not None and behind > HOME_RANGE + 40:
        # Too far out. Drop back.
        bearing = to_our_goal
        speed = 0.6
    elif shadow is not None:
        # In position: slide across to stay in front of the ball. The component
        # of the ball's bearing across our goal line is the way to go.
        across = wrap_angle(shadow - upfield)
        bearing = wrap_angle(upfield + (math.pi / 2 if across > 0 else -math.pi / 2))
        speed = min(1.0, abs(math.sin(across)))
    else:
        bearing = 0.0
        speed = 0.0

    # Face up the field, so a save comes off the front and goes forwards.
    return robot.motors(
        drive(bearing=bearing, speed=speed, spin=clamp(upfield * 0.9, -1.0, 1.0)),
        dribbler=1.0,
        say={"role": "goalie", "active": False},
    )


def nearest_wall_behind(s, to_our_goal):
    """Distance to the wall in the direction of our own goal, if the sonar sees it."""
    beams = [
        (0.0, s.range.front),
        (math.pi / 2, s.range.left),
        (math.pi, s.range.back),
        (-math.pi / 2, s.range.right),
    ]
    best = None
    for offset, reading in beams:
        if reading is None:
            continue
        # Only a beam pointing roughly at our own goal tells us anything useful.
        if abs(wrap_angle(offset - to_our_goal)) > math.pi / 4:
            continue
        if best is None or reading < best:
            best = reading
    return best


def off_the_line(s):
    """A bearing to run in, if any line sensor can see the white line."""
    x = 0.0
    z = 0.0
    hits = 0
    for sensor in s.lines:
        if sensor.surface != "line":
            continue
        hits += 1
        x -= math.cos(sensor.bearing)
        z -= math.sin(sensor.bearing)
    if hits == 0:
        return None
    if math.hypot(x, z) < 0.2:
        return math.pi
    return math.atan2(z, x)


if __name__ == "__main__":
    robot.run(args.url)
