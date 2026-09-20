# Retire the dual-runtime "Hybrid Mode"; make `machine` the one connection and `rcja_soccer` a pure library

> **Done, and since superseded in one respect.** The plan below turned on a
> load-bearing fact: `Runtime` already held the whole server frame, so
> "no camera/radio/encoder simulation needs building". That was true and it is
> what made the slice cheap — but it left `machine.Runtime` as the documented
> way to write a robot, and `Runtime` is not a name any MicroPython board has.
> Every sensor now has a device instead: the camera on a UART, the radio on
> another, encoders as quadrature counts through a working `Pin.irq()`, and the
> start button and end switches a human operates. `machine` exports only real
> MicroPython names and the back door moved to `rcja_soccer.simulator`. See
> [docs/micropython.md](../micropython.md).

## Context

`rcja_soccer.Robot` (event-driven: `@robot.tick` + `robot.run()`) and `machine`
(MicroPython-style `Pin`/`PWM`/`ADC`, real imperative `while True: ...
time.sleep_ms(20)` loop) are two **independent** client runtimes, each opening
its own WebSocket connection under the same robot slot. This was proved live
(not just reasoned about): the moment a `@robot.tick` function touches any
`machine` object, `machine.Runtime` tries to open a second connection for the
same seat and the server rejects it every tick (`"violet-1 is already
connected"`), which `Robot._play()` swallows silently — the robot just never
sends a command again. `docs/micropython.md`'s "Hybrid
Mode" section describes this combination working; it never did.

Rather than build a seam to reconcile two runtimes, collapse to one:
**`machine` becomes the sole connection and the sole tick source** (matching
what a real MicroPython board actually is), and **`rcja_soccer` stops being a
second framework and becomes what its own docstrings already call it — "a
usable library"**: pure functions and stateful helpers (`drive`, `sense`,
`field`, `frame.GoalFrame`) that take a sensor reading and return numbers, with
no network code of their own.

This is a bigger rework than a "wire the two together" seam because it retires
`rcja_soccer.Robot`'s whole event loop, not just connects it to `machine`. The
load-bearing fact that makes it tractable: `machine.Runtime` already stores the
**entire** raw sensor frame from the server (`self.last_frame = frame`,
unfiltered) — camera goal blobs, team radio messages, wheel encoders,
`attackDirection` and all (`src/protocol.ts:184-234`) — it just never exposes
any of that beyond a hardware-realistic pin/ADC subset. And
`drive.py`/`sense.py`/`field.py`/`frame.py` already have **zero import
dependency** on `rcja_soccer.robot`/`Reading`/`Robot` — they're already pure,
duck-typed on `getattr(s, ...)`. So no camera/radio/encoder simulation needs
inventing; it only needs a doorway.

## What changes

### 1. `python/machine/_backend.py` — `Runtime` becomes the one thing that owns a connection

Add, alongside the existing Pin/PWM/ADC-facing methods:

- **`Runtime.sensors() -> Reading`** — wraps `self.last_frame` (the full
  server frame, not the pin-filtered subset) in a `Reading`-style
  attribute/camelCase-bridging object, exactly what `think(s, me)`'s `s`
  parameter is today. Move the existing `Reading` class (and its `_camel`/
  `_wrap` helpers) out of `rcja_soccer/robot.py` into `python/machine/reading.py`
  — it's a generic "wrap this JSON frame" helper, not soccer-specific, and
  `machine` is now the thing that owns the frame.
- **`Runtime.send_command(motors=None, dribbler=0.0, kicker=False, say=None)`**
  — sends a command dict directly over the wire in the same shape
  `build_actuator_frame()`/the gateway already expect, bypassing individual
  `Pin`/`PWM` writes. This is the new home for what `robot.motors()` used to
  return; `rcja_soccer.drive()`'s output plugs straight in.
- **Port the reconnect-with-timeout loop from `rcja_soccer/robot.py`'s
  `Robot.run()`** (the `try/except (TransportError, OSError)`,
  `reconnect_for` budget, `time.sleep(1.0)` retry) into `sync_tick()`/
  `ensure_connected()`. Today a pure-`machine` program has **no** retry at all
  — a dropped connection just raises out of the student's loop. `robot.py`'s
  own docstring explains why this matters operationally (a harness that spawns
  robots detached can't clean up a process that retries forever, so it must
  give up after `reconnect_for` seconds) — that property must not quietly
  disappear.
