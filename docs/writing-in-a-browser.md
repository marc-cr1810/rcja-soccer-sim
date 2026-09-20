# Writing in a browser

For a student on a school machine that will not let them install anything —
no Python, no editor, no terminal. Everything needed is already on the venue's
server; this gives them somewhere to keep their code and a way to type into it.

Their code **runs on the server**, not in the tab: the same CPython, the same
`bwrap` sandbox with the same CPU and memory ceilings, the same simulator a
scored match uses. That is the whole reason it works this way. A rehearsal on a
different Python, without the ceilings, would be a rehearsal of a different
sport — a robot that was comfortably fast enough in a tab could blow its budget
at the venue, and the team would find out during the match.

What a team needs: a browser, the address of the venue server, and a secret.

## Running it (for the organiser)

Build the bundle once, then start the server with a team list:

```bash
bun run build:viewer && bun run build:workspace
```

Write a JSON file of team names to secrets — one line per team you have
registered. Make the secrets long and random; anyone holding one can read and
replace that team's code.

```json
{
  "ACT Robotics": "9Qb2pLm4vTz8Kx3w",
  "NSW Lightning": "r7Hs2nD6yUe1Fq5a"
}
```

```bash
rcja-soccer-sim serve --team-tokens teams.json
```

It prints where the workspace is and which teams it knows:

```
  team workspaces:  http://localhost:8080/workspace
  teams:            ACT Robotics, NSW Lightning
```

Hand each team their own secret, out of band. This is the same hand-issued
arrangement as the Phase 1 push token and the referee's console token.

**At a real event, run a [league server](running-a-league.md) instead.** There
the team signs in to the site and this page opens with nothing to paste — the
secret becomes their account, which is the only thing that changes about it.
The arrangement here is the laptop one, and it stays, because a laptop has
nobody to register with.

| flag | what it does |
|---|---|
| `--team-tokens <file>` | the JSON above; hosting workspaces at all |
| `--team-token TEAM=SECRET` | one team inline, for trying it out |
| `--workspaces-dir <dir>` | where the folders are kept (default `./workspaces`) |

Without `--team-tokens` or `--team-token` there is no workspace on the server
at all: `/workspace-api/*` answers 404 for everything, and nothing about a
plain `serve` changes.

## Using it (for a team)

Open `/workspace`, paste your secret, and you are in. A team that has never
been here gets a starter robot that already drives at the ball — not a good
robot, deliberately, but a complete and legal one, so your first act is
changing something and seeing what it did rather than working out what a
manifest is from a blank page.

**Robot 1 and Robot 2 are separate**, with their own files and their own push,
because the two robots on a side are routinely written by two different people.
Switch between them at the top.

**Your code saves as you type** — there is no save button, and closing the tab
does not lose the line you were on. The header says `saved` when the server has
it.

**Push to the competition** when you want it to count. It is checked the moment
you push, not at the moment you play: the manifest has to parse, the code has
to be valid Python, it can only import the standard library, `rcja_soccer` and
the MicroPython modules (`machine`, `utime`, `micropython` and the `u*`
aliases), and it has to answer one tick. If any of that fails you get told why, in words
you can act on:

```
robot.py imports "numpy", which is not available at a venue with no internet
and no pip. Only the standard library, the MicroPython modules (machine,
utime, micropython and the u* aliases), rcja_soccer, and files in this same
folder are.
```

A push that fails changes nothing — whatever you last pushed successfully is
still what will play.

## Watching it play

**Run it** is beside *Push to the competition* on a
[league server](running-a-league.md). It opens your team's
[practice field](practising.md) if you have not got one, puts that robot in a
seat and takes you to it, and from there you drag things around and watch.

What runs is **what you typed, as it stands**: the server takes a copy the
moment you press it, so you can carry on editing while it plays, and the robot
on the field stays the version you ran until you run it again. Your code does
not have to be good, or finished, or even parse — running it is how you find
out that it does not. Nothing here reaches the competition until you press
*Push*.

**When it crashes**, the seat has an **Output** button and your traceback is
under it, the same text a terminal would have shown you. That is the whole
point of running it on a field rather than guessing.

On a plain match server started with `--team-tokens` there is no Run button:
there are no accounts, so there is nothing to decide whose field is whose. Push
from here instead, and ask your organiser to put your robot on a practice field
— a seat takes a pushed submission by team name. If they have given you the
link to a field, you can fill its seats yourself from its console.

## What this is not

**It is not a different way to enter.** A workspace pushed from a browser and a
folder pushed with `python/submit.py` go through the same validator and land in
the same place on disk, with the same join token beside them. A competition
where the entry route changed the rules would not be a competition.

**It is not a place to keep anything but a robot.** A robot folder is flat —
`manifest.json`, an entry point, and whatever `.py` files it imports from
alongside it. No subdirectories, no data files. See
[writing a robot](writing-a-robot.md) for the format, and
[python/README.md](../python/README.md) for what a robot can see and do.

**It is not private from your organiser.** A workspace is ordinary files on the
venue's disk, which is deliberate — it means an admin can look at your code
with a text editor when something is going wrong at eleven at night.
