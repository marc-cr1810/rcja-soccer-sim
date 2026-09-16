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

## The first admin, and every account after it

The first organiser cannot be made from a page that requires an organiser to log
into, so it is made from the terminal:

```bash
bun run serve -- account --create --role admin --name "Your Name"
```

It asks for a password twice and prints the name to log in as. Everybody else
registers with a **single-use invitation code**:

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

## Arenas, and how many of them

An **arena** is one child process holding one world: a fixture from the draw, or
a practice field somebody opened. They are reached under `/a/<id>/` through the
one port the venue configured, so a robot on a student's laptop still has
somewhere to connect and the venue still opens one hole in one firewall.
`/f/<id>/` keeps working, because it is in the docs and in students' history.

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
    "perTeam": 1,
    "claimSecs": 90
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

A broken `league.json` does not stop the server. It starts on the defaults and
prints what it ignored, because an organiser with a stray comma twenty minutes
before a match needs a server that comes up.

## Refereeing

A referee signs in and opens **`/referee`**, which lists the matches in progress;
the console opens on the arena playing one. There is no token to hand out and
nothing to paste. The hub decides from the session and the referee's capability
whether to let them in, so a spectator never downloads match-control code at
all.

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

## Watching the machine

`/admin` shows three numbers rather than one — what you set, what the hardware
guarantees, and what is in use right now, read from the live processes — with a
row per arena giving its kind, age, CPU, memory and how much of real time its
match is managing to play, and a button to stop it. A venue's real failure mode
is four things running that should not be and nobody knowing which machine they
are on.

## From a terminal

`arenas` lists what a league server is running, and stops one — over HTTP, with
an ordinary API key from an admin account's `/team/settings`, because an arena
lives in the running server's memory and nothing on disk knows about it:

```bash
bun run serve -- arenas --url http://localhost:8080 --key rcja_…
bun run serve -- arenas stop <id> --url http://localhost:8080 --key rcja_…
```

Both are on `/admin` as well. They are here too because the day this gets asked
in earnest is the day `/admin` is the thing that has gone wrong.

## What this is not yet

A Run button in the browser workspace, a field that gives itself back when a
team walks away, a referee's pre-game and lineup lock, and the full
administration screen are the phases after this one — see
[PHASES.md](../PHASES.md). Today a field stays open until its team closes it or
its team is called to a match.
