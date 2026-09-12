import json

rows = [json.loads(l) for l in open('scratch/trace.jsonl')]

by_seed = {}
for r in rows:
    by_seed.setdefault(r['seed'], []).append(r)

def side_of(seed, half, scorer):
    # h1: cyan attacks +x, yellow attacks -x. h2 reversed.
    if half == 1:
        return '+x' if scorer == 'cyan' else '-x'
    return '+x' if scorer == 'yellow' else '-x'

tot = {'+x': 0, '-x': 0}
goal_list = []
for seed, rs in sorted(by_seed.items()):
    rs.sort(key=lambda r: r['clock'])
    for half in (1, 2):
        hr = [r for r in rs if r['half'] == half]
        prev = {'cyan': 0, 'yellow': 0}
        for r in hr:
            sc = r['score']
            for team in ('cyan', 'yellow'):
                if sc[team] > prev[team]:
                    side = side_of(seed, half, team)
                    tot[side] += 1
                    goal_list.append((seed, half, team, side, r['clock']))
            prev = sc

print('goals by end:', tot)

def show_around(seed, half, t):
    hrs = sorted([r for r in by_seed[seed] if r['half'] == half], key=lambda r: r['clock'])
    t0 = max(0, t - 50)
    t1 = min(t + 25, hrs[-1]['clock'])
    pre = next((r for r in hrs if r['clock'] == t0), None)
    post = next((r for r in hrs if r['clock'] == t1), None)
    if not pre:
        return
    rob = {x['id']: x for x in pre['robots']}
    print(f"  t0={t0} ball=({pre['ball']['x']:.0f},{pre['ball']['z']:.0f})")
    for pid in ('cyan-2', 'yellow-2'):
        p = rob[pid]
        print(f"    {pid}: x={p['x']:6.0f} z={p['z']:6.0f} h={p['h']:5.1f}")
    if post:
        print(f"  t1={t1} ball=({post['ball']['x']:.0f},{post['ball']['z']:.0f}) score={post['score']}")

for seed, half, team, side, t in goal_list:
    print(f"seed {seed} h{half} goal by {team} @ {side} (t={t})")
    show_around(seed, half, t)

# Also: keeper position stats per half: how much time each keeper spends where.
print('\nkeeper positional heat (fraction of half at x sign, mean across seeds):')
kid = {'h1': ('cyan-2', 'yellow-2'), 'h2': ('cyan-2', 'yellow-2')}
for half in (1, 2):
    keepers = ('cyan-2', 'yellow-2') if half == 1 else ('yellow-2', 'cyan-2')
    # keeper of the team that defends +x in this half, and -x
    defender_plus = 'yellow-2' if half == 1 else 'cyan-2'
    defender_minus = 'cyan-2' if half == 1 else 'yellow-2'
    for label, kp in (('defends +x', defender_plus), ('defends -x', defender_minus)):
        xs = []
        for seed, rs in sorted(by_seed.items()):
            for r in rs:
                if r['half'] != half:
                    continue
                p = next(x for x in r['robots'] if x['id'] == kp)
                xs.append(p['x'])
        import statistics
        print(f"  h{half} {label}: mean x={statistics.mean(xs):.0f} min={min(xs):.0f} max={max(xs):.0f}")

# Mean |z| when keeper defending +x vs -x (how far off line they drift)
print('\nkeeper |z| (drift off line):')
def keeper_drift(kp, half):
    zs = []
    for seed, rs in sorted(by_seed.items()):
        for r in rs:
            if r['half'] != half:
                continue
            p = next(x for x in r['robots'] if x['id'] == kp)
            zs.append(abs(p['z']))
    return sum(zs) / len(zs)
for half in (1, 2):
    print(f"  h{half} defends +x: |z|={keeper_drift('yellow-2' if half==1 else 'cyan-2', half):.0f}"
          f"  defends -x: |z|={keeper_drift('cyan-2' if half==1 else 'yellow-2', half):.0f}")