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

## Phase 3 — A tournament runs itself ✅

*Gate: a draw goes in, a division plays, and a table comes out — across a
process restart.*

Passed. A draw of two pushed teams was played through, killed with ctrl-c
mid-fixture, and resumed in a fresh process: it restarted at the fixture that
had not finished, counted none of them twice, and printed a table. Each fixture
tore down its lineup and spawned the next one's — verified by the submission
hashes in the records, which show the same code changing sides between fixtures.

`src/tournament.ts` · `src/tournament-store.ts` · `src/tournament-run.ts` ·
[docs/running-a-tournament.md](docs/running-a-tournament.md)

- A draw, a fixture list, and results that persist to disk. **There is no
  mutable state file**: a tournament is its draw, written once, plus whichever
  fixture results exist. The table is folded out of them on every read and the
  next fixture is the first with no result, so resuming is not a feature but a
  consequence — and a fixture interrupted halfway leaves nothing behind.
- Headless for qualifying, wall-clock on the screen for finals. **Not 400×**:
  headless routes sandboxed submissions through `playFast`, which yields once
  per control cycle and runs at better than ten times real time, bounded by how
  fast the programs answer. The unbounded path is only open to in-process
  agents, which a submission is not. The two modes are not interchangeable
  results — a slow program misses more cycles headless — so a division is
  played one way or the other.
- Best-of-three on recorded seeds, as `--legs 3`. Seeds are fixed in the draw
  rather than derived at kick-off, so a fixture replays as itself. Legs decide
  a fixture, not aggregate goals, and a fixture is worth one row's points.
- A published match record per fixture: seed, the sha256 of the code in each
  seat, and the referee event log — now kept whole, rather than the 60-entry
  ring buffer sized for the referee's banner, plus every referee action that
  took effect and when.

Caught by playing it rather than by testing it: the referee console's
"remove a robot" list cached itself on the four seat ids, which never change,
so it kept the team names of the first match the console ever saw. One `serve`
playing the same two teams all day hid it completely; the second fixture of a
tournament turned it into a referee sending off the robot they did not pick.

---

## Phase 4 — A team rehearses on its own ✅

*Gate: a team opens a practice field, puts its own pushed robots on it, drags
them and the ball where it wants them, and watches them play — through the
same pipeline a scored match uses, with nothing scored and nothing written.*

Passed. A field was opened on a venue server, a striker pushed to it with
`python/submit.py` was dropped into a seat mid-run and took over sandboxed
under `bwrap`, its program was stopped and restarted from the console — it
left the field while it was gone and came back when it returned — a second
robot joined another seat live from a laptop through the venue's own port,
and a second field ran alongside the first without either noticing. Killing
the venue server outright took every field down with it.

`src/practice.ts` · `src/fields.ts` · `practice/` ·
[docs/practising.md](docs/practising.md)

- **A situation, not a mode.** `World` takes an `Arrangement` — who is on the
  field, where, and where the ball is — and `stage()` makes it what *restarts*
  go back to. That one substitution is the whole feature: the detectors still
  watch, the rules still fire, and a goal calls the same `resetRobots` it
  always did, so a rehearsal repeats itself without anything driving it. The
  roster is whichever robots the arrangement names, so one robot alone, or
  robot 1 against robot 2, is an arrangement rather than a special case.
