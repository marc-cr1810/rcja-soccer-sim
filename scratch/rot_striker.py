"""Run the real striker over rotated frame pairs and compare its commands.

Under a 180-degree rotation of the world the robot frame is carried along, so a
correct controller emits THE SAME motor powers, the same dribbler and the same
kicker. Any difference is a direction bias in the strategy code.
"""
from __future__ import annotations

import importlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
sys.path.insert(0, os.path.join(ROOT, "python", "examples"))

from rcja_soccer.robot import Memory, Reading  # noqa: E402

FRAMES = os.path.join(HERE, "rotframes")
WHICH = sys.argv[1] if len(sys.argv) > 1 else "striker"


def load(tag):
    with open(os.path.join(FRAMES, tag + ".json")) as fh:
        return json.load(fh)


def run(module_name, team, frames):
    """Fresh module state per run: the trackers are module globals."""
    sys.argv = ["x", "--team", team, "--number", "1"]
    for name in list(sys.modules):
        if name == module_name:
            del sys.modules[name]
    mod = importlib.import_module(module_name)
    me = Memory()
    out = []
    for raw in frames:
        if raw.get("kickoff", {}).get("pending") and "restarted" in me:
            me.clear()
        cmd = mod.think(Reading(raw), me)
        out.append(cmd)
    return out, mod


def main():
    tags = sorted(f[:-5] for f in os.listdir(FRAMES) if f.endswith(".json") and not f.startswith("r_"))
    print(f"{'case':<8} {'worst |dmotor|':>15} {'dribbler':>9} {'kicker':>7}   verdict")
    worst_overall = 0.0
    n_bad = 0
    for tag in tags:
        a_frames = load(tag)
        b_frames = load("r_" + tag)
        a, mod_a = run(WHICH, "cyan", a_frames)
        b, mod_b = run(WHICH, "cyan", b_frames)

        worst = 0.0
        drib = 0.0
        kick_diff = 0
        for ca, cb in zip(a, b):
            ma = ca.get("motors", [0, 0, 0, 0])
            mb = cb.get("motors", [0, 0, 0, 0])
            for x, y in zip(ma, mb):
                worst = max(worst, abs(x - y))
            drib = max(drib, abs(ca.get("dribbler", 0.0) - cb.get("dribbler", 0.0)))
            if bool(ca.get("kicker")) != bool(cb.get("kicker")):
                kick_diff += 1
        worst_overall = max(worst_overall, worst)
        bad = worst >= 1e-6 or drib >= 1e-6 or kick_diff != 0
        if bad:
            fa, fb = mod_a.frame, mod_b.frame
            print(f"{tag:<8} {worst:>15.6f} {drib:>9.3f} {kick_diff:>7d}   ASYMMETRIC  <--")
            print(
                f"         frame A up=({fa.up_x:+.3f},{fa.up_z:+.3f}) my=({fa.my_x:+.0f},{fa.my_z:+.0f}) their={fa.their_colour}"
                f"   |   B up=({fb.up_x:+.3f},{fb.up_z:+.3f}) my=({fb.my_x:+.0f},{fb.my_z:+.0f}) their={fb.their_colour}"
            )
            n_bad += 1
    print(f"\n{len(tags)} cases, {n_bad} asymmetric.  worst motor difference {worst_overall:.6f}")


if __name__ == "__main__":
    main()
