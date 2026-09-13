"""Run a whole match: both teams, four robots, the same code on each side.

    python play.py

Starts four programs — a striker and a keeper for each team — and points them
all at a match server. Both sides run the identical code, so whatever happens
is the robots, not the matchup.

    python play.py --only violet

Starts one side, which is what a bench run wants: the other two robots are the
opponent the bench is measuring you against, and it supplies them itself.

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
parser.add_argument("--violet", default="ACT-01", help="name for the violet team")
parser.add_argument("--lime", default="QLD-04", help="name for the lime team")
parser.add_argument("--debug", action="store_true", help="stream live robot decision telemetry")
parser.add_argument(
    "--only",
    choices=["violet", "lime"],
    default=None,
    help="start one side only, which is what a bench run of that side wants",
)
args = parser.parse_args()

#: Both sides, same two programs. Robot 1 attacks, robot 2 keeps goal - which
#: is a choice, not a rule: 5.8 only says a team may nominate one goalie.
LINE_UP = [
    ("striker.py", "violet", 1, args.violet),
    ("goalie.py", "violet", 2, args.violet),
    ("striker.py", "lime", 1, args.lime),
    ("goalie.py", "lime", 2, args.lime),
]

if args.only:
    LINE_UP = [entry for entry in LINE_UP if entry[1] == args.only]

processes: list[subprocess.Popen] = []


def stop(*_):
    for process in processes:
        if process.poll() is None:
            process.terminate()
    sys.exit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)

import os

env = dict(os.environ)
parent_str = str(HERE.parent)
env["PYTHONPATH"] = parent_str + (os.pathsep + env["PYTHONPATH"] if "PYTHONPATH" in env else "")

for script, team, number, name in LINE_UP:
    command = [
        sys.executable,
        str(HERE / script),
        "--team", team,
        "--number", str(number),
        "--name", name,
        "--url", args.url,
    ]
    if args.debug:
        command.append("--debug")
    processes.append(subprocess.Popen(command, env=env))
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
