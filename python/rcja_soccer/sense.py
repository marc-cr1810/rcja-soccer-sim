"""Turning sensor readings into the two things a strategy actually wants.

A strategy wants to know where it is and where the ball is. No sensor answers
either question. Each one answers a fragment of it, badly, in the robot's own
frame, and the fragments disagree — which is the whole job, and the reason this
module exists separately from the robots that use it.

It is ordinary, readable code, the same as ``drive.py``. Read it. Copy it.
Replace it. The parts most worth replacing are marked.

Three things here are worth understanding before trusting any of it:

**The camera is the sensor with a range on it.** ``s.ball.strength`` falls off
with the square of distance and is therefore a range in principle, but it
saturates: at the mouth of the dribbler it reads 1.0, and it keeps reading 1.0
for every distance closer than that. The infrared ring's real contribution is a
*bearing*, fifty times a second, that no opponent can fake. Take bearing from
the ring and range from the camera and you have a better ball estimate than
either sensor gives alone, which is what :class:`BallTracker` does.

**The sonars are the most accurate thing on the robot, and the most dangerous.**
Eight millimetres of noise against the camera's nine percent — but a sonar does
not report the distance to a *wall*, it reports the distance to whatever came
back first, and on a soccer field that is regularly another robot. Treat every
echo as a wall and one opponent standing in front of the goal moves the fix by
most of a metre, which is precisely how a keeper ends up driving out to the
halfway line convinced it is on its own line. An echo can only ever be
*shorter* than the wall behind it, so the test is cheap: predict the wall from
something that cannot be occluded, and throw away any echo that comes back
too early. :class:`Locator` does that, and it is the difference between the
sonars being the best sensor on the robot and the worst.

**Fusing means weighting.** Averaging a 6 mm measurement with a 90 mm one
throws away most of the good one. :class:`Locator` keeps a weight per reading
and solves for the position that best fits all of them at once, which is a
dozen lines of arithmetic and worth every one.
"""

from __future__ import annotations

import math

from .drive import clamp, wrap_angle
from .field import (
    BALL_RADIUS,
    CONTACT_RANGE,
    HALF_LENGTH,
    HALF_WIDTH,
    MOUNT_RADIUS,
    ROBOT_RADIUS,
    WALL_X,
    WALL_Z,
    WHEEL_RADIUS,
    goal_centre,
)

#: Matches IR_REFERENCE_RANGE in the simulator: strength reads 1.0 at contact,
#: and says nothing at all about anything closer.
IR_REFERENCE_RANGE = 131.0

#: Roughly what each reading is worth, as a standard deviation in mm. These are
#: the numbers the weighting is built on, and they come from the simulator's
#: own sensor model — a team measuring their own hardware would put their own
#: numbers here and get a better fix than these give.
SONAR_SD = 8.0
CAMERA_RANGE_SD_FRACTION = 0.09
CAMERA_BEARING_SD = 0.02


# --------------------------------------------------------------- yaw from wheels


class YawRate:
    """How fast the robot is turning, from the wheel encoders.

    Differencing the compass would do it too, and badly: the compass is noisy
    and the difference of two noisy numbers over a 20 ms tick is mostly noise.
    The encoders are clean, and on a four-wheel omni drive the translation
    cancels out of their mean exactly, leaving rotation — which is worth knowing
    because a heading controller without a rate term oscillates, and an
    oscillating robot cannot dribble.
    """

    def __init__(self, tau: float = 0.05) -> None:
        self.rate = 0.0
        self.moving = 0.0
        self._tau = tau
        self._last: list[float] | None = None
        self._clock: float | None = None

    def update(self, s) -> float:
        clock = s.clock
        dt = 0.02 if self._clock is None else max(1e-3, clock - self._clock)
        self._clock = clock

        encoders = list(getattr(s, "encoders", []) or [])
        last = self._last
        self._last = encoders
        if last is None or len(last) != len(encoders) or not encoders:
            return self.rate

        turns = [a - b for a, b in zip(encoders, last)]
        # Every tangential wheel turns the same way to spin the chassis, so the
        # mean is rotation and the rest is translation.
        mean = sum(turns) / len(turns) / dt
        omega = mean * WHEEL_RADIUS / MOUNT_RADIUS
        # How hard the wheels are working at all, which is how a stall is told
        # apart from standing still on purpose.
        self.moving = sum(abs(t) for t in turns) / len(turns) / dt * WHEEL_RADIUS

        blend = min(1.0, dt / self._tau)
        self.rate += (omega - self.rate) * blend
        return self.rate

    def reset(self) -> None:
        self.rate = 0.0
        self._last = None
        self._clock = None


