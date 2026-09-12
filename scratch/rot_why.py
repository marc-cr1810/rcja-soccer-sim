"""Which intermediate quantity diverges, for one case."""
import importlib, json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python")); sys.path.insert(0, os.path.join(ROOT, "python", "examples"))
from rcja_soccer.robot import Memory, Reading

TAG = sys.argv[1] if len(sys.argv) > 1 else "open"
load = lambda t: json.load(open(os.path.join(HERE, "rotframes", t + ".json")))

def run(frames):
    sys.argv = ["x", "--team", "cyan", "--number", "1"]
    sys.modules.pop("striker", None)
    mod = importlib.import_module("striker")
    rec = []
    real_drive = mod.drive
    real_aim = mod.choose_aim
    cur = {}
    def drive(bearing=0.0, speed=1.0, spin=0.0):
        cur["drive"] = (bearing, speed, spin)
        return real_drive(bearing, speed, spin)
    def choose_aim(bx, bz, me_z, frame):
        out = real_aim(bx, bz, me_z, frame)
        cur["aim"] = out
        cur["me_z"] = me_z
        return out
    mod.drive = drive
    mod.choose_aim = choose_aim
    me = Memory()
    for raw in frames:
        cur.clear()
        cmd = mod.think(Reading(raw), me)
        rec.append((cmd, dict(cur)))
    return rec

a = run(load(TAG)); b = run(load("r_" + TAG))
print(f"{'i':>3} {'dmot':>7} | {'A aim':>18} {'A bearing/spin':>18} me_z | {'B aim (negated)':>18} {'B bearing-pi/spin':>18} me_z")
for i, (ca, cb) in enumerate(zip(a, b)):
    d = max(abs(x - y) for x, y in zip(ca[0]["motors"], cb[0]["motors"]))
    if d < 1e-9 and i > 4:
        continue
    A, B = ca[1], cb[1]
    def f(v, neg=False):
        if v is None: return " " * 18
        return f"({-v[0] if neg else v[0]:8.1f},{-v[1] if neg else v[1]:7.1f})"
    wrap = lambda x: math.atan2(math.sin(x), math.cos(x))
    da, db = A.get("drive"), B.get("drive")
    print(f"{i:>3} {d:>7.4f} | {f(A.get('aim')):>18} "
          f"{'' if not da else f'({da[0]:+.3f},{da[2]:+.3f})':>18} {A.get('me_z', float('nan')):+.2e} | "
          f"{f(B.get('aim'), True):>18} "
          f"{'' if not db else f'({wrap(db[0]):+.3f},{db[2]:+.3f})':>18} {B.get('me_z', float('nan')):+.2e}")
    if i > 14: break
