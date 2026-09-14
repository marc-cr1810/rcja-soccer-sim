# RCJA Soccer Sim

Match server and simulator for a proposed **RoboCup Junior Australia Soccer
Simulation** league: two robots a side on the RCJA field, under the RCJA rules,
driven by student Python instead of hand-built hardware.

**Status: it plays, and you can watch it.** Matches run headless at about 400×
real time, or live on a screen at the venue. A team can push a robot folder
and have it validated and sandboxed on arrival, and `npm run serve` loads and
plays whatever has been pushed under the names given to `--home`/`--away`,
falling back to the reference agent for any robot nobody has pushed yet.

**Documentation:** this file is the pitch — what this is and why it's built
the way it is. For the manual, see [docs/](docs/): [writing a
robot](docs/writing-a-robot.md), [running a server](docs/running-a-server.md),
[practising](docs/practising.md), and the full sensor/actuator reference in
[python/README.md](python/README.md).

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
| `src/gateway.ts` | **New.** Where robot programs connect, on the same port. |
| `src/bench.ts` | **New.** Measures a robot program and says what is wrong with it. |
| `src/manifest.ts` `src/submission.ts` | **New.** A team folder's manifest, and validating a push on arrival. |
| `src/sandbox.ts` | **New.** Running a submission with no network and no filesystem outside its own folder. |
| `src/lineup.ts` | **New.** Turning `--home`/`--away` into the submissions to spawn and play. |
| `src/tournament.ts` | **New.** A draw, the fixtures in it, and the table folded out of them. |
| `src/tournament-store.ts` `src/tournament-run.ts` | **New.** Where a tournament lives on disk, and playing a draw through resumably. |
| `viewer/` | **New.** The spectator client, using the lab's renderer. |
| `referee/` | **New.** The referee console — a separate bundle, so the spectator one can never carry it. |
| `python/` | **New.** The client library teams write against, and examples. |

`npm test` runs 334 tests.

### Python robots

Teams write Python. See [python/README.md](python/README.md).

```bash
npm run serve -- --agents          # waits for four programs
cd python && PYTHONPATH=. python3 examples/play.py
```

The library has **no dependencies**, including its WebSocket client, because
the schools this league exists to reach are the ones where pip is behind a
proxy or offline, and a dependency is a reason a team cannot enter.

### Pushing a robot

A team folder is one robot: `manifest.json` naming the team, the robot
number, and which `.py` file to run, plus that file and anything it imports
locally. The two robots on a side are pushed independently — typically from
two different laptops, since they are routinely written by two different
students who should not have to merge their code together first.

```bash
python python/submit.py --dir path/to/your/robot --url http://venue:8080/submit
```

The server validates on arrival — the manifest parses, the entry point is
valid Python, everything it imports is the standard library or `rcja_soccer`
(a venue has no internet and no pip), and it answers one sensor frame — and
rejects a bad push with a specific reason, before it ever replaces a team's
last-good folder for that robot. The one check that runs the submission's own
code does it sandboxed (`src/sandbox.ts`, via `bwrap`): no network, and no
filesystem visible beyond the platform's library and the submission's own
folder. Requires `bwrap` and a delegated user cgroup (true of an ordinary
login session on any reasonably modern Linux distro) on the machine running
the server.

A successful push gets back a token, printed by `submit.py` — proof this
program is the one the platform validated for this team's *this* robot, not
just whatever a connecting process claims to be. It rotates on every push, so
the value to keep is always whatever the last one printed. Server-spawned
play (below) reads it off disk automatically and hands it to the program
itself; a team running its own copy by hand for a scrimmage passes it the
same way its own script already takes `--team`/`--number`. A per-*robot*
token, not a per-team one — the two robots on a side are independent
programs on independent connections, and one should not be able to speak for
the other.

```bash
npm run serve -- --home "Your Team Name" --away "Their Team Name"
```

Whichever of the four seats has a validated submission under that name plays
it — spawned sandboxed by the server itself, reached over the same kind of
network-less Unix socket the validation check uses, held open for the whole
match rather than one tick (`src/lineup.ts`). Any seat nobody has pushed
falls back to the reference agent, so a team with one robot pushed and one
still being written, or a lone submission scrimmaging the reference team,
both just work. A submission that crashes mid-tournament is respawned (up to
five times) rather than leaving that seat empty for the rest of the event.

Each spawned robot runs inside its own `systemd-run --user --scope` cgroup, on
top of the same `bwrap` sandbox validation uses — a CPU quota and a memory
ceiling, enforced by the kernel rather than a `ulimit` inside the sandbox.
The CPU one *throttles* rather than kills: a runaway busy-loop is slowed down
to its share of one core for as long as it keeps running, rather than the
match losing that robot at an arbitrary cutoff unrelated to whether the game
is still going. A memory ceiling still ends a process that blows through it,
same as before, just measured against what it is actually using rather than
how much address space it reserved.