class CompassBias:
    """Recover the compass's slow drift from the goal posts.

    The compass is the only sensor with an absolute reference, and its needle
    wanders a few degrees over a half. A driver never notices; a strategy that
    projects every reading into field coordinates through ``heading`` does,
    and the error is the whole world rotating gently underneath it.

    The drift cannot be measured from the compass itself, but the goals are
    always at the same two absolute places and the camera sees them every
    frame. Whatever the compass says, the bearing to a goal from a known spot
    is exact, so the difference between that and the camera's bearing to the
    same goal is the drift, averaged over both goals and smoothed over time.
    """

    def __init__(self, alpha: float = 0.03) -> None:
        self.bias = 0.0
        self._alpha = alpha

    def update(self, me_x: float, me_z: float, heading: float, s) -> None:
        """Fold this frame's goal sightings into the drift estimate.

        ``me`` is the previous frame's fix, which is a short lag on a bias that
        moves a fraction of a degree a second; the position error it puts into
        the true bearing washes out of the average.
        """
        camera = getattr(s, "camera", None)
        goals = getattr(camera, "goals", None) if camera is not None else None
        if goals is None:
            return
        errors = 0.0
        count = 0
        for side in ("cyan", "yellow"):
            sighting = getattr(goals, side, None)
            if sighting is None:
                continue
            gx, gz = goal_centre(side)
            true = math.atan2(gz - me_z, gx - me_x)
            observed = wrap_angle(heading + sighting.bearing)
            errors += wrap_angle(observed - true)
            count += 1
        if count:
            self.bias = wrap_angle(self.bias + self._alpha * (errors / count - self.bias))

    def corrected(self, heading: float) -> float:
        """The heading the compass is really pointing in."""
        return wrap_angle(heading - self.bias)


def spin_towards(error: float, yaw: YawRate, kp: float = 1.4, kd: float = 0.28) -> float:
    """Spin power that turns to face something and stops there.

    Proportional to the heading error, damped by how fast the robot is already
    turning. Without the damping term the robot overshoots and comes back, over
    and over, and every reading it takes while doing it is taken from a chassis
    that is rotating.
    """
    return clamp(error * kp - yaw.rate * kd, -1.0, 1.0)


# ------------------------------------------------------------------ where am I


