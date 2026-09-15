"""What one arena actually costs, measured rather than reasoned.

The seed for `capacity --measure` (PHASES.md Phase 7). Samples /proc CPU and
RSS for a practice field's own Node process and each of its sandboxed robots,
and checks realtime fidelity by comparing the simulated clock against the wall.

    bun run serve -- practice --port 8099 &
    # fill all four seats, e.g.
    for s in violet-1 violet-2 lime-1 lime-2; do
      curl -s -X POST localhost:8099/practice-api/seat \
        -H 'content-type: application/json' \
        -d "{\"seat\":\"$s\",\"fill\":\"submission\",\"team\":\"rehearsal\"}"
    done
    curl -s -X POST localhost:8099/practice-api/start
    python3 scratch/measure-arena.py "four real robots" 30

Measured 15 Sep 2026 on an Ultra 7 155H (22 logical CPUs, 31 GB): an arena of
four real robots costs 0.17 cores and 176 MB against a granted 2 cores and
2 GB, at 100% realtime fidelity. A robot written to spend its grant gets
exactly 50.0% of a core, so the grant is real and the headroom is about 12x.

Note: a submission needs BOTH 1/ and 2/ folders, or the robot-2 seats sit
filled-but-unconnected and the measurement quietly halves.
"""

import os, sys, time, subprocess, json, urllib.request

HZ=os.sysconf('SC_CLK_TCK'); PAGE=os.sysconf('SC_PAGE_SIZE')
def comm(p):
    try: return open(f'/proc/{p}/comm').read().strip()
    except: return ''
def find():
    out=subprocess.run(['ps','-eo','pid,args'],capture_output=True,text=True).stdout
    node=None; pys=[]
    for line in out.splitlines():
        pid,_,a=line.strip().partition(' ')
        if not pid.isdigit(): continue
        pid=int(pid); c=comm(pid)
        if c=='node' and 'cli.ts practice --port 8099' in a and '--require' in a: node=pid
        if c=='python3' and 'robot.py' in a and '/submissions/' in a: pys.append(pid)
    return node,sorted(pys)
def stat(p):
    s=open(f'/proc/{p}/stat').read(); f=s[s.rindex(')')+2:].split()
    return int(f[11])+int(f[12]), int(f[21])*PAGE
def clock():
    with urllib.request.urlopen('http://localhost:8099/practice-api/state',timeout=5) as r:
        return json.load(r)['state']['clock']

def run(label, dur):
    node,pys=find()
    tgts=[('arena-node',node)]+[(f'robot{i+1}',p) for i,p in enumerate(pys)]
    base={n:stat(p) for n,p in tgts}
    c0=clock(); t0=time.time()
    time.sleep(dur)
    c1=clock(); el=time.time()-t0
    print(f'\n--- {label} ---')
    print(f'{"process":12}{"CPU % of a core":>17}{"RSS MB":>10}')
    tc=tr=0
    for n,p in tgts:
        try: cc,rr=stat(p)
        except: print(f'{n:12}   (died)'); continue
        pct=(cc-base[n][0])/HZ/el*100; rss=rr/1048576; tc+=pct; tr+=rss
        print(f'{n:12}{pct:16.1f}%{rss:9.1f}')
    print(f'{"TOTAL":12}{tc:16.1f}%{tr:9.1f}   = {tc/100:.2f} cores, {tr/1024:.2f} GB')
    sim=c1-c0
    print(f'realtime fidelity: {sim:.1f}s simulated in {el:.1f}s wall = {sim/el*100:.1f}% of real time')
    return tc,tr,sim/el

run(sys.argv[1] if len(sys.argv)>1 else 'sample', int(sys.argv[2]) if len(sys.argv)>2 else 30)
