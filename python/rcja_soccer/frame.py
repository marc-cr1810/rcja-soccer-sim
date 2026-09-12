"""The field frame, from what the robot can see.

A robot on a real table is not told which way its team is attacking. It looks
at the goals. Both ends are painted a team colour, but colours live at fixed
places and do not move at half-time — what changes (rule 1.4/5.4) is which
goal a team defends. So "my goal" is a *place* fact, not a colour fact: at a
kick-off this robot is standing on its own half, and its goal is the nearer of
the two. A cyan robot defending the far end sees its own goal under the
camera's other label, and it does not care.

The camera sees both goals every frame (they are wide targets on the walls of
the hall, and the sweep is the whole field), so the frame can be re-derived at
any moment. It is re-derived at the first frame of a kick-off and frozen until
play is going again: the field does not move while a passage of play is going
on, a frame that does not wobble is a frame a keeper can hold, and a frame
that does not *flip* halfway through a kick-off is a frame a striker can trust
(the striker crosses the centre spot to strike the ball, and closer-to-me
stops being a definition that holds).
"""

from __future__ import annotations

import math

from .field import other_side


class GoalFrame:
    """Which way is up, from the two goal sightings.

    ``up`` is a unit vector pointing from the goal this robot defends to the
    one it attacks — the attack direction as a direction, not as a sign. Every
    quantity that used to be ``DEFEND_X + FORWARD * something`` is instead a
    point on that axis; ``depth(x, z)`` replaces ``(x - DEFEND_X) * FORWARD``
    and means the same thing: the number of millimetres the point is up the
    field from this robot's own goal.

    The frame is measured at the first frame of a kick-off and held until the
    next one, so a keeper's guard spot and a striker's aim do not swim with the
    sensor noise or flip as the striker crosses the centre spot to strike the
    ball. A goal sighting that happens to be missing keeps the last frozen
    frame.
    """

    def __init__(self, team: str) -> None:
        self.team = team
        self.other = other_side(team)
        #: Unit vector from our goal towards theirs.
        self.up_x = 1.0
        self.up_z = 0.0
        #: The centre of the goal this robot's team defends, in field coords.
        self.my_x = 0.0
        self.my_z = 0.0
        #: The centre of the goal this team attacks, in field coordinates.
        self.their_x = 0.0
        self.their_z = 0.0
        self._frozen = False
        self._seen_kickoff = False

    def update(self, s, heading: float, me_x: float, me_z: float) -> None:
        # The first frame of a kick-off is the moment to look, because `me` is
        # re-anchored there too and the ball is on the centre spot. Between
        # kick-offs, keep the last frame, so the geometry a keeper or striker
        # is aiming at does not tremble with a range measurement.
        if not s.kickoff.pending:
            self._seen_kickoff = False
            return
        if self._seen_kickoff:
            return

        cv = getattr(s, "camera", None)
        goals = getattr(cv, "goals", None) if cv is not None else None
        mine = getattr(goals, self.team, None)
        theirs = getattr(goals, self.other, None)
        if mine is None or theirs is None:
            # Nothing to look at - hold whatever frame we had. With an
            # omnidirectional camera and goals that cannot be hidden this is
            # not expected to happen; the guard is for honesty, not for play.
            return

        my_x = me_x + math.cos(heading + mine.bearing) * mine.range
        my_z = me_z + math.sin(heading + mine.bearing) * mine.range
        their_x = me_x + math.cos(heading + theirs.bearing) * theirs.range
        their_z = me_z + math.sin(heading + theirs.bearing) * theirs.range

        # Which of the two is this robot's own goal is a *place* question, not
        # a colour one: at a kick-off it is standing on its own half, so its
        # goal is the nearer of the two. Reaching for the sighting named after
        # the team would be wrong in one half — team colours stay at fixed
        # places while, rule 1.4/5.4, which end each team defends swaps.
        d_mine = (my_x - me_x) ** 2 + (my_z - me_z) ** 2
        d_theirs = (their_x - me_x) ** 2 + (their_z - me_z) ** 2
        if d_theirs < d_mine:
            my_x, my_z, their_x, their_z = their_x, their_z, my_x, my_z

        dx = their_x - my_x
        dz = their_z - my_z
        size = math.hypot(dx, dz) or 1.0
        self.up_x = dx / size
        self.up_z = dz / size
        self.my_x = my_x
        self.my_z = my_z
        self.their_x = their_x
        self.their_z = their_z
        self._seen_kickoff = True
        self._frozen = True

    def up_angle(self) -> float:
        """Field heading that points up the field, towards the other goal."""
        return math.atan2(self.up_z, self.up_x)

    @property
    def my_colour(self) -> str:
        """The camera's name for the goal this team defends.

        The goal colours live at fixed places, so the name is a function of
        where the frame found its own goal, not of the team.
        """
        return "cyan" if self.my_x < 0 else "yellow"

    @property
    def their_colour(self) -> str:
        """The camera's name for the goal this team attacks."""
        return "cyan" if self.their_x < 0 else "yellow"

    def depth(self, x: float, z: float) -> float:
        """How far up the field a point is, measured from our own goal."""
        return (x - self.my_x) * self.up_x + (z - self.my_z) * self.up_z

    def from_our_goal(self, along: float) -> tuple[float, float]:
        """A point ``along`` millimetres up the field from our goal."""
        return self.my_x + self.up_x * along, self.my_z + self.up_z * along