class Locator:
    """Where the robot is, from everything that has an opinion about it.

    Each reading is written as a scalar constraint on the position: "my
    position, projected onto this direction, is that number, and I am this sure
    of it". A sonar echo off the +x wall is one of those. So is the range to a
    goal, and so, separately, is the *bearing* to a goal — which is a much
    better measurement than the range and deserves a much bigger weight.

    Solving the pile of them is a two-by-two least squares, which is small
    enough to write out. The alternative — averaging position estimates — lets
    the camera's 9% range error swamp the sonar's 8 mm.

    The sonar readings are checked before they are believed. The camera's fix
    on the goals cannot be occluded, so it goes first and every echo is then
    asked whether it came back sooner than the wall it was supposed to find.
    The ones that did bounced off a robot, and using them is worth roughly
    eight hundred millimetres of error apiece.
    """

    def __init__(self, team: str) -> None:
        self.team = team
        self.x = 0.0
        self.z = 0.0
        #: 0 when the fix is a guess carried over, 1 when it is well determined.
        self.confidence = 0.0
        self._started = False

    def reset(self) -> None:
        self.x = 0.0
        self.z = 0.0
        self.confidence = 0.0
        self._started = False

    def update(self, s, heading: float) -> tuple[float, float]:
        # Normal equations for sum of w * (n . p - c)^2.
        axx = ayy = axy = bx = bz = 0.0

        def constrain(nx: float, nz: float, c: float, sd: float) -> None:
            nonlocal axx, ayy, axy, bx, bz
            w = 1.0 / (sd * sd)
            axx += w * nx * nx
            ayy += w * nz * nz
            axy += w * nx * nz
            bx += w * nx * c
            bz += w * nz * c

        # -- camera, first -------------------------------------------------
        # A goal is a wide target high on the goal line and a robot does not
        # hide it, so this is the one fix nothing on the field can spoil. It
        # goes first because everything else needs a prior to be checked
        # against.
        #
        # A sighting is two measurements, not one: a range along the line of
        # sight, and a bearing across it. They deserve very different weights,
        # so they are entered as two constraints in the two directions.
        seen: list[tuple[float, float, float]] = []  # (x, z, range)
        camera = getattr(s, "camera", None)
        goals = getattr(camera, "goals", None) if camera is not None else None
        for side in ("cyan", "yellow"):
            sighting = getattr(goals, side, None) if goals is not None else None
            if sighting is None:
                continue
            gx, gz = goal_centre(side)
            angle = wrap_angle(heading + sighting.bearing)
            ux, uz = math.cos(angle), math.sin(angle)
            px = gx - ux * sighting.range
            pz = gz - uz * sighting.range
            seen.append((px, pz, sighting.range))
            constrain(ux, uz, px * ux + pz * uz, max(30.0, CAMERA_RANGE_SD_FRACTION * sighting.range))
            constrain(-uz, ux, px * -uz + pz * ux, max(8.0, CAMERA_BEARING_SD * sighting.range))

        if seen:
            prior_x = sum(p[0] for p in seen) / len(seen)
            prior_z = sum(p[1] for p in seen) / len(seen)
            # Roughly how wrong that prior can be, so the gate below is not
            # tighter than the thing it is gating with.
            gate = max(140.0, 0.22 * min(p[2] for p in seen))
        elif self._started:
            prior_x, prior_z = self.x, self.z
            gate = 260.0
        else:
            prior_x, prior_z, gate = 0.0, 0.0, 1e9

        # -- sonar, checked ------------------------------------------------
        for offset, reading in (
            (0.0, s.range.front),
            (math.pi / 2, s.range.left),
            (math.pi, s.range.back),
            (-math.pi / 2, s.range.right),
        ):
            if reading is None:
                continue
            angle = wrap_angle(heading + offset)
            dx = math.cos(angle)
            dz = math.sin(angle)
            reach = reading + ROBOT_RADIUS

            # Which wall this beam would reach from the prior, and how far.
            tx = (math.copysign(WALL_X, dx) - prior_x) / dx if abs(dx) > 1e-6 else math.inf
            tz = (math.copysign(WALL_Z, dz) - prior_z) / dz if abs(dz) > 1e-6 else math.inf
            expected = min(tx, tz)

            # An echo shorter than the wall behind it came off something that
            # is not the wall — another robot, almost always. The reverse can
            # only be prior error, so it is tolerated.
            if reach < expected - gate:
                continue

            if tx <= tz:
                # An x wall. A glancing beam measures the distance along a
                # direction it barely points in, so it is worth less.
                if abs(dx) < 0.25:
                    continue
                constrain(1.0, 0.0, math.copysign(WALL_X, dx) - reach * dx, SONAR_SD / abs(dx))
            else:
                if abs(dz) < 0.25:
                    continue
                constrain(0.0, 1.0, math.copysign(WALL_Z, dz) - reach * dz, SONAR_SD / abs(dz))

        det = axx * ayy - axy * axy
        # A determinant near zero means every reading constrains the same
        # direction — two sonars both looking down the field, say — and there
        # is nothing to solve. Keep the old fix rather than inventing a new one.
        scale = max(axx, ayy, 1e-9)
        if det > 1e-6 * scale * scale:
            self.x = (bx * ayy - bz * axy) / det
            self.z = (bz * axx - bx * axy) / det
            self.confidence = 1.0
            self._started = True
        else:
            self.confidence = max(0.0, self.confidence - 0.05)

        self.x = clamp(self.x, -WALL_X, WALL_X)
        self.z = clamp(self.z, -WALL_Z, WALL_Z)
        return self.x, self.z


# ---------------------------------------------------------------- where is it


