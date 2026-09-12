"""Check python's Locator and BallTracker for a +x directional bias.

Feeds ideal sensor frames (mirrored pairs) through the python perception and
compares the estimates: a mirror-symmetric perception should estimate
+-symmetric positions.
"""
import json
import math
import os
import sys

sys.path.insert(0, str(os.path.join(os.path.dirname(__file__), "..", "python")))

from rcja_soccer.robot import Reading  # noqa: E402
from rcja_soccer.sense import BallTracker, Locator  # noqa: E402

HERE = os.path.join(os.path.dirname(__file__), "frames")


def load(tag: str):
    with open(os.path.join(HERE, tag + ".json")) as fh:
        return Reading(json.load(fh))


def heading(fr):
    return fr.compass.heading


def run_locator(tag):
    fr = load(tag)
    loc = Locator("cyan")
    x, z = loc.update(fr, heading(fr))
    return x, z, loc.confidence


def run_ball(tag, me_x, me_z):
    fr = load(tag)
    bt = BallTracker()
    bt.update(fr, heading(fr), me_x, me_z)
    return bt.x, bt.z, bt.vx, bt.vz


def main():
    tags = sorted(
        f[:-5] for f in os.listdir(HERE) if f.endswith(".json") and not f.startswith("m_")
    )
    print(f"{'pair':<12} {'+x est':>8} {'-x est':>8} {'sym err':>8}  ball sym err")
    failures = 0
    for tag in tags:
        lx, lz, lc = run_locator(tag)
        mlx, mlz, mlc = run_locator("m_" + tag)
        sym_err = mlx - (-lx)  # how far mirrored estimate is from -forward estimate
        bx, bz, bvx, bvz = run_ball(tag, lx, lz)
        mbt = run_ball("m_" + tag, mlx, mlz)
        ball_sym = mbt[0] - (-bx), mbt[1] - bz
        status = "OK" if abs(sym_err) < 1.0 else "MISMATCH  <--"
        if abs(sym_err) >= 1.0:
            failures += 1
        print(
            f"{tag:<12} {lx:>8.1f} {mlx:>8.1f} {sym_err:>8.1f} "
            f"{status}   ball ({ball_sym[0]:+.1f},{ball_sym[1]:+.1f})"
        )
    print(f"\n{len(tags)} pairs, {failures} with x-symmetry error")


if __name__ == "__main__":
    main()