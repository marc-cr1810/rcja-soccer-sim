# Running a league

For whoever is running the event, once it is bigger than one laptop.

Everything else in this manual describes a **match server**: one process, one
world, no accounts, nothing to log into. That is still exactly what it was, and
`bun run serve` is unchanged — no login, no front page, no database file
created, nothing to opt into. A team practising in a classroom should never
have to stand up an identity system to see their robot move.

A **league server** is the other deployment. It owns accounts, the draw, the
schedule and the public pages, and **plays no football itself** — every world it
shows is a child process running the same match server a team runs on a laptop,
several of them at once.

```bash
bun run build:viewer && bun run build:referee && bun run build:workspace && bun run build:site
bun run serve -- league --name state-round-1
```

```
  RCJA Soccer Simulation — league server
  front page:  http://localhost:8080
  watch:       http://localhost:8080/live
  arenas:      up to 10 (computed; this machine guarantees 10) · 2 for fixtures · 8 for practice
  playing:     State Round 1 — 12 fixtures
```

Without `--name` it serves the front door and plays nothing, which is what a
venue wants the evening before: teams registering, pushing and checking the
schedule while nothing is on.

## Who needs an account, and who does not

**Watching needs no account at all.** The front page, the schedule, the table,
every match's record and the live viewer are open to anybody who can reach the
server. That is deliberate and it is not going to change: the spectator stream
is untrusted by design, so there is nothing for a login to protect.

Entering, refereeing and administering need one.

| | guest | team | referee | organiser |
|---|---|---|---|---|
| watch, read results | ✓ | ✓ | ✓ | ✓ |
| push code, edit a workspace | | their own | | anybody's |
| control a match | | | ✓ | ✓ |
| accounts, invitations | | | | ✓ |

## Initializing a league and creating the first admin

The first organiser cannot be made from a page that requires an organiser to log
into, so it is made from the terminal:

```bash
rcja-soccer-sim league-setup
```
*(or `bun run cli league-setup` / `make league-setup`)*

This creates the required storage folders (`league/`, `tournaments/`, `submissions/`, `workspaces/`),
prompts securely for an admin password (masked off the terminal, never saved in bash history),
and creates the root administrator account.

You can also create accounts individually with `account --create`:

```bash
rcja-soccer-sim account --create --role admin --name "Your Name"
```

## Managing teams from the terminal

An organiser can create and manage teams directly from the CLI without opening a browser:

```bash
# Create a team, generate their workspace, and mint their push key in one step:
rcja-soccer-sim team create "ACT Robotics"

# List all registered teams, active keys, and robot submissions:
rcja-soccer-sim team list

# Mint an additional push API key for a team:
rcja-soccer-sim team key "ACT Robotics"

# Issue a single-use registration invite code:
rcja-soccer-sim team invite "ACT Robotics"
```

A team can also register themselves using an invitation code:

```bash
bun run serve -- invite --role team --team "ACT Robotics"
bun run serve -- invite --role referee
```

Hand the code over. The team goes to `/register`, pastes it and chooses their
own password. **A team invitation carries the team's name**, so registering
cannot rename it: the organiser decides who "ACT Robotics" is. This is the same
arrangement as the hand-issued secret it replaces — you hand a team a string —
except the string stops working the moment it is used, and the team's password
is theirs rather than yours.

You can also issue invitations from `/admin` once you are logged in. The
terminal and the browser do the same thing.

When somebody cannot log in twenty minutes before their match:

```bash
bun run serve -- account --passwd --name act-robotics
bun run serve -- account --list
```

That closes every session that password had opened, which is what changing it is
for.

## Pushing to a league server

A team's push credential is now a **key they mint themselves**, at
`/team/settings`. It is shown once, when they make it.

```bash
python3 python/submit.py --dir myteam/robot1 --url http://venue:8080/submit --key rcja_…
```

The key says which team the push is, and the server holds the manifest to it: a
push whose `manifest.json` names somebody else is refused. **The team comes from
the credential, never from the file** — the same rule the join has always been
held to, now applied to the door it was missing from. On a match server there
are no accounts and no key is wanted, exactly as before.

The **join token** minted beside a submission is unchanged. It was never an
account credential; it is how a seat knows which folder is allowed in it.

## Where things are kept

> **The database holds who. The disk holds what happened.**

`league.db` — under `./league` by default, moved with `--data` — holds accounts,
sessions, keys, invitations, per-account grants and the audit log, and nothing
about a match. Draws, results, match records, submissions and workspaces stay
where they are, as files. Delete `league.db` and you have lost your logins: not
a season, not a table, not a team's code, and you can still open a team's robot
in a text editor at eleven at night.

SQLite costs no dependency — `bun:sqlite` is built into Bun, with no
experimental warning to quieten and nothing to install.

## What the front page shows

Three bands, folded fresh out of the draw and whatever results exist:

- **Now playing** — a card per fixture being played, with its score, half and
  clock, each linking through to the arena playing it.
- **Up next** — the fixtures after them.
- **Results** — what has finished, and the table.

A finished match's page is built entirely out of what a tournament already
records: the seed each leg played on, the sha256 of the code that was in each
seat, and the referee event log kept whole. The timeline on that page is that
log, with nothing new written to produce it.

## Resuming

A league server is the same fixture loop `tournament` runs, so it resumes for
the same reason: **the next fixture is the first one with no result on disk.**
Stop it with ctrl-c and start it again and it picks up where it stopped, having
counted nothing twice. A fixture interrupted halfway leaves nothing behind and
is replayed.

