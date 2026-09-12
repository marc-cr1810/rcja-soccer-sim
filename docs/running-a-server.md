# Running a server

## Quick start

```bash
npm install
npm run build:viewer
npm run serve            # then open http://localhost:8080
```

With nothing else specified, both sides are the built-in reference agent —
what an organiser wants on the screen while a hall fills up. `ctrl-c` stops
it.

## The three ways to fill the four seats

**Built-in, the default.** No flags. Both sides are the reference agent, and
`--opponent <bot>` swaps the yellow side for one of the deliberately poor
test robots (`naive-chaser`, `shover`, `waller`, `spinner`, ...) — useful for
watching the referee actually do something, since e.g. a waller drives
itself off the field within seconds.

**`--agents`, for laptops in the room.**

```bash
npm run serve -- --agents
```

Waits for four programs to connect to `ws://<host>:<port>/agent` before
kicking off — the mode for "four laptops in a room right now," development,
and `npm run bench`. Nothing here is pushed or validated; whoever connects
and claims a seat gets it (see [writing a robot](writing-a-robot.md) for the
program side of this).

**`--home`/`--away`, for pushed submissions.**

```bash
npm run serve -- --home "ACT-01" --away "QLD-04"
```

These names double as a lookup against whatever's been pushed and validated
(below). Each of the four seats is resolved **independently** — a team with
one robot pushed and one robot still being written, or a lone submission
scrimmaging the reference team, both just work; a match is never
all-or-nothing between "real teams" and "the built-in agent." Any seat
nobody has pushed anything for falls back to the reference agent. This is
resolved once at startup — a team pushing a fix mid-tournament needs the
server restarted to pick it up.

## Pushing a robot

A team pushes one robot at a time (see [writing a robot](writing-a-robot.md)
for the folder shape):

```bash
python python/submit.py --dir path/to/your/robot --url http://venue:8080/submit
```

The server validates before it ever touches that team's last-good folder for
that robot:

1. `manifest.json` parses and names a real `.py` file in the same folder.
2. The entry point is syntactically valid Python.
3. Everything it imports, transitively, is the standard library, its own
   local siblings, or `rcja_soccer` — a venue has no internet and no `pip`.
4. It's actually spawned, sandboxed, and made to answer one synthetic sensor
   frame — proof it connects and produces a command, not just that it
   parses.

A rejected push gets a specific reason back and never replaces anything. A
successful one gets back:

```
accepted: ACT-01 robot 1
token: <a long random string>
keep this - it's what lets a program join as this robot
```

That token is server-issued proof of identity for **this specific `(team,
robot)`** — not the team as a whole, since the two robots are independent
programs on independent connections and neither should be able to speak for
the other. It's what closes the gap a bare join message used to leave wide
open: without it, anything that connects and claims `team: "ACT-01", robot:
1` got that seat, no questions asked. It rotates on every push — the value
printed just now is the current one, and re-pushing (even unchanged code)
mints a fresh one.

`--home`/`--away` mode reads this token off disk automatically and hands it
to the spawned process itself; you never touch it. It only matters by hand
if you're running your own copy against a venue server for a scrimmage
outside of that automatic path — pass whatever `submit.py` last printed as
`--token`.

## Sandboxing and resource limits

The one validation step that runs a submission's own code, and every
match-time spawn of one, happens inside:

- **`bwrap`** (bubblewrap): no network namespace at all, and no filesystem
  visible beyond the platform's own library and the submission's own folder.
- **A `systemd-run --user --scope` cgroup** around that: a CPU quota that
  *throttles* a runaway program rather than killing it at an arbitrary
  cutoff — the right shape for a control loop that's meant to run for a
  whole match — and a memory ceiling that OOM-kills on genuine over-use.

**Requires**, on the machine running the server: `bwrap` on `PATH`, and a
delegated user cgroup (true of an ordinary interactive login session on any
reasonably modern Linux distro — what a venue laptop actually is). Without
both, pushing anything fails validation with a specific "not available"
reason rather than silently running unsandboxed.

A submission that crashes or gets OOM-killed mid-tournament is respawned
automatically (five times, by default) rather than leaving that seat empty
for the rest of the event.

## CLI reference

```
serve     run the match server and keep playing matches
          [--port --half --home --away --seed --opponent --agents --fast]
match     play one match headless and print the result
          [--half --home --away --seed --opponent]
ladder    play every built-in bot against every other  [--half --rounds --seed]
bench     measure your robot program and say what is wrong
          [--spawn --team --opponent --seeds --half --noisy-sensors --json --baseline]
```

`npm run serve -- --help` (or any command with no recognised flags) prints
this same summary with the current flag defaults.

Other `serve` flags worth knowing: `--fast` runs as fast as the physics loop
allows instead of wall-clock (for a machine, not a screen); `--noisy-sensors`
turns on drift and dropouts instead of the default ideal sensors;
`--view-hz` changes the spectator frame rate (default 60).

## Watching

Open the port `serve` printed. A viewer connects over WebSocket and gets a
frame ~30 times a second — positions and the score, nothing a program's
sensors or commands would reveal, since anyone on the venue network can open
one. Four cameras along the bottom of the screen, or press **C**.
