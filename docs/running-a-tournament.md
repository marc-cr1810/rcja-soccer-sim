# Running a tournament

A draw goes in, a division plays, and a table comes out — and it survives the
process being killed, because a venue's laptop will be.

Three commands:

```bash
npm run serve -- draw --name state-round-1
npm run serve -- tournament --name state-round-1
npm run serve -- table --name state-round-1
```

## Making a draw

```bash
npm run serve -- draw --name state-round-1
```

Entrants default to every team that has actually pushed a robot that would
load — the same checks a lineup makes, so a team listed here is a team that can
play. Name them yourself instead with `--teams "ACT,QLD,VIC"`, which is how you
rehearse a draw before anyone has pushed anything.

Everyone plays everyone else **both ways round**. That is not a nicety: kick-off
placement, starting headings and which goal the camera finds first all differ
between violet and lime, so a single meeting measures the colours as much as it
measures the robots. Three entrants is six fixtures, four is twelve.

| flag | |
|---|---|
| `--name` | required; also the folder the tournament lives in |
| `--teams "A,B,C"` | entrants, instead of scanning `submissions/` |
| `--legs 1` | matches per fixture; `3` for best-of-three |
| `--half 300` | seconds per half |
| `--seed 1` | the draw's base seed |
| `--headless` | make a tournament that never waits for a referee |

**A draw is written once and never rewritten.** Re-running `draw` with the same
name fails rather than quietly replacing a fixture list an organiser has already
printed and pinned to a wall. To change one, delete the folder by hand.

### Best-of-three

`--legs 3` plays each fixture three times on three seeds fixed when the draw is
made, and the side that wins more legs takes the fixture and its three points.
Goals aggregate across the legs; the *legs* decide it, not the aggregate, so one
blowout cannot take a fixture that was otherwise even.

It is worth the three times the match time when a table has to mean something.
A single meeting is mostly noise — separating a reference agent at skill 1.0
from one at 0.35 took sixteen matches, which is recorded in the Phase 0 test —
so a table built from single matches is partly a table of luck.

## Playing it

```bash
npm run serve -- tournament --name state-round-1
```

By default every fixture **waits for a referee** and plays at wall-clock, which
is what a tournament day looks like: the hall watches, and teams see what their
robots actually did.

The referee console works exactly as it does for a single match — see
[running a server](running-a-server.md#refereeing-a-match) — with one
difference worth knowing:

**The referee signs in once, for the whole tournament.** The token is printed
once when `tournament` starts and lasts the day. Between fixtures the console
follows along on its own: the scoreboard changes to the next pairing, and the
match sits there until someone presses a kick-off. There is no rejoining, no
reload, and no second token.

`--headless` plays the run unattended instead, whatever the draw says — for
getting a table out of a qualifying round without anyone clicking.

| flag | |
|---|---|
| `--name` | required |
| `--headless` | play this run unattended |
| `--port 8080` | |
| `--referee-token` | set the token yourself instead of a random one |

**Headless and refereed are not interchangeable results.** Headless play steps
as fast as the programs can answer rather than waiting for them, so a robot that
is slow to reply misses more control cycles than it would at wall-clock. The
misses are recorded per seat in every match record, so it is visible rather than
silent — but play a division one way or the other, not half each.

This is also why the choice is per *run* and not per fixture: the speed is a
property of the server, so it cannot change between fixtures inside one process.

## Stopping and carrying on

Ctrl-c, then re-run the same command. It picks up at the fixture that did not
finish.

There is no state file to corrupt and no "resume" flag. A tournament is its
draw, which never changes, plus whichever fixture results are on disk; the table
is folded out of those every time it is asked for, and the next fixture is
simply the first one with no result yet. A fixture interrupted halfway leaves
nothing behind, so it plays again from the start — which is what should happen,
because half a match is not a result.

## What is left behind

```
tournaments/<name>/draw.json
tournaments/<name>/results/<home>-v-<away>.json
```

One file per completed fixture, written whole or not at all. Each one is the
published record of that fixture, and carries:

- the **seed** of every leg, recorded in the draw before a ball was kicked, so
  the match can be replayed
- the **sha256 of the code in each seat** at the moment it played — a team name
  cannot stand in for this, because a name is re-pointed at new code on every
  push. A seat missing from that list was filled by the built-in agent.
- every **referee call** of the match, in order and complete. The referee
  console's own event list is a 60-entry ring buffer sized for a banner; the
  record is not, so a ten-minute match keeps its first half.
- every **referee action** that took effect — what was pressed, and at what
  point on the match clock
- the score, the goals with their times, any score corrections, whether it was
  abandoned and why, and per-seat connection health

That is what makes a result reviewable rather than merely recorded, and it is
what a later front page is built on.

## The table

```bash
npm run serve -- table --name state-round-1
```

Three points a fixture, one for a draw, ordered on points, then goal
difference, then goals for — as every other soccer league. A best-of-three
fixture is one meeting, so it is one row's worth of points, not three.

An abandoned match counts with the score as it stood. The record keeps enough
for a tournament committee to decide otherwise.
