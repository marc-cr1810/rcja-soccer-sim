"""An attacking robot.

The shape of it, in order of how much each part is worth:

**Never shoot at something that is not the goal.** The kicker sends the ball
along the robot's heading at better than two metres a second, and a ball that
leaves the playing area is placed on a neutral point (rule 5.9.2) — possession
handed back for nothing. So the kicker only fires when a ray cast from the ball
along the current heading actually reaches the goal mouth. That single test is
worth more than everything else here put together.

**Get behind the ball, then drive through it.** Driving straight at the ball
pushes it in whatever direction the robot happened to arrive from, which is how
a robot scores at its own end. The target is a point behind the ball on the
line to the goal; only once the robot is on that line does it drive at the ball
at all.

**The white line is a force, not an alarm.** Rule 5.7.1.6 only punishes a robot
that is *wholly* in the out area, and the goal mouth sits 50 mm further out
than the line does — so a robot that bolts for the middle every time a sensor
sees white can never take a shot. The line pushes; it does not interrupt.

**A kick-off is a strike (rule 5.4.7).** Drive at the ball and fire the kicker;
the referee wants the ball 50 mm clear, and pushing it never gets there.

**Pinned deep in your own end, lay it off - sideways, not backward.** A robot
standing over the ball right in front of its own goal, with an opponent's
shell already blocking the lane forward, is not "about to dribble past it" -
it is one stolen touch from conceding. The keeper is a legal, radioed-in
outlet the same way it always was, just rarely worth using this far back;
here it is the only thing worth using. But a robot that spins round to face
its own goal and fires reads as attacking it, whatever the geometry actually
checks out to - so this only ever fires when the keeper is enough to one
side that the pass is a sideways lay-off, never a shot straight back at the
own net.

**Knowing when it has been picked up.** A 5.7.1.6 return or a 5.11 reposition
teleports the robot with no word of warning in the protocol. A position fix
jumping further than any drive on this table could manage in one tick is the
tell, and it is treated as a reset, the same as a kick-off - a ball estimate
built from the spot this robot used to occupy is not carried into the spot
it is standing in now.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

# Ensure rcja_soccer can be imported regardless of current working directory
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rcja_soccer import (
    Robot,
    clamp,
    drive,
    pass_is_open,
    opening,
    relay_ball,
    relay_position,
    shot_is_open,
    teammate_ball,
    teammate_position,
    teammate_says,
    teleported,
    wrap_angle,
)
from rcja_soccer.field import (
    BALL_RADIUS,
    CONTACT_RANGE,
    HALF_GOAL_WIDTH,
    HALF_LENGTH,
    HALF_WIDTH,
    PENALTY_DEPTH,
    in_penalty_box,
    kick_lands_in_goal,
    shot_range,
)
from rcja_soccer.frame import GoalFrame
from rcja_soccer.sense import (
    BallTracker,
    CompassBias,
    GyroRate,
    Locator,
    WheelEffort,
    back_inside,
    keep_inside,
    obstacle_range,
    spin_towards,
    steer_ball_inside,
    steer_clear_of_edges,
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default="violet", choices=["violet", "lime"])
parser.add_argument("--number", type=int, default=1, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None, help="server-issued at submit time")
parser.add_argument("--debug", action="store_true", help="print telemetry")
args = parser.parse_args()

robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)

#: Which goal this robot scores in is whatever end its team currently defends,
#: which a kick-off places it on (rule 1.4/5.4 only swaps which end that is).
#: The frame finds both goals in the camera and takes the nearer one as its
#: own, so no ref-fed attack direction is involved — the direction of attack is
#: the line between the goals, as seen.
TEAM = args.team
frame = GoalFrame(TEAM)

#: Inside the posts by enough that the ball fits and a keeper on the line has
#: to actually move. The posts are at 225 mm.
AIM_POST = 155.0

#: How far either side of the goal centre a covering striker ever stands when
#: it is screening an empty net. The posts are at 225 mm, so anything wider is
#: a robot watching the shot go past it rather than standing in the way.
POST_SCREEN = 190.0

#: Where a striker stands to take a pass from its own keeper.
#:
#: Far enough up the field that the keeper will actually play it - the keeper
#: refuses any outlet that is not a genuine advance - clear of our own penalty
#: box so rule 5.11 never enters into it, and out on a wing, because a ball
#: played up the middle is played through everybody.
RECEIVE_DEPTH = PENALTY_DEPTH + 520.0
RECEIVE_WING = HALF_WIDTH * 0.55

#: How far up the field counts as "deep in our own end" for a backpass - the
#: same scale `choose_aim` uses for "too central to have a wing of its own",
#: pulled in tighter: this is only for the spot losing the ball is worst.
BACKPASS_DEPTH = HALF_LENGTH * 0.3

yaw = GyroRate()
effort = WheelEffort()
locator = Locator(TEAM)
ball = BallTracker()
drift = CompassBias()


@robot.tick
def think(s, me):
    if not s.playing:
        return robot.coast()

    # The ball is on the spot but play is not live until the whistle ends the
    # countdown. This is easy to miss post-goal, where the clock is still
    # running: `playing` is true while `kickoff.countdown` ticks down, and a
    # robot that makes for the ball early is encroaching before the restart.
    if s.kickoff.countdown > 0:
        return robot.coast()

    # `me` is emptied at every kick-off, so an empty one is the signal that the
    # previous passage of play is over. The trackers are not in `me` and have
    # to be told: a ball estimate from before the restart is an estimate of
    # where the ball no longer is.
    if s.kickoff.pending and not me.get("restarted"):
        me.restarted = True
        ball.reset()
        yaw.reset()
        effort.reset()

    yaw.update(s)
    effort.update(s)
    heading = s.compass.heading
    drift.update(locator.x, locator.z, heading, s)
    heading = drift.corrected(heading)
    prev_x, prev_z, prev_confidence = locator.x, locator.z, locator.confidence
    me_x, me_z = locator.update(s, heading)
    if teleported(prev_x, prev_z, prev_confidence, me_x, me_z):
        # Picked up and set down somewhere else - a 5.7.1.6 return or a 5.11
        # reposition, neither of which the protocol announces. Everything
        # tracked from the ball's own motion is now an estimate of a ball
        # near a robot that is no longer there.
        ball.reset()
        yaw.reset()
        effort.reset()
    frame.update(s, heading, me_x, me_z)
    ball.update(s, heading, me_x, me_z)
    holding = s.ball_gate.held

    if s.kickoff.pending and os.environ.get("RJC_DEBUG_KO"):
        print(
            f"[KO] t={s.clock:6.2f} ours={s.kickoff.ours} me=({me_x:7.1f},{me_z:6.1f}) "
            f"h={math.degrees(heading):6.1f} ball.seen={ball.seen} holding={holding} "
            f"ball=({ball.x if ball.seen else float('nan'):7.1f},"
            f"{ball.z if ball.seen else float('nan'):6.1f}) gate={s.ball_gate.held}",
            flush=True,
        )

    # -- rule 5.4.7 ---------------------------------------------------------
    # A kick-off is a strike, not a carry: the ball has to roll 50 mm clear or
    # the referee gives the kick-off to the other side. Pushing never gets
    # there, because a shoved ball travels with the robot and the gap never
    # opens.
    #
    # So: touch the ball, then stop dead and keep asking for the kicker. The
    # stopping is the part that matters. The kicker is very often still
    # charging at a restart — a goal is generally scored by firing at it, and
    # the restart follows within the recharge time — and a robot that keeps
    # driving while it waits has carried the ball off the spot and given the
    # kick-off away before the solenoid is ready. Standing still is legal for
    # the three seconds rule 5.4.7 allows, and the charge arrives first.
    if s.kickoff.pending:
        if not s.kickoff.ours:
            # Rule 5.4.5 has us in our own box and 5.4.6 keeps us off the ball.
            return robot.motors(drive(speed=0.0), dribbler=0.0)
        square = spin_towards(wrap_angle(frame.up_angle() - heading), yaw)
        if holding:
            say(me, "KICK_OFF_WAIT")
            return robot.motors(drive(speed=0.0, spin=square), dribbler=1.0, kicker=True)
        # The approach must not chase the ball estimate. A kick-off starts you
        # right behind the ball, facing up the field; the estimate has not
        # converged again after the restart, and steering by it for the first
        # half second is exactly what drags the ball off the spot. The referee
        # called illegal kick-offs whose only difference from the legal ones
        # was how long the striker spent steering. So creep dead straight (in
        # front of you, no spin) until the gate has the ball, then stop and
        # let the kicker do the rest. The roller has to stay OFF while
        # creeping - on, it drags the ball along with you before you hold it.
        say(me, "KICK_OFF")
        return robot.motors(
            drive(bearing=0.0, speed=0.15, spin=0.0), dribbler=0.0, kicker=True
        )

    # -- the edges ----------------------------------------------------------
    # Only an emergency when the robot is already out, which is the only thing
    # rule 5.7.1.6 actually punishes; everything short of that is handled by
    # folding a push back inside into the direction of travel.
    #
    # And the way back in comes from the position fix, not from the line
    # sensors. The ring reports that the boundary is underneath the chassis; it
    # cannot report which side of it the robot is on, because both sides give
    # the same reading. Steering away from the line is right when the robot is
    # inside it and drives the robot off the field when it is not, so a robot
    # that decides on the ring alone sits on the boundary turning round and
    # round until it is removed.
    if abs(me_x) > HALF_LENGTH + 25 or abs(me_z) > HALF_WIDTH + 25:
        home_x, home_z = back_inside(me_x, me_z, margin=170.0)
        say(me, "RECOVER")
        return robot.motors(
            drive(
                bearing=wrap_angle(math.atan2(home_z - me_z, home_x - me_x) - heading),
                speed=1.0,
                spin=0.0,
            ),
            dribbler=1.0,
        )

    # -- our keeper wants to pass -------------------------------------------
    # It announces the pass on the radio and nothing was listening, so the
    # keeper aimed at a robot busy orbiting the ball the keeper was holding.
    if (
        not holding
        and teammate_is_keeping(s)
        and teammate_says(s, "held", False)
        and teammate_says(s, "intent") in ("PASS", "TURN_TO_PASS")
    ):
        return receive(s, me, me_x, me_z, heading, yaw, frame)

    # -- no ball ------------------------------------------------------------
    if not ball.seen:
        told = teammate_ball(s)
        if told is None:
            # Fall back towards the middle of our own half, facing up the
            # field, which is where the ball will most likely reappear and
            # where being wrong costs least.
            home_x, home_z = frame.from_our_goal(HALF_LENGTH * 0.65)
            travel = wrap_angle(math.atan2(home_z - me_z, home_x - me_x) - heading)
            say(me, "SEARCH")
            return robot.motors(
                drive(bearing=travel, speed=0.55, spin=spin_towards(wrap_angle(frame.up_angle() - heading), yaw)),
                dribbler=1.0,
                say=report("SEARCH", me_x, me_z, held=False),
            )
        bx, bz = told
    else:
        bx, bz = ball.x, ball.z

    # -- where to put it ----------------------------------------------------
    aim_x, aim_z = choose_aim(bx, bz, me_z, locator.confidence, frame)

    # Where the goal is actually open beats a guess about where the keeper is.
    #
    # `choose_aim` picks the far post on the reasoning that a keeper sitting on
    # the near one has further to travel - a good guess, and only a guess. The
    # camera's blobs are not a guess: a robot in the mouth is not goal-coloured,
    # so the colour is missing exactly where the shot would be saved, and what
    # is left is the part of the goal that is genuinely open. Aim at the middle
    # of the widest piece.
    #
    # Ignored deep in our own half, where `choose_aim` is not aiming at their
    # goal at all - it is clearing up the wing, and the opposition's mouth is
    # the wrong target from there whatever the camera can see of it.
    seen = opening(s, frame.their_colour)
    if seen is not None and frame.depth(bx, bz) >= HALF_LENGTH * 0.55:
        gap_bearing, gap_width, gap_range = seen
        # A gap the ball cannot get through is not a target. Six ball radii is
        # 126 mm against a 42 mm ball - room to be wrong by a ball's width and
        # still score.
        if gap_width > BALL_RADIUS * 6:
            aim_x = me_x + math.cos(heading + gap_bearing) * gap_range
            aim_z = me_z + math.sin(heading + gap_bearing) * gap_range
    push = math.atan2(aim_z - bz, aim_x - bx)

    # Face the way the ball has to go. The kicker fires along the heading, so
    # this is the aim as much as it is the posture. Recomputed below once the
    # push has been bent away from any edge it was heading for.
    spin = spin_towards(wrap_angle(push - heading), yaw)

    # Stay out of our own box while the keeper is working it (rule 5.11).
    #
    # `off_line` is the part that matters. A keeper that has gone out to smother
    # a loose ball has left the net open behind it, and until now nothing at all
    # stood in front of that net - this robot carried on attacking a ball its own
    # keeper was already committed to. Hearing it said, the cover drops onto the
    # line between the ball and our goal instead of the loose screening spot.
    keeper_active = teammate_is_keeping(s)
    keeper_off_line = bool(teammate_says(s, "off_line", False))
    if keeper_active and in_penalty_box(bx, bz, frame.my_colour, slack=60.0) and not holding:
        return cover(s, me, me_x, me_z, bz, heading, spin, frame, keeper_off_line)

    # -- curve round behind it, then drive through it ----------------------
    # Keep the push on the field. Most of the balls that go out in a match are
    # not wild shots, they are a robot patiently dribbling one over a touchline
    # (rule 5.9.2, and the ball comes back on a neutral point).
    push = steer_ball_inside(bx, bz, push)
    spin = spin_towards(wrap_angle(push - heading), yaw)

    range_to_ball = math.hypot(bx - me_x, bz - me_z)
    to_ball = math.atan2(bz - me_z, bx - me_x)


    # One number decides the whole approach: how far round the ball the robot
    # is from where it ought to be. Zero means it is directly behind the ball
    # on the line to the target, and driving straight at the ball pushes it
    # straight at the target. A right angle means it is beside the ball, and
    # driving at the ball would knock it sideways.
    #
    # Steering by an amount proportional to that angle turns the two cases into
    # one: the robot curves round the ball and straightens up onto the line as
    # it arrives, with no state and no moment where it switches plans. A
    # threshold instead — "am I behind it yet?" — gives a robot that charges
    # from wherever it happens to be standing and spends the match shoving the
    # ball towards the nearest touchline.
    # `swing` is zero when the robot is directly behind the ball on the line to
    # the target, and grows to +/-pi as it works round to the wrong side.
    swing = wrap_angle(to_ball - push)
    # Steering off the line to the ball by a fraction of it gives a path that
    # curves round the ball and straightens onto the line as it arrives: there
    # is always some component towards the ball, so the robot spirals in
    # rather than orbiting forever, and there is always some component round
    # it, so it never arrives from the wrong side. Wider arcs close in, where
    # there is no room left to correct.
    gain = clamp(0.6 + 120.0 / max(range_to_ball, 100.0), 0.6, 1.4)
    travel_field = wrap_angle(to_ball + clamp(swing * gain, -1.9, 1.9))

    aligned = abs(swing) < 0.35
    if holding:
        travel_field = to_ball
        state = "CARRY"
    elif aligned:
        state = "STRIKE"
    else:
        state = "ROUND"

    # Full power down the line, a little less while swinging round, so the
    # robot does not arrive at the ball still travelling sideways.
    speed = 1.0 if (holding or aligned) else clamp(1.15 - abs(swing) * 0.35, 0.6, 1.0)

    # The edges, as a force. Zero in open play, decisive on the line.
    #
    # While the ball is in the dribbler the thing that has to stay on the field
    # is the ball, not the chassis - it rides a robot's radius in front, so a
    # robot that keeps only itself inside the touchline dribbles the ball over
    # it and hands back possession on a rule 5.9.2 neutral point.
    travel_field = steer_clear_of_edges(
        travel_field,
        me_x,
        me_z,
        190.0 if holding else 150.0,
        carry=CONTACT_RANGE if holding else 0.0,
        heading=heading,
        attack_x=frame.up_x,
    )
    if not holding and keeper_active:
        travel_field = leave_room_for_the_keeper(travel_field, me_x, me_z, frame)

    # -- shoot --------------------------------------------------------------
    # Three questions, and all of them have to be yes.
    #
    # Does the shot reach the goal if nothing is in the way? Is anything in the
    # way? And is it close enough to be a shot rather than a hopeful punt? A
    # geometrically perfect shot from the halfway line has a keeper, an
    # opposing striker and a metre and a half of carpet to survive, and when it
    # hits any of them it rebounds into the out area about half the time — the
    # ball comes back on a neutral point (rule 5.9.2), which is to say the
    # robot has just made a save against itself.
    blocker = obstacle_range(s, heading, me_x, me_z)
    lane_clear = blocker is None or blocker > 430.0
    reach = shot_range(bx, bz, heading, frame.their_colour)
    close_enough = reach is not None and reach < (1100.0 if blocker is None else 800.0)
    # And is the goal open where the kicker is pointing?
    #
    # `lane_clear` is the sonar's answer to a nearby but different question -
    # "is there something in front of me" - and it is about the carpet rather
    # than about the goal. It cannot tell a keeper filling the mouth from a
    # team mate crossing in front of one, and it says nothing at all about the
    # half of the goal the keeper is not covering. `shot_is_open` asks whether
    # goal colour is actually visible along the heading, which is the fact that
    # decides whether the shot goes in.
    mouth_open = shot_is_open(s, frame.their_colour)
    shot_on = reach is not None and lane_clear and close_enough and mouth_open
    kick = holding and shot_on
    dribbler = 0.0 if kick else 1.0

    # -- pinned deep, lay it off ---------------------------------------------
    # Only when there is actually somebody in the way (`not lane_clear`) and
    # only this close to our own goal: further up the field, "blocked" is a
    # defender to dribble round, not a reason to give the ball up.
    outlet = teammate_position(s) if (holding and not lane_clear) else None
    back_heading = math.atan2(outlet[1] - me_z, outlet[0] - me_x) if outlet is not None else 0.0
    # However safe the geometry, a robot that spins round to face its own
    # goal and fires reads as attacking it - so this is restricted to a lay-
    # off that is actually sideways, not just a backward pass that happens
    # not to score. `pass_is_open`'s own-goal check still applies on top;
    # this is about how it looks, not just whether it is safe.
    straight_back = wrap_angle(frame.up_angle() + math.pi)
    sideways_enough = outlet is not None and abs(wrap_angle(back_heading - straight_back)) > math.radians(40)
    in_trouble = sideways_enough and frame.depth(me_x, me_z) < BACKPASS_DEPTH
    # Standing still holding the ball while lining this up is only worth it
    # for a moment - a lane that has not opened in getting on for a second is
    # not about to, and dribbling round the defender beats waiting forever.
    waited = me.get("backpass_wait", 0) + 1 if in_trouble else 0
    me.backpass_wait = waited
    backpass = in_trouble and waited <= 30

    if backpass:
        # Committed to the turn the moment the situation calls for it, the
        # same way `spin` always chases `push` above - otherwise the heading
        # never comes round to something `pass_is_open` can say yes to.
        travel_field = back_heading
        spin = spin_towards(wrap_angle(back_heading - heading), yaw)
        speed = 0.0
        clear_of_own_goal = not kick_lands_in_goal(me_x, me_z, heading, frame.my_colour)
        if clear_of_own_goal and pass_is_open(s, heading, me_x, me_z, *outlet):
            kick = True
            dribbler = 0.0
            state = "BACKPASS"
            me.backpass_wait = 0
        else:
            state = "LINE_UP_BACKPASS"
    elif holding and not shot_on:
        if reach is not None and not lane_clear:
            # Aimed right, but there is a robot in front. Carry on round it:
            # the heading stays on the goal, and an omni drive can travel
            # sideways while it does.
            side = -1.0 if me_z > 0 else 1.0
            travel_field = wrap_angle(push + side * 1.15)
            travel_field = steer_clear_of_edges(
                travel_field, me_x, me_z, 190.0,
                carry=CONTACT_RANGE, heading=heading, attack_x=frame.up_x,
            )
            speed = 0.9
            state = "DRIBBLE_ROUND"
        elif reach is not None:
            # On target and unobstructed, just too far out. Take it closer.
            state = "CARRY_IN"
        else:
            # Carrying, but pointed at nothing. Turn rather than driving on and
            # firing at a sideline.
            speed = min(speed, 0.5)
            state = "TURN_ON_GOAL"

    # -- stuck --------------------------------------------------------------
    travel_field, speed, spin, state = unstick(
        s, me, me_x, me_z, travel_field, speed, spin, state, push, holding
    )

    say(me, state, range_to_ball)
    return robot.motors(
        drive(bearing=wrap_angle(travel_field - heading), speed=speed, spin=spin),
        dribbler=dribbler,
        kicker=kick,
        say=report(state, me_x, me_z, held=holding, claim=range_to_ball),
    )


def report(
    intent: str,
    me_x: float,
    me_z: float,
    held: bool,
    claim: float | None = None,
    ready: bool = False,
) -> dict:
    """What this robot puts on the radio (rule 4.2.5).

    One place, so every branch says the same things and a branch cannot quietly
    stop saying one of them. Three kinds of thing go on the wire:

    - **What it can see.** The ball - only first-hand sightings, because
      relaying back what the other robot just told us would turn one stale
      reading into a loop of them.
    - **Where it is.** For aiming a pass at the robot rather than at its last
      ball sighting.
    - **What it is doing.** `intent` and `claim` - the state it is in and how
      far it is from the ball. Position says where a robot is; those two say
      what it is about to do about it, which is the thing the other robot cannot
      work out for itself and the thing it needs to not duplicate the effort.
    """
    return {
        "role": "striker",
        "ball": (
            relay_ball(ball.x, ball.z, locator.confidence)
            if ball.seen
            else None
        ),
        "pos": relay_position(me_x, me_z, locator.confidence),
        "held": held,
        "intent": intent,
        "claim": round(claim) if claim is not None else None,
        "ready": ready,
    }


def receive(s, me, me_x, me_z, heading, yaw, frame):
    """Get open for the keeper's pass, and say so once we are.

    The keeper aims its outlet at wherever this robot happens to be standing.
    Until now that was usually a robot orbiting the very ball the keeper was
    holding, so the pass went into the keeper's own feet or straight to an
    opponent. A pass nobody is waiting for is a giveaway with extra steps.

    Two things have to be true before it is worth playing, and the keeper can
    see neither for itself: this robot has to be somewhere useful, and it has
    to be *facing* the keeper, because a dribbler only catches what arrives in
    front of it. `ready` says both, and the keeper holds until it hears it.
    """
    keeper = teammate_position(s)

    # Up the field from our own goal, out on the wing this robot is already
    # nearer. The tie-break comes from the frame rather than a fixed sign, so
    # the two ends of the field stay the same game.
    cx, cz = frame.from_our_goal(RECEIVE_DEPTH)
    wing = math.copysign(RECEIVE_WING, me_z if abs(me_z) > 60 else frame.up_x)
    spot_x, spot_z = keep_inside(cx - frame.up_z * wing, cz + frame.up_x * wing, 200.0)

    gap = math.hypot(spot_x - me_x, spot_z - me_z)
    travel = math.atan2(spot_z - me_z, spot_x - me_x)

    # Face the keeper, not the spot being driven to: the ball arrives from the
    # keeper, and a dribbler pointing anywhere else will not take it.
    face = (
        math.atan2(keeper[1] - me_z, keeper[0] - me_x)
        if keeper is not None
        else wrap_angle(frame.up_angle() + math.pi)
    )
    error = wrap_angle(face - heading)
    ready = gap < 150.0 and abs(error) < 0.35

    say(me, "RECEIVE")
    return robot.motors(
        drive(
            bearing=wrap_angle(travel - heading),
            speed=0.0 if gap < 70.0 else clamp(gap / 260.0, 0.3, 1.0),
            spin=spin_towards(error, yaw),
        ),
        dribbler=1.0,
        say=report("RECEIVE", me_x, me_z, held=False, ready=ready),
    )


def leave_room_for_the_keeper(
    travel: float, me_x: float, me_z: float, frame: GoalFrame
) -> float:
    """Stay out of the strip of our own box the keeper is working in.

    Rule 5.11.1 is two robots of one team inside their own penalty box, in
    front of the goal, for long enough to affect the game — and the referee's
    remedy is to move one of them, which is a worse outcome than never having
    been there. The detector tests the central corridor, so the corners of the
    box are not the problem; standing on the keeper's toes is.
    """
    if not in_penalty_box(me_x, me_z, frame.my_colour, slack=30.0) or abs(me_z) > 290.0:
        return travel
    # Up the field is always out of our own box, and it is where the striker
    # wants to be anyway.
    wx = math.cos(travel) + frame.up_x * 1.5
    wz = math.sin(travel) + frame.up_z * 1.5
    return math.atan2(wz, wx)


def choose_aim(
    bx: float, bz: float, me_z: float, me_confidence: float, frame: GoalFrame
) -> tuple[float, float]:
    """Where in the goal to put it — or, deep in our own half, where instead.

    Near our own goal the opponent's net is the wrong target: the line to it
    runs straight across our own mouth, and a push that goes wrong there is a
    goal against. Aim up the wing the ball is already on and sort the rest out
    in the other half.
    """
    if frame.depth(bx, bz) < HALF_LENGTH * 0.55:
        # The tie-break, when the ball is too central to have a wing of its
        # own, has to come from the frame and not from a bare `1.0`. A constant
        # here names a fixed direction on the *field*, so the team attacking +x
        # and the team attacking -x do not play the same game up their own
        # field - and the ends swap at half-time, so neither does one team
        # between halves. `up_x` reverses with the attack, which is what makes
        # the choice the same choice at both ends.
        wing = math.copysign(HALF_WIDTH * 0.55, bz if abs(bz) > 60 else frame.up_x)
        wx, _ = frame.from_our_goal(HALF_LENGTH * 1.5)
        return wx, wing

    # Otherwise the far post, so a keeper sitting on the near one has to travel.
    if bz > 45:
        post = -AIM_POST
    elif bz < -45:
        post = AIM_POST
    else:
        # A deadband, not `me_z <= 0`, and not `!= 0.0` either.
        #
        # On the centre line the fix does not come back as a clean zero, it
        # comes back as whatever the least-squares solve rounded to - order
        # 1e-14, and its SIGN is rounding noise rather than a fact about the
        # field. Hanging a 310 mm swing of the aim on that sign means two
        # robots in mirrored positions pick the same physical post instead of
        # mirrored ones, and the two ends of the field stop being the same
        # game. Every restart puts a robot on z = 0 exactly, so this is the
        # normal case and not a corner: below the deadband, take the side from
        # the frame, which does reverse with the attack.
        #
        # And only when the fix is actually solid. `me_z` holds its last
        # solved value even after the solve fails - a robot occluded for a
        # while is not on z = 0, it just has not been told otherwise - so an
        # unconfident `me_z` is stale rather than a fact worth a 310 mm swing
        # of the aim either.
        trust_me_z = abs(me_z) > 1.0 and me_confidence >= 1.0
        post = math.copysign(AIM_POST, -me_z if trust_me_z else frame.up_x)
    return frame.their_x, clamp(post, -HALF_GOAL_WIDTH + 70, HALF_GOAL_WIDTH - 70)


def cover(s, me, me_x, me_z, bz, heading, spin, frame: GoalFrame, guard_mouth: bool = False):
    """Wait outside our own box while the keeper deals with it.

    Rule 5.11 makes two robots defending one goal a call the referee has to
    make, and the keeper is better placed than we are. Sit on the edge of the
    box, square on, ready for the clearance.

    `guard_mouth` is the keeper saying it has left its line. The net behind it
    is open, so the waiting spot tightens onto the mouth: closer in, and clamped
    to the posts rather than wandering 300 mm either side of them, which is wide
    enough to watch a shot go past. Still *outside* the box - the whole point of
    waiting here is that rule 5.11.1 is about two robots inside it, and the
    referee's remedy is to pick one of them up.
    """
    if guard_mouth:
        wait_x, _ = frame.from_our_goal(PENALTY_DEPTH + 40.0)
        wait_z = clamp(bz * 0.5, -POST_SCREEN, POST_SCREEN)
    else:
        wait_x, _ = frame.from_our_goal(390.0)
        wait_z = clamp(bz * 0.6, -300.0, 300.0)
    gap = math.hypot(wait_x - me_x, wait_z - me_z)
    travel = math.atan2(wait_z - me_z, wait_x - me_x)
    state = "COVER_MOUTH" if guard_mouth else "COVER"
    say(me, state)
    return robot.motors(
        drive(
            bearing=wrap_angle(travel - heading),
            speed=clamp(gap / 140.0, 0.0, 1.0) if gap > 30 else 0.0,
            spin=spin,
        ),
        dribbler=1.0,
        say=report(state, me_x, me_z, held=False),
    )


def unstick(s, me, me_x, me_z, travel, speed, spin, state, push, holding):
    """Notice a scrum and roll out of it sideways.

    A stall here is wheels turning with the robot not moving, which is what
    happens when two robots meet over the ball. Rule 5.6.1.2 gives it a few
    seconds before the referee intervenes; going sideways is faster and keeps
    the ball.
    """
    history = me.get("track", [])
    history.append((s.clock, me_x, me_z))
    while history and s.clock - history[0][0] > 0.45:
        history.pop(0)
    me.track = history

    moved = math.hypot(me_x - history[0][1], me_z - history[0][2]) if len(history) > 1 else 999.0
    trying = effort.value > 180.0
    stalled = len(history) > 8 and moved < 22.0 and trying

    timer = me.get("breakout", 0)
    if timer > 0:
        me.breakout = timer - 1
        side = me.get("breakout_side", 1.0)
        if holding:
            # Holding it and pinned: turning is better than shoving, because
            # the shot only needs the heading to come round.
            return travel, 0.45, spin, "PINNED_TURN"
        return wrap_angle(push + side * math.pi / 2), 1.0, spin, "BREAK_OUT"

    count = me.get("stall", 0)
    count = count + 1 if stalled else max(0, count - 1)
    me.stall = count
    if count >= 8:
        me.stall = 0
        me.breakout = 16
        me.breakout_side = -me.get("breakout_side", -1.0)
    return travel, speed, spin, state


def teammate_is_keeping(s) -> bool:
    """Whether the other robot is playing as the keeper.

    Read through `teammate_says` rather than by hand. A message body arrives as
    a `Reading`, not a `dict` - `Reading` exists to let `s.camera.goals.yellow`
    read the way it is written on paper - so the obvious `isinstance(body, dict)
    and body.get("role")` is False for every message ever sent, and this
    returned False for the whole of every match.

    Nothing announced that. It just quietly switched off every behaviour that
    depended on knowing the keeper was there: staying out of our own box while
    the keeper works it (`cover`), and leaving it room when we are in there
    anyway (`leave_room_for_the_keeper`, which is rule 5.11.1 avoidance). Two
    robots defending one goal is a call the referee has to make, and we were
    making it easy.
    """
    return teammate_says(s, "role") == "goalie"


def say(me, state: str, distance: float | None = None) -> None:
    """Optional debug telemetry at ~2 Hz."""
    if not args.debug:
        return
    ticks = me.get("log", 0) + 1
    me.log = ticks
    if ticks % 25 == 0:
        extra = f"ball {distance:6.0f}" if distance is not None else " " * 11
        print(
            f"[{args.team}-{args.number} striker] {state:<14} {extra}"
            f"  at ({locator.x:7.0f},{locator.z:6.0f})"
            f"  ball ({ball.x:7.0f},{ball.z:6.0f}) age {ball.age:.2f}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    robot.run(args.url)
