"""The field, from the rulebook.

Nothing here is privileged information. Every number is printed in the RCJA
Soccer Rules 2026 field diagram and section 2, a team measures them off the
real table before a competition, and a robot that knows where the goal is is
not cheating — it is a robot whose programmer read the rules.

What a robot still does not get is where it *is*, where the ball is, or where
anybody else is. Those have to come out of the sensors. This module only says
what the world is shaped like.

Coordinates match the simulator's own: +x towards the yellow goal, +z towards
one sideline, origin at the centre of the playing area, millimetres throughout.
"""

from __future__ import annotations

import math

#: Rule 2.1.1. The playing area is inside the white lines, exclusive of them.
HALF_LENGTH = 915.0
HALF_WIDTH = 610.0

#: The 50 mm white line sits OUTSIDE the playing area, between HALF_LENGTH and
#: HALF_LENGTH + LINE_THICKNESS. Crossing it is not in itself an offence: rule
#: 5.7.1.6 only punishes a robot that is *wholly* in the out area, and there is
#: a full 250 mm band of out area beyond the line to be wholly inside, at the
#: ends of the field as well as at the touchlines.
LINE_THICKNESS = 50.0
OUT_BAND = 250.0

#: Wall to wall, rule 2.1 diagram: the field is 2430 x 1820 over all.
WALL_X = 1215.0
WALL_Z = 910.0

#: Rule 2.3. The mouth is on the goal line - the inner edge of the white line,
#: flush with the playing area - and the goal runs 74 mm outward from there to
#: the back wall a goal is scored against (rule 5.5.1). Rule 2.3.6 carries the
#: goal's side walls on from there to the end wall, so nothing can pass behind
#: it: driving at your own goal, the thing that stops you is GOAL_MOUTH_X.
GOAL_WIDTH = 450.0
HALF_GOAL_WIDTH = 225.0
GOAL_MOUTH_X = 915.0
GOAL_BACK_X = 989.0

#: From the field diagram.
PENALTY_DEPTH = 300.0
PENALTY_WIDTH = 900.0
NEUTRAL_OFFSET = 300.0
NEUTRAL_POINTS = ((0.0, -NEUTRAL_OFFSET), (0.0, NEUTRAL_OFFSET), (0.0, 0.0))

#: Rule 4.1.2's 220 mm cylinder, and the Open league's 42 mm ball.
ROBOT_RADIUS = 110.0
BALL_RADIUS = 21.0
#: Centre-to-centre distance at which robot and ball are touching.
CONTACT_RANGE = ROBOT_RADIUS + BALL_RADIUS

#: Drivetrain geometry, matching drive.py and the simulator's robot model.
WHEEL_RADIUS = 25.0
MOUNT_RADIUS = 90.0


def attack_x(direction: float) -> float:
    """The x of the goal line this attack direction is shooting at.

    Takes ``s.attack_direction`` (+1 or -1), not a team colour: rule 1.4/5.4
    swaps ends at half-time, so which goal a team shoots at is not fixed for
    the whole match the way its colour is.
    """
    return HALF_LENGTH if direction > 0 else -HALF_LENGTH


def defend_x(direction: float) -> float:
    """The x of the goal line this attack direction is defending."""
    return -attack_x(direction)


def attack_heading(direction: float) -> float:
    """Field heading pointing up the field, towards the opponent's goal."""
    return 0.0 if direction > 0 else math.pi


def their_goal(direction: float) -> str:
    """The camera's name for the goal this attack direction is shooting at."""
    return "yellow" if direction > 0 else "cyan"


def our_goal(direction: float) -> str:
    """The camera's name for the goal this attack direction is defending."""
    return "cyan" if direction > 0 else "yellow"


def other_side(team: str) -> str:
    """The other team's id.

    Team ids are the robot colours — violet or lime; the goals are *places*
    whose paint lives at a fixed place for the whole match, so which name a
    robot calls the goal it is shooting at is a field fact found from the
    frame, not a team fact.
    """
    return "lime" if team == "violet" else "violet"


