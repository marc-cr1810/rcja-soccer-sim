# The end state

What the whole thing looks like when it is finished, and who sees what.

[PHASES.md](PHASES.md) says where this is going and in what order. This says
where it arrives. It is a description of an interaction, not a schedule — read
it as the thing the phases are trying to become, and argue with it before the
code exists rather than after.

> Written 14 September 2026, after Phase 5. Everything described as *today* was
> in the repository then; everything else was a proposal.
>
> Since then Phases 6 and 7 have landed, so parts of this are now simply a
> description: accounts and the front page, the hub that supervises rather than
> plays, the arena as a child process under `/a/<id>/`, the measured budget and
> its three numbers, and `capacity`. What is still a proposal is everything an
> arena *belongs* to somebody — ownership, the Run button, the queue,
> reclamation — the referee's pre-game and lineup lock, and the administration
> screen. [PHASES.md](PHASES.md) is the authority on which is which.

---

## Two deployments, one binary

The single most important shape in here is that there are **two ways to run
this, and the second one contains the first**.

**A match server** is what exists today. One machine, one process, one world.
A team runs it on a laptop, pushes robots at it, and watches. No accounts, no
front page, no database, no network beyond the one they are sitting on.

```bash
bun run serve                                  # a server, playing matches
python3 python/submit.py --url http://localhost:8080 --dir my-team/robot1
```

