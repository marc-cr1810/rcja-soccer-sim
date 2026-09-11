"""Run a whole match: both teams, four robots, the same code on each side.

    python play.py

Starts four programs — a striker and a keeper for each team — and points them
all at a match server. Both sides run the identical code, so whatever happens
is the robots, not the matchup.

Start the server first, in another terminal:

    npm run build:viewer
    npm run serve -- --agents

Then open http://localhost:8080 and watch.
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--cyan", default="ACT-01", help="name for the cyan team")
parser.add_argument("--yellow", default="QLD-04", help="name for the yellow team")
args = parser.parse_args()

#: Both sides, same two programs. Robot 1 attacks, robot 2 keeps goal - which
#: is a choice, not a rule: 5.8 only says a team may nominate one goalie.
LINE_UP = [
    ("striker.py", "cyan", 1, args.cyan),
    ("goalie.py", "cyan", 2, args.cyan),
    ("striker.py", "yellow", 1, args.yellow),
    ("goalie.py", "yellow", 2, args.yellow),
]

processes: list[subprocess.Popen] = []


def stop(*_):
    for process in processes:
        if process.poll() is None:
            process.terminate()
    sys.exit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)

for script, team, number, name in LINE_UP:
    command = [
        sys.executable,
        str(HERE / script),
        "--team", team,
        "--number", str(number),
        "--name", name,
        "--url", args.url,
    ]
    processes.append(subprocess.Popen(command))
    print(f"started {script} as {team}-{number} ({name})", file=sys.stderr)
    # A moment apart, so four connections do not race for the same seat and so
    # the log is readable when one of them fails.
    time.sleep(0.2)

print(f"\n{len(processes)} robots connected to {args.url}", file=sys.stderr)
print("ctrl-c to stop them all\n", file=sys.stderr)

try:
    while True:
        for process in processes:
            if process.poll() is not None:
                print(f"a robot exited with {process.returncode}", file=sys.stderr)
                stop()
        time.sleep(0.5)
except KeyboardInterrupt:
    stop()