def goal_centre(side: str) -> tuple[float, float]:
    """Centre of a goal mouth, on the goal line — what the camera ranges to."""
    return (-HALF_LENGTH if side == "cyan" else HALF_LENGTH, 0.0)


def in_penalty_box(x: float, z: float, side: str, slack: float = 0.0) -> bool:
    """Whether a point is inside the penalty box defending the given goal.

    ``side`` names a goal by its paint, which lives at a fixed place; pass the
    frame's ``my_colour`` to get this team's own box in either half.
    """
    if abs(z) > PENALTY_WIDTH / 2 + slack:
        return False
    if side == "cyan":
        return x <= -HALF_LENGTH + PENALTY_DEPTH + slack
    return x >= HALF_LENGTH - PENALTY_DEPTH - slack


def is_out(x: float, z: float) -> bool:
    """Whether a point is outside the playing area, rule 5.9.1's test for Open."""
    return abs(x) > HALF_LENGTH or abs(z) > HALF_WIDTH


def shot_range(bx: float, bz: float, heading: float, side: str) -> float | None:
    """How far a kick from (bx, bz) along a field heading would travel to go in.

    None if it would not go in at all. The kicker fires the ball along the
    robot's *heading*, not along the line from the ball to wherever the program
    was aiming, so this is the question that actually decides whether a shot is
    a shot: ray-cast from the ball and see which boundary it reaches first.

    The distance matters as much as the answer. A ball that leaves the playing
    area goes to a neutral point (rule 5.9.2), and a shot from the far side of
    the halfway line has a keeper, an opposing striker and two metres of carpet
    to survive. Firing one is not ambition, it is a gift.
    """
    dx = math.cos(heading)
    dz = math.sin(heading)
    goal_x, _ = goal_centre(side)

    if dx * goal_x <= 0:
        return None  # pointed away from that goal entirely
    t_goal = (goal_x - bx) / dx
    if t_goal <= 0:
        return None

    # A sideline reached first ends the shot there, out of play.
    if abs(dz) > 1e-6:
        t_side = (math.copysign(HALF_WIDTH, dz) - bz) / dz
        if 0 < t_side < t_goal:
            return None

    # Rule 5.5.1 wants the back wall of the goal; the mouth is the opening it
    # has to fit through, and the ball needs its own width of room.
    if abs(bz + dz * t_goal) > HALF_GOAL_WIDTH - BALL_RADIUS:
        return None
    return t_goal


def kick_lands_in_goal(bx: float, bz: float, heading: float, side: str) -> bool:
    """Whether a kick from here along this heading goes in, at any range."""
    return shot_range(bx, bz, heading, side) is not None


def pass_lands_near(
    bx: float, bz: float, heading: float, target_x: float, target_z: float, tolerance: float = 140.0
) -> float | None:
    """How far a kick from (bx, bz) along heading travels before passing near a teammate.

    The same ray-cast `shot_range` uses, aimed at a robot instead of a goal
    mouth: the kicker fires along the heading, not along the line to wherever
    the program was aiming, so whether a pass finds a teammate is a question
    about the heading, not about where the teammate happens to be standing.
    None if the line never comes within `tolerance` of them, runs backwards,
    or leaves the playing area before it gets there.
    """
    dx = math.cos(heading)
    dz = math.sin(heading)
    t = (target_x - bx) * dx + (target_z - bz) * dz
    if t <= 0:
        return None
    miss = math.hypot(bx + dx * t - target_x, bz + dz * t - target_z)
    if miss > tolerance:
        return None
    if is_out(bx + dx * t, bz + dz * t):
        return None
    return t


def clear_is_safe(bx: float, bz: float, heading: float) -> bool:
    """Whether a clearance along this heading stays in play for a while.

    A keeper's clearance does not have to end up anywhere in particular, but it
    must not simply put the ball out over the nearest sideline, which is the
    usual way a keeper gives possession straight back.
    """
    dx = math.cos(heading)
    dz = math.sin(heading)
    reach = 700.0
    return not is_out(bx + dx * reach, bz + dz * reach)
