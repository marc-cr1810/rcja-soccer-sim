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
npm run build:viewer && npm run build:workspace
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
arrangement as the Phase 1 push token and the referee's console token, and it
is replaced by real accounts in Phase 6 — what those tokens are *for* does not
change, only where they come from.

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
to be valid Python, it can only import the standard library and `rcja_soccer`,
and it has to answer one tick. If any of that fails you get told why, in words
you can act on:

```
robot.py imports "numpy", which is not available at a venue with no internet
and no pip. Only the standard library, rcja_soccer, and files in this same
folder are.
```

A push that fails changes nothing — whatever you last pushed successfully is
still what will play.

## Watching it play

There is no Run button yet. It is coming, and it needs something this does not
have: a field that belongs to your team, which means accounts rather than a
secret your organiser wrote down. That is the next phase.

Until then you are not stuck. Push from here, then ask your organiser to put
your robot on a [practice field](practising.md) — a seat takes a pushed
submission by team name, so yours goes on the same as anybody else's, and you
watch it in the browser like a match. Slower than it will be, and it costs
somebody else thirty seconds, but nothing about your robot is waiting on it.

If your organiser has given you the link to a practice field of your own, you
can fill the seats yourself from its console.

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
