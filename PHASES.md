# Phases

Where this is going, and the order it gets there in.

Each phase has a **gate**: one question, answered by playing rather than by
reasoning, the way Phase 0 was. A phase is done when the gate is a passing test,
not when the code exists.

> Reconstructed on 11 September 2026 from the original intent after the session
> holding it was cleared. Phase 0 is history; everything after it is a plan and
> can be argued with.

[END-STATE.md](END-STATE.md) describes what Phases 6 to 10 add up to — the whole
interaction, screen by screen and role by role. This file is the order; that one
is the destination.

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

`src/practice.ts` · `src/arenas.ts` · `practice/` ·
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

## Phase 6 — Accounts and the front door ✅

*Gate: a visitor with no account opens the site and sees what is upcoming, in
progress and already played; a team registers itself, logs in, and finds its
existing push credential and workspace exactly where they were.*

Passed. A draw of two teams was run under `league`; the front page showed the
fixture move from **next** to **on now**, with the score and clock ticking, to
**played**, to a record page carrying the seed, the code hashes and the whole
referee event log — all of it to a browser with no account. A team registered
from an invitation code, minted a push key, pushed with
`python3 python/submit.py --key …`, watched that push be refused when its
manifest named somebody else, and opened the browser editor with no secret to
paste. An organiser made from the terminal refereed the match from `/referee`
with no hand-issued token anywhere, and `bun run serve` still creates no
`league.db` and still serves the viewer at `/`.

`src/accounts.ts` · `src/capabilities.ts` · `src/authority.ts` ·
`src/league.ts` · `site/` · [docs/running-a-league.md](docs/running-a-league.md)

Phases 1, 2 and 5 each shipped a hand-issued secret and each said, in the same
words, that Phase 6 replaces where it comes from. This is that — and only that.
It was once a much larger phase; the rest of it is now Phases 7 to 10, because
"accounts, a front page, several arenas at once, fields that belong to somebody,
a run queue and a referee's pre-game" is six gates wearing one hat. See [END-STATE.md](END-STATE.md) for
what the four of them add up to.

- **Registration and roles.** Team registration, referee registration, an admin
  role. Four roles over a capability list, each capability scoped — a referee
  controls the match they are *assigned to*, not every match — so per-user
  grants are a row rather than a redesign.
- **Identity is the first mutable state, and it is fenced.** Accounts, sessions,
  grants, invites and the audit log in SQLite via `node:sqlite`, which costs no
  dependency. **The database holds who; the disk holds what happened.** Draws,
  results, match records, submissions, join tokens and workspaces stay files.
  Losing the database loses logins, never a season.
- **The tokens keep working, from a new source.** A push credential becomes an
  API key minted from the team's account, so `python/submit.py` is unchanged. A
  referee token and a workspace secret become a session. The per-submission
  join token does not change at all — it was never an account credential.
- **A front page.** Upcoming fixtures, matches in progress linking through to
  the live viewer, and past results — built on the records and fixture list
  Phase 3 already persists, which is why this comes after it. Visitors need no
  account: watching stays open and the viewer stream stays untrusted by design.
- **One site, role-gated.** Referee, team and admin areas are separately built
  chunks the server refuses to a session without the capability, so a spectator
  never downloads match-control code — Phase 2's rule, kept as a server rule
  rather than a build artefact.
- **A way in from outside the browser, because the circle has to break
  somewhere.** The first admin cannot be made from a page that requires an
  admin to log into, so `account` and `invite` join the CLI. This is also a
  debt the database choice incurred: the standing promise that an organiser can
  fix the broken thing in a text editor at eleven at night still holds for
  workspaces, submissions, draws and results, and no longer holds for accounts.
  `account --passwd` rebuilds that hatch for the failure most likely to happen
  under pressure — somebody cannot log in, twenty minutes before their match.
