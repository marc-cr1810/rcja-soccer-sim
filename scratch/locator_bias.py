"""Is the python position fix biased along x?

Feed it ideal frames for a robot at a known place and at the 180-degree
rotation of that place, and compare the errors. Ideal sensors mean the camera
is exact and the sonars are exact, so the only thing between the readings and
the answer is Locator's own arithmetic - and a fix that is right at one end of
the field and wrong at the other is a direction bias that everything
downstream inherits.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

from rcja_soccer.robot import Reading  # noqa: E402
from rcja_soccer.sense import Locator  # noqa: E402

frames = json.load(open(os.path.join(HERE, "locframes.json")))

print(f"{'true (x, z, heading)':>28} {'fix x':>9} {'fix z':>9} {'err x':>8} {'err z':>8}")
worst = 0.0
errors: list[tuple[float, float]] = []
for f in frames:
    reading = Reading(f["frame"])
    loc = Locator("cyan")
    x = z = 0.0
    for _ in range(3):  # a few ticks, the way a real one runs
        x, z = loc.update(reading, reading.compass.heading)
    ex, ez = x - f["x"], z - f["z"]
    errors.append((ex, ez))
    worst = max(worst, abs(ex), abs(ez))
    print(
        f"({f['x']:+8.1f},{f['z']:+7.1f},{f['heading']:+6.2f}) "
        f"{x:>9.1f} {z:>9.1f} {ex:>8.1f} {ez:>8.1f}"
    )

print(f"\nworst |error| {worst:.1f} mm")
print("\n-- rotated pairs: the error should itself rotate, so ex(B) = -ex(A) --")
for i in range(0, len(errors), 2):
    a, b = errors[i], errors[i + 1]
    print(
        f"  pair {i // 2}: err A ({a[0]:+7.1f},{a[1]:+7.1f})   err B ({b[0]:+7.1f},{b[1]:+7.1f})"
        f"   sum x {a[0] + b[0]:+7.1f}"
        + ("   <-- NOT rotation-symmetric" if abs(a[0] + b[0]) > 0.5 else "")
    )
