# Running a league

For whoever is running the event, once it is bigger than one laptop.

Everything else in this manual describes a **match server**: one process, one
world, no accounts, nothing to log into. That is still exactly what it was, and
`npm run serve` is unchanged — no login, no front page, no database file
created, nothing to opt into. A team practising in a classroom should never
have to stand up an identity system to see their robot move.

A **league server** is the other deployment. It owns accounts, the draw, the
schedule and the public pages, and it shows the football happening in the same
match server a team runs on a laptop.

```bash
npm run build:viewer && npm run build:referee && npm run build:workspace && npm run build:site
npm run serve -- league --name state-round-1
```

```
  RCJA Soccer Simulation — league server
  front page:  http://localhost:8080
  watch:       http://localhost:8080/live/
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
npm run serve -- account --create --role admin --name "Your Name"
```

It asks for a password twice and prints the name to log in as. Everybody else
registers with a **single-use invitation code**:

```bash
npm run serve -- invite --role team --team "ACT Robotics"
npm run serve -- invite --role referee
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
npm run serve -- account --passwd --name act-robotics
npm run serve -- account --list
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

SQLite costs no dependency — `node:sqlite` is built into Node. It is
experimental before Node 24, and the league commands quieten exactly that one
warning rather than asking you to silence all of them.

## What the front page shows

Three bands, folded fresh out of the draw and whatever results exist:

- **Now playing** — the fixture being played, with its score, half and clock,
  linking through to the live viewer.
- **Up next** — the fixtures after it.
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

## What this is not yet

Several matches at once, practice fields that belong to a team, a Run button, a
referee's pre-game and lineup lock, and the full administration screen are the
phases after this one — see [PHASES.md](../PHASES.md). Today a league server
runs one world at a time, and a practice field is still opened on a match server
with `--practice-fields`.