- **Optional, not load-bearing.** `serve` on a laptop is untouched: no login, no
  front page, no database file created, nothing to opt into. Accounts are a
  layer above `MatchServer`, never a path threaded through it. The seam that
  buys this is one injected object: `MatchServer` asks an `Authority` who is
  making a request, and is handed the hand-issued one by default and an
  account-backed one by a league server. It is a function reference, not a
  database, and 407 existing tests passing unchanged is the proof.

**Found while building it, and worth writing down: `POST /submit` had no
authentication at all.** The team came from the pushed `manifest.json`, so
anybody who could reach a venue server could push over anybody's robot. Phase 1
wrote the rule down — *a secret enough to bind a push to a team name* — and
built it only for the workspace push, which got it for free by going through a
token. So this phase is not moving the push credential to a new source; it is
the first time the laptop push is authenticated, and `python/submit.py` gained
the `--key` it always should have had.

Caught by playing it rather than by testing it, four times:

- **Importing `node:sqlite` is what emits its experimental warning**, so a top
  level import in `cli.ts` made every command in the CLI print it — including
  `match`, `bench` and the plain `serve` this phase promised to leave alone.
  The accounts layer is now imported inside the three commands that use it,
  which also means a laptop never loads a database driver it will never open.
- **The viewer's assets were absolute**, so mounting it at `/live/` fetched the
  *site's* `/assets/…` and the spectator page arrived unstyled and stuck on
  "connecting…". The practice and workspace bundles had already solved this
  with a relative base; the viewer had never needed it, because until now it
  was only ever served from `/`. It was also silently wrong under `/f/<id>/`.
- **Both existing consoles demanded a token that no longer exists.** The
  referee console and the workspace editor each open on a login screen asking
  for a secret, and on a league server the person is already signed in. Both
  now ask the server whether it knows them before showing it — which is the
  difference between the console opening and a referee hunting for a string
  nobody issued them.
- **The site went down when the last fixture ended.** `league` began as
  `tournament` with a front door on it, and a tournament is a batch job: it
  prints the table and stops. A venue's front door is not — the moment the
  final whistle goes is the moment everybody opens the table. Playing the draw
  out was the only way to find it; every test and every earlier run stopped
  while fixtures remained.

---

## Phase 7 — The league server supervises ✅

*Gate: two fixtures and a practice field play at once on one server, and the
admin console says honestly how much of the machine that is using.*

Passed. A four-team draw ran under `league` with two fixtures in flight at
once — Alpha v Bravo and Charlie v Delta, each in its own child process with
four sandboxed robots — while an organiser held a practice field open beside
them. Both were refereed from a browser at `/a/<id>/referee/`, with no token
anywhere; the front page showed two live cards ticking to a visitor with no
account; `/admin` reported 3 arenas of 6, against 10 this machine guarantees,
using 0.05 of 22 cores and 323 MB of 30 GB, and stopping the practice field
from that page moved the numbers. The hub was killed mid-fixture and restarted:
it resumed at the fixture that never finished and started two more. `serve` on
a laptop still creates no `league.db`, still serves the viewer at `/`, and
still opens practice fields on `/f/<id>/`.

`src/arenas.ts` · `src/arena.ts` · `src/capacity.ts` · `src/usage.ts` ·
`src/settings.ts` · `src/measure.ts` · `src/team-api.ts`

One `MatchServer` is one world, one viewer broadcast, one gateway over four
fixed seats. A hall with three live fixtures and four teams rehearsing needs
seven of all of that. [`src/arenas.ts`](src/arenas.ts) already answered this
once — a child process per field, proxied back through the one port the venue
configured — and this is that answer taken seriously.

Nothing here knows whose field is whose. That is Phase 8, deliberately: this
phase is *can one machine hold several worlds and tell the truth about it*, and
a competition day is meaningfully shorter the moment two fixtures can play at
once, whether or not practice has grown owners yet.

