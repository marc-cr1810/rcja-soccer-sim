# RCJA Soccer Sim

Match server and simulator for a proposed **RoboCup Junior Australia Soccer
Simulation** league: two robots a side on the RCJA field, under the RCJA rules,
driven by student Python instead of hand-built hardware.

**Status: early. Nothing here plays a match yet.** What exists is the boundary
everything else hangs off — the drivetrain and the sensor suite.

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

| | |
|---|---|
| `src/field.ts` | Field geometry, every dimension cited to section 2 of the 2026 rules. Copied from the lab. |
| `src/physics.ts` | 2D rigid-body solver: collisions, walls, goals. Copied from the lab. |
| `src/drive.ts` | **New.** The motor model. Powers in, force and torque out. |
| `src/sensors.ts` | **New.** The sensor suite, and the specific way each reading is wrong. |
| `src/protocol.ts` | **New.** The wire contract: `SensorFrame` in, `ActuatorFrame` out. |

```bash
npm install
npm test        # 48 tests
npm run typecheck
```

### The drivetrain is sized against the lab's own numbers

Four omni wheels at 45°, 135°, 225° and 315°, each driving tangentially, on a
2.5 kg robot (§4.1.1). Stall force and free speed are chosen so this drive
reproduces the top speed (1150 mm/s) and acceleration (9200 mm/s²) the lab's AI
was tuned against, so matches feel the same and that AI can be ported without
retuning.

There is a pleasing check on the sizing. With the motors idle, back-EMF alone
damps the robot at **8.0 per second** — which is exactly the `ROBOT_DAMPING` the
lab arrived at by hand, and for four wheels 90° apart it comes out the same in
every direction. The artificial damping constant was standing in for a motor all
along. The first draft here also had a separate carpet-friction term; it was
double-counting, and removing it is what makes the top speed land on 1150.

Two consequences worth knowing before tuning anything:

- **A two-wheel drive cannot strafe**, at any power, because no wheel points
  that way. There is a test for it. Under the lab's model it could.
- **A four-omni drive is √2 faster between two wheel axes than along one**
  (≈1150 vs ≈810 mm/s). That is the drivetrain's own asymmetry, not a bug, and a
  team that orients their approach around it has found something real.

### The sensors are defined by how they fail

Readings are easy. The interesting part is the specific imperfection:

- **IR ball seeker** — bearing quantised to 16 sectors (22.5° of ambiguity),
  inverse-square strength, and **occlusion**: a robot between you and the ball
  returns `null`. This is the most important one in the suite. It means
  possession is about having a clear line, not just being close, and it is why a
  robot that only drives straight at the ball gets shut out by a defender
  standing still.
- **Compass/gyro** — noise, plus drift tuned to be invisible in a thirty-second
  test and to matter by the end of a five-minute half. That gap is the lesson.
- **Camera** — 30 fps against a 50 Hz control loop, so the same frame arrives
  twice about half the time. `fresh` says which; a team that ignores it builds a
  controller that oscillates.
- **Ultrasonics** — lose the echo entirely off a wall struck past 65°, which is
  why sonar-guided robots work square to a wall and lose the plot in corners.
- **Encoders** — count wheel rotation, not distance. A wheel spins while the
  robot is held still; an omni roller takes a sideways shove and reports
  nothing. Odometry drifts, and nothing here fixes that because nothing on a
  real robot does.

All noise is seeded per robot per match, so a match can be replayed exactly — a
match that cannot be replayed cannot be disputed, and an intermittent fault a
student is chasing has to happen again.

## Next

1. The agent host: run a program against the boundary, with a step budget.
2. Port the lab's AI to play through it, seeing only sensors and driving only
   motors. If it still plays a watchable match, the boundary is right.
3. World and rule detectors, adapted for an automatic referee.
4. The server: agent, referee and spectator connections.
5. The Python client library.

## Licence

Apache 2.0. Field geometry and the physics solver originate in RCJA Soccer Lab
by the same author; everything else is new here.

The rules this implements are the **RCJA Soccer Rules 2026, v26.0** and the
**2026 RCJA General Rules**. The published PDFs control. This is a simulator, not
an authority.
