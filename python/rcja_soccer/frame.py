"""The field frame, from what the robot can see.

A robot on a real table is not told which way its team is attacking. It looks
at the goals. Both ends are painted a team colour, but colours live at fixed
places and do not move at half-time — what changes (rule 1.4/5.4) is which
goal a team defends. So "my goal" is a *place* fact, not a colour fact: at a
kick-off this robot is standing on its own half, and its goal is the nearer of
the two. A violet robot defending the far end sees its own goal under the
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

from .drive import wrap_angle
from .field import other_side

#: The camera's two goal sightings are named after the goal paint (cyan, yellow),
#: which stays at a fixed place for the whole match; a team id is the robot colour
#: (violet, lime). Half 1: violet defends the cyan goal, lime defends the yellow.
_GOAL_OF_TEAM = {"violet": "cyan", "lime": "yellow"}


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
        #: The end switch as it was when this frame was last anchored. A human
        #: flips it at half time, and that is the only announcement of the swap
        #: a robot gets - see `update()`.
        self._anchored_direction = None
        #: The camera's name for our goal at the last anchor, and ``None``
        #: before the first. See the nearest-goal comment in `update()`.
        self._mine_colour = None

    def update(self, s, heading: float, me_x: float, me_z: float) -> None:
        # The first frame of a kick-off is the moment to look, because `me` is
        # re-anchored there too and the ball is on the centre spot. Between
        # kick-offs, keep the last frame, so the geometry a keeper or striker
        # is aiming at does not tremble with a range measurement.
        # The end switch changed, so somebody carried this robot to the other
        # end between halves (rule 1.4/5.4) and told it so. Look again.
        #
        # This is a *trigger*, not the answer: which goal is which is still
        # decided below from the two camera sightings, because a switch says
        # only that something changed and a robot that trusted it for the
        # answer would have a handedness bug waiting for the day it is set
        # wrong. Without it, a headless match - which swaps ends without ever
        # stopping play, so the start button never falls - would keep the
        # first half's frame for the whole of the second and attack its own
        # goal. Measured: 3.7-0 in the first half, 0.3-7.3 in the second.
        direction = getattr(s, "attack_direction", None)
        swapped = direction is not None and direction != self._anchored_direction

        if not s.kickoff.pending and not swapped:
            self._seen_kickoff = False
            return
        if self._seen_kickoff and not swapped:
            return

        cv = getattr(s, "camera", None)
        if cv is not None and not getattr(cv, "fresh", False):
            # The camera runs at 30 fps against a faster control loop, so most
            # ticks hand back last frame's reading rather than a new one. On an
            # ordinary tick that is harmless - a stale ball or goal sighting is
            # off by one control step. It is not harmless here: a kick-off
            # teleports every robot, and a cached sighting is a bearing and
            # range to the goals from wherever this robot stood *before* that
            # teleport. Freeze that and the whole half's attack direction is
            # built from a snapshot of a position the robot no longer occupies.
            # So wait for a sighting that was actually taken this tick; nothing
            # else here is tight enough on time to need it.
            return
        goals = getattr(cv, "goals", None) if cv is not None else None
        mine = getattr(goals, _GOAL_OF_TEAM[self.team], None)
        theirs = getattr(goals, _GOAL_OF_TEAM[self.other], None)
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
        #
        # `d_mine` and `d_theirs` reduce algebraically to `mine.range ** 2` and
        # `theirs.range ** 2`, so this is purely comparing the two camera range
        # readings. Near the centre circle both ranges are similar, and a small
        # amount of sensor noise can make the opponent's goal measure as the
        # nearer one, flipping the whole frame and sending the striker at its
        # own net. Require a clear margin (> ~5% shorter range, i.e. 0.81x in
        # the squared domain) so ambiguous near-equal readings are left as-is
        # rather than swapped on noise.
        #
        # And "at a kick-off" is the load-bearing part. The start button also
        # goes down when a referee stops play and restarts it where everyone
        # stands - a ball out, a lack of progress - and a striker that is
        # re-anchored 400 mm into the opponents' half finds *their* goal nearer
        # and attacks its own for the rest of the half. Nearest-goal is only
        # asked when the answer can have changed: the first anchor of all, and
        # the end switch moving. Otherwise the goal that was ours still is, and
        # only the geometry is refreshed.
        d_mine = (my_x - me_x) ** 2 + (my_z - me_z) ** 2
        d_theirs = (their_x - me_x) ** 2 + (their_z - me_z) ** 2
        if self._mine_colour is not None and not swapped:
            flip = self._mine_colour != _GOAL_OF_TEAM[self.team]
        elif d_theirs < d_mine * 0.81:
            flip = True
        elif d_mine < d_theirs * 0.81 or self._mine_colour is None:
            flip = False
        else:
            # Too close to call at an end change: the ends did change, so ours
            # is the one that was not ours before - not the one named after us,
            # which is wrong in every second half.
            flip = self._mine_colour == _GOAL_OF_TEAM[self.team]
        if flip:
            my_x, my_z, their_x, their_z = their_x, their_z, my_x, my_z
        self._mine_colour = _GOAL_OF_TEAM[self.other if flip else self.team]

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
        self._anchored_direction = direction

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

    # ------------------------------------------------- attack-relative coords

    @property
    def centre(self) -> tuple[float, float]:
        """The centre spot, as this robot measured it: midway between the goals."""
        return (self.my_x + self.their_x) / 2.0, (self.my_z + self.their_z) / 2.0

    def to_frame(self, x: float, z: float) -> tuple[float, float]:
        """A field point in attack-relative coordinates.

        The frame's ``+x`` runs towards the goal this robot is attacking and
        its origin is the centre spot, so it is the field frame turned to face
        the right way — same origin, same millimetres, same constants. Feed the
        result to :func:`~rcja_soccer.field.in_penalty_box`, ``back_inside`` or
        anything else that takes field coordinates and it still means what it
        says; ``HALF_LENGTH`` is still the goal line, and the goal being
        attacked is now always the one at ``+HALF_LENGTH``.

        That is the point of it. A rule written in these coordinates is the
        same rule at both ends, because the ends are no longer distinguishable
        from inside the rule: there is no ``attack_direction`` left to multiply
        by and so none to forget. ``if bz > 60`` picks the same physical side
        of the field in the first half and the second.

        The lateral axis is ``up`` turned a quarter turn to the left, which
        makes this a *rotation* and not a mirror. That matters here rather than
        being a detail: the open drivetrain is chiral - four tangential wheels
        all driving the same way round - so a frame that flipped handedness
        would turn a robot's own left into its right and every steering
        correction with it.
        """
        cx, cz = self.centre
        dx = x - cx
        dz = z - cz
        return dx * self.up_x + dz * self.up_z, -dx * self.up_z + dz * self.up_x

    def from_frame(self, forward: float, lateral: float) -> tuple[float, float]:
        """Back to field coordinates, for anything that still speaks them."""
        cx, cz = self.centre
        return (
            cx + forward * self.up_x - lateral * self.up_z,
            cz + forward * self.up_z + lateral * self.up_x,
        )

    def heading(self, heading: float) -> float:
        """A compass heading, relative to the goal this robot is attacking.

        Facing the attacking goal reads ``0`` in *both* halves, so the ±pi
        branch cut sits behind the robot rather than under it. Nothing in this
        library needs that - every angle here is compared with ``wrap_angle``,
        which does not care where the cut falls - but a program that filters,
        averages or integrates a heading of its own does, and this is the
        reading to do it to.

        The robot-frame bearing a motor mixer wants comes out the same either
        way: ``travel`` and ``heading`` are both shifted by the same amount, so
        their difference is unchanged. Mixing conventions is therefore safe in
        the one place it would otherwise be easy to get wrong.
        """
        return wrap_angle(heading - self.up_angle())

    def goals(self, s) -> tuple[object | None, object | None]:
        """The camera's two goal sightings, named by what they are to us.

        Returns ``(attacking, defending)``. The camera reports goals by paint,
        because that is what a colour blob detector can tell you, and the paint
        does not move at half-time while (rule 1.4/5.4) which one this team is
        shooting at does. Asking for them this way is the other half of not
        having to track the swap: with ``to_frame`` for the geometry and this
        for the camera, nothing a program reads is still keyed to an end of the
        field.
        """
        camera = getattr(s, "camera", None)
        goals = getattr(camera, "goals", None) if camera is not None else None
        if goals is None:
            return None, None
        return (
            getattr(goals, self.their_colour, None),
            getattr(goals, self.my_colour, None),
        )