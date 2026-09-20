# Writing a robot

This is about the **submission** — the folder you push to a venue server and
the shape it has to be in. For the sensor/actuator API itself — what `s.ball`
means, why bearings are quantised, what `board.apply(...)` takes — see
[python/README.md](../python/README.md), and
[docs/micropython.md](micropython.md) for the board and its pinout. This page
is about packaging that program so a server can validate it, sandbox it, and
load it into a match.

## One folder, one robot

A submission is **one team's one robot** — not a two-robot team folder. The
two robots on a side are routinely written by two different students on two
different laptops, and neither should have to wait on or merge with the
other before they can push. A team with two robots pushes twice.

The folder needs:

```
myrobot/
  manifest.json
  main.py        # or whatever manifest.json names as the entry point
  board.py       # the pin numbers, and one read() over all of them
  camera.py      # the camera's packet format
  radio.py       # rule 4.2.5
```

That is what a real robot project looks like: your files, importing `machine`
and nothing else. A new team gets all four, and every one of them is theirs to
change — `board.py` first, when the wiring is not this wiring.

`manifest.json`:

```json
{ "team": "ACT", "robot": 1, "entry": "main.py" }
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

There is no separate runner — the entry script itself is what gets executed.
When a server spawns it for a match it passes five arguments:

```
--team violet --number 1 --name "ACT Robotics" --url <address> --token <token>
```

**You do not have to do anything with them.** The runtime underneath `machine`
reads them off `sys.argv` itself when it connects, so a plain MicroPython
program is a complete, valid submission:

```python
from machine import Pin, PWM
import time

fl = PWM(Pin(12), freq=1000, duty_u16=0)

while True:
    fl.duty_u16(30000)
    time.sleep_ms(20)
```

The one way to get this wrong is to parse the arguments *yourself* and forget
one. `argparse` exits with "unrecognized arguments" on a flag it has not been
told about, so a script that declares four of the five crashes the instant a
server spawns it. If you use `argparse`, declare all five:

```python
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet", choices=["violet", "lime"])
parser.add_argument("--number", type=int, default=1, choices=[1, 2])
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()
```

`--token` is the one easy to forget. A server always passes it — proof the
connecting program is the one the platform actually validated for this team's
this robot, not just whatever a socket claims to be. Validation catches a
missing one for you: the push runs your script with all five flags, so it fails
at push time with a clear reason rather than on match day. Running your own
script by hand with no `--token` is unaffected.

`examples/striker.py` and `examples/goalie.py` are the canonical version of
this convention — copy from there. `examples/raw_hardware.py` is the other
end of the range: one file, `machine` and the standard library, nothing else at
all.

## Being taken off, and coming back

Rule 5.7 takes a damaged robot off the field for thirty seconds. While you are
off, **your program keeps running but stops being asked anything**: no sensor
frames arrive, the start button goes up — because somebody has picked the robot
up — and the server tells you why about once a second. You will see it on your
own terminal:

```
[Violet/1] off the field under rule 5.7.1 (damaged); back in 30s
[Violet/1] back on the field
```

There is nothing to do about it and nothing to decide — your robot is in
somebody's hands beside the pitch. Do not treat the pause as a crash.

When you are put back, rule 5.7.4 replaces you at a corner of your own penalty
box, so whatever you were chasing has moved. The first frame after you return
has **`s.returned`** set, and it is set on that one frame only.

**It does not tell you a removal is what happened.** `returned` is true after
*any* restart, because to the robot they are the same event: somebody put it
down and pressed start. A kick-off looks identical. That is not a gap in the
simulator — it is what a robot on a real field knows, which is that it is
suddenly somewhere else.

**Nothing is cleared for you**, and that is deliberate. Both habits are real
and both are legal: some teams switch the robot off and on again, so the
software starts from scratch; others leave it running with a start/stop button,
so it carries on with what it knew and waits for the acknowledgement. Your
program here was never actually stopped, so it is the second kind. If you want
the first, ask for it:

```python
while True:
    s = board.read()
    if s.returned:
        # Off and on again: forget everything, we have been moved.
        locator.reset()
        ball.reset()
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
cd python && PYTHONPATH=. python3 myrobot/main.py --team violet   # in another
```

The server shows a field as soon as it starts, and each robot appears on it as
its program connects — so you can see which of your four are in before anything
kicks off.

One thing worth checking before a competition rather than during one: that
your robot plays the same in the second half as the first. It changes ends at
half-time and your code does not, which is the one bug that looks like bad luck
— see ["You change ends at half-time, and your code does
not"](../python/README.md#nine-things-that-will-catch-you-out). `bun run bench`
will flag it if the scoreline is lopsided enough to show.

or use `examples/play.py` / `bun run bench` to run it against the reference
team — see [python/README.md](../python/README.md#try-it) and
[python/README.md](../python/README.md#measuring-it). None of that involves a
push, a manifest, or a token; those only come into it once you're ready to
hand the folder to a venue server. See
[running a server](running-a-server.md#pushing-a-robot) for that half.
