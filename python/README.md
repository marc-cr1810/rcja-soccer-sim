# Writing a robot

Your robot is a loop. It reads what the sensors report, decides what the motors
should do, and sleeps — and the sleep is what sends the command and brings back
the next set of readings, fifty times a second.

```python
import time

from board import Board

board = Board()

while True:
    s = board.read()
    if not s.playing:
        board.coast()
    elif s.ball is None:          # an opponent is blocking the infrared
        board.coast()
    else:
        board.apply(motors=drive(bearing=s.ball.bearing, speed=0.8), dribbler=1.0)

    time.sleep_ms(20)
```

That is a MicroPython program, not something shaped like one. `board.py` is a
file in your own folder, and every line of it is `machine` — the hardware API a
real ESP32 or RP2040 gives you. Nothing is hidden and nothing is privileged:
the ball is eight photodiodes you take a vector sum of, the camera is a serial
port you parse packets from, the wheels are quadrature counts you catch in an
interrupt. See [docs/micropython.md](../docs/micropython.md) for the board, the
pinout and the camera's protocol.

Your folder starts with four files, and they are all yours to change:

| | |
|---|---|
| `main.py` | your robot. The only one you need on day one. |
| `board.py` | the wiring: pin numbers in, one `read()` out. |
| `camera.py` | the camera's packet format, about ninety lines of parsing. |
| `radio.py` | rule 4.2.5, about fifteen. |

`rcja_soccer` is an optional library on top: functions that take readings and
return numbers, with no network code of its own. **Nothing requires it** —
`examples/raw_hardware.py` is a complete legal robot that imports only
`machine`. What it is for is the arithmetic that is tedious to get right, and
`drive()` above is the smallest piece of it. No dependencies, on purpose:
`pip install` pulls in nothing at all, because the schools this league exists
to reach are the ones where pip is behind a proxy, offline, or not something a
student is allowed to run.

## Try it

Start a server that waits for robots, in one terminal:

```bash
bun run build:viewer
bun run serve -- --agents
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
bun run bench -- --spawn "python3 python/examples/play.py --only violet --url {url}"
```

One command. It starts your robots, plays three matches against the reference
team at about ten times real time, and prints a page: the score, where each
robot spent the match, what it did with the ball, what the referee had to do
about it — and then a list of what is wrong, with the rule each thing breaks.

To measure a change rather than a robot, save the numbers first and compare:

```bash
bun run bench -- --spawn "..." --json before.json
# edit the robot
bun run bench -- --spawn "..." --baseline before.json
```

Every line then carries which way it moved and whether that is the good
direction. Useful flags: `--seeds 1-10` for more matches, `--half 90` for
longer ones, `--opponent shover` to play one of the deliberately poor robots,
`--team both` for a mirror match against yourself, and `--noisy-sensors` to
turn on the drift and the dropouts. `bun run serve -- --help` lists the rest.

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
| `s.messages` | What your team mate said (rule 4.2.5), with `.age`. |
| `s.kickoff.pending` | A restart happened less than three seconds ago. |
| `s.playing` | Whether the start button is down. |
| `s.returned` | True on the first tick after any restart. |
| `s.team` / `s.robot` / `s.attack_direction` | The switches somebody set before the half. |
| `s.clock` | `time.ticks_ms()` in seconds. Never stops. |

**Three of these say less than you might expect, and that is not an oversight.**
`kickoff.pending` is a ceiling off the start button, not a referee's state:
nothing tells a robot whose kick-off it is, nothing sends an all-clear when it
is over, and being picked up for a 5.7.1 removal looks exactly the same as a
kick-off, because physically it is — somebody put the robot down and pressed
start. Working out whose it is (you were placed behind the ball) and when it is
over (the ball left the spot) is the robot's job, and both example robots show
one way. `rcja_soccer.simulator.frame()` will hand you the server's own answers
while you are debugging, and is named so you do not ship it.

Your own state is whatever you keep in local variables outside the loop —
there is no framework holding it for you, and nothing is reset on your behalf.
`rcja_soccer.Memory` is a small convenience if you want somewhere to hang
things, but a plain variable is just as good. Either way, clearing at a
kick-off is something you do yourself:

```python
if s.kickoff.pending:
    ball.reset()
```

## Nine things that will catch you out

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

**You change ends at half-time, and your code does not.** This is the one that
costs a half and never looks like a bug. `s.compass.heading` has a fixed zero —
it faces the yellow goal and it faces the yellow goal all match — but rule
1.4/5.4 swaps which goal you are attacking. So every rule you write about an
`x` or a `z` is only half a rule. The other half is a sign, and it has to be
right at *every* site:

