# RCJA Soccer Sim

Match server and simulator for a proposed **RoboCup Junior Australia Soccer
Simulation** league: two robots a side on the RCJA field, under the RCJA rules,
driven by student Python instead of hand-built hardware.

**Status: it plays, and you can watch it.** Matches run headless at about 400×
real time, or live on a screen at the venue. What is missing is the part where
a team's own program is the thing playing — right now both sides are the
reference agent.

## What this is not

It is not [RCJA Soccer Lab](../rcja-soccer-lab). That is a rules reference and
referee-training tool, and it stays that. This repository borrows its field
geometry and its physics solver — `src/field.ts` and `src/physics.ts` are copied
across with only the import paths changed — and goes a different way from there.

The difference is one design decision. In the lab, a robot is driven by applying
force in whatever direction the AI wants, and it reads the ball's exact position
out of the world. That is right for referee training, where robots only have to
be plausible. It is wrong for a competition, because it hands students a robot no
team could build.

Here a robot knows only what a sensor tells it and moves only by turning motors.

## The league, in one paragraph

One division, **Open**: four omni wheels, a dribbler, a kicker, a camera and a
radio to the other robot. Two robots a side, one nominable as goalie (§5.8), on
the 2430 × 1820 mm field with its 1830 × 1220 mm playing area. Two halves of five
minutes (§5.2.1). Refereeing is automatic, with a human able to pause and
intervene. Teams keep their code on their own laptops all season and push a copy
to whichever venue server is in front of them.

## What works today

```bash
npm install
npm run build:viewer
npm run serve            # then open http://localhost:8080
```

| | |
|---|---|
| `src/field.ts` | Field geometry, cited to section 2 of the 2026 rules. From the lab. |
| `src/physics.ts` | 2D solver. From the lab, with the ball's friction changed (below). |
| `src/world.ts` | Match state and the rule detectors. From the lab, driven by motors. |
| `src/drive.ts` | **New.** The motor model. Powers in, force and torque out. |
| `src/sensors.ts` | **New.** The sensor suite, and how each reading is wrong. |
| `src/protocol.ts` | **New.** The wire contract: `SensorFrame` in, `ActuatorFrame` out. |
| `src/agent.ts` | **New.** Running a program without letting it run the match. |
| `src/match.ts` | **New.** Physics at 100 Hz, programs polled at 50. |
| `src/reference.ts` | **New.** The reference opponent, and the worked example. |
| `src/bots.ts` | **New.** Deliberately poor robots, for testing the referee. |
| `src/ladder.ts` | **New.** Every entry against every other, both ways round. |
| `src/server.ts` | **New.** The match server: runs matches, streams them. |
| `viewer/` | **New.** The spectator client, using the lab's renderer. |

`npm test` runs 167 tests.

### Watching a match

The server owns the world. Viewers connect over a WebSocket and are sent a
frame 30 times a second — the physics runs at 100, and nobody can see the
difference above about 30, so sending every step would be three times the
bandwidth for none of the benefit. Venue wifi is the one thing at an event that
can be relied on to be bad.

A frame is about 1.5 KB, so a screen costs roughly 44 KB/s. It carries positions
and the score and nothing else: a viewer is untrusted, anyone on the venue
network can open one, and it gets what the audience can already see. There is a
test that it contains no sensor readings and no motor commands.

The renderer is the lab's, unmodified except for two things. It takes a
`RenderView` rather than a `World`, because a screen in a hall has no world —
only what the server told it a moment ago. And the broadcast camera frames
itself to the aspect it is given, as referee mode already did, instead of
sitting at a fixed distance that left the field filling half the screen.

Press **C** to change camera. The default is the broadcast angle.

### The drivetrain is sized against the lab's own numbers

Four omni wheels at 45°, 135°, 225° and 315°, each driving tangentially, on a
2.5 kg robot (§4.1.1). Stall force and free speed reproduce the top speed
(1150 mm/s) and acceleration (9200 mm/s²) the lab's AI was tuned against.

With the motors idle, back-EMF alone damps the robot at **8.0 per second** —
exactly the `ROBOT_DAMPING` the lab arrived at by hand, and the same in every
direction for four wheels 90° apart. The artificial damping constant was
standing in for a motor all along.

- **A two-wheel drive cannot strafe**, at any power. There is a test.
- **A four-omni drive is √2 faster between two wheel axes than along one**
  (≈1150 vs ≈810 mm/s). The drivetrain's own asymmetry, not a bug.

### The sensors are defined by how they fail

- **IR ball seeker** — 16 sectors, inverse-square strength, and **occlusion**: a
  robot in the way returns `null`. Possession is about having a clear line, not
  being close, which is why a robot that drives straight at the ball gets shut
  out by a defender standing still.
- **Compass/gyro** — drift tuned to be invisible in a thirty-second test and to
  matter by the end of a half.
- **Camera** — 30 fps against a 50 Hz loop, with a `fresh` flag.
- **Ultrasonics** — lose the echo entirely past 65° of incidence. A robot needs
  opposite beams to agree before it trusts either, because an obstruction can
  only make a reading *short*.
- **Encoders** — count wheel rotation, not distance. Odometry drifts.

Noise is seeded per robot per match.

### The ball rolls, rather than decaying

The one physics change to the lab's solver, and the biggest single change to how
the game plays.

The lab damps the ball exponentially, sized so a 2400 mm/s kick crosses the
field as §4.7.1 requires. That is right for the kick and wrong for everything
else: exponential decay makes every speed travel proportionally the same
distance, so a gentle 700 mm/s knock still rolled 574 mm — and it is only
610 mm from the centre of the field to the touchline. Almost every touch sent
the ball out.

Rolling resistance on carpet is near enough a constant force, so distance goes
with the square of speed: hard kicks carry, gentle knocks die. Per ten-minute
match this took goals from 17.5 to 4.8 and ball-out-of-play from 183 to 89.

## Next

1. Load submitted programs, so a match is between two teams rather than two
   copies of the reference agent.
2. The Python client library, and Pyodide in the browser for teams who cannot
   install it.
3. A referee console: start, pause, resume, and the calls `World` already has
   methods for.
4. Tournament running — a draw, a table, and results that persist.

Known and recorded as tests rather than hidden: the reference agent still scores
the occasional own goal against a motionless opponent (0–5 a match, down from
19), and the game is still looser than real RCJA Open at about 89 restarts a
ten-minute match.

## Licence

Apache 2.0. Field geometry and the physics solver originate in RCJA Soccer Lab
by the same author; everything else is new here.

The rules this implements are the **RCJA Soccer Rules 2026, v26.0** and the
**2026 RCJA General Rules**. The published PDFs control. This is a simulator, not
an authority.