A seat's join is checked against the token its submission was issued, not
just the team/robot it claims — the last piece of "run it sandboxed" that
was still just self-declared. A robot run with no token at all (`--agents`
mode, a bench run, local dev against `examples/play.py`) is unaffected: a
seat only requires one if the server was told to expect it.

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

Four cameras, along the bottom of the screen or by pressing **C**. Broadcast is
the one to leave it on; **Overhead** settles an argument about where a robot
actually was; **Follow ball** is what a small screen wants; **Orbit** is for the
hall while it fills up.

When a robot is taken off under rule 5.7, a card appears with the rule it went
off under and the seconds left of its stand-down. It says *Ready* rather than
counting past zero, because serving the time does not put a robot back on —
5.7.4 wants the referee to agree it has been repaired. A team playing a robot
short is the most consequential thing that happens in a match short of a goal,
and until now the robot simply vanished with nothing to say why.

`--opponent waller` puts a robot on the lime side that drives itself off the
field, which is the quick way to watch a stand-down happen.

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

- **IR ball seeker** — 24 sectors, inverse-square strength, and **occlusion**: a
  robot in the way returns `null`. Possession is about having a clear line, not
  being close, which is why a robot that drives straight at the ball gets shut
  out by a defender standing still.
- **Compass** — a fused heading whose drift is tuned to be invisible in a
  thirty-second test and to matter by the end of a half.
- **Gyro** — a raw angular rate, not fused with anything. Fine to read every
  tick; its bias random-walks like the compass's drift does, but a bias in a
  *rate* only costs you anything once you integrate it into a heading of your
  own, at which point it is worse than the compass ever gets.
- **Camera** — 30 fps against a 50 Hz loop, with a `fresh` flag. Each goal
  arrives twice: as one bearing and range, and as the raw **colour blobs** a
  Pixy or an OpenMV would emit. A robot in front of the net is not goal-coloured,
  so it cuts the arc, and a goal with a keeper in the middle of it arrives as two
  blobs with a gap between them — where that opening is, and whether it is worth
  shooting at, is the program's to work out. Range comes off blob *height*, which
  an oblique view foreshortens and blob width does not.
- **Ultrasonics** — lose the echo entirely past 65° of incidence. A robot needs
  opposite beams to agree before it trusts either, because an obstruction can
  only make a reading *short*.
- **Encoders** — count wheel rotation, not distance. Odometry drifts.

Noise is seeded per robot per match, so a match that can be replayed can be
disputed. A seed fixes every noise stream (see `rand.ts`: each sensor derives
its own stream from the seed), and a match's seed is 64 bits — a fresh crypto
draw per match on the live server, printed before kick-off as `0x…` and
pasteable straight back in as `--seed` to replay that exact match. Sensor
noise is exactly normal, drawn by a table inverse-CDF with no transcendentals.

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

## Watching it

```bash
npm run build:viewer && npm run serve       # then open http://localhost:8080
```

The viewer is served by the match server, so it watches whatever is on the port
it was loaded from and there is nothing to configure.

Working on the viewer itself, `npm run dev:viewer` serves it from Vite instead,
on port 5173, with hot reload — and Vite knows nothing about any match, so in
dev the client looks for a match server on its own default port. Start one
alongside. A screen watching a different machine, or a second server on another
port, wants `?server=host:port`.

If it cannot reach a server it says so, and says which address it tried. A
socket left hanging in CONNECTING is not a state worth showing anybody: Vite
accepts the connection and then never completes the upgrade, so neither `open`
nor `close` ever fires, and the result is a black field, no error, and nothing
to go on.

## Measuring a robot

```bash
npm run bench -- --spawn "python3 python/examples/play.py --only violet --url {url}"
```

Starts your programs, plays them against the reference team at about ten times
real time, and prints a page of ground truth: where each robot spent the match,
what it did with the ball, what the referee had to do about it — then a list of
what is wrong, each one naming the rule it breaks and what the fix looked like.

Everything it checks came from a fault that was genuinely in a robot in this
repository, that was invisible watching the match at normal speed, and that
took a measurement to find. A striker wholly outside the playing area for a
quarter of the match. Every kick-off illegal, because a pushed ball travels
with the robot pushing it and the 50 mm gap rule 5.4.7 asks for never opens. A
keeper convinced it was on its own goal line while standing on the halfway
mark, because it believed a sonar that had bounced off an opponent. Shots aimed
perfectly and blocked at a metre, rebounding out for a neutral-point restart.

`--json before.json` saves the numbers; `--baseline before.json` on the next
run shows which way each one moved and whether that is the good direction,
which is what makes it usable in a loop.

## Next

1. A team rehearsing on its own: a scenario configured by hand — a striker
   alone, a goalie against a striker — played through the same pipeline a
   scored match uses.
2. Pyodide in the browser, and a VS Code extension, for teams who cannot
   install Python at all.
3. Accounts and a front page, replacing the hand-issued tokens.

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