class BallTracker:
    """Where the ball is and where it is going, in field coordinates.

    Kept in field coordinates on purpose. A bearing is only meaningful at the
    instant it was measured from the heading it was measured at; a position on
    the field survives the robot turning round, survives the ball disappearing
    behind an opponent, and can be told to a team mate over the radio, which a
    bearing cannot.

    Bearing comes from the infrared ring, which reports every tick and cannot be
    confused by anything but an occlusion. Range comes from the camera when the
    camera has a frame, because the ring's strength saturates at the dribbler
    mouth and is a poor range everywhere else. The estimate carries a velocity,
    which is what lets a keeper move to where the ball is going rather than to
    where it was.
    """

    #: Seconds of memory. Beyond this the ball has not been seen for long
    #: enough that acting on the last sighting is worse than admitting it.
    MEMORY = 1.2

    def __init__(self) -> None:
        self.x = 0.0
        self.z = 0.0
        self.vx = 0.0
        self.vz = 0.0
        self.age = 99.0
        self._clock: float | None = None
        self._have = False

    def reset(self) -> None:
        self.__init__()

    @property
    def seen(self) -> bool:
        """Whether the estimate is recent enough to act on."""
        return self._have and self.age <= self.MEMORY

    @property
    def fresh(self) -> bool:
        """Whether the ball was actually measured within the last few ticks."""
        return self._have and self.age < 0.12

    def update(self, s, heading: float, me_x: float, me_z: float) -> None:
        clock = s.clock
        dt = 0.02 if self._clock is None else clamp(clock - self._clock, 1e-3, 0.5)
        self._clock = clock

        # Carry the estimate forward, with the carpet slowing the ball down.
        self.x += self.vx * dt
        self.z += self.vz * dt
        decay = math.exp(-dt * 1.5)
        self.vx *= decay
        self.vz *= decay
        self.age += dt

        bearing = None
        distance = None

        ir = getattr(s, "ball", None)
        if ir is not None:
            bearing = wrap_angle(heading + ir.bearing)
            if ir.strength < 0.98:
                # Usable, if coarse. At 0.98 and above the ring is saturated and
                # the only honest reading is "against the shell".
                distance = IR_REFERENCE_RANGE / math.sqrt(max(ir.strength, 1e-4))
            else:
                distance = CONTACT_RANGE

        camera = getattr(s, "camera", None)
        cam_ball = getattr(camera, "ball", None) if camera is not None else None
        if cam_ball is not None and getattr(camera, "fresh", False):
            # The camera has a real range. Keep the ring's bearing when there is
            # one — it is this tick's, and the camera frame may not be.
            distance = cam_ball.range
            if bearing is None:
                bearing = wrap_angle(heading + cam_ball.bearing)

        if bearing is None or distance is None:
            return

        mx = me_x + math.cos(bearing) * distance
        mz = me_z + math.sin(bearing) * distance

        if not self._have:
            self.x, self.z, self.vx, self.vz = mx, mz, 0.0, 0.0
            self._have = True
            self.age = 0.0
            return

        # A light low-pass on position, and velocity from how fast the estimate
        # is being dragged. Heavier smoothing on velocity: it is a difference of
        # two noisy numbers and deserves to be distrusted.
        gain = 0.45
        px, pz = self.x, self.z
        self.x += (mx - self.x) * gain
        self.z += (mz - self.z) * gain
        vgain = clamp(dt / 0.18, 0.0, 1.0)
        self.vx += (((self.x - px) / dt) - self.vx) * vgain
        self.vz += (((self.z - pz) / dt) - self.vz) * vgain
        self.age = 0.0

    def predict(self, seconds: float) -> tuple[float, float]:
        """Where the ball will be, if nothing touches it.

        Integrated against the same carpet drag the estimate decays with, so a
        fast ball is not projected halfway across the hall.
        """
        if seconds <= 0:
            return self.x, self.z
        k = 1.5
        travel = (1.0 - math.exp(-k * seconds)) / k
        return self.x + self.vx * travel, self.z + self.vz * travel

    def speed(self) -> float:
        return math.hypot(self.vx, self.vz)


# ------------------------------------------------------------- what is in front


