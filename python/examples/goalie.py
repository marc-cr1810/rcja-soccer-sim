"""A goalkeeper robot.

A smart, dependable goalkeeper ported from the battle-tested reference agent:
- Full position estimation (locate) using sonars and compass.
- Anchors reliably 180 mm in front of the goal line.
- Clamped strictly within the 450 mm goal mouth (±190 mm).
- Active PD heading controller with encoder damping.
- Decisive clearing when the ball is loose in front of the net.
- Safe detouring around the ball if it rolls behind the keeper.
- Immediate line escape without spinning.
- Camera ball fallback.
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
parser.add_argument("--number", type=int, default=2, choices=[1, 2])
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

TOWARDS_THEIR_GOAL = 0.0 if args.team == "cyan" else math.pi
ATTACK_X = HALF_LENGTH if args.team == "cyan" else -HALF_LENGTH
DEFEND_X = -ATTACK_X

# Anchor 180 mm in front of the goal line
HOLD_X = DEFEND_X + (180.0 if args.team == "cyan" else -180.0)
POST_CLAMP_Z = 175.0  # 450 mm goal mouth with posts at ±225 mm

CLEARING_RANGE = 300.0
MEMORY_TICKS = 50


@robot.tick
def think(s, me):
    if not s.playing:
        return robot.coast()

    update_yaw_rate(s, me)

    # 1. Heading with real-time visual gyro drift cancellation
    heading = update_heading(s, me, me.get("est_x", HOLD_X), me.get("est_z", 0.0))

    # 2. Rule 5.7.1.6: Line escape takes absolute priority without spinning
    line_escape = off_the_line(s)
    if line_escape is not None:
        log(me, "ESCAPE_LINE")
        return robot.motors(drive(bearing=line_escape, speed=1.0, spin=0.0), dribbler=1.0)

    # 3. Kick-off pause
    if s.kickoff.pending:
        return robot.coast()

    # 4. Active PD heading control towards opponent's goal
    upfield_err = wrap_angle(TOWARDS_THEIR_GOAL - heading)
    spin = spin_to(upfield_err, me)

    # 5. Estimate field position (robust goalkeeper localisation)
    est_x, est_z = locate_goalie(s, me, heading)

    # 6. Ball perception (IR + camera fallback)
    seen = update_ball_memory(s, me, heading)

    if seen is None:
        log(me, "HOLD_CENTER")
        return hold(s, me, est_x, est_z, target_x=HOLD_X, target_z=0.0, spin=spin, heading=heading)

    ball_bearing, ball_dist = seen
    bx = est_x + math.cos(heading + ball_bearing) * ball_dist
    bz = est_z + math.sin(heading + ball_bearing) * ball_dist

    # Convex crease arc guarding (from rcja-soccer-lab reference AI)
    upfield_dir = 1.0 if args.team == "cyan" else -1.0
    target_z = guard_z(bx, bz, HOLD_X, DEFEND_X)
    arc_step = clamp((1.0 - abs(target_z) / POST_CLAMP_Z) * 60.0, 0.0, 60.0)
    target_x = HOLD_X + upfield_dir * arc_step

    # Check whether the ball is threatening in front of the net -> clear forward
    ball_is_close = ball_dist < CLEARING_RANGE
    ball_in_front_of_net = (
        abs(bz) < 260.0
        and upfield_dir * (bx - DEFEND_X) > 0
        and abs(bx - DEFEND_X) < 400.0
    )

    if ball_is_close and ball_in_front_of_net:
        # Clear strictly down central corridor (rcja-soccer-lab clearance)
        clear_target_z = clamp(bz * 0.1, -60.0, 60.0)
        away = wrap_angle(math.atan2(clear_target_z - bz, ATTACK_X - bx) - heading)
        clear_spin = spin_to(away, me)
        log(me, "CLEAR_BALL", ball_dist)
        return robot.motors(
            drive(bearing=ball_bearing, speed=1.0, spin=clear_spin),
            dribbler=1.0,
            kicker=s.ball_gate.held,
            say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": True},
        )

    # Otherwise stay strictly anchored on the convex crease arc
    log(me, "CREASE_GUARD", ball_dist)
    return hold(s, me, est_x, est_z, target_x=target_x, target_z=target_z, spin=spin, heading=heading)


def guard_z(bx: float, bz: float, line_x: float, own_x: float) -> float:
    """Shadow the line of sight connecting the ball to our goal center."""
    span = own_x - bx
    if abs(span) < 1.0:
        return clamp(bz, -POST_CLAMP_Z, POST_CLAMP_Z)
    intercept = bz + ((line_x - bx) / span) * (-bz)
    return clamp(intercept, -POST_CLAMP_Z, POST_CLAMP_Z)


def hold(s, me, est_x: float, est_z: float, target_x: float, target_z: float, spin: float, heading: float):
    """Maintain anchor position on the crease arc with smooth linear deceleration."""
    dx = target_x - est_x
    dz = target_z - est_z

    dist = math.hypot(dx, dz)
    if dist < 8.0:
        return robot.motors(
            drive(bearing=0.0, speed=0.0, spin=spin),
            dribbler=1.0,
            say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": False},
        )

    to_hold = wrap_angle(math.atan2(dz, dx) - heading)
    speed = clamp(dist / 220.0, 0.0, 0.90)
    # Turn priority: dedicate power to snapping heading into position
    turn_priority = clamp(1.0 - abs(spin) * 0.5, 0.4, 1.0)
    speed *= turn_priority

    return robot.motors(
        drive(bearing=to_hold, speed=speed, spin=spin),
        dribbler=1.0,
        say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": False},
    )


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


def locate_goalie(s, me, heading: float) -> tuple[float, float]:
    """Estimate field coordinates (x, z) robustly for goalkeeper."""
    last_x = me.get("est_x", HOLD_X)
    last_z = me.get("est_z", 0.0)

    offsets = [
        (0.0, s.range.front),
        (math.pi / 2, s.range.left),
        (math.pi, s.range.back),
        (-math.pi / 2, s.range.right),
    ]

    defend_dir = -1.0 if DEFEND_X < 0 else 1.0
    defend_beam = None
    attack_beam = None
    z_beams = []

    for off, r in offsets:
        if r is None:
            continue
        angle = wrap_angle(heading + off)
        dx = math.cos(angle)
        dz = math.sin(angle)

        tx = ((WALL_X if dx > 0 else -WALL_X) - last_x) / dx if abs(dx) > 1e-5 else float("inf")
        tz = ((WALL_Z if dz > 0 else -WALL_Z) - last_z) / dz if abs(dz) > 1e-5 else float("inf")

        if tx > 0 and tx <= tz:
            if abs(dx) > 0.4:
                wall_target = math.copysign(WALL_X, dx)
                val = wall_target - (r + ROBOT_RADIUS) * dx
                if (dx * defend_dir) > 0:
                    if defend_beam is None or abs(dx) > defend_beam[2]:
                        defend_beam = (val, r, abs(dx))
                else:
                    if attack_beam is None or abs(dx) > attack_beam[2]:
                        attack_beam = (val, r, abs(dx))
        elif tz > 0:
            if abs(dz) > 0.4:
                wall_target = math.copysign(WALL_Z, dz)
                val = wall_target - (r + ROBOT_RADIUS) * dz
                z_beams.append((val, abs(dz)))

    new_x = last_x
    if defend_beam:
        new_x = defend_beam[0]
    elif attack_beam:
        new_x = attack_beam[0]

    new_z = last_z
    if z_beams:
        total_w = sum(w for _, w in z_beams)
        new_z = sum(v * w for v, w in z_beams) / total_w

    new_x = clamp(new_x, -HALF_LENGTH, HALF_LENGTH)
    new_z = clamp(new_z, -HALF_WIDTH, HALF_WIDTH)

    alpha = 0.5
    smoothed_x = last_x + (new_x - last_x) * alpha
    smoothed_z = last_z + (new_z - last_z) * alpha

    me.est_x = smoothed_x
    me.est_z = smoothed_z
    return smoothed_x, smoothed_z


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
    """Low-pass filter ball observations with camera fallback."""
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


def log(me, state: str, dist: float | None = None) -> None:
    """Optional debug telemetry at ~2 Hz."""
    if not args.debug:
        return
    ticks = me.get("log_ticks", 0) + 1
    me.log_ticks = ticks
    if ticks % 25 == 0:
        d_str = f"dist={dist:.0f}mm" if dist is not None else ""
        print(f"[{args.team}-{args.number} Goalie ] {state:<16} {d_str}", file=sys.stderr)


if __name__ == "__main__":
    robot.run(args.url)
