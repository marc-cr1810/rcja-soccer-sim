import json, collections

rows = [json.loads(l) for l in open('scratch/trace_after.jsonl')]
by = collections.defaultdict(list)
for r in rows:
    by[(r['seed'], r['half'])].append(r)

def pose(rs, clock, tid):
    best = None
    for r in rs:
        if best is None or abs(r['clock'] - clock) < abs(best['clock'] - clock):
            best = r
    for p in best['robots']:
        if p['id'] == tid:
            return p
    return None

for (seed, half), rs in sorted(by.items()):
    rs = sorted(rs, key=lambda r: r['clock'])
    prev = {'cyan': 0, 'yellow': 0}
    for r in rs:
        for t in ('cyan', 'yellow'):
            if r['score'][t] > prev[t]:
                kp = 'yellow-2' if t == 'yellow' else 'cyan-2'
                parts = []
                for dc in range(0, 41, 10):
                    p = pose(rs, r['clock'] - dc, kp)
                    if p:
                        parts.append(f"{dc}:[{p['x']:.0f},{p['z']:.0f},{p['h']:.2f}]")
                ball = f"({r['ball']['x']:.0f},{r['ball']['z']:.0f}) v=({r['ball']['vx']:.0f},{r['ball']['vz']:.0f})"
                print(f"s{seed} h{half} {t} concedes,keeper={kp} ball{ball}  keeper " + ' '.join(parts))
        prev = r['score']