## Correcting a draw, and playing a fixture again

`/admin/tournaments` is the organiser's view of the draw. It shows the
programme with every fixture's state, the entrants, and every correction
already made to the draw — who made it, when, and **why**, because nothing here
is written without a reason typed into the box. A button is much easier to press
by accident than a command is to type.

| what | when to press it |
|---|---|
| **Play it again** | the fixture was abandoned, or was played and scored wrong |
| **Move** | give it a new kick-off time |
| **Void** | it is not going to be played at all |
| **Restore** | you voided it and were wrong |
| **Withdraw** (on an entrant) | a team has gone home; their unplayed fixtures are awarded against them |
| **Substitute** (on an entrant) | somebody else takes their place in every fixture they have not played |

These are the same records the `amend` command appends, through the same
writer, so a browser and a shell cannot make a draw say two different things.
The only difference is that a correction made here names the account that made
it, and one made from a terminal names the Unix user.

**A match somebody is standing at is not yours to correct.** A fixture in
pre-game, on the pitch, or waiting on its referee's confirmation shows no
buttons and says *a referee has it*. Ending it is theirs — from their own page —
and no admin button pulls a pitch out from under a whistle.

### An abandoned match, and a schedule that has drained

A referee who abandons a match leaves it unwritten, which is right: half a match
is not a result. The schedule then stops offering it for the rest of the run,
which is also right — a fixture that fails for a reason that has not gone away
should not be retried in a loop.

What that used to mean is that re-running it needed the server restarted, taking
the front page, every login and every practice field down with it. Now the
fixture sits on `/admin/tournaments` marked *abandoned*, with the referee's
reason beside it, and **Play it again** puts it straight back into the schedule.

The same holds after the last fixture has been played. The run ends; the
schedule does not. Voiding a result — from the browser or with `amend
void-result` in a terminal — wakes it again within a few seconds and the fixture
is offered to a referee, with nothing restarted.

## Arenas, and how many of them

An **arena** is one child process holding one world: a fixture from the draw, a
practice field somebody opened, or — if the venue turned it on — a **demo**
arena that plays back-to-back matches for a hall screen. They are reached under
`/a/<id>/` through the one port the venue configured, so a robot on a student's
laptop still has somewhere to connect and the venue still opens one hole in one
firewall. `/f/<id>/` keeps working, because it is in the docs and in students'
history.

**Arenas are not persisted.** A league server going down takes every arena with
it — there is nothing meaningful to resume a physics loop and four sandboxed
interpreters from — and a fixture interrupted that way writes no result and is
simply replayed.

Check what your machine can hold *before* the day:

```bash
bun run serve -- capacity
bun run serve -- capacity --measure      # runs one real arena for half a minute
```

Bare, it is instant: it reads the machine, works out what a seat's grant costs,
and prints what can be guaranteed. With `--measure` it plays a real arena of
four calibration robots — the repository's own example striker and keeper, so
that two venues' numbers mean the same thing — and reports what it actually
cost. Expect a wide gap between the two: **a grant is about twelve times what a
real robot uses.** Budgeting by grant is safe and very conservative; budgeting
by measured load bets on teams staying bad at this.

## Turning the budget

Settings live in `league.json`, beside `league.db` under `--data`. It is an
ordinary file, editable by hand:

```json
{
  "arenas": {
    "max": null,
    "seatCpuPercent": 50,
    "seatMemoryMb": 512,
    "reserveCores": 1,
    "concurrentFixtures": 2
  },
  "practice": {
    "open": true,
    "max": null,
    "idleMins": 20,
    "graceMins": 5,
    "perTeam": 1,
    "claimSecs": 90
  },
  "demo": {
    "on": false,
    "bots": "reference",
    "home": "Violet",
    "away": "Lime",
    "halfSeconds": 300,
    "league": null,
    "gapSeconds": 3
  }
}
```

`arenas.max` of `null` means *whatever this machine can guarantee*, which is the
default because 4 was a guess made before anything had been measured. Set it
higher than the guaranteed figure and it is accepted, with a warning that names
the consequence: matches run slower than wall-clock rather than wrongly, the
schedule slips, and practice arenas are shed first.

Two things follow from the numbers and are not settings you can turn:

- **Practice capacity is derived.** It is `arenas.max` less
  `arenas.concurrentFixtures`, so **a fixture never queues behind a rehearsal**.
  `practice.max` is a policy cap on top and may only ever *subtract* — set it
  above what is spare and it does nothing.
- **One seat grant, for practice and finals alike.** Shrinking practice seats to
  fit more fields in is not available: a rehearsal under different conditions is
  a rehearsal of a different sport. Lowering `seatCpuPercent` lowers it
  everywhere, and it is recorded in every match result as a condition of play.

`practice.idleMins` and `practice.graceMins` are how a field nobody is using
comes back. After `idleMins` of quiet the field is marked, with a banner on it
and a line on the owner's team page saying when it will close; `graceMins`
later, it closes. Touching anything at all cancels it — so does simply having
the console or the viewer open in front of you. **A connected robot does not**:
a program somebody left running when they went home is the thing being
reclaimed, not a reason to keep the field. When teams are queued the quiet
period halves (never below three minutes) and only the quietest field goes per
sweep, so the limit bites when it is needed and not on a quiet afternoon.

Closing a field costs the team its processes and not its setup: the arrangement
is written to `workspaces/<team>/field.json` and the next field they open comes
back with it.

