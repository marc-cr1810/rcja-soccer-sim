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

At a league server, sign in and open **your team's page**. There is an **Open
one** button under *Your practice field*. The field that appears belongs to
your team: you run it, and nobody else can see the console or touch a seat
unless you invite them.

One field per team is the usual setting. If every field on the server is in
use you are given a **place in the queue** instead of an error, with how many
teams are ahead of you. When one frees up it is *held* for you for a short
while and your team page says so — claim it and it is yours; leave it and it
passes to the next team, so a field is never opened for somebody who has gone
home.

**Inviting another team.** Type their name under your field and press
**Invite**. It appears on *their* team page, not as a link to paste around.
Once they accept they can open the console and put their own robots in seats —
but the field is still yours to drag, start, stop and close. Being a guest
costs them nothing: they can still open a field of their own.

If the organiser started a plain match server with `--practice-fields` instead,
there are no accounts at all: `POST /practice` answers with a link, and anybody
who has that link can join and move things.

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
- **what I am writing** — the code in your [browser workspace](writing-in-a-browser.md)
  as it stands right now, pushed or not. This is the fast loop: type, press
  **Run it**, watch. The server takes a *copy* when you press it, so you can
  carry on typing while it plays, and what is on the field stays the version you
  ran until you run it again.
- **a pushed robot** — your submission. It runs sandboxed, exactly as it would
  in a match. **Restart** re-spawns it, which is what you want after pushing a
  new version; **Stop** kills it.
- **my laptop** — a program on your own machine, connected live. On a plain
  match server, run it with the field's own agent URL:

  ```bash
  python myrobot.py --team violet --number 1 --url ws://<host>/agent
  ```

  On a league server the seat is *yours*, so it asks for a token. Setting the
  seat prints a whole command under it — copy it, and run it in the folder your
  robot is in:

  ```bash
  python3 python/join.py --token <token> --url ws://<host>/a/<field id>/agent my_robot.py
  ```

  `join.py` runs **your file, unedited**. Nothing about the token or the
  address goes into your code, so the robot you tested is the robot you push,
  character for character. The token is for that one seat and does not last; if
  it stops working, set the seat to *my laptop* again and copy the new command.

  This is the practice loop from [writing a robot](writing-a-robot.md) — no
  push, no validation, no waiting — and a practice field is the place it was
  always meant to point at.

## Running what you are writing

The quickest way onto a field is the **Run it** button — in the browser editor
beside *Push to the competition*, and on your team page beside each robot. It
opens your field if you have not got one, puts that robot in a seat, and takes
you to it. If every field is in use you are told your place in the queue, the
same as pressing *Open one*.

Running is not pushing. The code is run exactly as you typed it, including code
that does not parse — that is what it is for. Nothing about it reaches the
competition until you press *Push*, and a match still plays whatever you last
pushed.

**Reading what went wrong.** A seat running your code has an **Output** button.
Whatever your program printed is under it, and so is the traceback when it
crashed — the same text you would see in a terminal if you were running it on
your own machine. If your program dies at startup you will see it exit and be
restarted a few times, and then the reason. The **Restart** button re-runs it
and keeps what was already said, so you can read the crash and the retry next
to each other.

**Whose robot is whose.** On a league server you fill the seats holding your
own robots, and so does every team you invite. Seats holding somebody else's
robot are shown but not yours to change. That also means you cannot rehearse
against another team's pushed code unless they come onto your field and put it
there themselves — their robot is theirs.

**One robot, one place.** Each of your two robots can be in exactly one seat
anywhere on the server at a time. Ask for a second and you are told where the
first one already is. It is not a limit invented to save CPU: a team has two
robots, and two robots cannot be on two fields. Your team page always says
where each of them is.

To measure a robot against many opponents at once, use
[the bench](writing-a-robot.md) — it plays a robot over a range of seeds
headless, on your own machine, and prints numbers, which is what "gather data
faster" actually wants.

**When your match is called.** A fixture always wins. When your fixture's arena
opens, your own practice field is closed and any seat of yours on somebody
else's field is emptied, with a line saying why — on the field and on your team
page. Both your robots are about to be seated in the match, so there is nothing
left to rehearse with anyway.

A robot whose program is not answering comes **off the field** rather than
standing on it as an obstacle, and goes straight back on when the program
reconnects. There is no thirty-second stand-down here; that is a match
sanction, and restarting your own program in practice is not a sanction.

## Giving a field back

A field holds a whole simulation and up to four sandboxed programs, and a venue
has only so many. So a field nobody is using is given back.

**What counts as using it:** somebody on it — you or a guest, with the console
or the viewer open and in front of them — or somebody doing something to it: a
drag, a seat change, start, stop. **A connected robot does not.** A field of
robots playing to an empty stand is exactly the thing being reclaimed, and a
program somebody forgot to close should not outrank the team waiting in line.

You are **warned before anything happens**, on the field itself and on your team
page, with the time it will close. Touching anything at all cancels it. How long
you get depends on whether anybody is waiting: on a quiet afternoon it is
generous, and when there is a queue the quietest field goes first.

**Closing costs you a process, not your afternoon.** The arrangement — who was
on the field, where, and where the ball was — is saved into your team folder,
and the next field you open comes back with it already set up. What you lose is
the running programs, which you start again in one press.

A practice field spends most of its life **stopped** — that is its normal state
while you drag things into place. A robot seated on a stopped field is still
read and still hears from the server; it just cannot move, and its frames say
`playing: false`. Nothing times out while you think.

## What a practice field is not

It is not a match. Nothing is scored against you, no result is written, and a
tournament will never see it. On a plain match server started with
`--practice-fields` it is also not private: anybody with the link can open your
field and move your robots. On a league server it is — the field belongs to
your team, and a guest gets on it by invitation.

And it is not the place to find out whether your robot is *good*. A staged
situation tells you what your robot does in that situation, which is exactly
what a match will not hand you. For strength, play matches —
[running a server](running-a-server.md) — or ask the bench.
