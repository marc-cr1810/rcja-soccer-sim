# Writing a robot

This is about the **submission** — the folder you push to a venue server and
the shape it has to be in. For the sensor/actuator API itself — what `s.ball`
means, why bearings are quantised, what `robot.motors(...)` takes — see
[python/README.md](../python/README.md). This page is about packaging that
program so a server can validate it, sandbox it, and load it into a match.

## One folder, one robot

A submission is **one team's one robot** — not a two-robot team folder. The
two robots on a side are routinely written by two different students on two
different laptops, and neither should have to wait on or merge with the
other before they can push. A team with two robots pushes twice.

The folder needs:

```
myrobot/
  manifest.json
  robot.py       # or whatever manifest.json names as the entry point
  helpers.py     # optional — anything the entry point imports locally
```

`manifest.json`:

```json
{ "team": "ACT-01", "robot": 1, "entry": "robot.py" }
```

| field | rule |
|---|---|
| `team` | up to 40 letters, digits, spaces, `-` or `_` — short enough for a scoreboard, safe enough to become a directory name |
| `robot` | `1` or `2` |
| `entry` | a `.py` file in this same folder — no subdirectories in this format |

The entry point can import other `.py` files sitting next to it (a flat
folder only — no nested packages), and anything in the standard library.
Nothing else: no `pip install`, no network, because a venue has neither. See
[running a server](running-a-server.md) for exactly what gets checked and
how.

## The argv convention

There is no separate runner — the entry script itself is what gets executed,
and it has to accept the arguments the server (or you, testing locally) hands
it:

```python
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet", choices=["violet", "lime"])
parser.add_argument("--number", type=int, default=1, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()

from rcja_soccer import Robot

robot = Robot(team=args.team, number=args.number, name=args.name, token=args.token)

@robot.tick
def think(s, me):
    return robot.coast()

robot.run(args.url)
```

`--token` is the one easy to forget. A server loading your submission into a
real match always passes one — proof the connecting program is the one the
platform actually validated for this team's this robot, not just whatever a
socket claims to be — and an entry script whose `argparse` doesn't accept it
will fail the moment it's spawned for a match, even though the push itself
validated cleanly. (Validation does catch this for you: pushing a script with
no `--token` argument fails at push time with a clear reason, precisely so
you find out before match day rather than during it.) Running your own
script by hand, with no `--token` on the command line, is unaffected — it
defaults to `None` and joins exactly as it always has.

`examples/striker.py` and `examples/goalie.py` are the canonical version of
this convention — copy from there.

## Try it before you push it

Nothing about pushing changes how you develop. Run your script straight
against a local server the same way you always have:

```bash
npm run serve -- --agents            # in one terminal
cd python && PYTHONPATH=. python3 myrobot/robot.py --team violet   # in another
```

or use `examples/play.py` / `npm run bench` to run it against the reference
team — see [python/README.md](../python/README.md#try-it) and
[python/README.md](../python/README.md#measuring-it). None of that involves a
push, a manifest, or a token; those only come into it once you're ready to
hand the folder to a venue server. See
[running a server](running-a-server.md#pushing-a-robot) for that half.
