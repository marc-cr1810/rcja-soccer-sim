import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path("python").resolve()))
sys.path.insert(0, str(Path("python/rcja_soccer").resolve()))

from rcja_soccer.robot import Reading
from rcja_soccer.frame import GoalFrame


def frame_for(team, x, z, heading, ball_x, ball_z):
    """Hand-built ideal frame for a robot standing on the goal axis."""
    def sighting(gx, gz):
        dx, dz = gx - x, gz - z
        bearing = 0.0
        # bearing relative to heading
        fwd = heading
        import math
        want = math.atan2(dz, dx)
        rel = (want - fwd) % (2 * math.pi)
        if rel > math.pi:
            rel -= 2 * math.pi
        return {"bearing": rel, "range": (dx * dx + dz * dz) ** 0.5}

    return Reading({
        "clock": 0.1,
        "robot": 1,
        "team": team,
        "attackDirection": 1 if team == "cyan" else -1,
        "playing": True,
        "kickoff": {"pending": True, "ours": False},
        "compass": {"heading": heading},
        "camera": {
            "goals": {
                "cyan": sighting(-915.0, 0.0),
                "yellow": sighting(915.0, 0.0),
            },
            "fresh": True,
        },
        "lines": [], "range": {"front": None, "left": None, "back": None, "right": None},
        "encoders": [0, 0, 0, 0],
        "ball": {"bearing": 0.0, "strength": 0.0},
    })


for label, team, x, heading in (("cyan def -x", "cyan", -700.0, 0.0),
                                ("yellow def +x", "yellow", 700.0, 3.14159)):
    f = GoalFrame(team)
    f.update(frame_for(team, x, heading, 0.1, -100.0, 0.0), heading, x, 0.0)
    ball = frame_for(team, x, heading, 0.1, -100.0, 0.0)
    bx, bz = -100.0, 0.0
    print(f"{label:16s} up=({f.up_x:.3f},{f.up_z:.3f}) up_angle={f.up_angle():.2f} "
          f"my=({f.my_x:.0f},{f.my_z:.0f}) their=({f.their_x:.0f}) depth(ball)={f.depth(bx,bz):.0f}")