- **The hub plays no football.** A league server owns accounts, the draw, the
  schedule and the front page, and spawns a child `MatchServer` per world. The
  same binary a team runs on a laptop is what runs a final. Phase 6 knowingly
  contradicted this by keeping one world in-process; this is the phase that
  restores it, and what made it possible to finish was noticing that a team's
  two doors — pushing code and editing it — are not football either. They moved
  to [`src/team-api.ts`](src/team-api.ts), mounted by the hub and by a match
  server alike, so the hub holds no world at all rather than one it never plays.
- **`FieldSupervisor` becomes `ArenaSupervisor`.** An arena has a kind —
  fixture or practice — and a place in the budget. `/f/<id>/` keeps working,
  because it is in the docs and in students' history.
- **Arenas die with the hub, and that is honest.** Nothing to resume a physics
  loop and four sandboxed children from; a fixture interrupted this way writes
  no result and is replayed, which Phase 3 already guarantees.
- **Two fixtures at once, with one rule.** The draw runner holds several
  fixtures in flight and starts the first whose teams are both free: **no team
  may be in two matches**, because a team has two robots and two robots cannot
  be on two pitches. Phase 8 restates that as one-robot-one-place; it is forced
  here already. A fixture that cannot be played is left unwritten and replays,
  and the others in flight are played out rather than abandoned — but the run
  still fails loudly unless the caller says otherwise, because a batch
  `tournament` that swallowed a broken fixture would print a table with a hole
  in it and say nothing.
- **A measured budget, and an admin's number.** `maxFields` was 4 because 4 was
  a guess made before anything had been measured. It has been measured now: an
  arena of four real robots costs **0.23 cores and 146 MB**, against a
  **granted 2 cores and 2 GB** — and a robot written to spend its grant gets
  exactly 50.0% of a core, because the cgroup is real. So the ceiling became an
  admin setting checked against the actual machine, showing three numbers
  rather than one: what you set, what the hardware guarantees, and what is in
  use right now. The last of those is read from `/proc` per process
  ([`src/usage.ts`](src/usage.ts)) rather than multiplied out of grants — a
  grant is about twelve times what a real robot uses, so a console built on
  grants reports a machine at capacity while it sits nearly idle. Exceeding the
  ceiling is allowed, with a warning that names the consequence rather than
  grading the risk.
- **Capacity is derived, and policy may only subtract.** `arenas.max` less
  however many fixtures the schedule runs at once is what practice can afford,
  so **a fixture never queues behind a rehearsal** without anyone remembering
  to arrange it. An organiser's `practice.max` sits on top and may only lower
  that, never raise it — a second number able to contradict the first is the
  thing this codebase keeps refusing.
- **Settings are a file, not a table.** `league.json` sits beside `league.db`,
  hand-editable at eleven at night like every other piece of state here; the
  database still holds only *who*. A broken file starts the server anyway and
  says what it ignored, because an organiser with a stray comma twenty minutes
  before a match needs a server that comes up.
- **`capacity`, so the budget can be checked before the day.** Without
  `--measure` it computes from `os.cpus()`, `os.totalmem()` and
  [`sandboxUnavailableReason()`](src/sandbox.ts) — which already existed, was
  already phrased for an operator to fix, and until now was only ever reached
  at spawn time, which is to say during a match. With `--measure` it runs one
  real arena for half a minute against the repo's own example robots and prints
  what it cost. A fixed calibration robot rather than a pushed team, because
  nobody has pushed anything the week before an event, which is when this gets
  asked.
