# Phases

Where this is going, and the order it gets there in.

Each phase has a **gate**: one question, answered by playing rather than by
reasoning, the way Phase 0 was. A phase is done when the gate is a passing test,
not when the code exists.

> Reconstructed on 11 September 2026 from the original intent after the session
> holding it was cleared. Phase 0 is history; everything after it is a plan and
> can be argued with.

## The destination

A student writes Python on their own laptop — or in a browser, on a school
machine where they cannot install anything — and pushes it to the venue server.
When the match starts the server runs it. A referee controls the game from a
console. The hall watches on a screen.

Two things have to be true at once, and they pull in different directions: the
competition has to be **trustworthy** (the server runs the code, under rules,
with a referee), and entering has to be **cheap** (no install, no dependencies,
no hardware, no account). Most of the ordering below comes from refusing to
trade one away for the other.

---

## Phase 0 — Sensors-only robots play football ✅

*Gate: can a robot that sees only what a sensor sees still play?*

Passed. Robots with a 16-sector IR bearing, a drifting compass, four
ultrasonics and a 30 fps camera find the ball, score, and get called for lack of
progress, ball out of play and multiple defence. Ten minutes runs in about 1.5
seconds.

`cf8a497` · [src/match.test.ts](src/match.test.ts)

Since then, off the phase line: rolling friction, the live viewer, the 5.7
stand-down card, the ladder harness, and the Python client library.

---

## Phase 1 — A submitted program plays

*Gate: a full match where all four robots are student code the server holds,
started by the server, with no laptop connected to anything.*

This is the one thing the README admits is missing — both sides are still the
reference agent. It is first because everything after it assumes the server owns
the program rather than trusting a socket.

- **A team folder.** A directory of Python with a manifest naming the team, the
  robots and the entry point. The same folder a student has open in their editor.
- **Push to a venue server.** Over HTTP to the server already running. Validated
  on arrival — manifest parses, entry point imports, no dependencies, robot
  answers one synthetic tick — and rejected with a reason a fifteen-year-old can
  act on, at the time they push, not at the time they play.
- **Run it sandboxed.** This is the hard part and the reason the phase is not
  small. A submission is untrusted code running on a machine at a school event:
  no network, no filesystem outside its own folder, a memory ceiling, and a CPU
  ceiling so a team cannot win by starving the other three robots. A program
  that exhausts its budget has its last command stand, exactly as a slow one
  does today.
- **Identity at the join.** [`src/gateway.ts`](src/gateway.ts) currently believes
  whatever a client claims — team, robot number, name. Anyone on the venue wifi
  can be cyan 1. A submitted program gets its slot from the match, not from its
  own say-so.

**The laptop path does not go away.** Connecting a live program over
[`AGENT_PATH`](src/gateway.ts) stays, as the practice and scrimmage loop — it is
how a student iterates, and it is fast. The distinction to hold onto: *live
connection is for practice, submission is for competition.* A scored match never
runs code from a laptop.

---

## Phase 2 — A referee runs the match

*Gate: a human referee takes a whole match from kick-off to full time in a
browser, without touching a terminal.*

`World` already has the methods; this is the surface over them, and the reason
it is Phase 2 rather than later is that a scored match is not scored until a
person can stop it.

- Kick off, pause, resume, end half, end match, abandon.
- Award a kick-off to the other side.
- Remove a robot under 5.7 and return it — 5.7.4 wants the referee to agree it
  has been repaired, which is why the stand-down card already says *Ready*
  instead of counting past zero.
- Correct the score, with a reason recorded against the match.
- Authenticated, on its own path, and never reachable from the spectator
  bundle. The viewer stream is untrusted by design and stays that way.

---

## Phase 3 — A tournament runs itself

*Gate: a draw goes in, a division plays, and a table comes out — across a
process restart.*

The [ladder harness](src/ladder.ts) already plays every entry against every
other, both ways round. What it lacks is everything around the football.

- A draw, a fixture list, and results that persist to disk.
- Headless at 400× for qualifying, wall-clock on the screen for finals.
- Best-of-three on recorded seeds. Sixteen matches were needed to separate a
  skill dial of 1.0 from 0.35 — that is a real statement about how noisy a
  single meeting is, and it is already written down in the Phase 0 test.
- A published match record per fixture: seed, both submissions' hashes, the
  referee event log. This is what makes a result reviewable, and it is the thing
  the committee paper's review pathway depends on existing.

---

## Phase 4 — Write it anywhere

*Gate: a student with a locked-down school laptop and no Python writes a robot,
watches it play, and submits it.*

Two front ends onto the same team folder and the same protocol.

- **VS Code extension.** Scaffold a team folder; run a practice match against
  the reference agent from the command palette; a sensor inspector that draws
  the IR ring, the line sensors and the range beams for the tick under the
  cursor, because the single hardest thing about this league is that you cannot
  see what your robot saw; breakpoints that pause the match rather than time out
  the connection; and submit to a venue server.
- **Pyodide in the browser.** For teams who cannot install Python at all. Same
  library, same code, running in the tab. Slower, and it does not matter for
  practice.

Both are accessibility work, which is the argument the whole league rests on, so
neither is optional — but both need a stable team folder and protocol to target,
which is why they are here and not at the front.

---

## Not yet placed

- **Season and venue management** — who is registered, which division, carrying
  a team's code between events.
- **Spectator polish** — a scoreboard overlay, replays, a results screen for the
  hall.
- **The reference agent's own goals.** Seed 5 against a motionless opponent
  still produces them. Recorded as a test rather than asserted away.

## Related

The committee paper proposing the league is drafted but **not circulated**, and
its §4 currently recommends adopting upstream `rcj-soccersim` on Webots as the
platform — written before this repository was taken into account. That section
contradicts this codebase and has to be rewritten before the paper goes anywhere.
