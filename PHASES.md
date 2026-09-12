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
- **Identity is a hand-issued token, not an account system yet.** Ahead of Phase
  6, a team's credential is whatever the admin running the venue hands them —
  a secret created by hand per team, enough to bind a push to a team name and
  mint a match's join tokens. Registration, roles, and self-service accounts are
  Phase 6's job, not a prerequisite here.

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
- Same hand-issued credential as Phase 1 for now — a real referee account
  is Phase 6's job.

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

## Phase 4 — A team rehearses on its own

*Gate: a team configures a scenario — a striker alone, a goalie against a
striker, the robot or the ball placed by hand — and watches its real
submission play it, through the same pipeline a scored match uses.*

This sits after Phase 3 on purpose: rehearsing against your own submission
only means something once a real submission and sandbox exist to rehearse
with, rather than a simulator-only stand-in.

- **Reuses Phase 3's harness, not a new one.** Running an isolated scenario is
  the same shape as a headless qualifying match — spin up `World`, feed it
  agents, run ticks — just with a different starting arrangement and no result
  written to a ladder table.
- **`World` needs to accept a scenario spec.** Today it assumes a standard
  four-robot kickoff. A scenario needs a partial roster (one robot instead of
  four) and arbitrary starting positions for robots and the ball, not just the
  kickoff layout.
- **Runs the real submission, sandboxed, same as a match.** The point is a team
  watching what their actual pushed code does under the actual constraints it
  will play under — not a separate simulator-only debug mode that could drift
  from what the venue server actually runs.
- **Not scored, not persisted.** A rehearsal produces no fixture, no result,
  nothing in the table Phase 3 builds. It is explicitly a practice path, kept
  distinct from a real match the way the laptop/`AGENT_PATH` loop in Phase 1 is.

---

## Phase 5 — Write it anywhere

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

## Phase 6 — Anyone can find the game

*Gate: a visitor with no venue access opens the site and sees what's upcoming,
what's in progress, and what already happened; a team or referee registers
themselves instead of getting a token by hand.*

Phases 1 and 2 got here first, on purpose, with a credential an admin hands
out — that was enough to prove identity mattered without building the whole
system around it up front. This is where it becomes real.

- **Team registration, referee registration, an admin role.** Replaces the
  hand-issued tokens from Phase 1 and 2 with actual accounts and a real sign-up
  flow, without changing what those tokens were *for* — the join-token and
  push-credential mechanics stay, only where they come from changes.
- **Visitors need no account at all.** Consistent with Phase 2's stance that
  the viewer stream is untrusted by design — watching stays open, only
  registering a team, refereeing, or administering needs a login.
- **A front page.** Upcoming fixtures, matches in progress (linking through to
  the live viewer), and past results — built on the match records and fixture
  list Phase 3 already persists, which is why this comes after it rather than
  before.
- **Optional, not load-bearing.** A team spinning up the server locally for a
  single match still gets today's behaviour — no login, no front page, nothing
  to opt into. Accounts and the front page are a layer above `MatchServer`, not
  a path threaded through it, so running one game alone stays exactly as cheap
  as [the destination](#the-destination) demands.

---

## Not yet placed

- **Spectator polish** — a scoreboard overlay and replays for the screen in
  the venue hall itself. Distinct from Phase 6's front page, which is for
  anyone browsing from outside the venue.
- **Multi-season structure** — which division a team is in, carrying a team's
  code and history between separate events, if the league runs more than once.
- **The reference agent's own goals.** Seed 5 against a motionless opponent
  still produces them. Recorded as a test rather than asserted away.

## Related

The committee paper proposing the league is drafted but **not circulated**, and
its §4 currently recommends adopting upstream `rcj-soccersim` on Webots as the
platform — written before this repository was taken into account. That section
contradicts this codebase and has to be rewritten before the paper goes anywhere.