This is not a degraded mode or a development convenience — it is the cheap
entry the whole league rests on, and [the destination](PHASES.md#the-destination)
demands it stay exactly this cheap. A team practising in a classroom should
never have to stand up an identity system to see their robot move.

**A league server** is the tournament deployment. It owns accounts, the draw,
the schedule, and the front page — and it plays no football at all. Every world
it runs is a **match server child process**, the same binary above, supervised
and proxied. That is the whole architecture in one sentence: *the league server
is a front door and a supervisor; the football happens in children that do not
know there is a league.*

```bash
bun run serve -- league --port 80 --data ./league
```

Why this way: `MatchServer` is one world, one viewer broadcast, one gateway
over four fixed seat ids. A hall with three live fixtures and four teams
rehearsing needs seven of all of that. Teaching the most load-bearing file in
the repository to hold N of everything is the alternative, and it means one
team's runaway robot shares a process with the final. [`src/arenas.ts`](src/arenas.ts)
already proved the other way works — child per field, reached back through the
one port the venue configured, so a robot on a student's laptop still has
somewhere to connect and the venue still opens one hole in one firewall.

### Arenas

Generalise the practice field into an **arena**: a child `MatchServer` holding
one world, proxied under `/a/<id>/`. Two kinds, differing in almost nothing:

| | fixture arena | practice arena |
|---|---|---|
| comes from | the draw | a team pressing Open |
| refereed | yes | no |
| scored | yes — writes a fixture result | never |
| lineup | bound at pre-game, then locked | changed any time, live |
| who may act on it | the assigned referee, an admin | its owner, their guests, an admin |
| lives for | the fixture | until idle, or until its owner closes it |

`FieldSupervisor` becomes `ArenaSupervisor` and learns a kind, an owner and a
capability check. `/f/<id>/` keeps working as an alias, because it is in the
docs and in students' browser history.

**Arenas are not persisted.** A league server going down takes every arena with
it, exactly as a venue server takes its practice fields today. That is honest
rather than lazy: the child is a process holding a physics loop and up to four
sandboxed CPython processes, and there is nothing meaningful to resume it
from. A fixture interrupted this way leaves no result and is replayed, which is
[what Phase 3 already guarantees](PHASES.md#phase-3--a-tournament-runs-itself-).

---

## What is in the database, and what is very deliberately not

Accounts are the first genuinely mutable state this codebase has had. Everything
so far is files that are written once — a draw, a fixture result, a submission,
a workspace folder — and the absence of a state file is load-bearing in three
separate phases.

So the rule is a line, not a preference:

> **The database holds who. The disk holds what happened.**

`league.db` holds accounts, sessions, roles, grants, invites, referee
assignments and the audit log. It holds nothing about a match. Draws, fixture
results, match records, submissions, join tokens and workspaces stay where they
are, as files, unchanged. Delete `league.db` and you have lost your accounts —
not a season, not a table, not a team's code. An admin can still open a team's
robot in a text editor at eleven at night, which is the property
[`src/workspace.ts`](src/workspace.ts) was designed around.

SQLite costs no dependency: `bun:sqlite` is built into Bun, with no
experimental warning to quieten, so the league server needs the same
`bun install` the match server does.

A sketch, not a schema:

```
accounts     id, kind (team|person), slug, display_name, email,
             password_hash, created_at, disabled_at
api_keys     id, account_id, hash, label, created_at, revoked_at
sessions     id, account_id, created_at, expires_at, revoked_at
grants       account_id, capability, scope, target        -- per-user extras
invites      code, role, team_id, created_by, expires_at, used_at
assignments  tournament_id, fixture_id, referee_account_id
audit        at, actor_id, capability, target, detail
```

Note what is missing: no arenas table (they die with the hub), no results table
(the files are the results), no standings table ([`deriveTable`](src/tournament.ts)
folds it on every read, and that is why it can never be stale).

### The hand-issued tokens do not disappear — they get a source

Three token schemes exist today: the push credential, the referee token and the
team workspace secret. Every one of them was written as *"the same shape as the
others, and Phase 6 replaces where it comes from"*. Hold to that exactly:

- A team's push credential becomes an **API key** minted from their account.
  `python/submit.py` keeps working, with a key they generated instead of one an
  organiser typed.
- The referee token becomes a session. The referee console keeps its own path
  and its own bundle.
- The workspace secret becomes the same session.
- A match's **join token** — minted beside a submission at push time, checked at
  the seat — does not change at all. It was never an account credential; it is
  how a seat knows which folder is allowed in it, and it stays that.

A match server run standalone still accepts a hand-issued token for all three.
Nothing about accounts is threaded through `MatchServer`; it is a layer above.

---

## Roles and capabilities

Four roles, each a named set of capabilities, each capability carrying a scope.
Checks are `can(actor, capability, target)` from the first line of code, so
"this referee may also amend the draw" is a row in `grants` rather than a fifth
role invented under pressure.

Scope is the part that matters: a referee may control **the match they are
assigned to**, not every match.

| capability | guest | team | referee | admin |
|---|---|---|---|---|
| `match.watch` | ✓ | ✓ | ✓ | ✓ |
| `results.read` | ✓ | ✓ | ✓ | ✓ |
| `match.join` | | own fixture | | any |
| `team.workspace.write` | | own | | any |
| `team.submit` | | own | | any |
| `field.open` | | ✓ | ✓ | ✓ |
| `field.control` | | own | | any |
| `field.invite` | | own | | any |
| `field.join` | | invited | ✓ | ✓ |
| `fixture.setup` | | | assigned | any |
| `match.control` | | | assigned | any |
| `match.score.correct` | | | assigned | any |
| `match.abandon` | | | assigned | any |
| `arena.list` / `arena.kill` | | | | ✓ |
| `tournament.create` / `.amend` | | | | ✓ |
| `referee.assign` | | | | ✓ |
| `account.manage` | | | | ✓ |
| `capability.grant` | | | | ✓ |

`field.control` and `field.join` answer two different questions about the same
field, which is why both exist: *may they run it* — drag, start, re-stage,
invite, close — and *may they be on it at all*. A team holds the first only over
a field they opened; a guest holds the second by invitation rather than by
capability, because a guest list is a ledger and not a role. Both are targeted
by the field's **owner**, so `own` means "a field of mine".

**Guests need no account at all.** Watching is open, and the viewer stream stays
untrusted by design — that is [Phase 2's stated position](PHASES.md#phase-2--a-referee-runs-the-match)
and nothing here weakens it. Only entering, refereeing or administering needs a
login.

---

## The front end

One site, one look, one login. Referee, team and admin areas are **separately
built chunks that the server refuses to a session without the capability** — so
the old guarantee ("the referee console is never reachable from the spectator
bundle") survives as a server rule rather than a build artefact, and a spectator
never downloads code for controlling a match.

The hall screen stays its own bundle: chrome-free, session-free, nothing to log
into and nothing to click, because it is going on a projector.

### Anyone, no account

```
/                     what is on now, what is next, what happened
/live                 every match in progress
/m/<match>            one match: live → watch it; finished → summary and record
/schedule             fixtures by division and time
/standings            the table, folded from results
/t/<team>             a team: fixtures, results, and their record
/screen/<match>       the hall projector view
```

The front page is three bands. **Now playing** — a card per live fixture arena
with score, half and clock, clicking through to the live viewer. **Up next** —
the next fixtures, whose teams, and whether the referee has opened pre-game yet.
**Results** — recent scores and the division tables.

A finished match's page is built entirely out of what Phase 3 already writes:
the seed, the sha256 of the code that played in each seat, and the referee event
log kept whole. That log is a timeline for free — goals, kick-offs, 5.7
stand-downs and returns, lack-of-progress calls, ball-out-of-play, every referee
action that took effect and when. Stats across a division are that log
aggregated, and need nothing new recorded to exist.

### A team

```
/team                 dashboard: your next game, and what to do about it
/team/code            the workspace editor, and what will play
/team/practice        your field
/team/fixtures        your games, past and future
/team/settings        API keys, members
```

**The dashboard is one big changing state**, because a team at a venue has
exactly one question at any moment and it is "what do I do now":

> *Round 2 · v NSW Lightning · 14:20 on field B*
> — **not yet** → *the referee has not opened this game*
> — **open** → **Join** (the button that binds your robots to your seats)
> — **joined** → *robot 1 ✓ robot 2 ✓ · waiting for NSW Lightning*
> — **locked** → *lineup locked · kick-off in 40s* — and pushing no longer
>   changes this match
> — **playing** → the live view, the score
> — **done** → the result, and a link to the record

**Code** is one page with two doors into the same folder: the browser editor
from Phase 5, and `python/submit.py` from a laptop. One list of versions, each
with its hash and when it was pushed, and one of them marked *this is what will
play*. A team that cannot install Python and a team that lives in vim see the
same list — that is Phase 5's "one way in, not two", made visible.

**Practice** is a field that belongs to them. Open it, and it is theirs: they can
drag robots, fill seats with their own submissions, the built-in agent, or a
program on their own laptop, and **press Run on whatever is in the workspace
right now** — the five-second loop the practice field was built for. They can
**invite another team by name**, and the invitation shows up on that team's
dashboard rather than as a link to paste; the guest can join and fill a seat
with their own robots, and cannot change the owner's. When every arena slot is
taken they get a **queue position**, not an error — and a queue is the honest
answer to "thirty teams rehearsing at once", which
[Phase 5 flagged and did not answer](PHASES.md#phase-5--write-it-in-a-browser).

Run also needs somewhere to put a traceback. `spawnSeat` already captures the
child's stdout *and* stderr; a per-seat output buffer the browser can read is
the missing half, and it is the difference between "my robot did not move" and
"line 40, `NameError`".

### A referee

```
/referee                        your assignments
/referee/m/<match>/setup        pre-game
/referee/m/<match>              the console
```

**Assignments** is the next game and the ones after it, with times and teams.
A referee at a venue should be able to look at one screen and know where to
stand.

**Pre-game** is the piece that does not exist today and is the most
consequential new interaction in this document. Opening it spawns the fixture's
arena and shows a checklist:

- four seats, and which team's robot belongs in each
- who has joined and who has not
- the code that will play in each seat, by hash and push time — so a team that
  pushed a fix ninety seconds ago can *see* that the fix is the thing loaded
- a per-seat validation result, already produced by `validateSubmission` at push
  time, shown here rather than only in the push response
- **Lock lineup**, which is the moment a push stops affecting this match

Locking is a real rule and it wants to be visible from both sides: before it, a
team may push and the match will use the new code; after it, the match plays
what was locked and the team's dashboard says so. Without an explicit lock, "did
my fix make it in" is decided by a race between an HTTP request and a whistle.

**The console** is what Phase 2 built, unchanged in function: kick off, pause,
resume, end half, end match, abandon, award a kick-off to the other side, remove
a robot under 5.7 and agree it is repaired before it returns, correct the score
with a reason recorded against the match.

**Post-game** is one confirmation. The referee agrees the score, and that is what
writes the fixture result — the same whole-or-nothing write
[`tournament-store.ts`](src/tournament-store.ts) already makes, which is why an
abandoned or unconfirmed fixture leaves nothing behind and simply gets replayed.

### An admin

```
/admin                overview: arenas, load, anything stuck
/admin/tournaments    draws, fixtures, assignments
/admin/arenas         everything running, and the button to stop it
/admin/teams          accounts, their files, their submissions
/admin/people         accounts, roles, per-user grants
/admin/audit          who did what, and when
```

**Arenas** is the operational screen: every child process, its kind, its owner,
how long it has run, its CPU and memory, and a stop button. A venue's real
failure mode is not a subtle bug, it is four things running that should not be
and nobody knowing which machine they are on.

**Teams** is the eleven-at-night screen. A team's workspace folder and their
submissions, readable and editable, because sometimes the answer is that a
student uploaded the wrong file and the fastest fix is an organiser fixing it in
front of them. Every edit here is an audit row.

**Tournaments** is where manual game editing lives, and it runs into something
real: **a draw is written once and never rewritten**, deliberately, because that
is what makes resuming a consequence rather than a feature and what makes a
fixture replay as itself. So editing is not editing:

> An amendment is an appended record, not a rewrite. `draw.json` stays
> immutable; `amendments/<n>.json` says what changed, who changed it and why.
> The effective draw is the draw folded with its amendments, exactly as the
> table is the results folded together.

That keeps rescheduling, substituting a withdrawn team, or voiding a fixture
possible without giving up the property that a tournament can be reconstructed
from disk and cannot silently disagree with itself.

---

## The arena budget

How many arenas a machine may run is the one number a venue has to get right,
and it is the admin's to set. What follows is measured rather than reasoned —
on an Intel Ultra 7 155H, 22 logical CPUs, 31 GB, cgroup v2 and bwrap 0.11.1,
driving a real practice field over its own HTTP API.

### What an arena actually costs

| | CPU | memory | realtime fidelity |
|---|---|---|---|
| **granted** per arena (4 seats × `MATCH_CPU_QUOTA_PERCENT`/`MATCH_MEMORY_LIMIT_MB`) | 2.00 cores | 2.00 GB | — |
| **measured**, four real robots (`rehearsal`, 764 lines of actual football) | **0.17 cores** | **176 MB** | 100.0% |
| **measured**, every seat spending its whole grant | **1.48 cores** | 190 MB | 100.0% |

Per process, at rest: the arena's own Node — physics at 100 Hz, control at
50 Hz, viewer broadcast at 30 Hz — takes 6.5% of a core and 103 MB, and each
sandboxed robot takes 2–3% of a core and 18 MB.

Two things follow, and they pull against each other:

- **A grant is about twelve times what a real robot uses.** Budgeting by grant
  is safe and enormously conservative: on this machine it allows about ten
  arenas where the measured load would allow well over a hundred.
- **The grant is real, not decorative.** A robot written to spend it gets
  exactly 50.0% of a core and not a cycle more — every seat, including seats
  restarted mid-session, lands in its own systemd scope with
  `cpu.max = 50000 100000` and `memory.max = 536870912`. A team is *entitled*
  to that 50%, so a venue that budgets on the 2–3% robots have used so far is
  budgeting on teams staying bad at this.

Also worth recording: **realtime fidelity held at 100% in both cases.** The
starvation guard at [`src/server.ts:449`](src/server.ts:449) only starts
dropping wall-clock time once the host is genuinely oversubscribed, which one
arena on this machine is nowhere near. That is the number the admin console
should watch, because it is the first thing to move when the budget is wrong.

> Re-run this before a venue, on the venue's machine. The numbers above are one
> laptop's; the method is the point, and `serve practice` plus four `seat` posts
> is the whole of it.

### What the admin sets

```
arenas.max                how many may run at once         (default: computed)
arenas.seatCpuPercent     per-seat CPU grant               (default: 50)
arenas.seatMemoryMb       per-seat memory grant            (default: 512)
arenas.reserveCores       kept for the hub, the OS and the hall screen
arenas.concurrentFixtures how many matches the schedule runs at once
```

`arenas.max` defaults to computed rather than to 4, because 4 was a guess made
when nothing had been measured and it is wrong in both directions on different
machines.

### The hardware check

The hub knows its own machine (`os.cpus()`, `os.totalmem()`) and it supervises
every child, so it can read each arena's cgroup `cpu.stat` and `memory.current`
directly. That gives the admin console three numbers, never one:

- **what you set** — `arenas.max`
- **what this machine guarantees** — `floor((cores − reserve) / (4 × seatCpu + arenaNode))`,
  and the memory equivalent, whichever is smaller. At the defaults on the
  machine above: 10 arenas.
- **what is actually being used right now** — summed from the live cgroups,
  next to the realtime fidelity of every running arena.

Set `arenas.max` above the guaranteed figure and it is accepted, with a warning
that names the consequence instead of grading the risk:

> **14 arenas exceeds what this machine can guarantee (10).**
> Typical robots use about a twelfth of their grant, so this will very likely
> be fine. It stops being fine the moment enough teams push heavy robots — and
> the most likely day for that is finals day. If it happens, matches run slower
> than wall-clock rather than wrongly: a five-minute half takes longer in the
> hall and the schedule slips. Practice arenas are shed first; fixtures in
> `arenas.fixtureReserve` are never shed.

Two refusals belong in the same check. Without cgroups or without `bwrap`
([`sandboxAvailable()`](src/sandbox.ts) already tests both) there are no grants
at all, so the console must say **unenforced** rather than compute a capacity it
cannot hold anyone to. And a machine that cannot honour even one arena at the
configured grant should refuse to start rather than discover it at kick-off.

### Restricting practice fields

"How many practice fields" is four limits with four different reasons, and
[`create()`](src/arenas.ts) has exactly one of them today — a global count, on
fields that belong to nobody. Accounts make the other three possible.

```
practice.open      whether practice may be opened at all   (default: yes)
practice.max       policy cap on practice arenas           (default: whatever is spare)
practice.perTeam   fields one team may own at once         (default: 1, max 2)
practice.idleMins  quiet before a field is warned          (default: 20, exists)
practice.graceMins warned before it is actually closed     (default: 5)
```

**Capacity and policy are kept apart, and only one of them is the truth.**
`arenas.max` minus `arenas.concurrentFixtures` is how many practice arenas the
machine and the schedule can afford — that is capacity, and it is derived, not
typed. `practice.max` is a *policy* limit on top: an organiser closing practice
during finals, or holding it to two while the hall network is struggling. It may
only ever subtract. Set it higher than the spare capacity and it does nothing,
because a second number that can silently contradict the first is the thing this
codebase keeps refusing. That is also why the fixture side is expressed as
"how many matches run at once" rather than as a reserve to hand-tune: **a
fixture must never queue behind a rehearsal**, and deriving its headroom from
the schedule is what guarantees that without anyone remembering to.

**`practice.perTeam` is the one that does the most work at a real event.** A
global cap of eight is no protection at all if one team opens eight. One field
per team is the default; its maximum is **2**, and that ceiling is not a guess
— it is how many robots a team has, for the reason below.

### One robot, one place

The field count is a capacity knob. Underneath it sits a rule that is not a
setting at all:

> **Each of a team's robots may be in exactly one seat, anywhere on this
> server, at any moment.**

Nothing technical forces this. Four processes can read the same submission
folder quite happily; it is read-only and they would all work. It is a rule
because the sport has one: a team has two robots, and two robots cannot be on
two fields. The simulation's job is to be the same sport — the argument that
[rejected Pyodide](PHASES.md#phase-5--write-it-in-a-browser) and that keeps one
seat grant for practice and finals alike.

Three things fall out of it, and they are why it is worth the enforcement:

- **"What is my robot doing right now" gets one answer.** One robot, one seat,
  one output buffer, one place to look. A team debugging a robot that exists in
  three places at once cannot be helped by anybody.
- **The fixture conflict disappears without a second rule.** During their
  match both robots are seated by the hub, so a team has nothing left to
  rehearse with. No special case needed.
- **The `practice.perTeam` ceiling stops being arbitrary.** A team can reach
  two fields only by splitting robot 1 onto one and robot 2 onto another. Three
  is not "discouraged", it is unreachable.

**Ownership and occupancy are two different ledgers,** which is what keeps
invitations alive:

- **A guest spends no *field* allowance.** They own nothing; accepting an
  invitation never costs a team their own right to open a field.
- **A guest does spend their own *robot* occupancy,** because their robots are
  genuinely in seats. So a team already running both robots at home is told
  plainly: *robot 1 is on your own field — take it off to join NSW Lightning's.*
  That is a legible sentence, which is the test.
- **A laptop connection counts too.** A live `AGENT_PATH` program claims a
  robot identity, and Phase 1 already settled that identity comes from the
  token rather than the client's say-so. It occupies the robot exactly as a
  submission does.

**Where the check has to live, and why that is a real change.** The hub proxies
`/a/<id>/...` blindly today — a seat request is answered by the child, which
can only see its own field. Occupancy is server-wide, so the hub has to stop
being transparent for exactly one action: it intercepts the seat request,
checks the robot is free, and only then forwards it. Getting this wrong is
silent — every field would look correct on its own.

The table itself needs no persistence. Arenas die with the hub, so occupancy
dies with it too, and the two can never disagree about what is running.

**What it costs, and why that is acceptable.** A team cannot run their striker
against three opponents at once to gather data faster. That case is real, and
it is already served better elsewhere: [`bench`](src/bench.ts) plays a robot
over a range of seeds headless, on the team's own machine, and prints numbers —
which is what "gather data faster" actually wants, and it neither queues for a
venue's CPU nor needs the venue at all. The practice field is for watching one
rehearsal; the bench is for measuring many.

Two more behaviours follow from ownership:

- **A team's field closes when their fixture's pre-game opens.** It frees
  capacity at exactly the moment capacity is wanted, and no team is left
  rehearsing while the referee is trying to seat them. They are told why.
- **A field is closed when its team stops using it** — see below.

### Giving a field back

A field held by a team who went home is the most common way a venue runs out of
capacity, and today's signal for it is weak: [`hold()`](src/arenas.ts) feeds one
counter from every HTTP request and every WebSocket upgrade, `/agent` included.
So a single laptop robot left connected keeps an arena alive indefinitely, while
a team thinking hard with the tab closed can lose theirs.

**What counts as using a field:**

- **A person is present** — the owner or an invited guest holding a viewer or
  console socket. Resets the clock.
- **Somebody interacted** — any `POST /practice-api/*`: a drag, a seat change,
  start, stop, re-stage. Resets the clock.
- **A robot is connected.** Does **not** reset the clock. This is a deliberate
  change from today: a field of robots playing to an empty stand is precisely
  the waste being reclaimed, and letting `/agent` hold an arena open means the
  team that forgot to close a terminal outranks the team waiting in the queue.

**Warned, then closed — never silently killed.** After `practice.idleMins` of
quiet the field is marked for closing, with a banner on the field itself and a
line on the owner's dashboard saying when. Touching anything cancels it. After
`practice.graceMins` more, it closes. A fifteen-year-old who walked away for
lunch should come back to an explanation, not an absence.

**Closing keeps the arrangement.** Who was on the field, where, and where the
ball was is a small `Arrangement` — Phase 4 already has the type. Write it to
`workspaces/<team>/field.json` on close and restore it on reopen, and
reclamation stops being a punishment: the team loses a process, not their setup.
It belongs in the workspace folder rather than the database because it is the
team's own scratch state, hand-editable like the rest of their folder, and
losing it costs nothing.

**Pressure scales with demand, instead of a flat maximum lifetime.** A hard
ceiling on how long a field may live is the obvious guard against a team who
pokes theirs every nineteen minutes to keep it — and it punishes everyone on a
quiet afternoon to stop one person on a busy one. Better: when nobody is
queued, be generous; when somebody is waiting, warn the longest-idle field
first and shorten its grace. The limit only bites when it is actually needed,
which is the only time it is fair.

**Reclamation is also what frees robot occupancy** — and that makes one case
urgent rather than tidy. Under [one robot, one place](#one-robot-one-place), a
team whose robot is still held by an abandoned field cannot be seated in their
own fixture. So the invariant needs an explicit winner: **a fixture pre-empts
practice.** At pre-game the hub takes the team's robots back, closes or empties
whatever practice seat held them, and says so on the field. Without that rule
the occupancy invariant deadlocks at precisely the worst moment of the day.

When a team asks for a field and every slot is taken, they get a **queue
position and what is ahead of them**, not an error — and practice arenas are
the ones shed first when the budget is over, because a rehearsal can wait and a
scheduled match cannot.

### Two rules that fall out of the numbers

**One seat grant, server-wide, for practice and fixtures alike.** The tempting
lever is to shrink practice seats to fit more fields in. It is not available:
that makes a rehearsal run under different conditions from the match, which is
the exact argument [Phase 5 used to reject Pyodide](PHASES.md#phase-5--write-it-in-a-browser)
— a robot comfortably fast in practice would blow its budget in the final and
the team finds out on the pitch. Lowering `seatCpuPercent` lowers it everywhere,
and the console has to say so before it is saved. **How many run at once** is
the only thing a venue is allowed to turn.

**The grant belongs in the match record.** If a venue plays at 25% seat grants,
that is a condition of play and part of what the result means — it goes in
beside the seed and the code hashes, so a match can be replayed as itself.

---

## From a terminal

Most of this is a browser, and deliberately so — Phase 2's gate is a referee
who never touches a terminal. But three things cannot be browser-only, and one
of them is not a convenience at all.

The existing commands stay flat and unchanged; these join them.

```
league      run the league server                    [--port --data --arenas-max …]
capacity    what this machine can actually run       [--measure]
account     create, disable or reset an account      [--team --role --passwd]
invite      mint a registration invite               [--role --team]
arenas      what is running; stop one                [--stop <id>]
amend       append an amendment to a draw            [--name --fixture --reason]
```

**`account` is mandatory, not optional — and it is a debt the database choice
incurred.** The first admin cannot be created from a browser that requires an
admin to log into; something has to break that circle from outside. Worse, this
codebase's standing promise is that an organiser can open the thing that is
broken in a text editor at eleven at night, and that promise still holds for
workspaces, submissions, draws and results — all still files. It does **not**
hold for accounts any more, because accounts are in SQLite. So the escape hatch
has to be rebuilt as commands, for exactly the failure most likely to happen
under pressure: somebody cannot log in, twenty minutes before their match.
`account --passwd` and `invite` are that hatch.

**`capacity` is the one worth building first**, because
[The arena budget](#the-arena-budget) currently tells a venue to re-measure on
its own machine, and advice that requires writing a `/proc` sampler is advice
nobody takes. Without `--measure` it computes instantly from `os.cpus()`,
`os.totalmem()` and [`sandboxUnavailableReason()`](src/sandbox.ts) — which
already exists and is already written "for an operator to fix", but today is
only ever reached at spawn time, which is to say during a match. With
`--measure` it runs one real arena for half a minute and reports what it cost:

```
  this machine
    22 logical CPUs · 31 GB · cgroup v2 ✓ · bwrap 0.11.1 ✓

  per-seat grant       50% of a core · 512 MB
  per-arena grant      2.00 cores · 2.00 GB

  measured  (one arena, four calibration robots, 30s)
    arena node         6.5% of a core · 103 MB
    each robot         2–3% of a core · 18 MB
    whole arena        0.17 cores · 176 MB · realtime 100.0%

  guaranteed capacity  10 arenas
  measured capacity    ~60 arenas  — not a promise: a team may spend its grant

  configured           arenas.max 8 · concurrentFixtures 2 · practice.max 6
```

It measures against **the repo's own example robot**, not a pushed team, for
two reasons: nobody has pushed anything the week before an event, when this
question actually gets asked; and a fixed calibration robot makes two venues'
numbers comparable. The "not a promise" line is the whole asymmetry stated
where an organiser will actually read it.

**What stays out of the terminal.** Refereeing, by definition. Team submission,
because [`python/submit.py`](python/submit.py) is already the terminal route
and Phase 5's rule is one way in, not two. And `serve` itself does not change:
a team running one match on a laptop gets today's flags and today's behaviour,
with no league, no database and no account.

---

## What this gives up, knowingly

**One machine's CPU is the real ceiling, and it is the admin's to set.** See
[The arena budget](#the-arena-budget) — measured rather than guessed, and
configurable with a warning that names the consequence rather than saying
"high".

**Headless and wall-clock still are not the same result.** A slow program misses
more control cycles headless, so a division is played one way or the other. The
hub must make that a property of a tournament, not of whichever arena happened
to be free.

**A scored match never runs code from a laptop.** Live `AGENT_PATH` connections
stay the practice loop and nothing more. That has been true since Phase 1 and
accounts do not change it.

**Sessions on a venue LAN are cookies over plain HTTP.** A venue network is not
hostile in the way the internet is, but it is a room full of teenagers. Either
the league server gets TLS (and therefore a certificate an organiser has to
obtain, at a venue, possibly offline), or sessions are scoped and short and the
admin surface is bound to localhost. This wants deciding before it is
discovered.

**`league.db` is the one thing that cannot be rebuilt from disk.** Everything
else in this system is reconstructible by reading files. Accounts are not. Back
it up, and keep it out of the match path so that losing it costs a login rather
than a season.

---

## Getting there

The phases that build this are [Phase 6 through Phase 11](PHASES.md#phase-6--accounts-and-the-front-door).
The ordering is the same argument as everywhere else: identity first, because
every other screen asks who is looking. The supervisor second, because it is
what lets more than one thing happen at a time — and it comes before ownership
on purpose, since a competition day is meaningfully shorter the moment two
fixtures can play at once, whether or not practice has grown owners yet.
Ownership third, which is where a field belongs to a team and a team finally
gets the Run button. The referee's day fourth, because it is the interaction a
scored match cannot happen without. Admin last, because it is the only one
whose absence can be worked around with a terminal.