- **Fix a real gap while touching this code**: `ensure_connected()` currently
  re-parses `sys.argv` for `--token`/`--url` itself and never calls
  `rcja_soccer.transport.join_token()`/`join_url()` — so `python/join.py`'s
  venue-practice-token flow (`use_join()`) **currently does nothing for a
  `machine`-based program**. Wire it in as a fallback, same precedence rule
  `transport.py` already documents ("a program that names its own token/url
  still wins").
- Keep depending on `rcja_soccer.transport.current_transport()` for
  pluggable-transport testing — `machine` already imports this today, so no
  new dependency is introduced.

### 2. `python/rcja_soccer/` — sheds its own runtime, keeps the library

- **Delete `robot.py`** (`Robot`, `Memory`, `Reading`, `PROTOCOL_VERSION`,
  `DEFAULT_URL`, `_play()`). Its useful piece (`Reading`) moved to `machine` in
  step 1.
- **Keep `Memory`** as a small opt-in convenience class, relocated to a new
  `rcja_soccer/memory.py` — same attribute-storage/helpful-error behavior, but
  **drop the automatic clear-on-kickoff magic**. A real MicroPython program
  manages its own state explicitly; that's more consistent with `Locator`/
  `BallTracker`/`GoalFrame` already requiring an explicit `.reset()` call, not
  a regression — a rewritten example just does
  `if s.kickoff.pending: mem.clear()` itself.
- **Keep `transport.py` exactly as-is** — `Channel`/`use_transport`/`use_join`
  still serve `machine`'s pluggable-transport and credential-installation
  needs (see step 1's join.py fix); nothing here depended on `robot.py`.
- **Keep `drive.py`, `field.py`, `sense.py`, `frame.py` untouched.** They're
  already the pure library this rework is aiming for.
- Update `__init__.py`'s exports: drop `Robot`, `Reading`, `PROTOCOL_VERSION`,
  `DEFAULT_URL`; drop the vestigial `try: import machine / except ImportError:
  pass` (no longer meaningful once `machine` is required, not optional).

### 3. The new canonical program shape

```python
import time
from machine import Runtime
from rcja_soccer import drive, sense

rt = Runtime.get()
locator = sense.Locator("violet")
ball = sense.BallTracker()

while True:
    s = rt.sensors()
    if s.kickoff.pending:
        locator.reset()
        ball.reset()
    heading = s.compass.heading
    x, z = locator.update(s, heading)
    ball.update(s, heading, x, z)
    if ball.seen:
        rt.send_command(motors=drive.drive(bearing=s.ball.bearing, speed=0.8))
    else:
        rt.send_command(motors=drive.coast())
    time.sleep_ms(20)
```

### 4. Rewrite the tuned example bots — logic unchanged, loop shape changed

`python/examples/striker.py` and `goalie.py` keep every line of actual
decision logic (that's the part with real duel/champion-measured tuning behind
it — see memory `python_robot_improvements`). Only the outer shape changes:
`@robot.tick def think(s, me): ... return robot.motors(...)` becomes a
`while True:` loop calling `rt.sensors()`/`rt.send_command()` and
`time.sleep_ms(20)`, with `me` becoming a plain `Memory()` instance (or local
variables) declared once outside the loop. Verify with the existing
`scratch/duel.py` rig against the pinned champion after rewriting, since a
pure loop-shape change should score identically — any divergence means the
port introduced a behavior bug, not a real change.

### 5. `src/workspace.ts` — rewrite `STARTER_ROBOT`

The hardcoded starter template every new student's workspace is seeded with
(`WorkspaceStore.seed()`) is currently the tick-decorator style. Rewrite it to
the new imperative shape from step 3. `workspace/editor.ts`'s comment
referencing `@robot.tick` as "the first unfamiliar thing" gets updated to
reference whatever the new starter's first unfamiliar line is (probably
`time.sleep_ms(20)` or `from machine import Runtime`).

### 6. Test migration — mechanical for most, real for a few

Confirmed by survey: of the 13 test-touching files, **11 just embed a
tick-style program as an incidental fixture** (a "team pushed some code" or "a
robot that connects and coasts" stand-in) to test something else entirely —
lineup resolution, admin rollback, pregame join, league push, workspace
seeding/API. These need only their embedded string swapped to the new
imperative style, and a couple of `toContain('@robot.tick')` substring
assertions changed to whatever marker the new starter uses
(`tests/workspace.test.ts`, `tests/workspace-api.test.ts`, `tests/league.test.ts`).

Two need real changes:
- **`tests/pytransport.test.ts`** currently tests `Robot`'s own behaviors
  directly (reconnect, tick-exception-coasts, kickoff-clears-memory,
  socket-close). Rewrite it to test the equivalent `machine.Runtime` behaviors
  instead (reconnect-with-timeout from step 1, `sensors()`/`send_command()`
  round-trip) — reusing the same fake-`Channel` pattern it already uses.
- **`tests/submission.test.ts`**'s 4 embedded programs and its pass/fail
  wording ("did not connect", "connects but never answers a tick") need
  updating for the new shape ("never sent a command"), but the thing being
  validated (a submitted program connects and responds) is unchanged.

### 7. Docs

Rewrite the "Hybrid Mode" section out of
`docs/micropython.md` entirely — there's only one paradigm
now. Document `Runtime.sensors()`/`Runtime.send_command()` as the two calls
that bridge `machine` and `rcja_soccer`.

## Sequencing

Do this as slices, verified live at each step (matching how every other phase
of this project has gone), not as one giant diff:

1. `machine._backend.py` additions (`sensors()`, `send_command()`, reconnect
   port, join.py fix) + `reading.py` + new tests. Verify live with a real
   `MatchServer`/`spawnLineup` harness (the same shape used to prove the
   original dual-connection bug) — one connection, a real frame with
   camera/messages present, reconnect survives a server restart.
2. Retire `rcja_soccer/robot.py`, update `__init__.py`, add `memory.py`.
3. Rewrite `striker.py`/`goalie.py`; verify with `scratch/duel.py` against the
   pinned champion — expect no score change.
4. Rewrite `src/workspace.ts`'s starter + `workspace/editor.ts` comment.
5. Migrate the 11 mechanical test fixtures, then the 2 real ones
   (`pytransport.test.ts`, `submission.test.ts`).
6. Docs.

Each slice gets checked in on and verified live before moving to the next,
rather than landing as one large diff.

## Verification

- `python/tests/` (unittest) + `make test-py` after each machine.py change.
- A live `MatchServer`/`spawnLineup` probe as the standard live-verification
  harness for connection/reconnect/frame behavior.
- `scratch/duel.py` against `scratch/champion` after the striker/goalie
  rewrite, to confirm the loop-shape change didn't change behavior.
- Full `bun test` at the end of the migration.
