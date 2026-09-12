"""Where exactly does the rotated pair diverge, and in which branch."""
import importlib, json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python")); sys.path.insert(0, os.path.join(ROOT, "python", "examples"))
from rcja_soccer.robot import Memory, Reading

TAG = sys.argv[1] if len(sys.argv) > 1 else "open"
def load(t):
    return json.load(open(os.path.join(HERE, "rotframes", t + ".json")))

def run(team, frames):
    sys.argv = ["x", "--team", team, "--number", "1"]
    sys.modules.pop("striker", None)
    mod = importlib.import_module("striker")
    me = Memory(); out = []
    for raw in frames:
        cmd = mod.think(Reading(raw), me)
        out.append((cmd, mod.locator.x, mod.locator.z, mod.ball.x, mod.ball.z, mod.ball.seen, me.get("stall", 0), me.get("breakout", 0)))
    return out, mod

a, ma = run("cyan", load(TAG))
b, mb = run("cyan", load("r_" + TAG))
print(f"{'i':>3} {'dmotor':>8}  {'A pos':>16} {'A ball':>16} seen  {'B pos(-)':>16} {'B ball(-)':>16} seen   stallA/B  boA/bo B")
for i, (ca, cb) in enumerate(zip(a, b)):
    d = max(abs(x - y) for x, y in zip(ca[0]["motors"], cb[0]["motors"]))
    mark = "  <<<" if d > 1e-6 else ""
    if d > 1e-6 or i < 6 or i % 8 == 0:
        print(f"{i:>3} {d:>8.4f}  ({ca[1]:>7.1f},{ca[2]:>6.1f}) ({ca[3]:>7.1f},{ca[4]:>6.1f}) {str(ca[5])[:1]}    "
              f"({-cb[1]:>7.1f},{-cb[2]:>6.1f}) ({-cb[3]:>7.1f},{-cb[4]:>6.1f}) {str(cb[5])[:1]}   "
              f"{ca[6]}/{cb[6]}  {ca[7]}/{cb[7]}{mark}")