- **One seat grant, for practice and finals alike.** The tempting lever is
  shrinking practice seats to fit more in, and it is not available: a rehearsal
  under different conditions is a rehearsal of a different sport, which is the
  argument that [rejected Pyodide](#phase-5--write-it-in-a-browser). The grant
  goes into the match record beside the seed and the code hashes, because it is
  a condition of play. See [The arena budget](END-STATE.md#the-arena-budget).

**Refereeing, in the interim.** `/referee` is a list of the matches in
progress, and the console itself opens on the arena playing one. The hub is
what decides — from a session and a capability — that this person may control
this match, and it replaces their browser's credential with a token only it
and the child know on the way through. That check *has* to live in the hub: a
child can only ever see its own world, so leaving it to the children would mean
every arena looking correct on its own while anybody holding an arena id could
kick off a final. Phase 10 replaces the list with real assignments.

Caught by playing it rather than by testing it:

- **The same absolute-path bug, for the third time.** The referee console asked
  for `/referee-api/…`, opened its socket at the server root, and was built
  with `base: '/referee/'` — all correct while a server had exactly one world
  and the console had exactly one address. Served at `/a/<id>/referee/` the
  first two arrive at the hub's front door, and the third fetches
  `/referee/assets/…`, which is a *page* route, so the browser gets HTML where
  it asked for JavaScript and the console never starts. The viewer hit this in
  Phase 6 and the practice console in Phase 4; relative is the answer every
  time, because a bundle does not get to know where it is mounted.
- **A redirect must be relayed, not followed.** `fetch` follows redirects by
  default, so the child's `/referee` → `/referee/` was consumed by the hub and
  the browser stayed on the slashless address — where the console's relative
  assets resolve one directory too high, onto the *viewer's* assets, arriving
  looking broken rather than missing. The `location` had to become relative
  too: an absolute `/referee/` relayed through a hub sends the browser to the
  hub's own front door.
- **The front page read `live` as one thing.** It had been one thing since
  Phase 6 and is now a list, and the site crashed on `live.score` rather than
  showing nothing — the one place where "several at once" was visible to a
  spectator and the last place it was carried through.

## Phase 8 — A field belongs to a team ✅

*Gate: a team opens a field that is theirs and invites another team onto it;
the same robot cannot be started anywhere else while it is in a seat; and when
a fixture falls due the hub takes that team's robots back and says so.*

Passed. ACT Robotics opened a field from their own page and invited NSW
Lightning by name; the invitation arrived on NSW's page rather than as a link,
they accepted, seated their robot 1 on it, and could not touch ACT's seats or
start the field. ACT's attempt to seat NSW's pushed robot was refused, and NSW —
already a guest — still opened a field of their own, because a guest spends no
field allowance. With robot 1 seated on ACT's field, the same robot asked for a
seat on NSW's and was told *robot 1 is already in the lime-1 seat on
act-robotics's practice field*. A laptop seat minted a token, printed one
command, and `python/examples/striker.py` joined through it **unedited**; the
token never appeared in the field's state, and a stale one was refused by name.
With two fields open on a server with room for two, a third team got a queue
position; closing one held it for them for the claim window, passed it on when
it lapsed, and the team that had gone home dropped out. When the second fixture
opened, the two teams' own fields closed and ACT's guest seat on QLD Thunder's
field emptied with a line saying why, while QLD's field played on. `arenas`
listed all of it from a terminal with an admin key, refused a team's key, and
stopped one. `serve --practice-fields` still opens a field to anybody with the
link, with no `league.db` anywhere, and `serve practice` still binds every
interface and still takes a self-declared laptop join.

`src/occupancy.ts` · `src/tenancy.ts` · `python/join.py`

> This and [Phase 9](#phase-9--run-it-and-give-it-back) were one phase until
  16 Sep 2026. Its gate had three clauses joined by "and" — press Run, *and*
  one robot in one place, *and* a field that comes back on its own — which is
  the shape [Phase 7 was already split out of](#phase-7--the-league-server-supervises).
  The seam is the same one that cut 7 from 8: this phase is **whose field, and
  whose robot**, and it is entirely the hub growing a ledger and stopping being
  a transparent proxy. Phase 9 is what a team does with a field once it has
  one, and both halves of it read and write the same workspace folder.

Phase 4 left practice fields open to whoever had the link, on purpose, because
the league had no accounts. Phase 6 built the accounts and Phase 7 built the
room for several fields to exist. This is the phase where a field stops being
anonymous.

- **A field belongs to somebody.** Which team owns it, what a second request
  for one does, and who may drag whose robot. A team can invite another team by
  name and the invitation lands on their dashboard, not as a link to paste.
- **One robot, one place.** Not a setting — a rule: **each of a team's robots
  may be in exactly one seat, anywhere on the server, at any moment.** Nothing
  technical forces it; the sport does, because a team has two robots and two
  robots cannot be on two fields. It makes "what is my robot doing right now"
  answerable, and it removes the fixture conflict without a second rule: during
  their match both robots are seated, so there is nothing left to rehearse
  with. It is also what makes one field per team, at most two, a derived
  ceiling rather than a guess — two is reachable only by splitting robot 1 onto
  one field and robot 2 onto another.
- **Ownership and occupancy are separate ledgers.** A guest spends no *field*
  allowance, so accepting an invitation never costs a team their own field; it
  does spend their own *robot* occupancy, because their robots really are in
  seats.
- **A laptop robot stops being anonymous.** Today a `laptop` seat
  [clears the token](src/practice.ts) — "a practice field is not where identity
  is being proved" — and a self-declared join is one the ledger cannot count.
  The team names which of its robots is joining, the hub mints a short-lived
  join token for that seat, and the student passes it the way `submit.py`
  passes a key. This is Phase 1's rule arriving where it was skipped: identity
  comes from the token, not the client's say-so.
- **The check lives in the hub, and that is a real change.** It proxies
  `/a/<id>/` blindly today and a child can only see its own field, so seat
  requests stop being transparently forwarded. Get this wrong and every field
  looks correct on its own while a robot plays in two places.
- **And the hub becomes the only door.** A practice arena binds every interface
  today; only fixtures get `--host 127.0.0.1`. That leaves its `/practice-api/`
  and its `/agent` reachable on a port the hub knows nothing about, which makes
  the ledger advisory for anyone who can read a port number. Under a hub, a
  practice arena binds loopback like a fixture does and everything arrives
  through the one configured port — which is what [`arenas.ts`](src/arenas.ts)'s
  own header already argues for. Standalone `serve practice` keeps binding
  wide: it has no hub in front of it.
- **A fixture pre-empts practice.** Without an explicit winner the invariant
  deadlocks at the worst moment of the day: a team whose robot is still held by
  an abandoned field cannot be seated in their own match. When the fixture's
  arena opens, the hub takes the robots back, empties whatever practice seat
  held them, and says so on the field and on the owner's dashboard.
- **A queue, not an error.** A team over the line is told where they are and
  what is ahead of them. When a field frees, the team at the front is notified
  and has a short window to claim it; unclaimed, it passes to the next team —
  because handing a field to somebody who has gone home starts an idle clock on
  an empty field and stalls everyone behind them for the whole quiet period.
  Practice arenas are shed first when the budget is over, because a rehearsal
  can wait and a scheduled match cannot.
- **`arenas` from the terminal.** Listing what is running and stopping one is
  on the admin screen, and also needs to work when the admin screen is the
  thing that has gone wrong.
- **The team's dashboard stops being a stub.** Where their field is, which of
  their robots is in which seat, where they are in the queue, and an invitation
  waiting to be accepted. [`dashboard()`](site/main.ts) said in its own comment
  that this is the phase that fills it in, and it is.

**Two ledgers, and they are not the same ledger.**
[`src/tenancy.ts`](src/tenancy.ts) is about fields — who owns one, who has been
invited onto it, how many a team may hold, who is waiting. `src/occupancy.ts` is
about robots. Keeping them apart is what keeps invitations alive: a guest spends
no *field* allowance, so accepting one never costs a team their own right to
open a field, while their robots genuinely do occupy seats and are counted
there. Neither is persisted, for the reason arenas are not: they die with the
hub, so the two can never disagree about what is running.

**Running a field and being on one are two questions, so they are two
capabilities.** `field.control` is drag, start, re-stage, invite, close, and a
team holds it only over a field they opened. `field.join` is *may they be here
at all* — and a guest holds that by invitation rather than by capability,
because a guest list is a ledger and not a role. Each team fills the seats
holding its own robots, owner and guest alike, which is what stops anybody's
robot occupancy being spent by somebody else's click. One visible consequence,
recorded because it is a change: rehearsing against another team's *pushed*
robot is no longer something a team can do alone. That team's code is theirs;
they can come onto the field and put it in a seat themselves.

Caught by playing it rather than by testing it:

- **A slot came free before the queue heard about it.** `close()` took an arena
  out of the supervisor's map immediately, but the ledgers were emptied by the
  child's `exited` handler a few milliseconds later — and in that window
  capacity said yes while nothing was being held for anybody, so the next team
  to press the button walked past everyone waiting. An arena is now declared
  over exactly once, at whichever of the two comes first.
- **Every join refusal reached the student as "connection is closed".**
  `WebSocket.close()` in [`python/rcja_soccer/_ws.py`](python/rcja_soccer/_ws.py)
  marked the socket closed *before* sending the courtesy close frame, so its own
  guard rejected it and `close()` raised every single time — and because
  `Robot._play` closes in a `finally`, that exception replaced whatever had
  actually gone wrong. A bad token, a seat already taken, a protocol from last
  season: all of them arrived as the one thing it never was. Invisible until
  this phase, because until now nobody typed a token by hand.
- **The practice console had stopped being able to change a seat at all.** It
  sends `{seat, fill, team}` with `fill` as a bare string, which is what the
  hand-written check took; when the endpoints
  [grew schemas](src/api/schemas.ts) the shape became `{seat, fill: {kind,
  team}}` and the console was not moved with them. The tests were, which is why
  nothing said so. Fixed toward the nested form, because that is the shape a
  seat already comes *back* in — the asymmetry is what hid it.

---

## Phase 9 — Run it, and give it back

*Gate: a team presses Run on the code in its workspace and watches its own
robot play; when it crashes they read the traceback in the browser; and a field
they walk away from comes back on its own, with their arrangement intact.*

Phase 8 made a field belong to a team. This is what the team does with it — and
the two halves belong together because they are the same folder: Run reads the
team's code out of the workspace, and giving a field back writes the
arrangement into it. It is also where a team finally gets the Run button
[Phase 5 deferred](#phase-5--write-it-in-a-browser), because Run is meaningless
until there is a field that belongs to the person pressing it.

- **Run it from the workspace.** A seat kind that runs a workspace rather than
  a submission — and mints a token to do it, because
  [`resolveLineup`](src/lineup.ts) skips a folder without one and a team
  watching the reference agent believing it is theirs is the worst possible
  failure. What a second Run does, and whether it disturbs the other three
  seats, follows Phase 4's rule that a seat starts and stops on its own.
- **A traceback has somewhere to go.** A per-seat output buffer the browser can
  read: [`spawnSeat`](src/lineup.ts) already captures stdout and stderr and
  sends both to a log line nobody at a venue is watching. The student whose
  code does not parse needs that text, and today the only symptom is a seat
  that says "not answering".
- **A field is given back when its team stops using it.** Configurable quiet
  time, then a warning on the field and the owner's dashboard, then closing —
  warned, never silently killed. A person present or an interaction resets the
  clock; **a connected robot does not**, which is a change from today, where
  [`trackConnection()`](src/arenas.ts) feeds one counter from `/agent` upgrades
  and viewer sockets alike and one forgotten laptop program holds an arena all
  day. Pressure scales with the queue rather than a flat maximum lifetime: be
  generous when nobody is waiting, warn the longest-idle field first when
  somebody is. See [Giving a field back](END-STATE.md#giving-a-field-back).
- **Closing costs a process, not an afternoon.** The Phase 4 `Arrangement` is
  saved to the team's workspace folder and restored when they open a field
  again. An arena holds a physics loop and four CPython processes and is not
  worth persisting; the setup somebody spent twenty minutes dragging into place
  is.

---

## Phase 10 — The referee's day

*Gate: a referee is assigned a fixture, takes it from pre-game through to a
confirmed result that appears in the table, and never opens a terminal.*

Phase 2 built the console and stopped at the whistle. What a refereed
competition actually needs around it is the twenty minutes before kick-off,
where the teams arrive, the code is loaded, and somebody decides that this is
the code that plays.

- **Assignments.** The next game and the ones after it, with times and teams.
- **Pre-game.** Opening it spawns the fixture's arena and shows a checklist:
  four seats, who has joined, the code loaded in each seat by hash and push
  time, and the validation result already produced at push time shown here
  rather than only in the push response.
- **Lineup lock.** The moment a push stops affecting this match, visible from
  both sides — before it, a team may push and the match will use the new code;
  after it, the match plays what was locked and the team's dashboard says so.
  Without an explicit lock, "did my fix make it in" is a race between an HTTP
  request and a whistle.
- **The console, unchanged in function.** Kick off, pause, end half, abandon,
  award a kick-off, remove a robot under 5.7 and agree it is repaired before it
  returns, correct the score with a reason recorded against the match.
- **One confirmation writes the result.** The referee agrees the score and that
  is what commits the fixture — the same whole-or-nothing write
  [`tournament-store.ts`](src/tournament-store.ts) makes today, which is why an
  unconfirmed fixture leaves nothing behind and is simply replayed.

---

## Phase 11 — Administering a venue

*Gate: an admin reschedules a fixture, stops a runaway practice field, fixes a
team's mis-uploaded file, and re-runs an abandoned game — all from a browser,
with the audit log saying who did each one.*

Last, because it is the only one of these whose absence can be worked around
with a terminal and an ssh session. Not optional, though: at a real event the
person holding this screen is the one being shouted at.

- **Every arena, and the button to stop it.** Kind, owner, age, CPU, memory.
  A venue's failure mode is four things running that should not be and nobody
  knowing which machine they are on.
- **Team files.** A team's workspace and submissions, readable and editable,
  because sometimes a student uploaded the wrong file and the fastest fix is an
  organiser fixing it in front of them. Every edit is an audit row.
- **Manual game editing, without breaking the draw.** `draw.json` is written
  once and never rewritten, deliberately — that is what makes resuming a
  consequence and a fixture replay as itself. So an amendment is an **appended
  record**: what changed, who changed it, and why. The effective draw is the
  draw folded with its amendments, exactly as the table is the results folded
  together. Rescheduling, substituting a withdrawn team and voiding a fixture
  all become possible without the tournament being able to disagree with itself.
  `amend` is its CLI pair, because `draw` already writes a draw from the
  terminal and the two belong at the same altitude.
- **Officials and people.** Assign referees to fixtures; manage accounts, roles
  and per-user capability grants.
- **An audit log.** Every privileged action, its actor, its target and its time.

---

## Phase 12 — See what your robot saw

*Gate: a team finds a real bug in their robot by scrubbing back to the tick
where it last saw the ball — without adding a print statement.*

A VS Code extension, for the team who has Python and is now losing matches for
reasons they cannot see. This is the single hardest thing about the league: a
robot that plays badly and a robot that is perceiving badly look identical from
the outside, and the only tool a team has today is printing things in a loop
that runs fifty times a second.

It is its own phase rather than part of Phase 5 because the two have nothing
in common but a target — Phase 5 is for a student who cannot run Python at all,
this is for one who can — and because one phase with two gates is a phase that
passes neither for months. It sits last because it does not block a season from
running: everything before it is needed to hold an event, and this is needed to
get good at one.

> It was Phase 7 until the accounts work was split into
> [6 through 10](END-STATE.md), and it has drifted up twice since. Renumbering
> stays free above 6 and nowhere else — eight places in the source name Phase 6
> as the one that builds accounts, and Phase 6 still is; nothing in the source
> names any phase above it.

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