def obstacle_range(s, heading: float, x: float, z: float, offset: float = 0.0) -> float | None:
    """How far away the robot in the way is, or None if the way is clear.

    The same fact that makes a sonar dangerous for localisation makes it the
    only sensor on this robot that can see an opponent at all: it reports the
    distance to whatever came back first, and an echo that arrives sooner than
    the wall behind it came off something that is not the wall.

    Worth having because a striker cannot otherwise tell a clear shot from one
    into a defender's shell. A blocked shot from a metre out rebounds off the
    playing area more often than not, and rule 5.9.2 puts the ball back on a
    neutral point — so the robot that fires anyway has given away possession to
    make its own save.
    """
    beam = {
        0: getattr(s.range, "front", None),
        1: getattr(s.range, "left", None),
        2: getattr(s.range, "back", None),
        3: getattr(s.range, "right", None),
    }[round(wrap_angle(offset) / (math.pi / 2)) % 4]
    if beam is None:
        return None

    angle = wrap_angle(heading + offset)
    dx = math.cos(angle)
    dz = math.sin(angle)
    tx = (math.copysign(WALL_X, dx) - x) / dx if abs(dx) > 1e-6 else math.inf
    tz = (math.copysign(WALL_Z, dz) - z) / dz if abs(dz) > 1e-6 else math.inf
    wall = min(tx, tz)

    reach = beam + ROBOT_RADIUS
    # Generous, because the position fix behind `wall` has its own error and a
    # phantom obstacle costs a shot the robot should have taken.
    if reach < wall - 220.0:
        return beam
    return None


# ------------------------------------------------------------------- the edges


def line_bearing(s) -> float | None:
    """Robot-frame direction of the white line under the chassis, or None.

    Note what this is *not*: it is not "which way to escape". Which way to
    escape depends on which side of the line the robot is on, and the ring
    cannot tell you that — the reading from a robot 50 mm inside the line and
    one 50 mm outside it is the same reading. Driving away from the line is
    right in the first case and drives you off the field in the second, and a
    robot that gets it wrong oscillates on the boundary until the referee
    removes it under rule 5.7.1.6.

    Only the position fix knows which side you are on, so let it decide and use
    this for what the ring is genuinely good for: knowing the boundary is
    underneath you right now, at 50 Hz, without waiting on a camera frame.

    There is a second reason not to lean on it. Eight sensors on a 95 mm ring
    sit 75 mm apart, and the line is 50 mm wide, so the line fits between two
    of them: a robot parked square across the boundary can have every sensor
    on carpet. The ring tells you the line is there; it does not tell you it
    is not.
    """
    x = 0.0
    z = 0.0
    hits = 0
    for sensor in s.lines:
        if sensor.surface != "line":
            continue
        hits += 1
        x += math.cos(sensor.bearing)
        z += math.sin(sensor.bearing)
    if hits == 0:
        return None
    if math.hypot(x, z) < 0.2:
        # Line all the way round, which means the chassis is sitting in a
        # corner of the band. There is no single direction to report.
        return None
    return math.atan2(z, x)


def back_inside(x: float, z: float, margin: float = 150.0) -> tuple[float, float]:
    """The nearest spot comfortably inside the playing area.

    The shortest way back on, which beats heading for the centre circle: a
    robot over the touchline at the far end has a metre and a half of field to
    cross before it is legal again, and only needs to travel 200 mm.
    """
    return (
        clamp(x, -(HALF_LENGTH - margin), HALF_LENGTH - margin),
        clamp(z, -(HALF_WIDTH - margin), HALF_WIDTH - margin),
    )


def keep_inside(x: float, z: float, margin: float = 150.0) -> tuple[float, float]:
    """A field-frame nudge back towards the playing area, growing near the edge.

    Zero well inside the field, so it costs nothing, and strong enough at the
    line to win an argument with whatever the strategy wanted.
    """
    push_x = 0.0
    push_z = 0.0
    over_x = abs(x) - (HALF_LENGTH - margin)
    if over_x > 0:
        push_x = -math.copysign(clamp(over_x / margin, 0.0, 1.6), x)
    over_z = abs(z) - (HALF_WIDTH - margin)
    if over_z > 0:
        push_z = -math.copysign(clamp(over_z / margin, 0.0, 1.6), z)
    return push_x, push_z


#: Past these the robot refuses to travel further out, whatever it wanted.
#: Neither is the white line: the touchline stop is inside it because a ball
#: out there would already have been moved to a neutral point (rule 5.9.2), so
#: there is nothing to chase; the end stop is outside it because the goal mouth
#: is, and a striker that will not cross the goal line cannot score.
EDGE_STOP_Z = HALF_WIDTH - 25.0
EDGE_STOP_X = HALF_LENGTH + 15.0


