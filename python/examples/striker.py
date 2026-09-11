"""An attacking robot.

A smart, decisive striker ported and enhanced from the reference agent:
- Full position estimation (locate) using sonars, 360 camera, and compass.
- Robust boundary protection: immediate line escape without spinning.
- Noise-free encoder-based PD heading controller with critically damped tracking (no wiggling).
- Continuous goal-oriented standoff approach and pocket convergence.
- High-precision shot aiming targeting open corners and far posts.
- Decisive kicker firing on ball-gate hold with clean dribbler release.
- 50 Hz IR seeker primary ball perception with fresh-camera fallback.
- Active scrum/stall detection with persistent lateral roll breakout maneuvers.
- Teammate radio message sharing.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

# Ensure rcja_soccer can be imported regardless of current working directory
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rcja_soccer import Robot, clamp, drive, wrap_angle

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default="cyan", choices=["cyan", "yellow"])
parser.add_argument("--number", type=int, default=1, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--debug", action="store_true", help="print telemetry")
args = parser.parse_args()

robot = Robot(team=args.team, number=args.number, name=args.name)

# Field dimensions (mm)
WALL_X = 1215.0
WALL_Z = 910.0
HALF_LENGTH = 915.0
HALF_WIDTH = 610.0
ROBOT_RADIUS = 110.0
WHEEL_RADIUS = 25.0
MOUNT_RADIUS = 90.0

#: Cyan attacks +x (0 rad); yellow attacks -x (pi rad).
TOWARDS_THEIR_GOAL = 0.0 if args.team == "cyan" else math.pi
THEIR_GOAL = "yellow" if args.team == "cyan" else "cyan"
OUR_GOAL = "cyan" if args.team == "cyan" else "yellow"
ATTACK_X = HALF_LENGTH if args.team == "cyan" else -HALF_LENGTH
DEFEND_X = -ATTACK_X

MEMORY_TICKS = 50
EDGE_MARGIN = 260.0
WALL_REPULSION = 1.4

# Smooth, critically-damped heading gains
SPIN_KP = 1.1
SPIN_KD = 0.4


@robot.tick
def think(s, me):
    if not s.playing:
        return robot.coast()

    # 1. Update yaw rate from encoders and heading
    update_yaw_rate(s, me)
    heading = s.compass.heading

    # 2. Rule 5.7.1.6: Boundary line recovery takes absolute priority.
    # Escape immediately with spin=0 so the robot drives straight back in.
    line_escape = off_the_line(s)
    if line_escape is not None:
        log(me, "ESCAPE_LINE")
        return robot.motors(drive(bearing=line_escape, speed=1.0, spin=0.0), dribbler=1.0)

    # 3. Rule 5.4.7: Kick-off must be a clean strike clear of the center spot.
    seen = update_ball_memory(s, me, heading)
    if s.kickoff.pending and s.kickoff.ours and seen is not None:
        log(me, "KICK_OFF")
        return robot.motors(drive(bearing=seen[0], speed=1.0, spin=0.0), dribbler=0.0)

    # 4. If locally blinded, check radio messages from teammate.
    if seen is None:
        teammate_ball = get_teammate_ball(s)
        if teammate_ball is not None:
            rel_bearing = wrap_angle(teammate_ball - heading)
            seen = (rel_bearing, 400.0)

    # 5. Ball lost: hunt towards own half while scanning
    if seen is None:
        log(me, "SEARCH")
        towards_own_half = wrap_angle(math.atan2(0.0, DEFEND_X) - heading)
        return robot.motors(
            drive(bearing=towards_own_half, speed=0.3, spin=0.5),
            dribbler=1.0,
            say={"role": "striker", "ball_field": None, "held": False},
        )

    ball_bearing, ball_dist = seen
    est_x, est_z, conf = locate(s, heading)
    me.est_x = est_x
    me.est_z = est_z

    bx = est_x + math.cos(heading + ball_bearing) * ball_dist
    bz = est_z + math.sin(heading + ball_bearing) * ball_dist

    upfield_dir = 1.0 if args.team == "cyan" else -1.0

    # 6. Rule 5.8 / 5.11: Friendly Penalty Box Exclusion Zone.
    PENALTY_DEPTH = 300.0
    PENALTY_WIDTH = 900.0
    ball_in_friendly_box = (
        upfield_dir * (bx - DEFEND_X) < (PENALTY_DEPTH + 40.0)
        and abs(bz) < (PENALTY_WIDTH / 2.0 + 30.0)
    )

    carrying = s.ball_gate.held

    if ball_in_friendly_box and not carrying:
        log(me, "COVER_BOX", ball_dist)
        wait_x = DEFEND_X + upfield_dir * (PENALTY_DEPTH + 85.0)
        wait_z = clamp(bz * 0.65, -280.0, 280.0)
        dx = wait_x - est_x
        dz = wait_z - est_z
        to_wait = wrap_angle(math.atan2(dz, dx) - heading)
        wait_dist = math.hypot(dx, dz)
        wait_speed = clamp(wait_dist / 110.0, 0.35, 1.0) if wait_dist > 25.0 else 0.0
        # Face the opponent goal ready for clearance
        to_goal_local = wrap_angle(TOWARDS_THEIR_GOAL - heading)
        spin = spin_to(to_goal_local, me)
        return robot.motors(
            drive(bearing=to_wait, speed=wait_speed, spin=spin),
            dribbler=1.0,
            kicker=False,
            say={"role": "striker", "ball_field": me.get("field_bearing"), "held": False},
        )

    # 7. Goal Aiming: target open corner / far post of the goal mouth
    if conf >= 0.5:
        target_x, target_z = select_shot_target(bx, bz, est_x, est_z)
        push_angle = math.atan2(target_z - bz, target_x - bx)
    else:
        push_angle = TOWARDS_THEIR_GOAL

    to_goal_local = wrap_angle(push_angle - heading)

    # Visual lock-on from 360 camera if goal is directly seen
    their_cam = getattr(getattr(s.camera, "goals", None), THEIR_GOAL, None)
    if their_cam is not None and abs(their_cam.bearing - to_goal_local) < 0.4:
        to_goal_local = their_cam.bearing * 0.7 + to_goal_local * 0.3

    # Always keep chassis smoothly tracking the opponent goal
    spin = spin_to(to_goal_local, me)

    # 8. Continuous Standoff Approach and Strike in Robot Frame
    ball_x = math.cos(ball_bearing) * ball_dist
    ball_z = math.sin(ball_bearing) * ball_dist
    gx = math.cos(to_goal_local)
    gz = math.sin(to_goal_local)

    standoff = clamp(ball_dist * 0.8, 120.0, 240.0)
    target_x = ball_x - gx * standoff
    target_z = ball_z - gz * standoff
    dist_to_pocket = math.hypot(target_x, target_z)

    # Check whether the robot is already positioned behind the ball relative to goal
    behind = (
        carrying
        or (dist_to_pocket < 90.0)
        or (ball_dist <= 220.0 and abs(ball_bearing) < 0.5 and abs(to_goal_local) < 0.5)
    )

    approach = math.atan2(target_z, target_x)

    # Detour around the ball only when pocket is behind us and ball is directly in between
    if target_x < -20.0 and abs(ball_z) < 150.0:
        steer_z = target_z + (160.0 if ball_z >= 0 else -160.0)
        approach = math.atan2(steer_z, target_x)

    bearing = ball_bearing if behind else approach
    closing = clamp(dist_to_pocket / 280.0, 0.45, 1.0)
    speed = 1.0 if behind else closing

    lined_up = abs(to_goal_local) < 0.32 or (their_cam is not None and abs(their_cam.bearing) < 0.30)
    # Fire kicker whenever ball is in contact/held and lined up
    kick = lined_up and (carrying or (behind and ball_dist <= 210.0))
    dribbler_pwr = 0.0 if kick else 1.0

    if carrying:
        log(me, "CARRY_AND_SHOOT", ball_dist)
        if not lined_up:
            speed = 0.5
    elif behind:
        log(me, "STRIKE", ball_dist)
    else:
        log(me, "CONVERGE_POCKET", dist_to_pocket)

    # 9. Anti-Scrum Stall Detection and Persistent Breakout Maneuver
    enc_delta = me.get("last_enc_delta", 1.0)
    last_speed = me.get("last_speed", 0.0)

    is_stalled = (
        last_speed > 0.6
        and enc_delta < 0.20
        and ball_dist <= 260.0
    )

    stall_ticks = me.get("stall_ticks", 0)
    if is_stalled:
        stall_ticks += 1
    else:
        stall_ticks = max(0, stall_ticks - 1)
    me.stall_ticks = stall_ticks

    # Trigger sustained breakout for ~0.35s (18 ticks) upon stall
    breakout_timer = me.get("breakout_timer", 0)
    if stall_ticks >= 6 and breakout_timer == 0:
        me.breakout_timer = 18
        me.scrum_side = 1.0 if (me.get("scrum_count", 0) % 2 == 0) else -1.0
        me.scrum_count = me.get("scrum_count", 0) + 1
        me.stall_ticks = 0

    if breakout_timer > 0:
        me.breakout_timer = breakout_timer - 1
        log(me, "SCRUM_BREAKOUT")
        if carrying:
            kick = True
            dribbler_pwr = 0.0
            bearing = to_goal_local
            speed = 1.0
        else:
            scrum_side = me.get("scrum_side", 1.0)
            # Lateral jink 90 degrees across attack line to roll off the opponent
            bearing = wrap_angle(to_goal_local + scrum_side * (math.pi / 2))
            speed = 1.0
            spin = spin_to(to_goal_local, me)

    me.last_speed = speed

    return robot.motors(
        drive(bearing=bearing, speed=speed, spin=spin),
        dribbler=dribbler_pwr,
        kicker=kick,
        say={"role": "striker", "ball_field": me.get("field_bearing"), "held": carrying},
    )


def select_shot_target(bx: float, bz: float, est_x: float, est_z: float) -> tuple[float, float]:
    """Aim at the far post or open side to beat the goalkeeper (from rcja-soccer-lab)."""
    post = 150.0  # inside 225 mm post

    # If ball is on right side of field, aim across goal to left post
    if bz > 35.0:
        target_z = -post
    elif bz < -35.0:
        target_z = post
    else:
        # Central: aim for far corner away from where striker is approaching
        target_z = post if est_z <= 0.0 else -post

    return ATTACK_X, clamp(target_z, -post, post)


def spin_to(error: float, me) -> float:
    """Smooth, critically-damped PD heading controller with encoder damping."""
    yaw_rate = me.get("yaw_rate", 0.0)
    return clamp(error * SPIN_KP - yaw_rate * SPIN_KD, -1.0, 1.0)


def update_yaw_rate(s, me) -> float:
    """Compute clean yaw rate from wheel encoders with low-pass filtering."""
    encoders = getattr(s, "encoders", None)
    dt = max(1e-3, s.clock - me.get("last_clock", s.clock))
    me.last_clock = s.clock

    if encoders is not None and len(encoders) >= 4:
        last_enc = me.get("last_encoders")
        me.last_encoders = list(encoders)
        if last_enc is not None and len(last_enc) == len(encoders):
            sum_diff = sum(encoders[i] - last_enc[i] for i in range(len(encoders)))
            enc_delta = sum(abs(encoders[i] - last_enc[i]) for i in range(len(encoders))) / len(encoders)
            me.last_enc_delta = enc_delta

            mean_speed = (sum_diff / len(encoders)) / dt
            omega = (mean_speed * WHEEL_RADIUS) / MOUNT_RADIUS
            rate = me.get("yaw_rate", 0.0)
            rate += (omega - rate) * min(1.0, dt * 20.0)
            me.yaw_rate = rate
            return rate

    # Fallback to compass differencing
    last_h = me.get("last_heading", s.compass.heading)
    diff = wrap_angle(s.compass.heading - last_h)
    me.last_heading = s.compass.heading
    raw_rate = diff / dt
    rate = me.get("yaw_rate", 0.0)
    rate += (raw_rate - rate) * min(1.0, dt * 10.0)
    me.yaw_rate = rate
    me.last_enc_delta = 1.0
    return rate


def locate(s, heading: float) -> tuple[float, float, float]:
    """Estimate field coordinates (x, z) using 360-degree dual-goal visual triangulation & sonar."""
    cam_estimates = []
    cam = getattr(s, "camera", None)
    if cam is not None and getattr(cam, "fresh", True):
        yellow_cam = getattr(cam.goals, "yellow", None)
        if yellow_cam is not None:
            angle = wrap_angle(heading + yellow_cam.bearing)
            cam_estimates.append((
                915.0 - math.cos(angle) * yellow_cam.range,
                0.0 - math.sin(angle) * yellow_cam.range,
            ))
        cyan_cam = getattr(cam.goals, "cyan", None)
        if cyan_cam is not None:
            angle = wrap_angle(heading + cyan_cam.bearing)
            cam_estimates.append((
                -915.0 - math.cos(angle) * cyan_cam.range,
                0.0 - math.sin(angle) * cyan_cam.range,
            ))

    beams = []
    offsets = [
        (0.0, s.range.front),
        (math.pi / 2, s.range.left),
        (math.pi, s.range.back),
        (-math.pi / 2, s.range.right),
    ]
    for offset, r in offsets:
        if r is not None:
            beams.append((wrap_angle(heading + offset), r))

    def solve(component_fn, wall):
        plus = None
        minus = None
        for angle, r in beams:
            c = component_fn(angle)
            if abs(c) < 0.6:
                continue
            val = math.copysign(wall, c) - (r + ROBOT_RADIUS) * c
            if c > 0:
                if plus is None or r > plus[1]:
                    plus = (val, r)
            else:
                if minus is None or r > minus[1]:
                    minus = (val, r)
        if plus is not None and minus is not None:
            better = plus if plus[1] >= minus[1] else minus
            return better[0], True
        only = plus or minus
        return (only[0], False) if only else None

    sol_x = solve(math.cos, WALL_X)
    sol_z = solve(math.sin, WALL_Z)

    if cam_estimates:
        cx = sum(p[0] for p in cam_estimates) / len(cam_estimates)
        cz = sum(p[1] for p in cam_estimates) / len(cam_estimates)
        if sol_x and sol_z:
            final_x = cx * 0.7 + sol_x[0] * 0.3
            final_z = cz * 0.7 + sol_z[0] * 0.3
        else:
            final_x, final_z = cx, cz
        return clamp(final_x, -HALF_LENGTH, HALF_LENGTH), clamp(final_z, -HALF_WIDTH, HALF_WIDTH), 1.0

    if sol_x and sol_z:
        return clamp(sol_x[0], -HALF_LENGTH, HALF_LENGTH), clamp(sol_z[0], -HALF_WIDTH, HALF_WIDTH), 0.8

    return (0.0, 0.0, 0.2)


def off_the_line(s) -> float | None:
    """Direction pointing inward away from the white boundary line."""
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


def update_ball_memory(s, me, heading: float) -> tuple[float, float] | None:
    """Track ball observations from 50 Hz 24-sensor IR seeker, with fresh camera fallback."""
    measured_field = None
    measured_range = None

    # Primary sensor: 24-sensor IR ring at 50 Hz
    if s.ball is not None:
        measured_field = wrap_angle(heading + s.ball.bearing)
        measured_range = 200.0 / math.sqrt(max(s.ball.strength, 1e-4))
    # Secondary fallback: 360 camera (only when IR is blocked and frame is fresh)
    else:
        cam = getattr(s, "camera", None)
        if cam is not None and getattr(cam, "fresh", False):
            cam_ball = getattr(cam, "ball", None)
            if cam_ball is not None:
                measured_field = wrap_angle(heading + cam_ball.bearing)
                measured_range = cam_ball.range

    if measured_field is not None and measured_range is not None:
        if me.get("field_bearing") is None:
            me.field_bearing = measured_field
            me.range = measured_range
        else:
            dt = max(1e-3, s.clock - me.get("last_ball_clock", s.clock))
            me.last_ball_clock = s.clock
            # Filter with tau = 0.2s to swallow 24-sensor stepping without lag
            k = 1.0 - math.exp(-dt / 0.2)
            me.field_bearing = wrap_angle(
                me.field_bearing + wrap_angle(measured_field - me.field_bearing) * k
            )
            me.range = me.range + (measured_range - me.range) * k

        me.age = 0
        return wrap_angle(me.field_bearing - heading), me.range

    age = me.get("age", MEMORY_TICKS + 1) + 1
    me.age = age
    if age > MEMORY_TICKS or me.get("field_bearing") is None:
        return None
    return wrap_angle(me.field_bearing - heading), me.range


def get_teammate_ball(s) -> float | None:
    """Read teammate radio messages for ball field coordinates."""
    for msg in getattr(s, "messages", []):
        body = getattr(msg, "body", None)
        if body is None and isinstance(msg, dict):
            body = msg.get("body")
        if isinstance(body, dict) and body.get("ball_field") is not None:
            return body["ball_field"]
    return None


def log(me, state: str, dist: float | None = None) -> None:
    """Optional debug telemetry at ~2 Hz."""
    if not args.debug:
        return
    ticks = me.get("log_ticks", 0) + 1
    me.log_ticks = ticks
    if ticks % 25 == 0:
        d_str = f"dist={dist:.0f}mm" if dist is not None else ""
        print(f"[{args.team}-{args.number} Striker] {state:<16} {d_str}", file=sys.stderr)


if __name__ == "__main__":
    robot.run(args.url)
