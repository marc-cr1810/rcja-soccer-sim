"""Push one robot's folder to a venue server.

    python submit.py --dir myteam/striker

Reads manifest.json from the folder to learn the team name and robot number,
sends every .py file plus the manifest as one push, and prints what the
server said. A team runs this once per robot — typically once per laptop,
since the two robots on a side are routinely written by two different
students who should not have to merge their code together first.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=".", help="the robot's folder (with manifest.json in it)")
    parser.add_argument("--url", default="http://localhost:8080/submit")
    parser.add_argument(
        "--key",
        help=(
            "your team's push key, from /team/settings on a league server. "
            "A match server on a laptop needs none."
        ),
    )
    args = parser.parse_args()

    folder = Path(args.dir)
    manifest_path = folder / "manifest.json"
    if not manifest_path.is_file():
        print(f"no manifest.json in {folder}", file=sys.stderr)
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text())
    team = manifest.get("team", "?")
    robot = manifest.get("robot", "?")

    files: dict[str, str] = {}
    for path in sorted(folder.iterdir()):
        if path.is_dir():
            continue
        if path.suffix != ".py" and path.name != "manifest.json":
            continue
        files[path.name] = base64.b64encode(path.read_bytes()).decode("ascii")

    print(
        f"pushing {team} robot {robot} to {args.url}: {', '.join(sorted(files))}",
        file=sys.stderr,
    )

    body = json.dumps({"files": files}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    # The key says which team this push is. A league server holds the manifest to
    # it and refuses a push that names somebody else - the team comes from the
    # credential, never from the file, which is the same rule the join has always
    # been held to. A match server on a laptop has no accounts and wants no key.
    if args.key:
        headers["Authorization"] = f"Bearer {args.key}"
    request = urllib.request.Request(args.url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(request) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as error:
        result = json.loads(error.read())
    except urllib.error.URLError as error:
        print(f"could not reach {args.url}: {error.reason}", file=sys.stderr)
        sys.exit(1)

    if result.get("ok"):
        print(f"accepted: {result['team']} robot {result['robot']}", file=sys.stderr)
        if result.get("token"):
            print(f"token: {result['token']}", file=sys.stderr)
            print("keep this - it's what lets a program join as this robot", file=sys.stderr)
        # Said last so it is the line still on the screen: a league server adds
        # this when the team's own next match has already locked its lineup, or is
        # at half-time and can still take this in. "accepted" on its own would be
        # read as "in the game about to start", which in both cases it is not.
        if result.get("notice"):
            print(result["notice"], file=sys.stderr)
    else:
        print(f"rejected: {result.get('reason', 'unknown reason')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