`practice.perTeam` is the setting that does the most work at a real event: a
global cap of eight is no protection at all if one team opens eight. One field
per team is the default and **2** is the ceiling — not a preference, but how
many robots a team has. A team reaches two fields only by putting robot 1 on
one and robot 2 on the other, because each robot may be in one seat anywhere on
the server at a time.

`practice.claimSecs` is how long a freed field is *held* for the team at the
front of the queue before it passes to the next. It is held rather than opened
because opening a field for a team who has gone home starts an idle clock on an
empty field and stalls everyone behind them for the whole quiet period.

### The demo arena — football for the hall screen

`demo.on: true` keeps one arena playing back-to-back matches at wall-clock
speed, *forever*, whether or not a draw is running. It kicks off its own matches
and records no results — it is an attraction, not a record — and the whole point
is that the screen never sits still. A venue with one hall screen and a demo
running has football to watch all day without anybody restarting anything.

It takes one arena slot of its own: **`arenas.max` must leave room for it next
to `concurrentFixtures`**, or a fixture waits behind it while the demo plays —
the server says exactly this at startup if it is the case.

- **`bots`** — who fills the seats.
  - `"reference"` (the default): the built-in agent plays itself, and nothing
    needs to be spawned.
  - `"examples"`: the repository's own `python/examples` line-up (striker and
    keeper, both sides) joins as four remote seats.
  - A bot-roster name, e.g. `"lab-rat"`: that deliberately poor bot against the
    built-in reference agent.
- **`home` / `away`** — what the two sides are called on the card.
- **`halfSeconds`** — a simulated half; the match is played at wall-clock speed,
  so 300 seconds a half is ten minutes in the hall.
- **`league`** — the rule set; `null` is the default league.
- **`gapSeconds`** — pause between matches, so the hall can read the table.

Every dial is also a flag for one run: `--demo` (pass `false` to turn off),
`--demo-bots`, `--demo-home`, `--demo-away`, `--demo-half`, `--demo-league`,
`--demo-gap`. A demo on a live venue shows on the front page and `/live` with an
*Exhibition* tag — and when it is the only thing playing, `/live` goes straight
to it.

Two caveats, honestly. The `examples` line-up needs `python3` on the venue
machine, and its robots join as ordinary **remote seats** — exactly the way four
laptops join — so they are *not* wrapped in a seat's sandbox grant. Standalone
for a laptop that does not have them: `bun run cli arena --kind demo`. And a
demo never plays a team's pushed submission; submissions are for matches and
rehearsals.

A broken `league.json` does not stop the server. It starts on the defaults and
prints what it ignored, because an organiser with a stray comma twenty minutes
before a match needs a server that comes up.

## Refereeing

A referee signs in and opens **`/referee`**, which lists **the matches they have
been assigned** — not every match on the server — whether or not they have
started. There is no token to hand out and nothing to paste. The hub decides
from the session and the referee's capability whether to let them in, so a
spectator never downloads match-control code at all.

Each game has its own page at **`/referee/m/<fixture>`**, and that address does
not change: it works before the match exists, so it is the thing to write on a
run sheet or send to somebody. Left open, it is where the match begins and then
where it is run: it grows an **Open pre-game** button when the fixture's turn
comes, becomes the pre-game checklist while the teams arrive, offers **Start the
match**, and then carries a **Take the match** link to the console. (It also
answers at `/referee/m/<fixture>/setup`, which is the same screen under the name
the design document gives it.) An arena's own address is no use for any of this
— it is born with the match and is a different string next time.

A referee is given a fixture from the terminal:

```bash
bun run serve -- assign --referee sam-referee --draw state-round-1 --fixture act-robotics-v-nsw-lightning
bun run serve -- assign --list
bun run serve -- assign --remove --referee sam-referee --draw state-round-1 --fixture act-robotics-v-nsw-lightning
```

The fixture is checked against the draw as it is written, so a typo is refused
with the fixture list rather than accepted as an assignment nobody can use. A
draw and a fixture are both needed because a fixture's id is `home-v-away` and
two divisions can produce the same one.

**Being a referee is not by itself permission to take a match.** An unassigned
referee still reaches their page — it says nothing has been given to them yet,
which at a venue is a far better answer than a door that will not open — but
they control no match until an organiser names one. An admin holds every
capability over everything. Assigning and unassigning take effect on the next
request, so a referee swapped at the last minute does not need to sign in again.
Two referees can hold the same fixture at once, deliberately: reassigning under
pressure should not fail on a rule about tidiness.

### Nothing starts until the referee opens it

A fixture's arena is a child process holding a physics loop and four sandboxed
Python interpreters, and until Phase 11 it came up the moment the schedule
reached the fixture — whether or not anybody was standing at that pitch.

Now the schedule only says **whose turn it is**. When a fixture's turn comes and
neither of its teams is in another match, it goes to *ready*, its referee's page
grows an **Open pre-game** button, and the terminal prints the address:

```
  ready:      ACT Robotics v NSW Lightning
              no pitch is running until the referee opens it at
              http://localhost:8080/referee/m/act-robotics-v-nsw-lightning
```

Pressing it is what spawns the arena. Nothing exists before that: the fixture
costs the venue nothing, and it is not holding one of the concurrency slots
either — being **ready** and **being played** are counted separately, so one
referee who has not arrived yet cannot idle a pitch that another referee is
waiting for. Every fixture whose turn has come is offered at once, however many
pitches the venue has; whoever presses first gets the next free one, and the
rest open as pitches come free.

