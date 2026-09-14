# The end state

What the whole thing looks like when it is finished, and who sees what.

[PHASES.md](PHASES.md) says where this is going and in what order. This says
where it arrives. It is a description of an interaction, not a schedule — read
it as the thing the phases are trying to become, and argue with it before the
code exists rather than after.

> Written 14 September 2026, after Phase 5. Everything described as *today* is
> in the repository now; everything else is a proposal.

---

## Two deployments, one binary

The single most important shape in here is that there are **two ways to run
this, and the second one contains the first**.

**A match server** is what exists today. One machine, one process, one world.
A team runs it on a laptop, pushes robots at it, and watches. No accounts, no
front page, no database, no network beyond the one they are sitting on.

```bash
npm run serve                                  # a server, playing matches
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
npm run serve -- league --port 80 --data ./league
```

Why this way: `MatchServer` is one world, one viewer broadcast, one gateway
over four fixed seat ids. A hall with three live fixtures and four teams
rehearsing needs seven of all of that. Teaching the most load-bearing file in
the repository to hold N of everything is the alternative, and it means one
team's runaway robot shares a process with the final. [`src/fields.ts`](src/fields.ts)
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

SQLite costs no dependency: `node:sqlite` is built into Node (verified working
on this machine's 22.22, stable from 24), so the league server needs the same
`npm install` the match server does. It emits an experimental warning on 22;
pin `>=22.5` and suppress it, or move to 24.

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

## What this gives up, knowingly

**One machine's CPU is the real ceiling.** Every arena is a physics loop plus up
to four sandboxed CPython processes. Four fixture arenas and four practice
fields is sixteen student programs plus eight game loops on a venue laptop.
`maxFields` is capped at 4 today for exactly this reason, and the answer at
league scale is admission control and a queue, not a bigger number — plus the
honesty to tell a team "you are third in line" rather than to run their field
badly.

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

The phases that build this are [Phase 6 through Phase 9](PHASES.md#phase-6--accounts-and-the-front-door).
The ordering is the same argument as everywhere else: identity first because
every other screen asks who is looking; the supervisor second because it is what
lets more than one thing happen at a time; the referee's day third because it is
the interaction a scored match cannot happen without; admin last because it is
the only one whose absence can be worked around with a terminal.
