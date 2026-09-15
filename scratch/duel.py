"""Play one version of the robots against another.

The standing benchmark. Run it with no arguments beyond the url and it plays the
working tree against the **champion** - the best version measured so far, pinned
by commit in `scratch/champion`:

    bun run bench -- --team both --seeds 1-25 \\
      --spawn "python3 scratch/duel.py --url {url}"

The scoreline the bench prints is then working tree (left) against champion
(right), and `--team both` is what hands all four seats to external programs.

**Why a frozen champion rather than the reference agent, or the previous
version.** Beating the reference stopped meaning anything once these robots
were beating it 19-0: a team that cannot score cannot exercise anything
defensive, so no coordination change is visible against it at all. It stays
useful as a *fixed yardstick for defects* - giveaways, illegal kick-offs,
rule 5.11 calls - and that is now the only job it has.

And duelling the previous version is a random walk: v1 against v0, v2 against
v1, v3 against v2, each step judged against a different opponent, so three small
wins in a row can still be a net loss and nothing would ever say so. A frozen
champion is fixed like the reference and strong like a real opponent. When a
version beats it, commit that version and promote it - put its sha in
`scratch/champion` - and every later version is measured against the new bar.

A source tree is a `python/` directory: `examples/striker.py`,
`examples/goalie.py` and the `rcja_soccer` package beside them. Each side
imports its *own* library, not a shared one - `striker.py` puts its own parent
on `sys.path` at position 0, so a robot launched out of an old tree gets the old
`sense.py` with it. That is the whole point: a change to the library is as much
a change to the robot as a change to the example.

`--violet-ref`/`--lime-ref` take any git ref and unpack its `python/` tree to a
temporary directory, so comparing against history needs no snapshot kept by
hand. `--violet-src`/`--lime-src` take a directory instead, for a tree that is
not committed.
"""

from __future__ import annotations

import argparse
import atexit
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).parent
CHAMPION_FILE = HERE / "champion"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--violet-src", default=None, help="python/ tree for the violet side")
parser.add_argument("--lime-src", default=None, help="python/ tree for the lime side")
parser.add_argument("--violet-ref", default=None, help="git ref to play on violet")
parser.add_argument("--lime-ref", default=None, help="git ref to play on lime")
parser.add_argument("--violet", default=None, help="team name for the violet side")
parser.add_argument("--lime", default=None, help="team name for the lime side")
parser.add_argument("--debug", action="store_true")
args = parser.parse_args()

_temporary: list[Path] = []


@atexit.register
def _clean_up() -> None:
    for path in _temporary:
        shutil.rmtree(path, ignore_errors=True)


def resolve_ref(ref: str) -> str:
    """Turn a ref into a commit, reading `scratch/champion` for `champion`."""
    if ref != "champion":
        return ref
    if not CHAMPION_FILE.exists():
        sys.exit(f"no champion pinned: write a commit into {CHAMPION_FILE}")
    for line in CHAMPION_FILE.read_text().splitlines():
        line = line.split("#")[0].strip()
        if line:
            return line
    sys.exit(f"{CHAMPION_FILE} names no commit")


def materialise(ref: str) -> Path:
    """Unpack a commit's `python/` tree somewhere temporary, and return it.

    From git rather than from a directory copied by hand, so a comparison made
    today can be made again in six months and mean the same thing.
    """
    commit = resolve_ref(ref)
    try:
        archive = subprocess.run(
            ["git", "archive", commit, "python/"], stdout=subprocess.PIPE, check=True
        )
    except subprocess.CalledProcessError:
        sys.exit(f"no such commit: {commit}")
    out = Path(tempfile.mkdtemp(prefix="duel-"))
    _temporary.append(out)
    subprocess.run(["tar", "-x", "-C", str(out)], input=archive.stdout, check=True)
    return out / "python"


def source_for(side: str, src: str | None, ref: str | None) -> tuple[Path, str]:
    if src and ref:
        sys.exit(f"give --{side}-src or --{side}-ref, not both")
    if ref:
        return materialise(ref), ref
    return Path(src or "python").resolve(), "working tree"


# The default is the standing benchmark: what is written now, against the bar.
violet_path, violet_label = source_for("violet", args.violet_src, args.violet_ref)
lime_path, lime_label = source_for(
    "lime", args.lime_src, args.lime_ref if (args.lime_src or args.lime_ref) else "champion"
)

SIDES = [
    (violet_path, "violet", args.violet or violet_label[:12]),
    (lime_path, "lime", args.lime or lime_label[:12]),
]

for source, _, _ in SIDES:
    for script in ("examples/striker.py", "examples/goalie.py"):
        if not (source / script).exists():
            sys.exit(f"{source / script} does not exist - is {source} a python/ tree?")

processes: list[subprocess.Popen] = []


def stop(*_):
    for process in processes:
        if process.poll() is None:
            process.terminate()
    sys.exit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)

for source, team, name in SIDES:
    # Each side's own tree goes on PYTHONPATH as well as the `sys.path.insert`
    # the examples do for themselves, so a tree laid out any other way still
    # finds its own library rather than falling through to the repository's.
    env = dict(os.environ)
    env["PYTHONPATH"] = str(source) + (
        os.pathsep + env["PYTHONPATH"] if "PYTHONPATH" in env else ""
    )
    for script, number in (("examples/striker.py", 1), ("examples/goalie.py", 2)):
        command = [
            sys.executable,
            str(source / script),
            "--team", team,
            "--number", str(number),
            "--name", name,
            "--url", args.url,
        ]
        if args.debug:
            command.append("--debug")
        processes.append(subprocess.Popen(command, env=env))
        print(f"{team}-{number}: {source / script}", file=sys.stderr)
        # A moment apart, so four connections do not race for the same seat.
        time.sleep(0.2)

print(f"\nviolet = {violet_label}   lime = {lime_label}", file=sys.stderr)

try:
    while True:
        for process in processes:
            if process.poll() is not None:
                print(f"a robot exited with {process.returncode}", file=sys.stderr)
                stop()
        time.sleep(0.5)
except KeyboardInterrupt:
    stop()