Exactly one of a team's fixtures is ever ready at a time, because two robots
cannot be on two pitches. A referee holding three games sees the one that is
theirs to start now.

**It never times out.** A fixture nobody opens waits all day, on the same
grounds as the confirmation at the other end of the match: a match nobody is
refereeing should not start on a timer. The cost is worth saying plainly — a
refereed draw on a server where **no referee has been assigned anything will sit
at *waiting for the referee* and play nothing.** Any admin can open any fixture
from the same page, so the way out is a browser rather than a restart. A server
run with `--headless` has nobody to ask and plays its fixtures as soon as their
turn comes, exactly as before.

### Teams turn up, and then the referee starts it

Opening pre-game brings the pitch up and stops there. Nothing kicks off until a
referee presses **Start the match**, and the twenty minutes in between are the
ones a competition actually has: teams arriving, robots coming off practice
fields, and somebody looking at the four seats and deciding that this is the
code that plays.

A team says they are here from their own page — **We're here**, which appears
under *Your next match* as soon as the fixture is theirs to play. They can press
it **before the pitch is free**, which is the point: teams turn up and wait, and
a referee opening a pitch should find them already standing at it. The hub holds
the arrival against the fixture and seats their robots by itself the moment the
arena exists.

The referee's page is the checklist:

```
Alpha robot 1    — 3f9c1a02 · pushed 14:31                       on the field
Alpha robot 2    — a71b4e55 · pushed 14:31
                   — its program would not start                 on the field
Bravo robot 1    — 0c28ff90 · pushed 13:04 — Bravo have not arrived yet   waiting
Bravo robot 2    — nothing pushed — Bravo have not pushed robot 2         waiting
```

The hash is there for one reason: a team that pushed a fix ninety seconds ago
has to be able to *see* that the fix is the thing loaded. A team name cannot
tell them, because it is re-pointed at new code on every push. There is no
separate validation column, and that is not an omission — a push that failed
validation was never kept, so a robot that is on disk has already passed.

#### The robots start when their team arrives

Pressing **We're here** does not just claim two seats on paper. It starts that
team's robots on the pitch, in the sandbox they will play in, and the checklist
says what each program is doing:

| | |
|---|---|
| *(nothing said)* | that team has not arrived, so nothing of theirs has been started |
| **starting** | the program is coming up |
| **on the field** | it is connected, and standing on its mark |
| **its program would not start** | it was retried and has stopped being retried |

This exists because of where the alternative put the bad news. Robots used to
come up at the whistle, so a submission that died at import was discovered ten
seconds *after* the referee had decided to play — and the fixture then refused
to play at all, wrote nothing and was replayed into the same wall. The twenty
minutes in which somebody could have fixed it had already gone.

**A team whose robot will not start has still arrived.** The seat stays
claimed, the team is still *ready*, and nothing on the penalty clock moves: the
clock is about people turning up, not about code compiling. What the referee
gets is the information, in time to use it.

**Pressing *We're here* again is the retry.** A team pushes a fix and presses
the same button, and only the robots that are *not* on the field are started
again — one that is already running is left exactly alone. That matters for
more than tidiness: a match records the hash of the code each seat was
*started* with, so a robot running since 14:31 is recorded as the code it has
been running, whatever landed on disk afterwards.

Starting the match with a robot that would not start plays the match without
it, and the built-in agent fills the seat — the same thing that happens to a
seat nobody ever pushed to. The referee is told so before they press it.

**A team plays with one robot.** The minimum is one for both sides, so a team
with one robot pushed and one still being written turns up and plays.

**Start is never refused.** However empty the list is, the referee decides when
a match starts — a team that never turns up must be able to delay a fixture
without being able to stop one. A seat nobody filled plays whatever that team
last pushed, exactly as it did before this phase; a seat with nothing pushed
behind it is filled by the built-in agent, exactly as it always has been.

Arriving is also what finally makes **one robot, one place** true during a
match. A fixture has always pulled both teams' robots off their practice fields;
until now it did not put them anywhere, so a team could walk away from their own
match and start rehearsing again with both robots. Now the fixture holds them,
and a practice field will refuse them with the sentence it has always used:

```
robot 1 is already in the violet-1 seat on your own practice field.
Take it out of that seat first — each of your two robots can only be in
one place at a time.
```

The pre-game room holds its arena and one of the venue's concurrency slots
while it waits, unlike the *ready* gate before it — a pitch with people standing
on it is a pitch in use. The terminal prints where to start it:

```
  pre-game:   ACT Robotics v NSW Lightning
              nobody kicks off until the referee starts it at
              http://localhost:8080/referee/m/act-robotics-v-nsw-lightning
```

A server run with `--headless` has nobody to ask and plays straight through,
exactly as before.

#### Locking the lineup

**Lock the lineup** is the moment a push stops reaching this match. Until the
referee presses it, a team can push a fix and press *We're here* again and the
new code goes on. After it, the four seats are running copies the arena holds,
and nothing in the submissions tree reaches the football.

Locking is not a flag: each seat's folder is copied into the arena's own
directory and the program is started from the copy. That is what makes the lock
real — a push replaces the folder in the submissions tree outright, and a robot
whose program crashes once is respawned from whatever is at that path *then*.
Copied, it cannot be.

