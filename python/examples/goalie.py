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
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

# Ensure rcja_soccer can be imported regardless of current working directory
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rcja_soccer import Robot, clamp, drive, wrap_angle
from rcja_soccer.field import (
    HALF_LENGTH,
    HALF_WIDTH,
    PENALTY_DEPTH,
    PENALTY_WIDTH,
    attack_heading,
    attack_x,
    clear_is_safe,
    defend_x,
)
from rcja_soccer.sense import (
    BallTracker,
    Locator,
    YawRate,
    back_inside,
    obstacle_range,
    spin_towards,
    steer_clear_of_edges,
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default="cyan", choices=["cyan", "yellow"])
parser.add_argument("--number", type=int, default=2, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None, help="server-issued at submit time")
parser.add_argument("--debug", action="store_true", help="print telemetry")
args = parser.parse_args()

robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)

#: Identity only - radio, name. NOT which goal to guard: rule 1.4/5.4 swaps
#: ends at half-time, so everything below derived from attack direction is
#: recomputed from `s.attack_direction` at the top of every tick instead.
TEAM = args.team
UPFIELD = 0.0
ATTACK_X = 0.0
DEFEND_X = 0.0
FORWARD = 1.0

#: How far off the goal line to guard. Far enough forward to cut the angle down
#: and to keep clear of rule 5.7.1.2's goal area, which starts at 965 mm; close
#: enough that a shot cannot simply be rolled round behind.
GUARD_X = 0.0
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
DEPTH_FLOOR = 0.0

#: How far across the field the keeper is ever allowed to be, and how far up
#: it. Nothing out there is its job: the goal is 450 mm wide and it is behind
#: the keeper, so every millimetre spent near a touchline is a millimetre of
#: open net. Passed to every steering call, which is what keeps it true even
#: when the ball is somewhere tempting.
LEASH_Z = 430.0
# abs(DEFEND_X) is HALF_LENGTH either way round, so unlike GUARD_X/DEPTH_FLOOR
# this needs no per-tick recompute from attack_direction.
LEASH_X = HALF_LENGTH - 40.0

yaw = YawRate()
locator = Locator(TEAM)
ball = BallTracker()


@robot.tick
def think(s, me):
    global UPFIELD, ATTACK_X, DEFEND_X, FORWARD, GUARD_X, DEPTH_FLOOR
    UPFIELD = attack_heading(s.attack_direction)
    ATTACK_X = attack_x(s.attack_direction)
    DEFEND_X = defend_x(s.attack_direction)
    FORWARD = 1.0 if ATTACK_X > 0 else -1.0
    GUARD_X = DEFEND_X + FORWARD * 175.0
    DEPTH_FLOOR = DEFEND_X + FORWARD * 120.0

    if not s.playing:
        return robot.coast()

    # `me` is emptied at every kick-off, so an empty one is the signal that the
    # previous passage of play is over. The trackers are not in `me` and have
    # to be told: a ball estimate from before the restart is an estimate of
    # where the ball no longer is.
    if s.kickoff.pending and not me.get("restarted"):
        me.restarted = True
        ball.reset()
        yaw.reset()

    yaw.update(s)
    heading = s.compass.heading
    me_x, me_z = locator.update(s, heading)
    ball.update(s, heading, me_x, me_z)
    holding = s.ball_gate.held

    # Square to the field, so the kicker points out of the goal rather than
    # across it, and so the dribbler mouth faces whatever is coming.
    square = spin_towards(wrap_angle(UPFIELD - heading), yaw)

    if s.kickoff.pending:
        return hold(s, me, me_x, me_z, GUARD_X, 0.0, square, heading, "KICK_OFF")

    # Out of the playing area is the only thing worth abandoning the goal for,
    # and the way back in comes from the position fix. The line sensors cannot
    # say which side of the boundary the chassis is on — the reading is the
    # same from either — so a keeper that steers by them alone works its way
    # off the field and is removed under rule 5.7.1.6.
    if abs(me_x) > HALF_LENGTH + 25 or abs(me_z) > HALF_WIDTH + 25:
        home_x, home_z = back_inside(me_x, me_z, margin=170.0)
        say(me, "RECOVER")
        return robot.motors(
            drive(
                bearing=wrap_angle(math.atan2(home_z - me_z, home_x - me_x) - heading),
                speed=1.0,
                spin=0.0,
            ),
            dribbler=0.0,
        )

    if not ball.seen:
        return hold(s, me, me_x, me_z, GUARD_X, 0.0, square, heading, "HOLD_CENTRE")

    bx, bz = ball.x, ball.z
    depth = (bx - DEFEND_X) * FORWARD          # how far up the field the ball is
    in_box = depth < PENALTY_DEPTH + 60 and abs(bz) < PENALTY_WIDTH / 2 + 40

    # -- got it: get rid of it ---------------------------------------------
    # Turn to a heading that clears, then fire. What a keeper must not do is
    # set off up the field with it: the dribbler will hold the ball for as long
    # as the robot keeps driving, and a keeper that follows its own clearance
    # is a keeper that has left the goal, crossed the halfway line and put the
    # ball out over a touchline — with nobody at home. Stay on the guard line
    # and let the kicker do the travelling.
    if holding:
        aim = clearance_heading(me_x, me_z)
        error = wrap_angle(aim - heading)
        blocker = obstacle_range(s, heading, me_x, me_z)
        safe = clear_is_safe(bx, bz, heading) and (blocker is None or blocker > 380.0)

        # Drift back towards the guard spot while turning, so a clearance that
        # takes a moment to line up does not cost the position as well.
        home_x = GUARD_X
        home_z = clamp(me_z, -POST_CLAMP, POST_CLAMP)
        gap = math.hypot(home_x - me_x, home_z - me_z)
        travel = steer_clear_of_edges(
            math.atan2(home_z - me_z, home_x - me_x), me_x, me_z, 210.0, LEASH_X, LEASH_Z
        )
        say(me, "CLEAR" if safe else "TURN_TO_CLEAR")
        return robot.motors(
            drive(
                bearing=wrap_angle(travel - heading),
                speed=clamp(gap / 200.0, 0.0, 0.5),
                spin=spin_towards(error, yaw),
            ),
            # The roller has to let go for the kick to carry.
            dribbler=0.0 if safe else 1.0,
            kicker=safe,
            say={"role": "goalie", "ball": [round(bx), round(bz)], "held": True},
        )

    # -- shoved onto the line: get back off it ------------------------------
    if (me_x - DEPTH_FLOOR) * FORWARD < 0:
        travel = steer_clear_of_edges(
            math.atan2(-me_z * 0.3, (GUARD_X - me_x)), me_x, me_z, 210.0, LEASH_X, LEASH_Z
        )
        say(me, "OFF_THE_LINE", abs(me_x - GUARD_X))
        return robot.motors(
            drive(bearing=wrap_angle(travel - heading), speed=1.0, spin=square),
            dribbler=1.0,
            say={"role": "goalie", "ball": [round(bx), round(bz)], "held": False},
        )

    # -- loose in the box: go and get it -----------------------------------
    # Rule 5.8.2 wants forward movement here, and 5.8.3 removes a keeper that
    # sits still for eight seconds while the ball is at its feet. But a keeper
    # chasing a ball is still a keeper: it comes out on a leash, because the
    # goal it left is bigger than the ball it is chasing, and a keeper that
    # follows one into a corner has conceded the next two.
    reachable = math.hypot(bx - me_x, bz - me_z) < 520.0
    if in_box and reachable and (ball.speed() < 350 or depth < 150):
        chase_x = DEFEND_X + FORWARD * clamp((bx - DEFEND_X) * FORWARD, 0.0, PENALTY_DEPTH)
        chase_z = clamp(bz, -420.0, 420.0)
        travel = steer_clear_of_edges(
            math.atan2(chase_z - me_z, chase_x - me_x), me_x, me_z, 210.0, LEASH_X, LEASH_Z
        )
        say(me, "SMOTHER", math.hypot(bx - me_x, bz - me_z))
        return robot.motors(
            drive(bearing=wrap_angle(travel - heading), speed=1.0, spin=square),
            dribbler=1.0,
            say={"role": "goalie", "ball": [round(bx), round(bz)], "held": False},
        )

    # -- otherwise: guard the line it is going to cross ---------------------
    target_z = intercept_z(me_x, me_z)
    # Come off the line a little when the shot is central and square, which
    # narrows the angle; sit back when it is wide, so it cannot be rolled round.
    step = clamp((1.0 - abs(target_z) / POST_CLAMP) * 70.0, 0.0, 70.0)
    target_x = GUARD_X + FORWARD * step
    state = "GUARD" if ball.speed() < 350 else "TRACK_SHOT"
    return hold(s, me, me_x, me_z, target_x, target_z, square, heading, state, bx, bz)