def steer_clear_of_edges(
    travel: float,
    x: float,
    z: float,
    margin: float = 150.0,
    stop_x: float = EDGE_STOP_X,
    stop_z: float = EDGE_STOP_Z,
) -> float:
    """Bend a direction of travel away from the boundary, and then forbid it.

    Two mechanisms, because one is not enough. The push is proportional and
    starts early, so most of the time the robot simply curves away and nothing
    looks like an intervention. The stop is absolute and applies at the very
    edge: past it, the outward component of the command is deleted.

    The stop is what stops rule 5.7.1.6. A proportional push alone loses, and
    loses in the worst way — a robot chasing a ball towards a touchline at
    full speed carries most of a metre of momentum past the point where the
    push finally exceeds what it was asked to do, ends up wholly in the out
    area, and is removed for thirty seconds. That is not a near miss; it is
    the most expensive thing on the field, and it happens to a robot that was
    only doing what it was told.
    """
    px, pz = keep_inside(x, z, margin)
    wx = math.cos(travel) + px
    wz = math.sin(travel) + pz

    # Past the stop, the command is not merely trimmed of its outward part, it
    # is turned around. Deleting the outward component leaves the robot
    # coasting: an unpowered robot on this drivetrain takes about 140 mm to
    # come to rest from full speed, which is most of the way from the stop to
    # being wholly out. Driving inward spends those 140 mm braking instead.
    if abs(z) > stop_z:
        wz = -math.copysign(1.8, z)
    if abs(x) > stop_x:
        wx = -math.copysign(1.8, x)

    if abs(wx) < 1e-6 and abs(wz) < 1e-6:
        # Everything it wanted is forbidden. Head for the middle.
        return math.atan2(-z, -x)
    return math.atan2(wz, wx)


def approach_point(
    ball_x: float,
    ball_z: float,
    aim_x: float,
    aim_z: float,
    standoff: float = 190.0,
) -> tuple[float, float]:
    """The spot to be in to push the ball at the aim point.

    Directly behind the ball on the line to the target. Driving at the ball
    instead means pushing it in whatever direction the robot happened to arrive
    from, which is how a robot scores at its own end.

    Pulled back inside the field if the geometry puts it outside one, because a
    spot the robot cannot legally stand in is not a spot: a ball against the
    touchline has its approach point in the crowd, and a robot that drives at
    it goes out of play and takes the ball with it.
    """
    dx = aim_x - ball_x
    dz = aim_z - ball_z
    size = math.hypot(dx, dz) or 1.0
    px = ball_x - dx / size * standoff
    pz = ball_z - dz / size * standoff
    reach = ROBOT_RADIUS * 0.4
    return (
        clamp(px, -HALF_LENGTH - reach, HALF_LENGTH + reach),
        clamp(pz, -HALF_WIDTH - reach, HALF_WIDTH + reach),
    )


def push_keeps_ball_in(ball_x: float, ball_z: float, push: float, reach: float = 320.0) -> bool:
    """Whether shoving the ball this way keeps it on the field for a bit.

    The ball leaving the playing area is rule 5.9's business and it costs a
    neutral-point restart. Most of those are not wild shots — they are a robot
    steadily dribbling the ball over a touchline it never looked at.
    """
    return (
        abs(ball_x + math.cos(push) * reach) <= HALF_LENGTH
        and abs(ball_z + math.sin(push) * reach) <= HALF_WIDTH
    )


def steer_ball_inside(ball_x: float, ball_z: float, push: float) -> float:
    """Bend a push away from the nearest edge, by as little as will do.

    Returns the push unchanged when the ball is not near an edge, so it costs
    nothing in open play. Near one it rotates the push towards the middle of
    the field until the ball would survive the next third of a metre.
    """
    if push_keeps_ball_in(ball_x, ball_z, push):
        return push
    for step in range(1, 13):
        bend = step * math.pi / 12
        for side in (1.0, -1.0):
            candidate = wrap_angle(push + side * bend)
            if push_keeps_ball_in(ball_x, ball_z, candidate):
                return candidate
    # Nowhere within reach is inside, which means the ball is already out.
    # Towards the middle is the only sensible answer left.
    return math.atan2(-ball_z, -ball_x)