**Pressing Lock restarts a seat running older code than its team has since
pushed**, and only such a seat. A robot already running exactly what is on disk
is left strictly alone, so locking a room where nothing has changed disturbs
nothing. The checklist says which seats are behind before the lock, too:

```
ACT Robotics robot 1 — 6d4d7a3c · pushed 4 minutes ago
  — still running 4c890e74, not the newest push
```

**There is no unlock, because pressing Lock again is the unlock.** Before
kick-off a referee may lock as often as they like and each press takes in every
team's newest code. That keeps the rule to one sentence: *a push reaches a
locked match only when a referee decides it does.* Once the whistle has gone,
nothing changes it, with exactly one exception: half-time, below.

**A push into a locked match is kept, and says so.** It is that team's code
from their next game on, and the push itself tells them rather than leaving
them to find out:

```
accepted: ACT Robotics robot 1
kept — but the lineup for your match against NSW Lightning is already locked,
so this is not in it. It is what plays from your next game on.
```

**Starting without locking locks what is on the field.** The whistle is not a
decision to take anybody's new code in — the referee pressed Start on a
checklist showing those robots running, so every seat keeps what it is running
and only the seats nobody has started yet are read off disk. That is the one
difference between the button and the whistle, and it is deliberate: a working
robot must never be restarted under a referee who did not ask for it.

Both legs of a tie play the same code, for the same reason: the copies are
taken once, and a push between the legs cannot reach the second one.

### What a late team costs

Out of the box, nothing. No timer runs, no goals accrue, and the referee starts
the match when they judge it right — which is the same answer this part of the
system gives everywhere else. Two things can be turned on when a day is running
behind, and neither of them takes the decision away from the referee.

**The penalty clock** is a button on the pre-game page, not a timer. Press
**Start the penalty clock** and the team that is standing at the pitch is
awarded one goal a minute against the team that is not. The referee starts it
because the referee is the only person there who can see whether the delay is
the team's fault or the venue's own network.

Three things about it are worth knowing before you use it at an event:

- **It banks a whole minute at a time,** to whoever was owed it then. A team
  that arrives four minutes late has cost their opponent four goals and owes
  nothing from that moment — and those four do not come back when they walk in.
- **Stopping it keeps what it earned.** A scoreline that could be wound back by
  turning up would make the clock pointless. Undo one with a score correction on
  the pitch instead, in front of everybody, with a reason attached.
- **With nobody there at all it awards nothing,** because there is nobody to
  award it to. The page says *neither team has arrived* rather than counting,
  so it stays somebody's decision.

Whatever it awarded travels into the match: the fixture kicks off at that
scoreline, and the arena's own record carries it as a score correction with the
reason, so a 3–0 at kick-off is never a number nobody can account for. Only the
first leg of a two-legged tie is charged — the late team was late once.

**Auto-start** is the timer, and it is off unless you ask for it. Set
`pregame.autoStartMins` and a pre-game room that nobody has started by then
starts itself, playing whatever is on disk. The referee's Start is available the
whole time either way.

```json
{
  "pregame": { "autoStartMins": 15, "penaltyPerMin": 1 },
  "rules": {
    "mercyMargin": 10,
    "halfTimeSeconds": 300,
    "heldBallSeconds": 8,
    "ballPlacementMinSeconds": 0.5,
    "ballPlacementMaxSeconds": 2
  }
}
```

On `league`, `--auto-start 15|off`, `--penalty-per-min 1`, `--mercy 10|off`,
`--half-time 300|off`, `--held-ball 8|off` and `--ball-placement 0.5-2|off` do the same for one run without
editing the file. (`bench` has a `--mercy` of its own, which works the other
way round — see below.)

### How long a robot may sit on the ball

`rules.heldBallSeconds` is the one 5.6 window that is a judgement rather than a
reading of the rule book, which is why it is a setting at all.

Rule 5.6 does not describe this ball. No opponent is contesting it, so 5.6.1.2
— the scrum — does not apply; and a robot is touching it, so "no robot has any
chance of locating the ball" is plainly false. What is happening is that one
robot has won the ball and is doing nothing with it, and how long a referee
lets that run is the referee's call.

Eight seconds unless you say otherwise. `0` turns it off, which is a venue
saying a team that wins the ball may keep it as long as they like — what every
match did before the test existed, and measurably worse than it sounds: a robot
was once left sitting on the ball for a whole match with nobody saying
anything.

It is displacement that is measured, not speed, so a robot dribbling the ball
up the field keeps it for as long as it is actually taking it somewhere — and a
robot spinning on the spot with the ball against it does not, however fast the
ball is moving.

### Putting the ball back

When the ball goes out of play (5.9.2) or lack of progress is called (5.6.2),
somebody has to walk over, pick it up and put it on a neutral point. The
simulator makes that take a person's time rather than none: each placement
draws its own delay between `rules.ballPlacementMinSeconds` and
`rules.ballPlacementMaxSeconds`, half a second to two unless you say otherwise.
The draw comes from the match seed, so a replayed match puts the ball down at
the same moments.

While it is in somebody's hand the ball is off the field. No robot can see it,
on the infrared or the camera — they read exactly what they would with the ball
out of sight — and nothing can touch it, score with it or be called over it.
Where it lands is decided when it is put down, so a robot that has parked on
the nearest neutral point meanwhile sends it to the next one, as it would with
a real referee.

Set the maximum to `0` and the ball moves instantly, as it did before this
existed. Both are capped at five seconds.

### Half-time

