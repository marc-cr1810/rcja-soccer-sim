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
PYTHONPATH=. python3 examples/play.py
```

Both sides run the same two programs, so whatever happens is the robots rather
than the matchup.

## Measuring it

Watching a match tells you the robot is bad. It does not tell you that it is
wholly off the field for a quarter of the match, that every kick-off it takes
is illegal, or that half its shots are aimed perfectly and hit a defender at a
metre. Those are invisible at normal speed and none of them show up in a
scoreline.

```bash
npm run bench -- --spawn "python3 python/examples/play.py --only cyan --url {url}"
```

One command. It starts your robots, plays three matches against the reference
team at about ten times real time, and prints a page: the score, where each
robot spent the match, what it did with the ball, what the referee had to do
about it — and then a list of what is wrong, with the rule each thing breaks.

To measure a change rather than a robot, save the numbers first and compare:

```bash
npm run bench -- --spawn "..." --json before.json
# edit the robot
npm run bench -- --spawn "..." --baseline before.json
```

Every line then carries which way it moved and whether that is the good
direction. Useful flags: `--seeds 1-10` for more matches, `--half 90` for
longer ones, `--opponent shover` to play one of the deliberately poor robots,
`--team both` for a mirror match against yourself, and `--noisy-sensors` to
turn on the drift and the dropouts. `npm run serve -- --help` lists the rest.

## What your robot can see

Everything is in **your robot's own frame**, in millimetres and radians. Bearing
0 is straight ahead and positive turns left. There is no list of opponents, no
ball position and no map: a real robot does not have those, so neither do you.

| | |
|---|---|
| `s.ball` | `.bearing` and `.strength`, or **`None`**. See below. |
| `s.compass.heading` | Your heading in field terms. 0 faces the yellow goal. |
| `s.gyro.rate` | Angular velocity, rad/s. Raw, not fused — see below. |
| `s.lines` | Eight sensors round the rim: `.bearing`, `.surface`, `.value`. |
| `s.range` | `.front` `.back` `.left` `.right` — mm to a wall, or `None`. |
| `s.encoders` | Accumulated wheel rotation, one per motor. |
| `s.camera.goals.cyan` / `.yellow` | `.bearing` and `.range`, or `None`. |
| `s.camera.ball` | `.bearing` and `.range`, or `None`. The only real range you get. |
| `s.camera.fresh` | Whether the camera actually updated this tick. |
| `s.ball_gate.held` | Whether the dribbler has the ball. |
| `s.messages` | What your team mate said (rule 4.2.5). |
| `s.kickoff.pending` / `.ours` | A kick-off is live and 5.4.7 applies. |
| `s.playing` | False before the whistle and at a stoppage. |

`me` is yours. Anything you put on it survives to the next tick, and it is
cleared at every kick-off.

## Eight things that will catch you out

**`s.ball` is `None` a lot.** The infrared ring sees nothing at all when a robot
stands between you and the ball — not a weak reading, nothing. A robot that
stops dead every time is a robot that stands still whenever it is defended.
Remember where the ball was.

**Bearings are quantised.** Twenty-four sectors, so 15° of ambiguity, and the
reading flickers between two of them when the ball sits on a boundary. Drive
straight at the raw number and you will weave down the field. Filter it.

**`s.ball.strength` is not a range.** It falls off with the square of distance,
so it looks like one, but it saturates: at the mouth of your dribbler it reads
1.0 and it keeps reading 1.0 for everything closer. Convert it if you like —
`131 / sqrt(strength)` — but treat 1.0 as "against the shell, distance unknown"
rather than as a measurement. `s.camera.ball.range` is the real range, and the
two together are better than either: bearing from the ring at 50 Hz, range from
the camera whenever a frame arrives.

**The line sensors cannot tell you which way to escape.** They report that the
white line is underneath you. Whether to drive towards it or away from it
depends on which side of it you are on, and the ring gives the same reading
from either — so a robot that decides on the ring alone drives *off* the field
half the time and then oscillates on the boundary until the referee removes it
under 5.7.1.6. Use your position estimate to decide, and the ring for what it
is good at: knowing the boundary is under you right now, without waiting on a
camera frame. There are only eight of them on a 95 mm ring, 75 mm apart, and
the line is 50 mm wide — so it fits between two sensors, and a robot parked
square across the boundary can have every sensor reading carpet.

**Do not push the ball towards your own goal.** Driving straight at it means
pushing it wherever you happen to be pointing. Come round the side first. This
is the single biggest difference between a robot that scores and one that does
not, and it is why the example striker curves round to a point *behind* the
ball before it drives at it.

**The compass drifts.** Slowly enough that you will not see it in a thirty
second test, and far enough to matter by the end of a five minute half.

**The gyro looks steadier than the compass, and is not.** `s.gyro.rate` is a
direct rate, fine to read every tick — a damping term, say, the way the
example robots use `YawRate`. It has a bias that random-walks, the same as
the compass's drift. Read it as a rate and the bias is nothing, a small
constant offset that never accumulates. Integrate it into a heading of your
own instead — trusting a gyro the way you'd trust the compass — and that
bias compounds every tick you integrate over. By the end of a half that is
a heading error considerably worse than the compass ever produces, from a
sensor that looked perfectly steady in a thirty-second test.

**A kick-off is a strike, not a carry.** Rule 5.4.7 wants the ball to roll
50 mm clear, and pushing never gets there — a shoved ball travels with you and
the gap never opens. Touch it and fire the kicker. Note that the kicker is very
often still charging at a restart, because the goal that caused the restart was
scored by firing at it, so stop dead and wait rather than carrying the ball off
the spot while you wait. Standing still is legal for the three seconds the rule
allows; carrying is not.

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

## What comes in the box

Three modules, none of which know anything your robot does not.

| | |
|---|---|
| `rcja_soccer.drive` | four wheel powers from a direction. Needed on day one. |
| `rcja_soccer.field` | the rulebook's dimensions, and the geometry questions worth asking of them — `shot_range`, `kick_lands_in_goal`, `in_penalty_box`. |
| `rcja_soccer.sense` | `Locator` (where am I), `BallTracker` (where is the ball and where is it going), `YawRate`, and the steering helpers the examples use. |

`field` is not a cheat: every number in it is printed in the rules and a team
measures them off the table before a competition. `sense` is where the
interesting work is, and it is all ordinary code — `Locator` in particular is
worth reading before you trust it, because the thing it spends most of its
effort on is *not* believing a sonar.

Both example robots are built on these and nothing else, and what is left in
them is strategy: roughly 235 lines of decisions in `striker.py` and 175 in
`goalie.py`, with the perception underneath them shared rather than copied
into each. That sharing is not tidiness — the two used to carry their own
copies of the same localisation code, and a fix to one of them was a fix to
one of them.

## When it goes wrong

A program that raises keeps its last command standing, the same as a real robot
whose control loop has hung, and the match carries on. The exception is printed
once per tick, so a robot that crashes every tick is loud rather than silent —
but it will also drive in a straight line into a wall, so read the output.

Missing a tick is not an error. If your answer does not arrive in time the
previous command simply stays, which is what a motor controller does between
loop iterations. Slow code plays badly; it does not forfeit.