- **Placed by hand, in a browser.** A third bundle (`practice/`, on the
  referee console's pattern) draws the field from overhead and lets a team
  drag a robot or the ball, running or stopped. Where you drag something is
  where a re-stage puts it back.
- **Changed while it runs, the way a referee changes a match.** What happens
  when the situation resolves — play on, freeze, or set it up again — is a
  button, not a setting chosen up front.
- **A seat takes a submission, a built-in, or a laptop.** The sandboxed
  submission is the point of the phase; the built-in agent is an opponent to
  put in front of it; and the live `AGENT_PATH` connection Phase 1 promised as
  the practice loop finally has somewhere to point. A seat's program starts,
  stops and restarts without disturbing the situation around it — which is
  what makes "push a new version and watch it again" a five-second loop. A
  robot whose program is not answering comes off the field and goes back on by
  itself when it returns; there is no 5.7.2 stand-down, because restarting
  your own program in practice is not a sanction.
- **A field is a process, and several run at once.** A venue server started
  with `--practice-fields` spawns a child `MatchServer` per field and proxies
  it — HTTP and both WebSocket doors — under `/f/<id>/`, so one team
  rehearsing neither blocks the fixture on `/` nor needs a second port opened
  in a firewall. Fields are capped, shut themselves down once nobody is
  watching, and die with the server that started them.
- **Open to whoever has the link.** No token and no login, deliberately: the
  league has no accounts until Phase 6, and a second hand-issued credential
  would only be thrown away when it gets them. Nothing on a practice field is
  scored or recorded, so the worst a stranger can do on one is move somebody
  else's robot.
- **Not scored, not persisted.** No fixture, no result, nothing in a table.

Caught by playing it rather than by testing it: dragging the ball re-applied
the *whole* arrangement, so nudging the ball teleported all four robots back
to where the situation started. Remembering an arrangement and putting one out
had to become two different things.

## Phase 5 — Write it in a browser

*Gate: a student with a locked-down school laptop and no Python writes a
robot and submits it to the competition — with nothing installed but a
browser.*

> The gate used to say "writes a robot, **watches it play**, and submits it".
> Watching it moved to Phase 6 rather than being quietly left unmet: running a
> team's code needs a field that belongs to *them*, a queue for when the four
> fields are taken, and somewhere to watch it — and all three of those are
> questions about accounts, which is Phase 6's whole subject. Building them on
> top of a hand-issued token would have meant building them twice. This is a
> re-cut of where the line falls, not a lowered bar.

This is the accessibility argument the whole league rests on, taken at its
word. Every phase so far has assumed a machine a student controls: a Python
they can run, a folder they can push from, a terminal. The schools this league
is supposed to reach are the ones where none of that is true — and a team that
cannot install Python is not a team that enters late, it is a team that does
not enter.

- **Their code lives on the venue server, and runs there.** Not in the tab.
  The same CPython, the same `bwrap` sandbox with the same CPU and memory
  ceilings, the same simulator a scored match uses. This was very nearly built
  the other way — Pyodide in the tab, the whole simulator with it — and the
  argument against it is the one this codebase keeps making: a rehearsal under
  different conditions from the match is a rehearsal of a different sport. A
  robot that is comfortably fast enough in a browser's Python, with no sandbox
  and no ceiling, could blow its budget at the venue and the team would find
  out during the match.
- **A workspace is a folder, and nothing else.** The same shape as a
  submission — a `manifest.json` and some flat `.py` files — at
  `workspaces/<team>/<robot>/`. No database, no metadata, no per-team record:
  the files on disk *are* the state, the way a tournament is its draw plus
  whichever results exist. That is what makes submitting a copy through the
  existing validator rather than a conversion, and it means an admin can open
  a team's code in a text editor when something is wrong at eleven at night.
- **Editing is not submitting.** A workspace holds whatever the student last
  typed, including code that does not parse, because an editor that refused to
  save broken code is an editor you cannot use — you could not save halfway
  through a thought. The validator's opinion is asked at the moment they push,
  which is exactly where a team on a laptop is asked for it.
- **One way in, not two.** A workspace pushed from a browser and a folder
  pushed with `python/submit.py` go through the same `validateSubmission`, land
  in the same place on disk, and get the same join token minted beside them. A
  competition where the entry route changed the rules would not be a
  competition. A push that fails changes nothing: whatever last passed is still
  what will play.
- **Identity is a hand-issued team secret.** The same arrangement as Phase 1's
  push token and Phase 2's referee token — a secret per team, created by the
  admin running the venue, checked on every request. The team always comes from
  the token and never from the request body, which is the same rule Phase 1 put
  on the join for the same reason: a client that can name its own team can be
  any team. Registration is Phase 6's job, and when it arrives nothing about
  this page changes except where the secret comes from.
- **Opt-in, like everything else.** Without `--team-tokens` there is no
  workspace surface at all: `/workspace-api/*` answers 404 for everything, and
  a plain `serve` is byte for byte what it was.

**Watching it run is Phase 6's.** Until then a team is not stuck: they push
from the workspace, and an organiser puts that submission on a practice field
by team name, which works today and is unchanged. It is not the five-second
loop the practice field was built for — that arrives with the Run button — but
nobody is left unable to see their robot move.

**What this gives up, knowingly.** A team cannot practise with no server
reachable — at home the night before, or at a school that blocks the venue.
And the server now carries the load that a laptop used to: `maxFields` is
capped at 4 today, and thirty teams rehearsing at once is a real question this
phase does not answer either, which is the other reason Run waits for the
phase that can answer it.

---

## Phase 6 — Anyone can find the game

*Gate: a visitor with no venue access opens the site and sees what's upcoming,
what's in progress, and what already happened; a team registers itself instead
of being handed a token, presses Run on the code in its workspace, and watches
its own robot play.*

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
- **Run it from the workspace.** Phase 5 gave a team somewhere to write their
  robot and a way to push it; this is the button that puts it on a field and
  shows them what it did. Most of the machinery is already in place — a
  practice field is a process, a seat takes a program, and `spawnSeat` already
  captures the child's stdout *and* stderr, so the traceback a student needs is
  being produced and simply has nowhere to go yet. What is missing is a seat
  kind that runs a workspace rather than a submission (and mints a token to do
  it — `resolveLineup` skips any folder without one, so getting this wrong
  fills the seat with the built-in agent and lets a team watch the reference
  robot believing it is theirs), a per-seat output buffer the browser can read,
  and the three things below that are only answerable with accounts.
- **A field belongs to somebody.** Which team owns which field, what happens
  when they press Run twice, and what they get back when all four fields are
  taken. Phase 4 left fields open to whoever has the link on purpose; a team's
  own rehearsal is the first thing that needs to know who is asking.
- **Optional, not load-bearing.** A team spinning up the server locally for a
  single match still gets today's behaviour — no login, no front page, nothing
  to opt into. Accounts and the front page are a layer above `MatchServer`, not
  a path threaded through it, so running one game alone stays exactly as cheap
  as [the destination](#the-destination) demands.

---

## Phase 7 — See what your robot saw

*Gate: a team finds a real bug in their robot by scrubbing back to the tick
where it last saw the ball — without adding a print statement.*

A VS Code extension, for the team who has Python and is now losing matches for
reasons they cannot see. This is the single hardest thing about the league: a
robot that plays badly and a robot that is perceiving badly look identical from
the outside, and the only tool a team has today is printing things in a loop
that runs fifty times a second.

It is Phase 7 rather than part of Phase 5 because the two have nothing in
common but a target — Phase 5 is for a student who cannot run Python at all,
this is for one who can — and because one phase with two gates is a phase that
passes neither for months. It sits after Phase 6 because it does not block a
season from running, and because renumbering would strand the five places in
the source that already name Phase 6 as the one that builds accounts.

- **The trace, first and on its own.** Sensor and actuator frames per tick,
  recorded from a match, written as a file. Nothing records these today.
  It lands as a CLI flag and a file format before any extension exists,
  because a trace is useful to a team with a terminal on the day it works,
  and because a data layer designed inside an editor plug-in comes out shaped
  like that plug-in.
- **The inspector.** For the tick under the cursor: the IR ring with the
  sector that fired, the line sensors and what each was over, the four range
  beams and where they ended, and the goal blobs as arcs — the reading, not an
  interpretation of it, because working out what a blob means is the team's
  job and the thing they are here to learn.
- **A practice field that stops.** [`playLockstep`](src/lockstep.ts) already
  holds the world until every program has answered, and is already written as
  a diagnostic mode that a competition must never use. A practice field that
  runs under it gets step and pause honestly, with the match standing still
  rather than the connection timing out.
- **No `debugpy`, and no pip anything.** Real breakpoints were the obvious
  design and they cost a dependency, which is the one thing this league has
  refused at every turn. A field that steps plus a trace you can scrub answers
  "what did it see and what did it do about it", which is the question — and
  answers it for the team whose laptop would not have let them install a
  debugger either.
- **Scaffold, run, submit.** A team folder from the palette, a practice match
  against the reference agent, and a push to a venue server — the same three
  things [`python/submit.py`](python/submit.py) and the docs already describe,
  minus the terminal.

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