**Five minutes between the halves, and the one window in a match where a team
may change their code.** It is `rules.halfTimeSeconds`; set it to `0` and a
match behaves exactly as it did before this existed — the referee simply
restarts when they are ready.

It begins by itself when the first half ends. Nobody presses anything, and
nothing about the football changes: the ball, the clock and every rule detector
stay where the whistle left them, and the four programs keep being polled so
none of them decides the server has gone.

What is different is that **a push can still reach this match**. A team fixes
their code, pushes it and waits for their robot to come back up; the referee
presses **Take the new code in** on the match page, which is the same Lock they
used before kick-off and takes every team's newest push at once. The push
itself says so:

```
accepted: ACT Robotics robot 1
kept — and your match against NSW Lightning is at half-time, so this can still
play the second half: tell the referee, and say you are ready once your robot
is back up.
```

A restarted robot rejoins the match in progress — it is not sent off under rule
5.7.1, because a program that stops while the game is stopped has not failed at
anything. It does take a second or two to come up, so take the code in before
you kick off rather than after.

**The second half's kick-off is held until both teams say they are ready.**
Each team presses *We're ready* on their own screen, and the console says who
is still working. That hold is only ever as long as half-time itself: **when
the clock runs out both buttons come back**, whatever either team has said, and
nothing kicks off by itself at any point. The five minutes tell the time; the
referee decides.

**When half-time changes the code, the record says so.** `submissions` on a
fixture is what each seat *started* on, and the leg that had the change carries
a `secondHalf` beside it with what played after. A match nobody pushed to at
half-time writes exactly the record it always did.

### The mercy rule, and a fixture nobody turned up for

**A match ends at a ten-goal difference**, wherever that difference came from.
It is not an RCJA rule — the rule book has no mercy rule — so it is
`rules.mercyMargin` and a venue can change it or set it to `null`.

It applies to every match that is *played*: fixtures, the hall demo, the batch
`tournament`. Three things opt out, and they are the three that are not playing
a match — a **practice field**, which is a rehearsal with no result to shorten,
and **`bench`** and **`ladder`**, which are measuring instruments. The rule only
ever takes goals off whoever is winning, so it moves an aggregate-goals
comparison asymmetrically and cuts the tail off a score distribution, which is
the thing both of those exist to look at. Pass `bench --mercy 10` or
`runLadder({ mercyMargin: 10 })` to reproduce a venue's conditions deliberately.

A match ended this way is **finished, not abandoned**. It counts, it is written
down, and its record says the mercy rule is what ended it — which matters,
because an abandoned fixture is left unwritten and replayed.

The mercy rule is also the ceiling on the penalty clock, and that is why the two
arrived together. Once the clock has awarded ten there is no match left to play,
so the fixture is **awarded without being played**: the pitch goes straight back
to the venue instead of standing empty all afternoon, and the result reads

```
Alpha 10 — 0 Bravo    Bravo did not arrive — the match was awarded 10-0.
```

It is an ordinary result in every other respect. It goes to the referee's
confirmation screen like every other result, which is the thing that makes it
safe: a team that walks in a minute after the margin was reached is somebody
pressing **Play it again**, not an argument.

### One confirmation writes the result

When the second half runs out, **nothing is recorded yet.** The fixture's page
shows the final score with two buttons, and the match is not in the table, not in
the results directory and not counted until one of them is pressed:

- **Confirm the result** — it is written whole, appears in the table
  immediately, and the arena is shut down.
- **Play it again** — nothing is written, and the fixture is re-run in this same
  session on a fresh arena. Use it when the game was a shambles rather than a
  match: a team that re-pushes before the re-run gets their new code in it,
  because a lineup is resolved when the arena opens.

A match **abandoned** from the console is the third answer, and it also writes
nothing — that is the point of abandoning. It is not re-run automatically; it
stays unplayed and comes round again the next time the server is started.

While a fixture waits to be confirmed it keeps its arena and one of the venue's
concurrency slots, so the referee can go back and look at the board. It never
times out, on purpose: a result nobody ever agreed to must not be able to reach a
table. If a referee walks away, **any admin can confirm it from the same page**,
and the terminal prints the address at full time:

```
  full time:  ACT Robotics v NSW Lightning  3-1
              nothing is recorded until it is confirmed at
              http://localhost:8080/referee/m/act-robotics-v-nsw-lightning
```

A server run with `--headless` has nobody to ask and writes results the moment
they are played, exactly as before.

## Whose field is whose

A practice field belongs to the team that opened it. They run it — drag, start,
stop, invite, close — and every team on it fills the seats holding *their own*
robots and nobody else's. A team invites another by name and it lands on that
team's page rather than as a link to paste; being a guest costs them nothing,
so they can still open a field of their own.

Underneath sits a rule rather than a setting: **each of a team's robots may be
in exactly one seat, anywhere on this server, at any moment.** It makes "what is
my robot doing right now" answerable, and it removes the fixture conflict
without a second rule — during their match both robots are seated, so there is
nothing left to rehearse with. The check lives in the hub, because a child arena
can only ever see its own world.

**A fixture pre-empts practice.** When a fixture's arena opens, each team's own
practice field is closed and any seat of theirs on another team's field is
emptied, said on the field and on their team page. Without an explicit winner
the rule above would deadlock at the worst moment of the day, when a team whose
robot is still held by a field they walked away from cannot be seated in their
own match.

