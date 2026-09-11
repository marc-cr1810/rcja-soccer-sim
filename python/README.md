# Writing a robot

Your robot is a function. It is called fifty times a second, it is given what
the sensors report, and it returns what the motors should do.

```python
from rcja_soccer import Robot, drive

robot = Robot(team="cyan", number=1, name="ACT-01")

@robot.tick
def think(s, me):
    if s.ball is None:          # an opponent is blocking the infrared
        return robot.coast()
    return robot.motors(drive(bearing=s.ball.bearing, speed=0.8), dribbler=1.0)

robot.run()
```

No dependencies, on purpose. `pip install` pulls in nothing at all, because the
schools this league exists to reach are the ones where pip is behind a proxy,
offline, or not something a student is allowed to run.

## Try it

Start a server that waits for robots, in one terminal:

```bash
npm run build:viewer
npm run serve -- --agents
```

Start four robots in another, and open <http://localhost:8080> to watch:

```bash
cd python
PYTHONPATH=. python examples/play.py
```

Both sides run the same two programs, so whatever happens is the robots rather
than the matchup.

## What your robot can see

Everything is in **your robot's own frame**, in millimetres and radians. Bearing
0 is straight ahead and positive turns left. There is no list of opponents, no
ball position and no map: a real robot does not have those, so neither do you.

| | |
|---|---|
| `s.ball` | `.bearing` and `.strength`, or **`None`**. See below. |
| `s.compass.heading` | Your heading in field terms. 0 faces the yellow goal. |
| `s.lines` | Eight sensors round the rim: `.bearing`, `.surface`, `.value`. |
| `s.range` | `.front` `.back` `.left` `.right` — mm to a wall, or `None`. |
| `s.encoders` | Accumulated wheel rotation, one per motor. |
| `s.camera.goals.cyan` / `.yellow` | `.bearing` and `.range`, or `None`. |
| `s.camera.fresh` | Whether the camera actually updated this tick. |
| `s.ball_gate.held` | Whether the dribbler has the ball. |
| `s.messages` | What your team mate said (rule 4.2.5). |
| `s.kickoff.pending` / `.ours` | A kick-off is live and 5.4.7 applies. |
| `s.playing` | False before the whistle and at a stoppage. |

`me` is yours. Anything you put on it survives to the next tick, and it is
cleared at every kick-off.

## Five things that will catch you out

**`s.ball` is `None` a lot.** The infrared ring sees nothing at all when a robot
stands between you and the ball — not a weak reading, nothing. A robot that
stops dead every time is a robot that stands still whenever it is defended.
Remember where the ball was.

**Bearings are quantised.** Sixteen sectors, so 22.5° of ambiguity, and the
reading flickers between two of them when the ball sits on a boundary. Drive
straight at the raw number and you will weave down the field. Filter it.

**Do not push the ball towards your own goal.** Driving straight at it means
pushing it wherever you happen to be pointing. Come round the side first. This
is the single biggest difference between a robot that scores and one that does
not, and it is why the example striker aims at a point *behind* the ball.

**The compass drifts.** Slowly enough that you will not see it in a thirty
second test, and far enough to matter by the end of a five minute half.

**A kick-off is a strike, not a carry.** Rule 5.4.7 wants the ball to roll
50 mm clear, so leave the dribbler off until it has. Otherwise the referee
awards the kick-off to the other side — repeatedly.

## What your robot can do

```python
robot.motors(powers, dribbler=0.0, kicker=False, say=None)
robot.coast()
```

`powers` is four numbers, −1 to 1, one per wheel. `drive(bearing, speed, spin)`
works them out for you and is ordinary code in `rcja_soccer/drive.py` — read
it, and replace it when you want to beat someone.

`say` reaches your team mate under rule 4.2.5. It expires after 0.4 seconds, so
it is for "I have the ball", not for a plan.

## When it goes wrong

A program that raises keeps its last command standing, the same as a real robot
whose control loop has hung, and the match carries on. The exception is printed
once per tick, so a robot that crashes every tick is loud rather than silent —
but it will also drive in a straight line into a wall, so read the output.

Missing a tick is not an error. If your answer does not arrive in time the
previous command simply stays, which is what a motor controller does between
loop iterations. Slow code plays badly; it does not forfeit.
