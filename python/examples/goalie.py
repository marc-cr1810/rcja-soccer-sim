"""A goalkeeper.

A keeper has one job and three ways to fail at it, and the code is arranged
around the three.

**Guarding where the ball is going, not where it is.** The shot arrives faster
than the keeper travels, so a keeper that tracks the ball's current position is
always behind it. This one projects the ball forward to the moment it would
reach the guard line and stands there instead. It is the whole difference
between a keeper and a wall.

**Coming out when it has to.** Rule 5.8.2 requires a keeper to respond to a
ball in its own penalty box with forward movement, and 5.8.3 removes one that
does not — so a keeper that simply hugs its line is not only beaten, it is
eventually carried off. When the ball is slow and inside the box, this one goes
and gets it.

**Clearing somewhere useful.** The kicker fires along the robot's heading, so a
keeper facing up the field and firing blind puts the ball out over a sideline
about as often as it clears it. The kick is gated on where the ball would
actually end up, and the clearance is aimed at the wing with more room in it
rather than straight back down the middle at the striker who just shot.

**A clearance is a pass, when the striker is somewhere worth passing to.**
Rule 4.2.5 gives every robot a radio, and the striker's own position is on it
just as much as the ball is - so before falling back to "whichever wing has
room", the keeper checks whether the striker has called in from further up
the field with a clean line to it. Finding the ball again from a random point
on a wing costs a striker several seconds it does not lose when the clearance
lands at its feet.

**Knowing when it has been picked up.** A 5.7.1.6 return or a 5.11 reposition
teleports the robot without a word of warning in the protocol - one tick it
is wherever the ball left it, the next it is on a corner of its own box. A
position fix jumping further than any drive on this table could manage in
one tick is the tell; treated as a reset, the same as a kick-off, so a ball
estimate from the spot this robot used to occupy is not carried into the
spot it is standing in now.
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

# Ensure rcja_soccer and machine can be imported regardless of current working directory
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from machine import Runtime
from rcja_soccer import (
    Memory,
    clamp,
    coast,
    drive,
    pass_is_open,
    relay_ball,
    relay_position,
    teammate_ball,
    teammate_position,
    teammate_says,
    teleported,
    wrap_angle,
)
from rcja_soccer.field import (
    CONTACT_RANGE,
    HALF_LENGTH,
    HALF_WIDTH,
    PENALTY_DEPTH,
    PENALTY_WIDTH,
    clear_is_safe,
)
from rcja_soccer.frame import GoalFrame
from rcja_soccer.sense import (
    BallTracker,
    CompassBias,
    GyroRate,
    Locator,
    back_inside,
    obstacle_range,
    spin_towards,
    steer_clear_of_edges,
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default="violet", choices=["violet", "lime"])
parser.add_argument("--number", type=int, default=2, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None, help="server-issued at submit time")
parser.add_argument("--debug", action="store_true", help="print telemetry")
args = parser.parse_args()

rt = Runtime.get()


def motors(powers, dribbler: float = 0.0, kicker: bool = False, say=None) -> dict:
    """Drive the motors, and optionally the dribbler and kicker.

    The same shape `Robot.motors()` used to build - a plain command dict for
    `rt.send_command(**...)`, so every branch below that used to `return
    motors(...)` still can.
    """
    command: dict = {"motors": list(powers)}
    if dribbler:
        command["dribbler"] = dribbler
    if kicker:
        command["kicker"] = True
    if say is not None:
        command["say"] = say
    return command

#: Which goal this robot is guarding is its own team's colour wherever on the
#: field it stands (rule 1.4/5.4 only swaps which end that is). The frame finds
#: that goal - and the one it defends from - in the camera every kick-off, so
#: no ref-fed attack direction is involved.
TEAM = args.team
frame = GoalFrame(TEAM)

#: How long the keeper will hold the ball waiting for the striker to get open,
#: in ticks of a 50 Hz loop. About a second and a half: long enough for a
#: striker most of the way across its own half to arrive and turn, short enough
#: that the scrum clock in 5.6.1.2 rarely gets started.
PASS_PATIENCE = 75

#: How far off the goal line to guard. Far enough forward to cut the angle down
#: and to keep clear of rule 5.7.1.2's goal area, which starts at 915 mm; close
#: enough that a shot cannot simply be rolled round behind.
GUARD_DIST = 175.0
#: The posts are at 225 mm. Staying inside them means a keeper on the correct
#: side of the mouth is always still in front of the goal.
POST_CLAMP = 180.0

#: Never be deeper than this, whatever else is going on.
#:
#: Two rules meet here. The goal area starts where the robot's shell crosses
#: the goal mouth line, and rule 5.7.1.2 removes a robot that spends twenty
#: seconds inside it — a keeper backed onto its own line is not being heroic,
#: it is being timed. And behind the goal line is where a keeper gets shoved
#: wholly into the out area by an attacker, which is rule 5.7.1.6 and another
#: thirty seconds off. Both are lost by standing still while being pushed.
DEPTH_DIST = 120.0

#: How far across the field the keeper is ever allowed to be, and how far up
#: it. Nothing out there is its job: the goal is 450 mm wide and it is behind
#: the keeper, so every millimetre spent near a touchline is a millimetre of
#: open net. Passed to every steering call, which is what keeps it true even
#: when the ball is somewhere tempting.
LEASH_Z = 430.0
# `LEASH_X` is the goal-line distance either way round, so it needs no frame.
LEASH_X = HALF_LENGTH - 40.0

yaw = GyroRate()
locator = Locator(TEAM)
ball = BallTracker()
drift = CompassBias()


def think(s, me):
    if not s.playing:
        return motors(coast())

    # Placed but not live: the whistle ends the countdown, and until it blows
    # nothing has been re-anchored for a keeper either. Post-goal the clock is
    # still running, so `playing` says true while the countdown runs — hold.
    if s.kickoff.countdown > 0:
        return motors(coast())

    # A tick-callback framework used to empty `me` at every kick-off, which
    # doubled as the signal that the previous passage of play was over. A
    # plain loop keeps its own `me` for good, so the rising edge of
    # `kickoff.pending` is tracked explicitly instead - once True, once per
    # kick-off. The trackers are not in `me` and have to be told separately: a
    # ball estimate from before the restart is an estimate of where the ball
    # no longer is.
    was_pending = me.get("kickoff_was_pending", False)
    me.kickoff_was_pending = s.kickoff.pending
    if s.kickoff.pending and not was_pending:
        ball.reset()
        yaw.reset()

    yaw.update(s)
    heading = s.compass.heading
    # The compass wanders a degree or three a half and every bearing is
    # projected through it, so take the drift back out before the world model
    # is built. It is estimated from the previous fix against the fixed goals.
    drift.update(locator.x, locator.z, heading, s)
    heading = drift.corrected(heading)
    prev_x, prev_z, prev_confidence = locator.x, locator.z, locator.confidence
    me_x, me_z = locator.update(s, heading)
    if teleported(prev_x, prev_z, prev_confidence, me_x, me_z):
        # Picked up and set down somewhere else - a 5.7.1.6 return or a 5.11
        # reposition, neither of which the protocol announces. A ball
        # estimate built from where this robot used to be is an estimate of a
        # ball near a robot that is no longer there.
        ball.reset()
        yaw.reset()
    frame.update(s, heading, me_x, me_z)
    ball.update(s, heading, me_x, me_z)
    holding = s.ball_gate.held

    guard_x, guard_z = frame.from_our_goal(GUARD_DIST)

    # Square to the field, so the kicker points out of the goal rather than
    # across it, and so the dribbler mouth faces whatever is coming.
    square = spin_towards(wrap_angle(frame.up_angle() - heading), yaw)

    if s.kickoff.pending:
        return hold(s, me, me_x, me_z, guard_x, guard_z, square, heading, "KICK_OFF")

    # Out of the playing area is the only thing worth abandoning the goal for,
    # and the way back in comes from the position fix. The line sensors cannot
    # say which side of the boundary the chassis is on — the reading is the
    # same from either — so a keeper that steers by them alone works its way
    # off the field and is removed under rule 5.7.1.6.
    if abs(me_x) > HALF_LENGTH + 25 or abs(me_z) > HALF_WIDTH + 25:
        home_x, home_z = back_inside(me_x, me_z, margin=170.0)
        say(me, "RECOVER")
        return motors(
            drive(
                bearing=wrap_angle(math.atan2(home_z - me_z, home_x - me_x) - heading),
                speed=1.0,
                spin=0.0,
            ),
            dribbler=0.0,
        )

    if not ball.seen:
        # The team mate can often still see it - the commonest way this
        # keeper loses the ball is the striker standing between it and the
        # ring. Shadow the side of the goal it reported rather than sitting
        # dead centre, but do not chase on secondhand information: leaving
        # the line still waits for `ball.seen` for real, further down.
        told = teammate_ball(s)
        if told is None:
            return hold(s, me, me_x, me_z, guard_x, guard_z, square, heading, "HOLD_CENTRE")
        _, told_z = told
        target_z = clamp(told_z, -POST_CLAMP, POST_CLAMP)
        step = clamp((1.0 - abs(target_z) / POST_CLAMP) * 70.0, 0.0, 70.0)
        target_x, _ = frame.from_our_goal(GUARD_DIST + step)
        return hold(s, me, me_x, me_z, target_x, target_z, square, heading, "GUARD_RELAY")

    bx, bz = ball.x, ball.z
    depth = frame.depth(bx, bz)               # how far up the field the ball is
    in_box = depth < PENALTY_DEPTH + 60 and abs(bz) < PENALTY_WIDTH / 2 + 40

    # -- got it: get rid of it ---------------------------------------------
    # Turn to a heading that clears, then fire. What a keeper must not do is
    # set off up the field with it: the dribbler will hold the ball for as long
    # as the robot keeps driving, and a keeper that follows its own clearance
    # is a keeper that has left the goal, crossed the halfway line and put the
    # ball out over a touchline — with nobody at home. Stay on the guard line
    # and let the kicker do the travelling.
    if holding:
        # An outlet is worth aiming at only if it is a genuine advance - a
        # sideways or backward "pass" just hands the striker's own problem
        # back to it - and `pass_is_open` re-checks the current heading every
        # tick the same way the wing clearance's `safe` does below.
        outlet = teammate_position(s)
        passing = outlet is not None and frame.depth(*outlet) > frame.depth(me_x, me_z) + 250.0

        # A pass wants a RECEIVER, not merely a team mate who happens to be up
        # the field. The striker says `ready` once it is both somewhere useful
        # and facing this way, and until it does the ball is held.
        #
        # Not indefinitely. Holding the ball is not itself a lack-of-progress
        # call - rule 5.6.1.1 wants the nearest robot 400 mm away and a keeper
        # with the ball is at zero, and 5.6.1.2 wants robots from BOTH teams on
        # it. That second one is the way this bites: a keeper sitting on the
        # ball invites an opponent over, and the moment one is touching it too
        # the four-second scrum clock starts. Measured, waiting costs about 0.2
        # extra calls a match. So when the patience runs out this goes back to
        # being an ordinary clearance.
        mate_ready = bool(teammate_says(s, "ready", False))
        waited = me.get("pass_wait", 0) + 1 if passing else 0
        me.pass_wait = waited
        if passing and not mate_ready and waited > PASS_PATIENCE:
            passing = False

        if passing:
            aim = math.atan2(outlet[1] - me_z, outlet[0] - me_x)
            safe = pass_is_open(s, heading, me_x, me_z, *outlet) and mate_ready
        else:
            aim = clearance_heading(me_x, me_z, frame.up_x, frame.up_z)
            blocker = obstacle_range(s, heading, me_x, me_z)
            safe = clear_is_safe(bx, bz, heading) and (blocker is None or blocker > 380.0)
        error = wrap_angle(aim - heading)

        # Drift back towards the guard spot while turning, so a clearance that
        # takes a moment to line up does not cost the position as well.
        home_x, home_z = guard_x, guard_z
        home_z = clamp(me_z, -POST_CLAMP, POST_CLAMP)
        gap = math.hypot(home_x - me_x, home_z - me_z)
        # Holding it, so the edge test has to follow the ball in the dribbler
        # rather than the chassis - a keeper that drifts back to its spot with
        # the ball held out in front can walk it over its own end line.
        travel = steer_clear_of_edges(
            math.atan2(home_z - me_z, home_x - me_x),
            me_x,
            me_z,
            210.0,
            LEASH_X,
            LEASH_Z,
            carry=CONTACT_RANGE,
            heading=heading,
            attack_x=frame.up_x,
        )
        if passing:
            state = "PASS" if safe else "TURN_TO_PASS"
        else:
            state = "CLEAR" if safe else "TURN_TO_CLEAR"
        say(me, state)
        return motors(
            drive(
                bearing=wrap_angle(travel - heading),
                speed=clamp(gap / 200.0, 0.0, 0.5),
                spin=spin_towards(error, yaw),
            ),
            # The roller has to let go for the kick to carry.
            dribbler=0.0 if safe else 1.0,
            kicker=safe,
            say=report(state, me_x, me_z, held=True),
        )

    # -- shoved onto the line: get back off it ------------------------------
    if frame.depth(me_x, me_z) < DEPTH_DIST:
        travel = steer_clear_of_edges(
            math.atan2(-me_z * 0.3, (guard_x - me_x)), me_x, me_z, 210.0, LEASH_X, LEASH_Z
        )
        say(me, "OFF_THE_LINE", abs(me_x - guard_x))
        return motors(
            drive(bearing=wrap_angle(travel - heading), speed=1.0, spin=square),
            dribbler=1.0,
            say=report("OFF_THE_LINE", me_x, me_z, held=False),
        )

    # -- loose in the box: go and get it -----------------------------------
    # Rule 5.8.2 wants forward movement here, and 5.8.3 removes a keeper that
    # sits still for eight seconds while the ball is at its feet. But a keeper
    # chasing a ball is still a keeper: it comes out on a leash, because the
    # goal it left is bigger than the ball it is chasing, and a keeper that
    # follows one into a corner has conceded the next two.
    reachable = math.hypot(bx - me_x, bz - me_z) < 520.0
    if in_box and reachable and (ball.speed() < 350 or depth < 150):
        chase_x, _ = frame.from_our_goal(clamp(depth, 0.0, PENALTY_DEPTH))
        chase_z = clamp(bz, -420.0, 420.0)
        travel = steer_clear_of_edges(
            math.atan2(chase_z - me_z, chase_x - me_x), me_x, me_z, 210.0, LEASH_X, LEASH_Z
        )
        reach = math.hypot(bx - me_x, bz - me_z)
        say(me, "SMOTHER", reach)
        return motors(
            drive(bearing=wrap_angle(travel - heading), speed=1.0, spin=square),
            dribbler=1.0,
            # The one state where the net is actually empty: this keeper has
            # left its line to go and get the ball. Saying so is what lets the
            # striker drop in and screen the mouth instead of carrying on
            # attacking a ball its own keeper is already committed to.
            say=report("SMOTHER", me_x, me_z, held=False, claim=reach, off_line=True),
        )

    # -- otherwise: guard the line it is going to cross ---------------------
    target_z = intercept_z(me_x, me_z, guard_x, guard_z, frame.my_x, frame.my_z, frame.up_x, frame.up_z)
    # Come off the line a little when the shot is central and square, which
    # narrows the angle; sit back when it is wide, so it cannot be rolled round.
    step = clamp((1.0 - abs(target_z) / POST_CLAMP) * 70.0, 0.0, 70.0)
    target_x, _ = frame.from_our_goal(GUARD_DIST + step)
    state = "GUARD" if ball.speed() < 350 else "TRACK_SHOT"
    return hold(s, me, me_x, me_z, target_x, target_z, square, heading, state, bx, bz)


def report(
    intent: str,
    me_x: float,
    me_z: float,
    held: bool,
    claim: float | None = None,
    off_line: bool = False,
) -> dict:
    """What this robot puts on the radio (rule 4.2.5).

    One place, so every branch says the same things. Beyond the ball and its own
    position, a keeper has one thing to say that nothing else on the field can
    work out: whether it is still in front of its goal. `off_line` is that, and
    it is the difference between a team mate that keeps attacking while the net
    stands open and one that drops in to screen it.

    The ball is sent as seen rather than with a velocity to project it by:
    that was tried and measured worse, because a ball that has bounced since
    the sighting is not travelling the way it was.
    """
    return {
        "role": "goalie",
        "ball": (
            relay_ball(ball.x, ball.z, locator.confidence)
            if ball.seen
            else None
        ),
        "pos": relay_position(me_x, me_z, locator.confidence),
        "held": held,
        "intent": intent,
        "claim": round(claim) if claim is not None else None,
        "off_line": off_line,
    }


def intercept_z(
    me_x: float,
    me_z: float,
    guard_x: float,
    guard_z: float,
    my_x: float,
    my_z: float,
    up_x: float,
    up_z: float,
) -> float:
    """Where across the mouth to stand.

    Two answers, and the keeper wants whichever is more urgent. A moving ball
    is going somewhere: project it to the guard line and be there. A slow ball
    is not, so fall back to standing on the line between it and the middle of
    the goal, which is the best guess about where the shot will come from.
    """
    if ball.speed() > 220:
        # Time for the ball to reach the guard line, if it keeps going.
        closing = -(ball.vx * up_x + ball.vz * up_z)
        if closing > 60:
            travel = ((ball.x - guard_x) * up_x + (ball.z - guard_z) * up_z) / closing
            _, future_z = ball.predict(clamp(travel, 0.0, 1.4))
            return clamp(future_z, -POST_CLAMP, POST_CLAMP)

    span = (my_x - ball.x) * up_x + (my_z - ball.z) * up_z
    if abs(span) < 1.0:
        return clamp(ball.z, -POST_CLAMP, POST_CLAMP)
    guard_proj = (guard_x - ball.x) * up_x + (guard_z - ball.z) * up_z
    shadow = ball.z + (guard_proj / span) * (-ball.z)
    return clamp(shadow, -POST_CLAMP, POST_CLAMP)


def clearance_heading(me_x: float, me_z: float, up_x: float, up_z: float) -> float:
    """Which way to face before firing.

    Up the field and towards the wing with more room in it. Straight back down
    the middle returns the ball to whoever just attacked; a diagonal at least
    has to be chased.
    """
    # `up_x`, not a bare `1.0`: a constant names a fixed direction on the field,
    # so a keeper defending the -x end would clear to the opposite side of its
    # own field from one defending the +x end. And a keeper sits on its guard
    # spot at z ~ 0, so this fallback is not the rare case - it is the usual one.
    wing = -math.copysign(HALF_WIDTH * 0.62, me_z if abs(me_z) > 40 else up_x)
    return math.atan2(wing - me_z, up_x * (HALF_LENGTH * 0.55) - me_x)


def hold(s, me, me_x, me_z, target_x, target_z, spin, heading, state, bx=None, bz=None):
    """Move to a spot on the guard line and stop there.

    The deadband matters: a keeper that chases the last few millimetres of a
    target that moves every tick spends the match jittering, and a jittering
    chassis takes every one of its readings while turning.
    """
    dx = target_x - me_x
    dz = target_z - me_z
    gap = math.hypot(dx, dz)
    message = report(
        state,
        me_x,
        me_z,
        held=False,
        claim=math.hypot(bx - me_x, bz - me_z) if bx is not None and bz is not None else None,
    )

    if gap < 18.0:
        say(me, state)
        return motors(drive(speed=0.0, spin=spin), dribbler=0.0, say=message)

    travel = steer_clear_of_edges(math.atan2(dz, dx), me_x, me_z, 210.0, LEASH_X, LEASH_Z)
    # Sideways along the mouth is the move a keeper makes most, and it is the
    # slow direction on this drivetrain — so ask for everything when the gap is
    # real, and ease off only at the end.
    speed = clamp(gap / 90.0, 0.3, 1.0)
    say(me, state, gap)
    return motors(
        drive(bearing=wrap_angle(travel - heading), speed=speed, spin=spin),
        dribbler=0.0,
        say=message,
    )


def say(me, state: str, distance: float | None = None) -> None:
    """Optional debug telemetry at ~2 Hz.

    Prints the position fix alongside the state, because most of what goes
    wrong with a keeper is that it is not where it thinks it is.
    """
    if not args.debug:
        return
    ticks = me.get("log", 0) + 1
    me.log = ticks
    if ticks % 25 == 0:
        extra = f"gap {distance:6.0f}" if distance is not None else " " * 10
        print(
            f"[{args.team}-{args.number} keeper ] {state:<14} {extra}"
            f"  at ({locator.x:7.0f},{locator.z:6.0f}) conf {locator.confidence:.1f}"
            f"  ball ({ball.x:7.0f},{ball.z:6.0f}) {ball.speed():5.0f} mm/s age {ball.age:.2f}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    memory = Memory()
    while True:
        s = rt.sensors()
        # A robot stood down under rule 5.7 gets no sensors worth reading -
        # `off_field` says so, the same as `Robot._play()` used to skip
        # calling `think()` on a "disabled" message rather than deciding
        # anything from a frame that stopped updating.
        if not rt.off_field:
            command = think(s, memory)
            if command is not None:
                rt.send_command(**command)
        time.sleep_ms(20)
