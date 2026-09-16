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
{ "team": "ACT", "robot": 1, "entry": "robot.py" }
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

## Being taken off, and coming back

Rule 5.7 takes a damaged robot off the field for thirty seconds. While you are
off, **your program keeps running but stops being asked anything**: no sensor
frames arrive, so your tick function does not run, and the server tells you why
about once a second. You will see it on your own terminal:

```
[Violet/1] off the field under rule 5.7.1 (damaged); back in 30s
[Violet/1] back on the field
```

There is nothing to do about it and nothing to decide — your robot is in
somebody's hands beside the pitch. Do not treat the pause as a crash.

When you are put back, rule 5.7.4 replaces you at a corner of your own penalty
box, so whatever you were chasing has moved. The first frame after you return
has **`s.returned`** set, and it is set on that one frame only.

**Your memory is not cleared for you**, and that is deliberate. Both habits are
real and both are legal: some teams switch the robot off and on again, so the
software starts from scratch; others leave it running with a start/stop button,
so it carries on with what it knew and waits for the acknowledgement. Your
program here was never actually stopped, so it is the second kind. If you want
the first, ask for it:

```python
@robot.tick
def think(s, me):
    if s.returned:
        # Off and on again: forget everything, we have been moved.
        me.clear()
    ...
```

Either way, check `s.returned` if you keep a position estimate or a plan across
ticks. A robot that comes back still believing it is where it was will drive
confidently at a ball that is no longer there.

## Try it before you push it

Nothing about pushing changes how you develop. Run your script straight
against a local server the same way you always have:

```bash
bun run serve -- --agents            # in one terminal
cd python && PYTHONPATH=. python3 myrobot/robot.py --team violet   # in another
```

The server shows a field as soon as it starts, and each robot appears on it as
its program connects — so you can see which of your four are in before anything
kicks off.

or use `examples/play.py` / `bun run bench` to run it against the reference
team — see [python/README.md](../python/README.md#try-it) and
[python/README.md](../python/README.md#measuring-it). None of that involves a
push, a manifest, or a token; those only come into it once you're ready to
hand the folder to a venue server. See
[running a server](running-a-server.md#pushing-a-robot) for that half.
