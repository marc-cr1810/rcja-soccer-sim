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
`--opponent <bot>` swaps the lime side for one of the deliberately poor
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
npm run serve -- --home "ACT" --away "QLD"
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
accepted: ACT robot 1
token: <a long random string>
keep this - it's what lets a program join as this robot
```

That token is server-issued proof of identity for **this specific `(team,
robot)`** — not the team as a whole, since the two robots are independent
programs on independent connections and neither should be able to speak for
the other. It's what closes the gap a bare join message used to leave wide
open: without it, anything that connects and claims `team: "ACT", robot:
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
          [--port --half --home --away --seed --opponent --agents --fast --referee --kickoff-countdown]
match     play one match headless and print the result
          [--half --home --away --seed --opponent]
ladder    play every built-in bot against every other  [--half --rounds --seed]
bench     measure your robot program and say what is wrong
          [--spawn --team --opponent --seeds --half --noisy-sensors --json --baseline]

draw        write a fixture list for a tournament
            [--name --teams --legs --half --seed --headless]
tournament  play a draw through, resumably
            [--name --headless --port --referee-token]
table       print a tournament's table as it stands  [--name]
```

The three tournament commands have their own page — see
[running a tournament](running-a-tournament.md).

`npm run serve -- --help` (or any command with no recognised flags) prints
this same summary with the current flag defaults.

**Seeds and replays.** Every match is fixed by a seed: `--seed 5` is fine,
and so is a 64-bit `--seed 0x1a2b3c4d5e6f7081`. Without `--seed`, `serve` and
`draw` draw a fresh 64-bit seed per match, and `serve` prints it right before
kick-off — paste that straight back in as `--seed` to replay the exact match.
The seed reaches restart placement and every sensor's noise stream, so the
replay is bit-for-bit: two `match` runs with the same seed print the same
score and the same goals. Ladder and bench keep numeric seeds by default,
because they are measurements, but accept the 64-bit form as well
(`bench --seeds "0x…,0x…"`).

Other `serve` flags worth knowing: `--fast` runs as fast as the physics loop
allows instead of wall-clock (for a machine, not a screen); `--noisy-sensors`
turns on drift and dropouts instead of the default ideal sensors;
`--view-hz` changes the spectator frame rate (default 60).

### The kick-off countdown

For any spectated match (realtime, and always for `--referee`), each kick-off
is placed but **not live** for three seconds by default: the robots are put
in their 5.4 spots, the ball is on the centre spot, and play — the clock, and
the 5.4.7 strike window — starts when the countdown reaches zero and the
whistle blows. The spectator viewer and the referee console both show a dial
in the kicking team's colour that drains as the countdown runs. A half-start
restart waits with the clock stopped, so a match cannot be started early by
clicking Resume instead of Kick Off; a restart after a goal keeps playing
because the clock was already running.

`--kickoff-countdown N` changes the wait for that server (headless matches
always get `0`, so `bench`, `ladder` and the `match` command are unchanged).
On the referee console, the **Kick off now** button skips the wait being
played out — it is enabled only while a countdown is actually running.

## Watching

Open the port `serve` printed. A viewer connects over WebSocket and gets a
frame ~30 times a second — positions and the score, nothing a program's
sensors or commands would reveal, since anyone on the venue network can open
one. Four cameras along the bottom of the screen, or press **C**.

(There's also a camera *mode* called `referee` — the overhead angle, for
settling arguments about where a robot was. Don't confuse it with the
referee console below; the camera mode is available to any spectator, and
controlling a match is not.)

## Refereeing a match

```bash
npm run build:referee
npm run serve -- --referee --half 300
```

`--referee` doesn't change how a match plays itself — a goal still kicks
straight back off, a robot that trips 5.7 is still taken off and returned on
its own the moment its penalty clock reaches zero, exactly as without the
flag. What it adds is a human at the two moments the simulator can't decide
for itself: nothing plays at all until the referee clicks kick-off for the
first half, and the second half waits the same way. From there a match runs
itself end to end unless the referee steps in — pause and resume at will,
award a kick-off to the other side, remove or return a robot by hand,
correct the score with a reason, or abandon the match outright.

The server prints a console URL and a token once, the moment `--referee` is
given:

```
referee console:  http://localhost:8080/referee
referee token:    <a long random string>
(hand this to the referee — it is not shown again)
```

This is a **separate page from the spectator viewer** — a different build
(`npm run build:referee`, landing in `dist-referee/` next to `dist-viewer/`),
served at `/referee` rather than `/`, and sharing no code with it. Opening
`/` needs nothing at all, the same as always; opening `/referee` shows a
login prompt for the token, and every action from there — kick off, pause,
resume, end half, end match, abandon, award a kick-off to the other side,
remove or return a robot, correct the score — is one authenticated
`POST /referee-api/<action>` call. Anyone watching the spectator stream
never sees this page, this token, or these calls; the two bundles are built
and served independently on purpose, per the trust boundary this league is
built around — watching is free, refereeing needs the token.

Like a Phase 1 push token, this is hand-issued, not an account: it's minted
fresh (or fixed with `--referee-token <value>`, for scripting a venue's
setup ahead of time) each time the server starts with `--referee`, and there
is nothing to register or sign into.

`--referee` and `--agents`/`--home`/`--away` are independent and combine
freely — four laptops or a pushed submission can play while a human still
explicitly kicks each half off, exactly as a real match would.

## Practice fields

`--practice-fields` lets anyone who can reach the server open a **practice
field** on it: a match nobody is scoring, with the robots and the ball placed
by hand.

```bash
npm run serve -- --practice-fields
```

`/practice` then answers with a page with one button on it. Each field is its
own child process running its own match — a team rehearsing does not slow
down or interfere with the fixture being played on `/` — reached back through
this same port at `/f/<field id>/`, so a student's laptop can join one with no
second port to open in the venue's firewall. Fields shut themselves down once
nobody is watching, and `--max-fields` (4 by default) caps how many run at
once, because each is up to four sandboxed robots and a physics loop.

They are **open to whoever has the link**: no token, no login. That is
deliberate for now — the league has no accounts yet, and a second hand-issued
credential would only be thrown away when it gets them. Nothing on a practice
field is scored or recorded, so what a stranger can do there is move somebody
else's robot around, which is worth one fewer credential to hand out at a
venue.

See [practising](practising.md) for what a team does with one.
