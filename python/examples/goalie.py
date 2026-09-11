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

    upfield_dir = 1.0 if args.team == "cyan" else -1.0

    # 1. Decisive Ball Clearing when ball is held on dribbler
    # When the goalkeeper captures the ball, NEVER back into the goal!
    # Turn OFF the dribbler so the kick isn't recaptured, fire the kicker,
    # and drive forward to launch the ball out of the danger zone.
    holding_ball = s.ball_gate.held
    if holding_ball:
        log(me, "CLEAR_HELD_BALL", ball_dist)
        to_center_upfield = wrap_angle(math.atan2(-bz * 0.1, ATTACK_X - bx) - heading)
        clear_spin = spin_to(to_center_upfield, me)
        return robot.motors(
            drive(bearing=0.0, speed=1.0, spin=clear_spin),
            dribbler=0.0,  # OFF: allows the kick impulse to release cleanly!
            kicker=True,
            say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": True, "has_ball": True},
        )

    # 2. Check if ball is inside our penalty crease or threatening in front of net
    PENALTY_DEPTH = 300.0
    PENALTY_WIDTH = 900.0
    ball_in_crease = (
        upfield_dir * (bx - DEFEND_X) < (PENALTY_DEPTH + 35.0)
        and abs(bz) < (PENALTY_WIDTH / 2.0 + 35.0)
    )
    ball_threatening = (
        abs(bz) < 260.0
        and upfield_dir * (bx - DEFEND_X) > -20.0
        and upfield_dir * (bx - DEFEND_X) < (PENALTY_DEPTH + 50.0)
        and ball_dist < 260.0
    )

    if ball_in_crease or ball_threatening:
        # Clear forward strictly down central corridor
        log(me, "CLEAR_CREASE_BALL", ball_dist)
        to_center_upfield = wrap_angle(math.atan2(-bz * 0.15, ATTACK_X - bx) - heading)
        clear_spin = spin_to(to_center_upfield if abs(ball_bearing) < 0.4 else ball_bearing, me)
        kick_now = ball_dist < 200.0
        return robot.motors(
            drive(bearing=ball_bearing, speed=1.0, spin=clear_spin),
            dribbler=0.0 if kick_now else 0.4,
            kicker=kick_now,
            say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": True, "has_ball": False},
        )

    # 3. Crease arc guarding
    target_z = guard_z(bx, bz, HOLD_X, DEFEND_X)
    arc_step = clamp((1.0 - abs(target_z) / POST_CLAMP_Z) * 60.0, 0.0, 60.0)
    target_x = HOLD_X + upfield_dir * arc_step

    # Stall detection for goalkeeper to avoid getting shoved backwards into the goal
    pos_hist = me.get("pos_hist", [])
    pos_hist.append((s.clock, est_x, est_z))
    while pos_hist and s.clock - pos_hist[0][0] > 0.35:
        pos_hist.pop(0)
    me.pos_hist = pos_hist

    dist_moved = 0.0
    if len(pos_hist) >= 2:
        dist_moved = math.hypot(est_x - pos_hist[0][1], est_z - pos_hist[0][2])

    is_stalled = (
        len(pos_hist) >= 6
        and (s.clock - pos_hist[0][0]) >= 0.25
        and dist_moved < 14.0
        and me.get("last_speed", 0.0) > 0.6
    )

    stall_ticks = me.get("stall_ticks", 0)
    if is_stalled:
        stall_ticks += 1
    else:
        stall_ticks = max(0, stall_ticks - 1)
    me.stall_ticks = stall_ticks

    log(me, "CREASE_GUARD", ball_dist)
    return hold(
        s,
        me,
        est_x,
        est_z,
        target_x=target_x,
        target_z=target_z,
        spin=spin,
        heading=heading,
        stall_ticks=stall_ticks,
    )


def guard_z(bx: float, bz: float, line_x: float, own_x: float) -> float:
    """Shadow the line of sight connecting the ball to our goal center."""
    span = own_x - bx
    if abs(span) < 1.0:
        return clamp(bz, -POST_CLAMP_Z, POST_CLAMP_Z)
    intercept = bz + ((line_x - bx) / span) * (-bz)
    return clamp(intercept, -POST_CLAMP_Z, POST_CLAMP_Z)


def hold(
    s,
    me,
    est_x: float,
    est_z: float,
    target_x: float,
    target_z: float,
    spin: float,
    heading: float,
    stall_ticks: int = 0,
):
    """Maintain anchor position on the crease arc with fast, decisive positioning."""
    dx = target_x - est_x
    dz = target_z - est_z

    dist = math.hypot(dx, dz)
    if dist < 6.0:
        me.last_speed = 0.0
        return robot.motors(
            drive(bearing=0.0, speed=0.0, spin=spin),
            dribbler=0.0,
            say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": False},
        )

    to_hold = wrap_angle(math.atan2(dz, dx) - heading)
    speed = clamp(dist / 110.0, 0.25, 1.0)

    if stall_ticks >= 6:
        # Pinned by an opponent at the goal: jink laterally along the goal mouth to slide free
        scrum_id = me.get("scrum_id", 0)
        scrum_side = 1.0 if (scrum_id % 2 == 0) else -1.0
        to_hold = wrap_angle(to_hold + scrum_side * 1.3)
        speed = 1.0
        spin = scrum_side * 1.0
        if stall_ticks > 18:
            me.scrum_id = scrum_id + 1
            me.stall_ticks = 0

    me.last_speed = speed

    return robot.motors(
        drive(bearing=to_hold, speed=speed, spin=spin),
        dribbler=0.0,
        say={"role": "goalie", "ball_field": me.get("field_bearing"), "clearing": False},
    )


def update_heading(s, me, est_x: float, est_z: float) -> float:
    """Return ground-truth compass heading."""
    return s.compass.heading


def spin_to(error: float, me) -> float:
    """Smooth, critically-damped PD heading controller with encoder damping."""
    SPIN_KP = 1.1
    SPIN_KD = 0.4
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


def locate_goalie(s, me, heading: float) -> tuple[float, float]:
    """Estimate field coordinates (x, z) robustly for goalkeeper using 360 camera and sonars."""
    cam_estimates = []
    if getattr(s, "camera", None):
        yellow_cam = getattr(s.camera.goals, "yellow", None)
        if yellow_cam is not None:
            angle = wrap_angle(heading + yellow_cam.bearing)
            cam_estimates.append((
                915.0 - math.cos(angle) * yellow_cam.range,
                0.0 - math.sin(angle) * yellow_cam.range,
            ))
        cyan_cam = getattr(s.camera.goals, "cyan", None)
        if cyan_cam is not None:
            angle = wrap_angle(heading + cyan_cam.bearing)
            cam_estimates.append((
                -915.0 - math.cos(angle) * cyan_cam.range,
                0.0 - math.sin(angle) * cyan_cam.range,
            ))

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

    if cam_estimates:
        cx = sum(p[0] for p in cam_estimates) / len(cam_estimates)
        cz = sum(p[1] for p in cam_estimates) / len(cam_estimates)
        final_x = cx * 0.7 + new_x * 0.3
        final_z = cz * 0.7 + new_z * 0.3
    else:
        final_x, final_z = new_x, new_z

    final_x = clamp(final_x, -HALF_LENGTH, HALF_LENGTH)
    final_z = clamp(final_z, -HALF_WIDTH, HALF_WIDTH)

    me.est_x = final_x
    me.est_z = final_z
    return final_x, final_z


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
