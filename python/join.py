"""Run your robot on a practice field at a league server.

    python3 join.py --token <token> --url ws://venue:8080/a/<id>/agent my_robot.py

The team's field says which seat you are joining and prints the command to
copy, token and all. This runs the file you wrote, unchanged, with that token
and that address filled in — so the file you push is the file you tested,
character for character, which is the whole reason this is a launcher rather
than two lines you paste into your program.

A match server on a laptop needs none of this. Run your robot the way you
always have; a seat there asks for no token because there is nobody to be.

The token is for one seat and is short-lived. If it stops working, set the
seat to "my laptop" again on the field and copy the new command.
"""

from __future__ import annotations

import argparse
import runpy
import sys
from pathlib import Path

import rcja_soccer

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("program", help="your robot's .py file")
parser.add_argument(
    "--token",
    required=True,
    help="minted for one seat on the field, from the practice console",
)
parser.add_argument(
    "--url",
    required=True,
    help="the field's agent address, e.g. ws://venue:8080/a/<id>/agent",
)
parser.add_argument(
    "args",
    nargs=argparse.REMAINDER,
    help="anything after the program file is passed to it unchanged",
)
args = parser.parse_args()

program = Path(args.program)
if not program.is_file():
    print(f"no such file: {program}", file=sys.stderr)
    sys.exit(1)

# Installed rather than passed: the point is that the program is not edited,
# and a program that names its own token or url still wins. See
# rcja_soccer.transport.use_join.
rcja_soccer.use_join(token=args.token, url=args.url)

# The program sees itself as the thing that was run — its own name in argv[0],
# its own arguments after it, and `__name__ == "__main__"` so the `robot.run()`
# at the bottom of every starter file actually happens.
sys.argv = [str(program), *args.args]
try:
    runpy.run_path(str(program), run_name="__main__")
except KeyboardInterrupt:
    pass
