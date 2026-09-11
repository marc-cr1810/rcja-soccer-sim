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

    upfield_dir = 1.0 if args.team == "cyan" else -1.0

    # 6. Rule 5.8 / 5.11: Friendly Penalty Box Exclusion Zone.
    # Prevent 3-robot scrums in our goal crease. If the ball is inside our
    # penalty area, leave it to the goalkeeper and wait outside for the clearance.
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
        # Always face the ball while holding outside the crease
        spin = spin_to(ball_bearing, me)
        return robot.motors(
            drive(bearing=to_wait, speed=wait_speed, spin=spin),
            dribbler=1.0,
            kicker=False,
            say={"role": "striker", "ball_field": me.get("field_bearing"), "held": False},
        )

    # 7. Smart Goal Aiming: target the far post or open corner (from rcja-soccer-lab)
    target_x, target_z = select_shot_target(bx, bz, est_x, est_z)
    push_angle = math.atan2(target_z - bz, target_x - bx)
    push_local = off_the_wall(s, wrap_angle(push_angle - heading))
    push_field = wrap_angle(heading + push_local)
    to_target_local = wrap_angle(push_field - heading)

    # 8. Continuous Standoff Approach and Strike
    standoff = clamp(ball_dist * 0.65, 110.0, 220.0)
    pocket_x = bx - math.cos(push_field) * standoff
    pocket_z = bz - math.sin(push_field) * standoff
    to_pocket_x = pocket_x - est_x
    to_pocket_z = pocket_z - est_z
    dist_to_pocket = math.hypot(to_pocket_x, to_pocket_z)

    # Geometry relative to push vector
    ux = math.cos(push_field)
    uz = math.sin(push_field)
    along = (est_x - bx) * ux + (est_z - bz) * uz
    lateral = (est_z - bz) * ux - (est_x - bx) * uz

    behind = carrying or (along < -25.0 and abs(lateral) < 120.0) or (dist_to_pocket < 85.0)

    # 9. Heading selection:
    # - Carrying or lined up in the pocket: face the shot target to aim and shoot.
    # - Approaching, flanking, or contesting: face the BALL directly so the front
    #   dribbler/kicker engages the ball, instead of turning the robot's back to it.
    if carrying:
        log(me, "CARRY_AND_SHOOT", ball_dist)
        bearing = to_target_local
        speed = 1.0
        desired_spin_err = to_target_local
        kick = abs(to_target_local) < 0.35
    elif behind:
        log(me, "STRIKE", ball_dist)
        bearing = ball_bearing
        speed = 1.0
        # Blend from facing the ball to facing the goal target as we close in
        desired_spin_err = to_target_local if abs(ball_bearing) < 0.35 else ball_bearing
        kick = (ball_dist < 240.0) and abs(to_target_local) < 0.35
    elif along > -25.0:
        # Wrong side of ball: sweep smoothly around the flank we are already closer to
        log(me, "SWEEP_FLANK", ball_dist)
        flank_side = 1.0 if lateral >= 0 else -1.0
        flank_angle = push_field + math.pi - flank_side * clamp(abs(lateral) / 140.0 + 0.6, 0.7, 1.3)
        flank_radius = 210.0
        waypoint_x = clamp(bx + math.cos(flank_angle) * flank_radius, -WALL_X + 130.0, WALL_X - 130.0)
        waypoint_z = clamp(bz + math.sin(flank_angle) * flank_radius, -WALL_Z + 130.0, WALL_Z - 130.0)
        bearing = wrap_angle(math.atan2(waypoint_z - est_z, waypoint_x - est_x) - heading)
        speed = 1.0
        # Keep front facing the ball during flank maneuvers!
        desired_spin_err = ball_bearing
        kick = False
    else:
        # Approaching into the pocket behind the ball
        log(me, "CONVERGE_POCKET", dist_to_pocket)
        bearing = wrap_angle(math.atan2(to_pocket_z, to_pocket_x) - heading)
        speed = clamp(dist_to_pocket / 160.0, 0.55, 1.0)
        # Face the ball while converging, blending to goal aim only in close pocket
        desired_spin_err = to_target_local if (dist_to_pocket < 65.0 and abs(ball_bearing) < 0.4) else ball_bearing
        kick = False

    # Never turn your back to the ball when the ball is nearby
    if abs(ball_bearing) > 0.8:
        desired_spin_err = ball_bearing

    # 10. Anti-Scrum Stall Detection and Breakout Maneuver
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
        and dist_moved < 16.0
        and me.get("last_speed", 0.0) > 0.6
    )

    stall_ticks = me.get("stall_ticks", 0)
    if is_stalled:
        stall_ticks += 1
    else:
        stall_ticks = max(0, stall_ticks - 1)
    me.stall_ticks = stall_ticks

    spin = spin_to(desired_spin_err, me)

    if stall_ticks >= 6:
        # Physical scrum detected: apply lateral jink and roll torque to break contact
        log(me, "SCRUM_BREAKOUT")
        scrum_id = me.get("scrum_id", 0)
        scrum_side = 1.0 if (scrum_id % 2 == 0) else -1.0
        bearing = wrap_angle(bearing + scrum_side * 1.35)
        speed = 1.0
        spin = scrum_side * 1.0
        if stall_ticks > 18:
            me.scrum_id = scrum_id + 1
            me.stall_ticks = 0

    me.last_speed = speed

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
    """Return ground-truth compass heading."""
    return s.compass.heading


def spin_to(error: float, me) -> float:
    """High-torque agile PD heading controller with gyro damping."""
    SPIN_KP = 3.5
    SPIN_KD = 0.15
    yaw_rate = me.get("yaw_rate", 0.0)
    return clamp(error * SPIN_KP - yaw_rate * SPIN_KD, -1.0, 1.0)


def update_yaw_rate(s, me) -> None:
    """Compute yaw rate from clean compass heading."""
    dt = max(1e-3, s.clock - me.get("last_clock", s.clock))
    me.last_clock = s.clock
    last_h = me.get("last_heading", s.compass.heading)
    yaw_rate = wrap_angle(s.compass.heading - last_h) / dt
    me.last_heading = s.compass.heading
    me.yaw_rate = yaw_rate


def locate(s, heading: float) -> tuple[float, float, float]:
    """Estimate field coordinates (x, z) using 360-degree dual-goal visual triangulation & sonar."""
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

    x = clamp(sol_x[0] if sol_x else 0.0, -HALF_LENGTH, HALF_LENGTH)
    z = clamp(sol_z[0] if sol_z else 0.0, -HALF_WIDTH, HALF_WIDTH)
    return x, z, 0.8


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
    """Track ball observations from 360 camera and 24-sensor IR seeker."""
    measured_field = None
    measured_range = None

    cam_ball = getattr(getattr(s, "camera", None), "ball", None)
    if cam_ball is not None:
        measured_field = wrap_angle(heading + cam_ball.bearing)
        measured_range = cam_ball.range
    elif s.ball is not None:
        measured_field = wrap_angle(heading + s.ball.bearing)
        measured_range = 200.0 / math.sqrt(max(s.ball.strength, 1e-4))

    if measured_field is not None and measured_range is not None:
        if me.get("field_bearing") is None:
            me.field_bearing = measured_field
            me.range = measured_range
        else:
            dt = max(1e-3, s.clock - me.get("last_ball_clock", s.clock))
            me.last_ball_clock = s.clock
            k_bearing = 1.0 - math.exp(-dt / 0.03)
            k_range = 1.0 - math.exp(-dt / 0.04)
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
