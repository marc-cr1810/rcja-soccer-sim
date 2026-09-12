"""Numerically verify goalie.py's field-frame math is a perfect mirror between
FORWARD=+1 (defending -x) and FORWARD=-1 (defending +x), for the same
mirrored ball state. No simulator, no agents - just the pure functions.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from rcja_soccer.field import HALF_LENGTH, attack_x, defend_x, PENALTY_DEPTH  # noqa: E402


def compute(direction, bx, bz, bvx, bvz):
    ATTACK_X = attack_x(direction)
    DEFEND_X = defend_x(direction)
    FORWARD = 1.0 if ATTACK_X > 0 else -1.0
    GUARD_X = DEFEND_X + FORWARD * 175.0
    DEPTH_FLOOR = DEFEND_X + FORWARD * 120.0

    depth = (bx - DEFEND_X) * FORWARD
    chase_x = DEFEND_X + FORWARD * max(0.0, min(PENALTY_DEPTH, (bx - DEFEND_X) * FORWARD))

    # intercept_z's "closing" branch
    closing = -bvx * FORWARD
    travel = (bx - GUARD_X) * FORWARD / closing if closing > 60 else None

    return {
        "ATTACK_X": ATTACK_X,
        "DEFEND_X": DEFEND_X,
        "FORWARD": FORWARD,
        "GUARD_X": GUARD_X,
        "DEPTH_FLOOR": DEPTH_FLOOR,
        "depth": depth,
        "chase_x": chase_x,
        "closing": closing,
        "travel": travel,
    }


print("Test 1: ball approaching each goal symmetrically")
# direction=+1 (attacks +x, defends -x): ball at x=-400 (between guard line and
# centre), moving toward -x (attacking this keeper's own goal) at vx=-600.
plus = compute(+1.0, bx=-400.0, bz=120.0, bvx=-600.0, bvz=0.0)
# Mirror: direction=-1 (attacks -x, defends +x): ball at x=+400, moving toward
# +x at vx=+600, same bz.
minus = compute(-1.0, bx=400.0, bz=120.0, bvx=600.0, bvz=0.0)

for key in plus:
    pv, mv = plus[key], minus[key]
    if pv is None or mv is None:
        ok = pv is mv
        print(f"  {key:12s}: +1={pv}  -1={mv}  {'OK' if ok else 'MISMATCH'}")
        continue
    mirrored = -mv if key not in ("closing", "travel", "depth") else mv
    # closing/travel/depth are scalar "how far/fast toward own goal" quantities
    # that should come out IDENTICAL (not mirrored) between the two setups,
    # since they're already forward-relative. ATTACK_X/DEFEND_X/GUARD_X/
    # DEPTH_FLOOR are positions and should mirror (sign-flip).
    ok = abs(pv - mirrored) < 1e-9
    print(f"  {key:12s}: +1={pv:10.3f}  -1={mv:10.3f}  {'OK' if ok else 'MISMATCH ' + str(pv - mirrored)}")

print("\nTest 2: off-axis ball, various bz signs and a slow-ball case (span branch)")
for bz in (-300.0, 0.0, 300.0):
    for bx_mag, bvx_mag in ((700.0, 0.0), (300.0, 150.0)):
        plus = compute(+1.0, bx=-bx_mag, bz=bz, bvx=-bvx_mag, bvz=50.0)
        minus = compute(-1.0, bx=bx_mag, bz=bz, bvx=bvx_mag, bvz=50.0)
        mismatches = []
        for key in plus:
            pv, mv = plus[key], minus[key]
            if pv is None or mv is None:
                if pv is not mv:
                    mismatches.append(key)
                continue
            mirrored = -mv if key not in ("closing", "travel", "depth") else mv
            if abs(pv - mirrored) > 1e-6:
                mismatches.append(key)
        status = "OK" if not mismatches else f"MISMATCH in {mismatches}"
        print(f"  bz={bz:6.0f} bx_mag={bx_mag:5.0f} bvx_mag={bvx_mag:5.0f}: {status}")
