"""An attacking robot.

A smart, decisive striker ported from the battle-tested reference agent:
- Full position estimation (locate) using sonars and compass.
- Robust boundary protection: immediate line escape without spinning.
- Active PD heading controller with encoder damping.
- Smooth standoff approach behind the ball relative to goal.
- Decisive strike through the ball and kicker on dribbler hold.
- Camera ball fallback when IR seeker is occluded.
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


@robot.tick
def think(s, me):
    if not s.playing:
        return robot.coast()

    # 1. Update yaw rate and heading with real-time visual drift correction
    update_yaw_rate(s, me)
    heading = update_heading(s, me, me.get("est_x", 0.0), me.get("est_z", 0.0))

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

    # 6. Smart Goal Aiming: target the far post or open corner (from rcja-soccer-lab)
    target_x, target_z = select_shot_target(bx, bz, est_x, est_z)
    push_angle = math.atan2(target_z - bz, target_x - bx)
    push_local = off_the_wall(s, wrap_angle(push_angle - heading))
    push_field = wrap_angle(heading + push_local)
    to_target_local = wrap_angle(push_field - heading)

    # 7. Continuous Standoff Approach and Strike
    standoff = clamp(ball_dist * 0.75, 120.0, 240.0)
    pocket_x = bx - math.cos(push_field) * standoff
    pocket_z = bz - math.sin(push_field) * standoff
    to_pocket_x = pocket_x - est_x
    to_pocket_z = pocket_z - est_z
    dist_to_pocket = math.hypot(to_pocket_x, to_pocket_z)

    carrying = s.ball_gate.held
    behind = carrying or (dist_to_pocket < 95.0)

    # Geometry relative to push vector
    ux = math.cos(push_field)
    uz = math.sin(push_field)
    along = (est_x - bx) * ux + (est_z - bz) * uz
    lateral = (est_z - bz) * ux - (est_x - bx) * uz

    if carrying:
        # Carrying ball on dribbler: run towards open post, square up and strike!
        log(me, "CARRY_AND_SHOOT", ball_dist)
        bearing = to_target_local
        speed = 1.0
        spin = spin_to(to_target_local, me)
        kick = abs(to_target_local) < 0.28
    elif behind:
        # Lined up in pocket behind the ball: drive through into target!
        log(me, "STRIKE", ball_dist)
        bearing = ball_bearing
        speed = 1.0
        spin = spin_to(to_target_local, me)
        kick = (ball_dist < 230.0) and abs(to_target_local) < 0.28
    elif along > -40.0:
        # Wrong side of ball: sweep smoothly around the flank we are already closer to
        log(me, "SWEEP_FLANK", ball_dist)
        flank_side = 1.0 if lateral >= 0 else -1.0
        flank_angle = push_field + math.pi - flank_side * clamp(abs(lateral) / 160.0 + 0.6, 0.7, 1.4)
        flank_radius = 230.0
        waypoint_x = clamp(bx + math.cos(flank_angle) * flank_radius, -WALL_X + 120.0, WALL_X - 120.0)
        waypoint_z = clamp(bz + math.sin(flank_angle) * flank_radius, -WALL_Z + 120.0, WALL_Z - 120.0)
        bearing = wrap_angle(math.atan2(waypoint_z - est_z, waypoint_x - est_x) - heading)
        speed = 0.85
        spin = spin_to(to_target_local, me)
        kick = False
    else:
        # Approaching into the pocket behind the ball with smooth speed ramp
        log(me, "CONVERGE_POCKET", dist_to_pocket)
        bearing = wrap_angle(math.atan2(to_pocket_z, to_pocket_x) - heading)
        speed = clamp(dist_to_pocket / 240.0, 0.40, 0.95)
        spin = spin_to(to_target_local, me)
        kick = False

    # Turn priority: ease translation power so rotation snaps fast
    turn_priority = clamp(1.0 - abs(to_target_local) * 0.5, 0.4, 1.0)
    speed *= turn_priority

    return robot.motors(
        drive(bearing=bearing, speed=speed, spin=spin),
        dribbler=1.0,
        kicker=kick,
        say={"role": "striker", "ball_field": me.get("field_bearing"), "held": s.ball_gate.held},
    )


def select_shot_target(bx: float, bz: float, est_x: float, est_z: float) -> tuple[float, float]:
    """Aim at the far post or open side to beat the goalkeeper (from rcja-soccer-lab)."""
    post = 165.0  # inside 225 mm post

    # If ball is on right side of field, aim across goal to left post
    if bz > 35.0:
        target_z = -post
    elif bz < -35.0:
        target_z = post
    else:
        # Central: aim for far corner away from where striker is approaching
        target_z = post if est_z <= 0.0 else -post

    # Boundary repulsion: if near sideline, steer shot inward onto playing area
    if abs(bz) > 360.0:
        urgency = (abs(bz) - 360.0) / 250.0
        target_z -= math.copysign(urgency * 150.0, bz)

    return ATTACK_X, clamp(target_z, -post, post)


def update_heading(s, me, est_x: float, est_z: float) -> float:
    """Continuously correct gyro drift whenever a goal is visible in camera."""
    drift = me.get("compass_drift")
    camera_fresh = getattr(s.camera, "fresh", True)
    if camera_fresh:
        for goal_name, gx, gz in [("yellow", 915.0, 0.0), ("cyan", -915.0, 0.0)]:
            goal_cam = getattr(s.camera.goals, goal_name, None)
            if goal_cam is not None and abs(goal_cam.bearing) < 0.38:
                expected_field_angle = math.atan2(gz - est_z, gx - est_x)
                derived_heading = wrap_angle(expected_field_angle - goal_cam.bearing)
                measured_drift = wrap_angle(s.compass.heading - derived_heading)
                if drift is None:
                    drift = measured_drift
                else:
                    drift = wrap_angle(drift + wrap_angle(measured_drift - drift) * 0.03)
                me.compass_drift = drift
                break
    if drift is None:
        drift = 0.0
    return wrap_angle(s.compass.heading - drift)


def spin_to(error: float, me) -> float:
    """High-torque agile PD heading controller with encoder damping."""
    SPIN_KP = 3.0
    SPIN_KD = 0.30
    yaw_rate = me.get("yaw_rate", 0.0)
    return clamp(error * SPIN_KP - yaw_rate * SPIN_KD, -1.0, 1.0)


def update_yaw_rate(s, me) -> None:
    """Compute yaw rate from wheel encoders."""
    dt = max(1e-3, s.clock - me.get("last_clock", s.clock))
    me.last_clock = s.clock
    yaw_rate = me.get("yaw_rate", 0.0)

    encoders = getattr(s, "encoders", None)
    if encoders:
        last_enc = me.get("last_encoders")
        if last_enc and len(last_enc) == len(encoders) and dt > 0:
            diffs = [e - l for e, l in zip(encoders, last_enc)]
            mean_wheel = sum(diffs) / len(diffs) / dt
            omega = (mean_wheel * WHEEL_RADIUS) / MOUNT_RADIUS
            yaw_rate += (omega - yaw_rate) * min(1.0, dt * 20.0)
        me.last_encoders = list(encoders)

    me.yaw_rate = yaw_rate


def locate(s, heading: float) -> tuple[float, float, float]:
    """Estimate field coordinates (x, z) and confidence (0..1) from sonars."""
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
            span = plus[1] + minus[1] + 2 * ROBOT_RADIUS
            agree = abs(span - 2 * wall) < 150.0
            better = plus if plus[1] >= minus[1] else minus
            return better[0], agree
        only = plus or minus
        return (only[0], False) if only else None

    sol_x = solve(math.cos, WALL_X)
    sol_z = solve(math.sin, WALL_Z)

    x = clamp(sol_x[0] if sol_x else 0.0, -HALF_LENGTH, HALF_LENGTH)
    z = clamp(sol_z[0] if sol_z else 0.0, -HALF_WIDTH, HALF_WIDTH)
    conf = (0.5 if sol_x and sol_x[1] else 0.0) + (0.5 if sol_z and sol_z[1] else 0.0)
    return x, z, conf


def off_the_wall(s, desired_bearing: float) -> float:
    """Bend aim bearing away from nearby walls."""
    beams = [
        (0.0, s.range.front),
        (math.pi / 2, s.range.left),
        (math.pi, s.range.back),
        (-math.pi / 2, s.range.right),
    ]
    rx = math.cos(desired_bearing)
    rz = math.sin(desired_bearing)
    for angle, dist in beams:
        if dist is None or dist > EDGE_MARGIN:
            continue
        urgency = 1.0 - dist / EDGE_MARGIN
        rx -= math.cos(angle) * urgency * WALL_REPULSION
        rz -= math.sin(angle) * urgency * WALL_REPULSION
    if math.hypot(rx, rz) < 1e-5:
        return desired_bearing
    return wrap_angle(math.atan2(rz, rx))


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
    """Low-pass filter ball observations in field frame with camera fallback."""
    measured_field = None
    measured_range = None

    if s.ball is not None:
        measured_field = wrap_angle(heading + s.ball.bearing)
        measured_range = 200.0 / math.sqrt(max(s.ball.strength, 1e-4))
    elif getattr(s.camera, "ball", None) is not None:
        measured_field = wrap_angle(heading + s.camera.ball.bearing)
        measured_range = s.camera.ball.range

    if measured_field is not None and measured_range is not None:
        if me.get("field_bearing") is None:
            me.field_bearing = measured_field
            me.range = measured_range
        else:
            dt = max(1e-3, s.clock - me.get("last_ball_clock", s.clock))
            me.last_ball_clock = s.clock
            k_bearing = 1.0 - math.exp(-dt / 0.06)
            k_range = 1.0 - math.exp(-dt / 0.08)
            me.field_bearing = wrap_angle(
                me.field_bearing + wrap_angle(measured_field - me.field_bearing) * k_bearing
            )
            me.range = me.range + (measured_range - me.range) * k_range

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