def intercept_z(me_x: float, me_z: float) -> float:
    """Where across the mouth to stand.

    Two answers, and the keeper wants whichever is more urgent. A moving ball
    is going somewhere: project it to the guard line and be there. A slow ball
    is not, so fall back to standing on the line between it and the middle of
    the goal, which is the best guess about where the shot will come from.
    """
    if ball.speed() > 220:
        # Time for the ball to reach the guard line, if it keeps going.
        closing = -ball.vx * FORWARD
        if closing > 60:
            travel = (ball.x - GUARD_X) * FORWARD / closing
            _, future_z = ball.predict(clamp(travel, 0.0, 1.4))
            return clamp(future_z, -POST_CLAMP, POST_CLAMP)

    span = DEFEND_X - ball.x
    if abs(span) < 1.0:
        return clamp(ball.z, -POST_CLAMP, POST_CLAMP)
    shadow = ball.z + ((GUARD_X - ball.x) / span) * (-ball.z)
    return clamp(shadow, -POST_CLAMP, POST_CLAMP)


def clearance_heading(me_x: float, me_z: float) -> float:
    """Which way to face before firing.

    Up the field and towards the wing with more room in it. Straight back down
    the middle returns the ball to whoever just attacked; a diagonal at least
    has to be chased.
    """
    wing = -math.copysign(HALF_WIDTH * 0.62, me_z if abs(me_z) > 40 else 1.0)
    return math.atan2(wing - me_z, (ATTACK_X * 0.55) - me_x)


def hold(s, me, me_x, me_z, target_x, target_z, spin, heading, state, bx=None, bz=None):
    """Move to a spot on the guard line and stop there.

    The deadband matters: a keeper that chases the last few millimetres of a
    target that moves every tick spends the match jittering, and a jittering
    chassis takes every one of its readings while turning.
    """
    dx = target_x - me_x
    dz = target_z - me_z
    gap = math.hypot(dx, dz)
    message = {"role": "goalie", "ball": None if bx is None else [round(bx), round(bz)], "held": False}

    if gap < 18.0:
        say(me, state)
        return robot.motors(drive(speed=0.0, spin=spin), dribbler=0.0, say=message)

    travel = steer_clear_of_edges(math.atan2(dz, dx), me_x, me_z, 210.0, LEASH_X, LEASH_Z)
    # Sideways along the mouth is the move a keeper makes most, and it is the
    # slow direction on this drivetrain — so ask for everything when the gap is
    # real, and ease off only at the end.
    speed = clamp(gap / 90.0, 0.3, 1.0)
    say(me, state, gap)
    return robot.motors(
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
    robot.run(args.url)
