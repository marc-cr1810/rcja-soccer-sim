# Practising

A **practice field** is a match nobody is scoring, with the situation in your
hands. You put your pushed robots on it, drag them and the ball wherever you
want them, start it, and watch. Nothing on a practice field is scored, nothing
goes in a table, and nothing about it is written to disk.

It runs the same code a real match runs: the same simulator, the same sensors,
the same rule detectors, and — for a seat filled by a robot you pushed — the
same sandbox with the same CPU and memory ceilings. That is the point. A
rehearsal that ran your robot under different conditions from the ones it will
play under would be rehearsing a different sport.

## Opening one

At a venue, if the organiser started the server with `--practice-fields`, open
`/practice` on it and click **Open a practice field**. You get a link. Anyone
who has that link can join and move things, so hand it to your team and nobody
else — practice fields have no passwords until the league has accounts.

On your own machine:

```bash
bun run build:viewer && bun run build:practice
bun run serve -- practice
```

That prints two URLs: one to watch the field, and one to arrange it. Push
robots to it exactly as you would to a venue server — a practice field
accepts `POST /submit` like any other:

```bash
python python/submit.py --dir myrobot --url http://localhost:8080/submit
```

## Arranging it

The console shows the field from overhead and a panel on the right.

**Drag a robot or the ball** to put it where you want it. That works while the
field is playing as well as while it is stopped — pushing the ball into a
corner mid-run to see what your robot does next is the whole reason it is a
drag and not a text box. Where you drag something is also where it goes back
to; **Put it back** re-stages the situation you arranged, and **Keep this**
takes the field as it stands right now to be that situation instead.

**Start** and **Stop** run and freeze play.

**When a goal goes in** decides what happens once the situation resolves
itself — a goal, or the ball leaving the field:

- *Set it up again* puts your arrangement back out and plays it again. Good
  for watching the same thing ten times.
- *Play on* carries on as an ordinary match would, from a kick-off — with the
  robots that are actually in your situation, not four.
- *Freeze* stops and holds the field exactly as it is, so you can look at it.

You can change this while it is running, the way a referee changes a match.

## Filling a seat

Each of the four seats is one robot, and each can be:

- **not in it** — the robot is not part of this situation at all. This is how
  you rehearse one robot alone, or robot 1 against robot 2: take the rest off.
- **a built-in robot** — the reference agent, as an opponent or a teammate.
- **a pushed robot** — your submission, by team name. It runs sandboxed,
  exactly as it would in a match. **Restart** re-spawns it, which is what you
  want after pushing a new version; **Stop** kills it.
- **my laptop** — a program on your own machine, connected live. Run it with
  the field's own agent URL:

  ```bash
  python myrobot.py --team violet --number 1 --url ws://<host>/agent
  ```

  On a venue server the field's URL prefix is part of that address:
  `ws://<host>/f/<field id>/agent`. This is the practice loop from
  [writing a robot](writing-a-robot.md) — no push, no validation, no waiting —
  and a practice field is the place it was always meant to point at.

A robot whose program is not answering comes **off the field** rather than
standing on it as an obstacle, and goes straight back on when the program
reconnects. There is no thirty-second stand-down here; that is a match
sanction, and restarting your own program in practice is not a sanction.

## What a practice field is not

It is not a match. Nothing is scored against you, no result is written, and a
tournament will never see it. It is also not private: until the league has
accounts, anybody with the link can open your field and move your robots.

And it is not the place to find out whether your robot is *good*. A staged
situation tells you what your robot does in that situation, which is exactly
what a match will not hand you. For strength, play matches —
[running a server](running-a-server.md) — or ask the bench.