**Everything goes through the one port.** A practice arena binds loopback under
a league server exactly as a fixture does, so every one of these checks is on
the only road in. On a plain `serve practice` it still binds wide: there is no
hub in front of it and no accounts to check.

## Fixing a team's file

A student uploads the wrong file twenty minutes before their match. It happens
at every event, and until Phase 12 the only fix was an ssh session.

**`/admin/teams`** shows every team, both robots, and what each one actually
has on the server: the entry point, the files, when they arrived, and — the
question the screen exists for — whether it **loads**. That last one is the
same three checks the lineup makes: a manifest that parses, a robot number
matching the folder it is in, and a join token. A robot that fails any of them
does not error; it is quietly replaced by the built-in agent wearing the team's
name, and nobody finds out until kick-off.

Under each robot is every push kept before the one that is live, newest first,
with who made it. Open one to read its files, then **Put this back**, with a
reason — required, like every `amend` verb, because without one it is an edit
rather than a correction.

An organiser **cannot type into a team's folder**, deliberately. A folder
somebody hand-edited is a folder that never went through the validator, and a
competition whose entry route can be bypassed is not one. What a rollback does
instead is put an earlier push through **the ordinary push path**: the same
validator, a freshly minted join token, and the same lineup-lock notice a
team's own push gets. Three things follow from that rather than being promised:

- a push that was valid when it was made and no longer is **fails loudly**,
  with the validator's own sentence, rather than seating a robot that cannot
  start;
- rolling back during a locked pre-game lands for the *next* match and leaves
  the one being played alone;
- the rollback is itself kept, so undoing one is just another one.

**The team's workspace is not touched.** A rollback restores what they
*submitted*; their browser editor still holds whatever broke it, and their next
Run or push will put it straight back. The screen says so beside the button —
the fix is not finished until the team fixes their own copy.

Ten pushes are kept per robot by default. `pushes.keep` in `league.json`
changes it, or `--pushes-kept` for one run; `--pushes <dir>` moves where they
live. They are deliberately **not** stored under `submissions/`, which is
scanned as a list of teams.

## Watching the machine

**`/admin/arenas`** shows three numbers rather than one — what you set, what
the hardware guarantees, and what is in use right now, read from the live
processes — with a row per arena giving its kind, owner, age, CPU, memory and
how much of real time its match is managing to play. A venue's real failure
mode is four things running that should not be and nobody knowing which machine
they are on. The page refreshes itself every few seconds, because every number
on it is a live one.

Each row also says **why the field is still up**:

| Column | What it means |
| --- | --- |
| `2 here` | People on it right now — a viewer, a console. |
| `quiet, 14m ago` | Nobody is on it, and when somebody last was. |
| `closing in 3m` | It has been warned and goes at that time unless somebody comes back. |

A **connected robot deliberately does not count** as somebody being there. A
field of robots playing to an empty stand is precisely the waste being
reclaimed, and one forgotten laptop program would otherwise outrank the team at
the front of the queue.

That queue is at the bottom of the same page, front first, because it is not
just a list of teams waiting — it is what makes the sweep impatient. With
nobody waiting a field sits for the full idle time; with somebody waiting that
halves, and only the quietest field goes per sweep. Reading *closing in 3m*
without seeing the queue beside it is reading half the sentence.

**Stop** needs two presses. The list re-renders while you read it, and one
press on a row that moved under the cursor is not a decision anybody made.

## Who may do what

**`/admin/people`** is every account at the venue: who they are, what their
role carries, anything granted on top of it, and which fixtures they referee.
Invitations are issued from the bottom of the same page.

**A role is fixed when the account is made.** There is no promotion. A referee
who should also be able to correct the draw is given that one thing as a
*grant*, which is the whole reason the capability table has grants in it: "Sam
may also amend the draw" should be a row somebody can read and take back, not a
fifth kind of account invented on the morning of an event.

Click a name to open them. Under **What they may do** is their role's list,
each with its reach, then any grants, each with a Revoke. To add one, pick a
capability, a reach, and — if it should only apply to one thing — name that
thing:

- **any** — everything of that kind.
- **own** — only things named after them. A team account's slug is also its
  folder on the server, so "own" means the same thing to the check and to the
  disk.
- **assigned** — only what they have been assigned, one fixture at a time.
  **On its own this reaches nothing**, and the page refuses it: being assigned
  *is* naming the thing, so give it a target or use `any`.

**Naming a thing beats the reach.** A grant with a target applies to that
target and nothing else, whatever the reach says, because the narrower of the
two is the one you meant. The page tells you what the combination in front of
you will actually do — including when it would change nothing, and when it
would widen something much further than it looks.

### Who referees what

The same page lists the draw and who has each fixture. Assign somebody, or take
it back; it is in force on their next request, with no restart. A referee holds
the matches named there and no others — that is what `assigned` means — so a
referee with nothing assigned has no match to control, which is the intended
state rather than a fault.

A voided fixture is not offered to anybody. An assignment already made to one
stays on that person's own card with a **Take back** beside it, because voiding
a fixture does not unassign anybody and a row nobody can remove outlives its
reason.

`assign` does the same from a terminal:

```bash
bun run serve -- assign --referee sam-referee --draw state-round-1 --fixture alpha-v-bravo
bun run serve -- assign --referee sam-referee --draw state-round-1 --fixture alpha-v-bravo --remove
bun run serve -- assign --list
```

### Passwords, and being locked out

Each person's card has a password reset — the eleven-at-night hatch, for
somebody who cannot log in with their match next. Disabling an account stops it
signing in and ends every session it had.

