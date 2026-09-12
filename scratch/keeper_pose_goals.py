import json, collections, math

rows = [json.loads(l) for l in open('scratch/trace4.jsonl')]
seen = set()
uniq = []
for r in rows:
    k = (r['seed'], r['half'], r['clock'])
    if k in seen:
        continue
    seen.add(k)
    uniq.append(r)

by = collections.defaultdict(list)
for r in uniq:
    by[(r['seed'], r['half'])].append(r)

HALF_LENGTH = 765
GUARD_DIST = 175

def keeper_pose(rs, clock, tid):
    best = min(rs, key=lambda r: abs(r['clock'] - clock)) if rs else None
    if best is None:
        return None
    for p in best['robots']:
        if p['id'] == tid:
            return p['x'], p['z'], p['h']
    return None

def defend_side(team, half):
    if half == 1:
        return '-x' if team == 'cyan' else '+x'
    return '+x' if team == 'cyan' else '-x'

stats = {'+x': [], '-x': []}
for (seed, half), rs in sorted(by.items()):
    rs = sorted(rs, key=lambda r: r['clock'])
    prev = {'cyan': 0, 'yellow': 0}
    for r in rs:
        for t in ('cyan', 'yellow'):
            if r['score'][t] > prev[t]:
                conceded = 'yellow' if t == 'cyan' else 'cyan'
                keeper = f"{conceded}-2"
                side = defend_side(conceded, half)
                guard_x = (HALF_LENGTH - GUARD_DIST if side == '+x' else -HALF_LENGTH + GUARD_DIST)
                p = keeper_pose(rs, r['clock'] - 25, keeper)
                if p is None:
                    continue
                off = math.hypot(p[0] - guard_x, p[1])
                stats[side].append(off)
                print(f"s{seed} h{half} {t} scored into {side}({conceded} conceded) at c={r['clock']} keeper={keeper} ({p[0]:.0f},{p[1]:.0f},{p[2]:.2f}) off_guard={off:.0f}mm guard_x={guard_x:.0f}")
        prev = dict(r['score'])

print("\n(conceding keeper pose 0.5s before goal)")
for side in ('+x', '-x'):
    v = stats[side]
    print(f"{side} end conceded: n={len(v)} mean_off={sum(v)/len(v):.0f}mm max={max(v):.0f}mm" if v else f"{side} end: none")