```python
# Wrong in one half, and it will be the half you did not test in.
side = -1.0 if me_z > 0 else 1.0
```

The fix is not a better sign, it is not needing one. `GoalFrame` turns the
field so that the goal you are attacking is always at `+x`:

```python
from rcja_soccer import GoalFrame

frame = GoalFrame(TEAM)          # once
frame.update(s, heading, me_x, me_z)   # every tick; it re-reads at each kick-off

me_x, me_z = frame.to_frame(me_x, me_z)
bx, bz = frame.to_frame(bx, bz)
heading = frame.heading(heading)

side = -1.0 if me_z > 0 else 1.0   # now right at both ends, with no sign
```

Same millimetres and the same constants — `HALF_LENGTH` is still the goal line,
and the goal you are shooting at is now always the one at `+HALF_LENGTH`. What
is gone is the ability to tell the two ends apart from inside a rule, and with
it the ability to get them different. `frame.goals(s)` does the same for the
camera, handing back `(attacking, defending)` instead of cyan and yellow.

It is worth doing even though you can get it right by hand, because getting it
right by hand is not a thing you do once. The reference agent shipped with this
simulator had forty-eight of these sites and got forty-seven of them right; the
forty-eighth steered its dribbler into the side wall for a whole half, and it
scored 82 goals at one end against 33 at the other before anyone noticed.

**The compass drifts.** Slowly enough that you will not see it in a thirty
second test, and far enough to matter by the end of a five minute half.

**The gyro looks steadier than the compass, and is not.** `s.gyro.rate` is a
direct rate, fine to read every tick — a damping term, say, the way the
example robots use `GyroRate`. It has a bias that random-walks, the same as
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
board.apply(motors=powers, dribbler=0.0, kicker=False, say=None)
```

`powers` is four numbers, −1 to 1, one per wheel — `coast()` is four zeros.
`drive(bearing, speed, spin)` works them out for you and is ordinary code in
`rcja_soccer/drive.py` — read it, and replace it when you want to beat someone.

**What you leave out is left alone.** `apply()` writes the outputs you name and
does not touch the rest, because that is what hardware does: a PWM you do not
write keeps the duty you last gave it. So `apply(motors=...)` with no
`dribbler` does not stop the roller — it leaves it running, which is an easy
way to hold onto the ball through a shot you meant to take. Set every output
every tick unless you mean otherwise.

Under it are the individual writes, and they are all `board.py` is doing:

```python
board.motors(powers)       # PWM duty and a direction pin, per wheel
board.dribbler(1.0)        # PWM duty
board.kick()               # a rising edge on the kicker pin
board.coast()              # motors and dribbler to zero
board.radio.send({"ball": [x, z]})
```

Nothing is sent when you call any of them. They set pins, and your next
`time.sleep_ms()` is what puts the frame on the wire and waits for the next set
of readings. A loop that never sleeps never sends anything at all.

The kicker needs time to charge and will not tell you when it is ready.
`say` reaches your team mate under rule 4.2.5 and the link forgets it after
0.4 seconds, so it is for "I have the ball", not for a plan.

## What comes in the box

Four modules, none of which know anything your robot does not, and none of
which you have to use.

| | |
|---|---|
| `rcja_soccer.drive` | four wheel powers from a direction. Needed on day one. |
| `rcja_soccer.field` | the rulebook's dimensions, and the geometry questions worth asking of them — `shot_range`, `kick_lands_in_goal`, `in_penalty_box`. |
| `rcja_soccer.frame` | `GoalFrame` — which way you are attacking, worked out from the two goal sightings, and the coordinates that follow from it. Read the ninth gotcha above before you decide you do not need it. |
| `rcja_soccer.sense` | `Locator` (where am I), `BallTracker` (where is the ball and where is it going), `GyroRate`/`YawRate` (how fast am I turning), `teammate_ball` (where did the radio say it was), and the steering helpers the examples use. |

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

**An uncaught exception ends your program**, the same as it would on a board.
The traceback prints, the process exits, the socket closes — and a program that
disconnects during play is a 5.7.1 removal, so your robot is carried off for
thirty seconds. If you would rather limp than stop, catch it yourself:

```python
while True:
    s = board.read()
    try:
        think(s)
    except Exception as error:
        print(error, file=sys.stderr)
        board.coast()
    time.sleep_ms(20)
```

That is worth doing for a competition and not worth doing while you are
developing, where a traceback that stops everything is the fastest way to find
out what you broke.

**Missing a tick is not an error.** If your answer does not arrive in time the
previous command simply stays, which is what a motor controller does between
loop iterations. Slow code plays badly; it does not forfeit.