**The last organiser who can still sign in cannot be disabled**, whoever asks.
A venue with nobody able to reach `/admin` on a Saturday has no way back in
from a browser. The terminal is not held to this, on purpose:

```bash
bun run serve -- account --create --role admin --name "Another Organiser" --password '…'
```

## Who did what

**`/admin/audit`** is the log, newest first: when, who, what they did, and what
they did it to. Everything gated by a capability writes a row — amending a
draw, rolling a team's file back, stopping an arena, opening and running a
practice field, and every save the browser editor makes.

Two things about it are worth knowing before you need it.

**The editor's saves are hidden by default.** The editor autosaves about once a
second while somebody is typing, so on an afternoon with twenty students they
are tens of thousands of rows. They are all recorded — nothing is thrown away —
but the page opens without them and says how many it is leaving out. One press
brings them back.

**Some rows have no name against them.** A field closed by the idle sweep says
*nobody signed in*, because nobody asked for it — and so does an account made
with the `account` command, because a terminal is not an account either. That row is the answer to the
most common complaint of the day — *my field disappeared while I was at lunch*
— and attributing it to whoever happened to be signed in would be worse than
saying nothing.

Filter by act or by person at the top. The log is not pruned: it grows by a few
megabytes on a busy day, inside `league.db` beside the accounts.

## Changing settings

**`/admin/settings`** is `league.json` as a form, grouped the way the file is
grouped, and **everything on it takes effect immediately**. The venue is not
restarted for any of it: the next practice field is opened under the new
ceiling, the next sweep uses the new quiet time, the next push prunes to the
new history cap.

Two things it will not do, and says so on the page:

- **Lowering the arena ceiling refuses the next arena — it never stops a match
  already being played.** Nothing is evicted because a number changed.
- **New per-seat grants reach arenas started from now.** A child process is
  given its grants when it starts and keeps them until it ends.

A value out of range is **clamped rather than refused**, and the page tells you
in the file's own words — the same sentence you would get from
`league.json` at eleven at night, because it is the same reader. The file is
then written with the number that will actually be obeyed, so the file and the
screen never disagree.

If you started the server with a flag — `--idle-mins`, say — that key shows
*set by a flag for this run*. Saving takes it back: the value you type wins and
becomes the file's. Flags on keys you did not touch keep working for the rest
of the run and are **not** written into the file, because a flag is for one run.

## From a terminal

`arenas` lists what a league server is running, and stops one — over HTTP, with
an ordinary API key from an admin account's `/team/settings`, because an arena
lives in the running server's memory and nothing on disk knows about it:

```bash
bun run serve -- arenas --url http://localhost:8080 --key rcja_…
bun run serve -- arenas stop <id> --url http://localhost:8080 --key rcja_…
```

Both are on `/admin/arenas` as well. They are here too because the day this
gets asked in earnest is the day the browser is the thing that has gone wrong.

## Installing on a fresh host

### Quick install (Standalone binary)

On a Linux host (e.g. Ubuntu or Debian venue machine), install the system prerequisites and run the one-line installer:

```bash
# Install sandboxing and python
sudo apt update && sudo apt install -y bubblewrap python3

# Install rcja-soccer-sim standalone binary (no Bun or Node required)
curl -fsSL https://raw.githubusercontent.com/marc-cr1810/rcja-soccer-sim/main/install.sh | bash
```

This places `rcja-soccer-sim` in `~/.local/bin/rcja-soccer-sim`, ensures permissions, and enables systemd linger.

Then initialize the venue league:
```bash
rcja-soccer-sim league-setup
```
Data files will be cleanly stored in `~/.local/share/rcja-soccer-sim/` (XDG standard).

---

## Running as a background service (Linux systemd)

The binary manages its own systemd user service with no root privileges needed:

```bash
# Install, configure and start the background service immediately:
rcja-soccer-sim service install

# Check live service status:
rcja-soccer-sim service status

# Tail live output and match events:
rcja-soccer-sim service logs

# Restart or stop the service:
rcja-soccer-sim service restart
rcja-soccer-sim service stop
```

*(From a git clone, `make systemd-user` is also available and runs `service install`.)*

---

## Updating and release notifications

### Startup release notifications
Whenever `rcja-soccer-sim league` or `serve` starts, it checks GitHub Releases in the background (cached for 12 hours). If a newer version is published, it prints a notification banner:

```text
  ╭────────────────────────────────────────────────────────╮
  │  Update available: 26.9-0f74e6 → 26.10-1a2b3c          │
  │  Run 'rcja-soccer-sim upgrade' to update               │
  ╰────────────────────────────────────────────────────────╯
```
*(To disable checks in offline air-gapped environments, pass `--no-update-check` or set `RCJA_NO_UPDATE_CHECK=1`)*.

### One-command upgrade
To update the server to the latest release:

```bash
rcja-soccer-sim upgrade
```

- **For binary installations**: downloads the latest matching platform binary from GitHub Releases, replaces the executable atomically, and restarts the running systemd service.
- **For git installations**: automatically runs `git pull`, `bun install`, `make build`, and restarts the service.
- All team accounts, registrations, tournaments, and match results are preserved untouched.

## What this is not yet

A Run button in the browser workspace, a field that gives itself back when a
team walks away, a referee's pre-game and lineup lock, and the full
administration screen are the phases after this one — see
[PHASES.md](../PHASES.md). Today a field stays open until its team closes it or
its team is called to a match.
