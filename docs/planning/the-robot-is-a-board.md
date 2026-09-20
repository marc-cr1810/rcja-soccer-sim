# The robot is a board

*Re-cut of Phase 13. Supersedes the VS Code extension as previously scoped;
the trace inspector it used to be becomes Phase 14.*

*Gate: a student who has used a Pico connects to their robot, copies files onto
it, interrupts it, types `ball.read_u16()` at a `>>>` prompt and gets a number —
then carries the same robot onto a practice field and into a match, without
uploading anything a second time.*

---

## Context

The API fidelity is already there and is not what this is about. `machine.Pin`,
`PWM`, `ADC` on a real pinout, `time.sleep_ms(20)` as the frame boundary, one
runtime owning one connection, a camera that speaks a framed protocol over a
UART. A student who has met a Pico recognises every line of that.

**The fidelity stops at the module boundary.** Above `import machine`, the
vocabulary is deployment, not robotics: four ways for code to reach a field,
five seat kinds of which three are the same code at different staleness, a
`manifest.json` no board has, and tokens and URLs a child copies off a web page
into a terminal.

And the two layers now openly contradict each other. `python/examples/board.py`
reads the robot switch on pin 41 and documents it as *"1 or 2. Two robots a
side, **and the same program on both**"* — while
[writing-a-robot.md](../writing-a-robot.md) says *"A submission is one team's
one robot — not a two-robot team folder… A team with two robots pushes twice."*
The board says one program on two boards; the submission system forbids it.

On a real robot the whole model is one sentence: **files live on the board, and
you carry the board to the field.**

---

## The nouns

Four, and three of them already exist in some form.

**A project** is a folder of Python. A team has as many as it likes — one, two,
or five. It is the thing a student has open in an editor, and on a laptop it is
literally a directory.

**`lib/`** is a team-level folder that lands on **every** board, alongside
whichever project was flashed. This is MicroPython's own convention — `/lib` is
on a board's `sys.path` — so it is not a concept this project invented, and it
is what makes shared code possible without a build step.

**A board** is a filesystem, and a team has exactly two: robot 1 and robot 2.
That number is not a design choice; it is how many robots a side has. A board
is what plays, what you connect to, and what gets checked in.

**A seat** is where a board plays — a position in a practice field or a match.
Moving a board between seats copies nothing.

The one verb is **flash**: copy a project (plus `lib/`) onto one or both
boards. Everything a student does is a project, a board, or flashing one onto
the other.

---

## Two robots, three layouts, one mechanism

The three shapes a team might want are not three features. They are three ways
of using *projects → boards*, and the server does not need to know which one a
team has chosen.

**One project, both robots.** The solo student, and the common case.

```bash
rcja push                 # flashes the current project to both boards
```

Both boards hold identical files. They differ only by the robot switch, exactly
as two real robots flashed from the same laptop do. A team that wants different
behaviour branches on it:

```python
if board.robot == 2:
    ...                   # their choice, their meaning, not ours
```

**Two projects, one per robot.** Two students, two laptops, nobody merging —
the case [writing-a-robot.md](../writing-a-robot.md) was right to protect.

```bash
cd striker && rcja push --to 1
cd keeper  && rcja push --to 2
```

**Two projects sharing code.** The same as above, plus a `lib/` that both
boards get. `from lib import drive` works on the board because `lib/` is on the
path there, the way it is on real hardware.

```
myteam/
  lib/            shared — lands on every board
  striker/        flashed to robot 1
  keeper/         flashed to robot 2
```

Nothing above is a mode or a setting. A team that never opens `lib/` never
learns it exists; a team with one project never types `--to`.

### No roles in the starter

The starter stays one behaviour with no striker/keeper split. Flashed to both
boards it produces two robots that chase the same ball and get in each other's
way — and **that is the first real problem the team gets to solve**, in their
own vocabulary, with whatever division of labour they invent. Shipping a role
switch in the starter would be handing them our answer to a question they have
not yet asked, and roles are a strategy decision, not a platform feature.

`board.robot` is there, documented, on pin 41, for the afternoon they want it.

---

## Signing in

Registration is unchanged and stays invite-first: an organiser issues a code,
the student redeems it in a browser, and a session cookie comes back. By the
time anybody runs `rcja`, they have a browser session on the same laptop. That
fact is what makes the terminal side cheap.

**`rcja login` is a device code**, the shape `gh auth login` uses:

```
$ rcja login https://venue.example
Open https://venue.example/device and enter:

    WXYZ-1234

Waiting… approved as "Ana's laptop".
```

1. The CLI posts a machine name (the hostname, overridable) to `/auth/device`
   and gets back a user code to show, a device code to poll with, an expiry and
   a poll interval.
2. The student opens the page in the browser they are already signed into,
   types the code, and sees **what they are approving** — the machine name and
   their team — before clicking.
3. The server mints an ordinary `rcja_` key labelled with that machine name.
   The next poll returns it; the CLI writes it to
   `~/.config/rcja/credentials.json`, keyed by origin, mode 0600.

Nothing secret is typed by a child and nothing secret is copied out of a page.
The only thing crossing by hand is a short, single-use, short-lived code going
*in*. And because the key names its machine, `/team/settings` stops being a list
of anonymous pasted secrets and becomes a list of authorised laptops with a
**Revoke** against each — which is also the fix for the laptop that went home in
somebody's bag.

Three details that are not decoration:

- **The code avoids ambiguous characters.** No `0`/`O`, no `1`/`I`/`l`. A
  ten-year-old is typing this off a screen in a noisy hall.
- **The approval page names the machine, and that is a security control, not a
  nicety.** A device flow's characteristic failure is somebody being talked into
  approving a code that is not theirs — *"hey, just type this in"* — and at a
  venue full of children that is a plausible afternoon. The machine name, the
  team, and a short expiry are what make a wrong one visible. It is worth a test
  that the page refuses a code raised against a different team.
- **A laptop match server needs no login at all**, and `rcja login
  http://localhost:8080` must say so and write nothing rather than failing.
  Phase 6's promise that `serve` creates no database and asks for no account is
  not weakened by a tool that assumes one.

`rcja whoami` prints who and where. `rcja logout` revokes the key server-side
*and* deletes it locally, in that order, so a failure leaves the key revoked
rather than orphaned.

### What this does not fix

A venue is routinely plain http on a hall's own network —
[league.ts](../../packages/server/src/league/league.ts:2440) says so where it
declines to set `Secure` on the session cookie, and it is right to. **Over plain
http a password, a pasted key and a device code are all readable by anybody on
that wifi.** A device code is still the best of the three, because it is
single-use and expires in minutes rather than being a permanent credential in
the clear, but it is not encryption and this plan does not pretend it is.

That is a real problem and it is [Phase 15](../../PHASES.md)'s, not this one's.
It was already owed before this phase existed: accounts have crossed hall
networks since Phase 6.

---

## Workflows

### A. The first afternoon

Nothing installed, a school laptop, a browser:

1. Sign in, open **your team**. Two boards are shown, robot 1 and robot 2, both
   holding the starter project.
2. Click a file. Change a number. It saves as you type — including code that
   does not parse, because an editor that refuses to save broken code is one
   you cannot use halfway through a thought.
3. Press **Flash** → both boards. Press **Play** → your field opens with both
   robots on it.
4. They fight over the ball. Good. Now you have something to fix.

With Python on the laptop, the same afternoon:

```bash
rcja login https://venue.example        # once, ever
rcja new myteam && cd myteam            # starter project, same files
rcja push                               # both boards
rcja play                               # opens your field, both robots on it
```

`rcja login` is the only time a URL is typed and the only time a credential
exists. A real board does not take a `--url`, and after this neither does
anything here.

### B. Flashing

```bash
rcja push                    # this project → both boards
rcja push --to 1             # → robot 1 only
rcja ls 1                    # what is actually on robot 1
rcja diff 1                  # what would change if you flashed it
rcja rm 1 old_helper.py
```

Flashing is not entering the competition. It puts files on a board, the way
`mpremote cp` does, and a board is validated on arrival: syntax, imports, and
the synthetic tick. The team page carries a standing **passes / does not pass**
light per board, so a broken robot is a thing you can see on a Tuesday rather
than a discovery twenty minutes before kick-off. That is Phase 1's promise —
*rejected with a reason at the time they push* — kept.

`rcja diff` exists because the one question a student asks at a venue is *is
what I am looking at what is on the robot*, and on real hardware the honest
answer is usually "nobody knows".

### C. Debugging

Three tools, in the order you reach for them.

**The output.** Whatever the program printed, and the traceback when it died.
Already built — Phase 10's per-seat buffer — and reachable from the field, the
team page, and `rcja logs 1`.

**The prompt.** The one that matters, and the one nothing in the plan had:

```
$ rcja repl 1
Connected to robot 1. Ctrl-C interrupts, Ctrl-D soft-resets, Ctrl-X exits.

>>> from machine import ADC, Pin
>>> ball = ADC(Pin(4))
>>> ball.read_u16()
41230
>>> # put your hand over it and ask again
>>> ball.read_u16()
1204
```

That is how a child learns what a sensor *is*, and it is not reproducible by
printing things in a loop that runs fifty times a second. Interrupting a
running robot works the way it does on a board:

```
>>> ^C
KeyboardInterrupt
>>> board.read().compass.heading
-1.5707
>>> ^D
— soft reset —
```

**The trace.** Phase 14. Not this phase, and the prompt is most of why it can
wait.

**How the prompt works, and its one honest difference.** A statement is `exec`'d
in `__main__`'s namespace *at the frame boundary* — the same window between one
frame arriving and the next going out where `Timer` callbacks already run, and
with the same caveat the docs already give for those: what you write lands on
the next frame. Nothing preempts anything, because nothing here ever does.

Adding a message type to the agent socket breaks no robot anybody has written,
for the reason Phase 9 relied on when it added `disabled`: the client's loop has
always ignored message types it does not know.

**The one rule: your board, your field.** A prompt into a scored match under
lineup lock is cheating, plainly. A fixture arena refuses it outright, and that
refusal gets its own test rather than a comment.

### D. Connecting to a live robot

Two different things a student means by this, and both should be one word.

**Running from the laptop, board untouched** — `mpremote run`:

```bash
rcja run                     # this project, robot 1's seat, from here
```

The board keeps whatever was flashed to it. This is the five-second loop: edit,
`rcja run`, watch. No push, no validation, no waiting.

**Attaching to the board itself** — `rcja repl 1`, above.

#### When there is no field to be had

You asked what happens when a field cannot be allocated. The good answer turns
out not to be a new kind of arena.

Phase 4 already settled that **a situation is an arrangement, not a mode**: the
roster is whichever robots the arrangement names, *"so one robot alone… is an
arrangement rather than a special case"*. So a pit table is not a new thing to
build — it is an arrangement of one robot, no opponents, no ball, stopped. Your
robot on the bench with the USB in.

What needs to change is the accounting, not the machinery: **the cap should
count occupied seats rather than arenas.** A rehearsal is four, a pit is one.
Under the same ceiling, four times as many students can be poking at a sensor,
and somebody checking whether their compass works stops competing with somebody
running a full four-robot rehearsal. The measured per-arena figure behind the
current ceiling was taken on full arenas; a pit needs its own measurement
before any number goes in a config, not an assumption that it is a quarter.

So the ladder is: a field if you can have one, a pit if you cannot, and the
existing queue only if even that is refused. `rcja repl` should almost never
queue, because almost nothing is being asked for.

### E. Moving a robot around

This is the part that has no analogue today and is one line under the board
model. **You do not upload anything to move a robot.** The board is the robot;
a seat is a place to put it.

| What a team does | What happens |
| :--- | :--- |
| Put robot 1 on the practice field | The board is assigned to a seat. Nothing is copied. |
| Open a second field and put it there too | Same board. It cannot play in both at once, and the second placement says so. |
| Invite another team and play them | Their boards fill the other seats. Still nothing copied. |
| Check in for a fixture | **A snapshot is taken** — the one moment a copy is made. |
| Push a fix after check-in | Flashes the board. Does not reach the locked match. The team page says so. |

Check-in is Phase 11's lineup lock, which is already a *copy* into the arena
rather than a flag, so the mechanism exists and only the name changes — to the
one a team already understands from scrutineering. **What plays is the last
check-in that passed**, so breaking your code at nine at night cannot break your
entry, and rollback is [pushes.ts](../../packages/server/src/match/pushes.ts:43)'s
existing kept history pointed at a board.

---

## The browser editor

**It is first-class, and that is a constraint rather than a preference.** Phase
5 exists because a team that cannot install Python is not a team that enters
late, it is a team that does not enter. So the rule for this whole phase is:
*anything the extension can do, this can do.* The moment that stops being true,
the extension is the good way in and the Chromebook is a second-class entry.

It is already CodeMirror 6 (`packages/workspace/`), which turns out to matter —
see [Breakpoints](#breakpoints).

### What changes

- **The robot 1 / robot 2 switcher becomes two separate things.** A **project
  picker**, because a team now has as many projects as it likes, and a
  **Boards panel** showing both boards, where each one currently is, and whether
  it passes. The switcher conflated source and hardware; they are different
  nouns now.
- **`lib/`** appears alongside the projects as a team-level folder, because that
  is what it is.
- **"Push to the competition" disappears entirely**, and this is the
  simplification worth noticing. Under the board model a team never pushes to
  the competition: they flash their boards, and the referee's check-in takes
  what is on them. So the button becomes **Flash**, with a board target, and an
  entire concept leaves the student's head.
- **Editing is not flashing**, which is Phase 5's *editing is not submitting*
  under the name that now fits. The workspace still holds whatever was last
  typed, including code that does not parse, because an editor that refuses to
  save broken code is one you cannot use halfway through a thought.

### Breakpoints here too, and CodeMirror already has the parts

The design is [below](#breakpoints); what matters here is that **the browser is
not the second front end to get it.** If breakpoints were VS Code only, the
decision to build them would have created exactly the two-tier system this
project has refused everywhere else.

The three socket messages are the real interface and DAP is one front end of
two: `rcja debug` speaks DAP because that is what editors expect, and the
browser speaks those same three messages over the WebSocket it already has,
needing no adapter at all.

The UI is ordinary work rather than a rewrite:

- **Breakpoint dots** are CodeMirror 6's `gutter` and `GutterMarker`, which
  exist for this.
- **The stopped line** is a decoration, the same mechanism as the syntax
  highlighting already there.
- **Stack and locals** are a panel.
- **Evaluate in a frame** is the REPL box, pointed at a frame instead of
  `__main__` — the same one feature, two front ends, one more time.

### The field beside the code, which is easier here

The extension's one real engineering risk — a webview having none of the
browser's cookies, so the field needs a short-lived view token — **does not
exist in the browser.** Same origin, same session, an iframe or a split pane and
nothing else. The token is a VS Code workaround, not a general requirement, and
it is worth being clear about that so it does not get built as though it were.

### Where it still ends up ahead

Check-in status, the queue for a field, invitations from other teams and the
match schedule all live on the team page, next to the editor. The extension can
link to them; it should not reimplement them. [END-STATE.md](../../END-STATE.md)
already wanted *"one page with two doors into the same folder"*, and boards,
projects and fields converging is the version of that the board model asks for —
a layout decision to take when building slice 2, not an architectural one.

### What it gives up, unchanged from today

No local files, no git, no other tooling, and no working offline. That was true
in Phase 5 and is still true; the board model does not make it better or worse.

---

## Breakpoints

Real ones: set a breakpoint in `main.py`, hit it, look at the call stack and the
locals, step, evaluate an expression in that frame, continue.

**The mechanism already exists and was already planned.** `playLockstep` holds
the world until every program has answered the previous frame, and its own
docstring calls it *"a diagnostic mode, not a competition mode."* Phase 13's
original note wanted it for a scrubbable practice field; it serves breakpoints
just as well, and for the same reason. A robot stopped inside its own `think()`
has not answered, so **the world simply waits.** Nothing times out, nothing
desynchronises, the last-command-stands rule never fires, and the field is
standing still rather than hanging.

So breakpoints are not a new risk bolted onto the simulator. They are a second
consumer of a mode the simulator was already going to grow.

### Practice only, and that is physics rather than purity

A scored match runs under `playFast`, which *"takes whatever has arrived and
steps regardless"* — and it must, because the rule that a hung robot's last
command stands is what stops one team's laptop taking the other team's match
down. A match cannot wait for somebody reading their locals, and a debugger
that could pause a scored match would also be a way to buy thinking time.

So a fixture arena refuses a debugger exactly as it refuses a prompt. Same gate,
same test, same reason.

### `rcja debug` is the adapter, not the extension

The Debug Adapter Protocol is spoken **by the CLI, on stdio** — which is how
VS Code launches debug adapters anyway. The extension contributes a debug type
and a `launch.json` snippet and spawns `rcja debug`, which is a few dozen lines
of TypeScript and no protocol knowledge.

The payoff is that anything speaking DAP gets this: Thonny, `nvim-dap`, or
whatever a student's mentor uses. Keeping the adapter in the CLI is the same
decision as keeping `--json` there, for the same reason.

### On the robot side, `bdb` and nothing installed

The runtime runs the student's program under a `bdb.Bdb` subclass — standard
library, built on `sys.settrace`, and it brings breakpoint bookkeeping,
conditional breakpoints and correct step/next/return semantics with it. No
`debugpy`, no pip, no dependency at a venue with no internet. (`sys.monitoring`
is faster and is worth moving to if the floor ever rises above Python 3.11.)

**`settrace` being slow does not matter here**, which is the part worth saying
out loud: it is slow relative to wall-clock, and in lockstep the world is
waiting for the robot rather than racing it. The CPU ceiling is not violated
either — a process stopped at a breakpoint is blocked on a socket read, not
burning its budget.

Three messages on the agent socket carry it: set breakpoints, report a stop with
its stack, and resume with a step mode. **Evaluating an expression in a frame is
the REPL's `exec`**, pointed at a frame's namespace instead of `__main__` — so
the prompt and the debugger are one feature with two front ends, not two.

### Four things that have to be got right

- **The lockstep deadline must be suspended while a debugger is attached.**
  `deadlineMs` exists precisely so a hung program ends the run instead of
  silently making it unreproducible — and a breakpoint is a deliberate hang. An
  attached session lifts it; detaching restores it.
- **The other robots freeze too, and the field has to say why.** In lockstep the
  world waits for *everyone*, so an invited team's robot stops dead with no
  explanation. The field shows *stopped at a breakpoint in Robot 1* to everybody
  on it, or it reads as a crash.
- **An attached debugger is a person present.** Phase 10 made a connected robot
  deliberately *not* reset the idle-reclaim clock, so one forgotten laptop
  cannot hold a field all day. Somebody sitting at a breakpoint is not that, and
  reclaiming their field while they read their locals would be its own bug.
- **Timing is not enforced in lockstep, and the field must say so.** This is the
  one honest cost. A student who only ever debugs stopped can write a `think()`
  far too slow for 20 ms and never find out, because lockstep hides exactly the
  thing the CPU budget exists to expose. So lockstep is a mode you turn on and
  visibly leave, and **Run it for real** replays the same arrangement at
  wall-clock with the budget on. Debug stopped; verify running.

### What it does not transfer

Worth one paragraph in the student docs and no more: the robot you build will
not have this. On a board you get `Ctrl-C`, a prompt and `print`, which is why
those exist here too and why they work in a match where a breakpoint cannot.
A breakpoint is a simulator affordance, and a good one — it is simply not a
thing the hardware can lend you.

---

## The VS Code extension

Last, and convenience over the two paths that matter. If it slipped a season
nothing would break — which is the test it has to keep passing, because the
moment the extension is the good way in, the school laptop that cannot install
it is a second-class entry and the whole accessibility argument falls over.

**It is what MicroPico is**, and deliberately nothing more:

- **A Boards view** in the sidebar. Robot 1 and Robot 2, each expanding to what
  is *actually on it*, with a passes / does not pass dot. Opening a file there
  shows the board's copy, read-only — which is `rcja ls` and `rcja diff` with a
  disclosure triangle, and answers the one question a student asks at a venue:
  *is what I am looking at what is on the robot?*
- **Status bar**: the venue you are signed into, and the two boards. Click to
  flash.
- **Commands**: Flash to both, Flash to 1, Flash to 2, Run here, Play, Open
  REPL, Show output, Diff board.
- **The REPL as an ordinary terminal**, which is `rcja repl 1` in a terminal
  pane and costs nothing once the CLI exists.
- **A debug type** contributing a `launch.json` snippet and spawning
  `rcja debug` — the adapter is the CLI's, so this is a registration and not an
  implementation. See [Breakpoints](#breakpoints).

### You flash a board, never a seat

A device list is the familiar shape — MicroPico shows the serial ports it found
and you pick one — and it is worth being clear that this deliberately does not
copy it. **Your two boards are always there, by name.** They are yours, they do
not come and go, and nothing is discovered. That is not a loss of familiarity;
it is the bit where a persistent robot is *easier* than a USB device.

What the Boards view does borrow is the part that made a device list useful:
**it says where each board is right now.**

```
ROBOTS
  ● Robot 1     on your practice field, playing     passes
  ○ Robot 2     idle                                does not pass — main.py:14
```

So the answer to *"can I upload to the robots on a field"* is: you flash the
board, and the seat it happens to be sitting in follows. A seat shows which
board is in it; seats holding another team's board are visible and not yours to
flash, which is Phase 10's rule already.

### Flashing something that is playing

The question a student hits in the first ten minutes, and hardware answers it
for us. On a real robot you can copy a file over USB while the program runs —
the file changes and **the running program does not**, until you reset it.

Exactly that here:

- **Flash** replaces files on the board. A program already running in a seat
  carries on with the code it started with.
- **Reset** — `rcja reset 1`, the REPL's `Ctrl-D`, or Phase 10's existing
  **Restart** button — re-runs `main.py` from the new files.

So the loop is flash, reset, watch; and the editor offers *Flash and reset* as
one command because that is what a student means nine times out of ten. The two
stay separable because mid-match they are very different acts.

A board is never flashed by somebody else's action, and **a board under a
lineup lock is not flashed into a match at all** — the flash lands, the match
keeps playing what was checked in, and the team page says so.

### How it actually works

`packages/vscode/`, TypeScript like every other bundle here. It spawns `rcja`
and renders what comes back. That is the whole architecture, and holding to it
is what keeps the extension cheap enough to be last.

**It shells out; it does not speak HTTP.** The extension could call the server
directly — it is TypeScript and the server is JSON over HTTP — and it must not.
Two clients means two sets of endpoint knowledge, two error vocabularies and two
things to keep in step, which is the *one way in, not two* rule this codebase
has kept since Phase 5. Shelling out also means the extension **never touches a
credential**: `rcja login` runs in a terminal the extension opens, the key lands
in `~/.config/rcja/` as it would anyway, and there is no second secret store to
reason about.

**Therefore `--json` is a slice 3 requirement, not a slice 6 one.** Every
command the editor needs — `ls`, `diff`, `push`, `logs`, `play` — needs a
machine-readable mode designed for a consumer from the start. Bolting it on in
slice 6 is precisely how *a data layer designed inside an editor plug-in comes
out shaped like that plug-in*, which this repository already warns about in
another context. The CLI's human output and its `--json` output are two
renderings of one result, decided together.

**Validation failures become squiggles.** `rcja push --json` returns the
validator's reason, and if it returns file and line with it, the extension puts
them in a `DiagnosticCollection` — a red underline on the offending line of
`main.py`, in the Problems panel, the moment a flash is refused. That is the
single most editor-native thing here and it costs the server nothing it does not
already compute. It does mean the validator's failures need positions, not just
prose: another thing to settle while building slices 1–3 rather than after.

**Finding `rcja` is the day-one papercut.** It lives in whichever Python
environment the team installed it into. Resolve it in order — the Python
extension's selected interpreter, then `PATH`, then an `rcja.path` setting — and
when none of those has it, say so with a one-click *install it* rather than a
stack trace. Every MicroPython extension gets this wrong at least once and it is
the difference between working on the first afternoon and not.

**A folder becomes a project the way a folder becomes a repository.** `rcja new`
(or `rcja init`, for a folder that already exists) writes a `.rcja/` holding
tool state: which venue, which boards this project flashes by default. The
extension activates on its presence.

> This is **not** `manifest.json` coming back, and the distinction matters.
> `manifest.json` claimed the robot's *identity* — team, robot number, entry
> point — which now comes from the credential and the board, and a file that can
> claim its own team is the hole Phase 6 closed. `.rcja/` holds local tooling
> preference, the way `.vscode/` does. Nothing in it is trusted by a server, and
> deleting it costs nothing but a re-`init`.

**The Boards view refreshes on action, not on a timer.** An editor quietly
polling a venue every few seconds is rude on a hall network and would be thirty
laptops doing it. Refresh after a flash, on view focus, and on an explicit
button.

**The REPL is a plain terminal** running `rcja repl 1`, not a custom
`Pseudoterminal`. History and line editing then come from the CLI, where they
are testable, and the terminal is a terminal.

#### The field panel is the one real engineering risk

A `WebviewPanel` with the practice field in it sounds like an iframe and mostly
is — but **a webview has its own isolated context and none of the browser's
cookies**, so the field will not authenticate the way it does in a tab. The fix
is small and is a new server surface all the same: `rcja play --json` returns a
**short-lived, single-field URL token** that the webview can load.

That is not free. It is a way to reach a practice field without a session, which
is exactly the kind of thing to scope tightly and test — bounded to one field,
minutes not hours, and never a fixture arena. Phase 4's plain match server
already hands out fields to *whoever has the link*, so this narrows an existing
idea rather than inventing one; on a league server, where fields are owned, it
is genuinely new. Worth deciding deliberately rather than discovering while
wiring up a webview.

**Keep the extension too thin to need its own tests.** VS Code extension testing
is awkward enough that the honest mitigation is to have almost no logic on that
side of the process boundary. If something is hard to test in `packages/vscode/`,
that is usually a sign it belonged in the CLI.

### The one thing it has that MicroPico cannot

**The field, in a panel beside the code.** On real hardware you look up from
the laptop at the robot; here the robot is on a screen, so bringing that screen
into the editor is the honest equivalent rather than a gimmick. It is cheap:
the practice bundle is already a web page, and a webview is an iframe of a page
that exists. Edit, Run, watch it play in the next pane, without alt-tabbing.

This is the only part of the extension worth building something for. Everything
else is a button that shells out.

### Autocomplete is nearly free, unlike on real hardware

MicroPython development needs stub packages precisely because the board's
modules cannot be imported on the host. Here they can — `machine` is ordinary
CPython in the same `rcja-soccer` package — so completion for `Pin`, `ADC`,
`board.read()` and the whole `rcja_soccer` library works the moment the
interpreter is pointed at the right environment. The extension's job is to
point it, not to ship `.pyi` files.

### Packaging

**`rcja` is a console script in the existing Python package**, not a new
artefact. `python/pyproject.toml` already ships `rcja-join` and `rcja-submit`
this way through shim modules under `rcja_soccer/`; `rcja` replaces both, and
those two entry points and their shims are deleted with them. So
`pip install rcja-soccer` gives a team the library, `machine`, and the tool in
one install — the same shape as `mpremote`, which is also a pip-installed
Python program.

That also settles what the extension depends on: a Python with the package in
it, which a team writing robots on a laptop has by definition. A student with
no Python is in the browser, where none of this is needed.

**Distribution is an open question worth not guessing at.** A school-managed
laptop may forbid marketplace installs as readily as it forbids installing
Python, so whether this ships to the Marketplace, as a `.vsix` an organiser
hands out, or both, wants finding out from actual schools rather than deciding
here.

---

## What gets deleted

Outright, in the slice that replaces each — nothing here has shipped to a team.

- **`manifest.json`**, and `parseManifest`'s team/robot/entry validation with
  it. `main.py` by convention; team and robot come from the credential and the
  board, which is [already where they came from](../../packages/server/src/accounts/workspace.ts:206).
- **`python/submit.py`** → `rcja push`.
- **`python/join.py`** → `rcja run`. The whole `--token --url ws://…/a/<id>/agent`
  copy-a-command-off-a-web-page ritual goes with it; it is the least board-like
  thing in the project.
- **`rcja_soccer/join.py` and `rcja_soccer/submit.py`**, the console-script
  shims, and the `rcja-join` / `rcja-submit` entries in `pyproject.toml`.
  `rcja` takes their place in the same package.
- **The bare `python myrobot.py --team violet --number 1 --url …` form** as a
  documented path. The argv convention itself *stays* — it is how the server
  spawns a board, it is firmware's business, and no student sees it.
- **Seat kinds `submission` and `workspace`**, merged into *your robot*. Five
  become four.
- **"A submission is one team's one robot… pushes twice"** and the section of
  [writing-a-robot.md](../writing-a-robot.md) built on it.
- **`python/examples/play.py`** as a documented student path — it spawns four
  robots at a `--agents` server, which is the old laptop-drives-everything
  model. Keep it if the bench harness still needs it, under `scratch/`, not in
  `examples/` where a student reads it as the way things are done.

To be checked rather than assumed during slice 1: whether `sitecustomize.py`
and `rcja_soccer_bootstrap.pth` are both still load-bearing once there is one
entry path, given a `.pth` in `data-files` [silently does not work](micropython-single-runtime.md).

---

## What this costs, honestly

- **Two students can now collide** in a browser workspace, if they choose the
  one-project layout. They could not before, because the folders were separate.
  The two-project layout is there precisely for them, but the default has to be
  explained rather than assumed.
- **`workspaces/<team>/<robot>/` is baked into paths, types and tests.**
  `RobotNumber` threading through `seed(team, robot)`, the workspace API and the
  store becomes project-and-board. This is the largest mechanical change in the
  phase.
- **Seat-count accounting is a change to a measured, enforced ceiling.** Getting
  it wrong oversubscribes a venue on match day. It wants its own measurement and
  its own live check, not a ratio inferred from the existing figure.
- **A live REPL is a new route into a sandboxed process.** Not a new privilege —
  the student's code already runs there — but it needs the ownership gate and
  the fixture-arena refusal tested rather than commented.

---

## Sequencing

Slices, each verified live before the next.

1. **Retire `manifest.json`.** `main.py` by convention; team and robot from the
   credential and the board.
2. **Projects and boards.** `workspaces/<team>/<robot>/` becomes projects plus
   two board filesystems plus `lib/`. Flash is the verb. Validation on arrival
   with a standing pass/fail. Seat kinds collapse to four; check-in replaces the
   lineup-lock wording. The browser editor's robot switcher splits into a
   project picker and a Boards panel, and **"Push to the competition" is
   deleted rather than renamed** — a team flashes boards, and check-in takes
   what is on them.
3. **`rcja` CLI, and the device flow with it.** `/auth/device` plus its poll
   and the `/device` approval page, then `login`, `whoami`, `logout`, `new`,
   `ls`, `diff`, `push`, `rm`, `run`, `logs`. `submit.py` and `join.py` are
   deleted here, not shimmed. The device endpoints are the only new
   *authentication* surface in the whole phase — everything else reuses the key
   that already works anywhere a session does.
   **`--json` is designed here, with the human output, not retrofitted in slice
   6** — and the validator's failures grow file and line positions, because
   that is what turns a refused flash into a squiggle later.
4. **The pit, and seat-count capacity.** One-robot arrangement; measure it; move
   the ceiling from arenas to seats.
5. **The REPL.** Frame-boundary `exec`, Ctrl-C, Ctrl-D, ownership-gated,
   refused on fixture arenas. `rcja repl` and the browser panel.
6. **Lockstep fields, and breakpoints.** A practice field that runs under
   `playLockstep` with the deadline lifted; `bdb` on the robot side; the three
   socket messages; `rcja debug` speaking DAP on stdio. Fixture arenas refuse it
   exactly as they refuse the prompt. **This is lifted out of Phase 14**, which
   had planned the stepping field for the scrubber — breakpoints need it sooner
   and the trace does not need to come with it.
   **The browser's breakpoint UI lands in this slice, not after the
   extension** — gutter markers, a stopped-line decoration, stack and locals,
   and the REPL box aimed at a frame. Shipping the editor's debugger first and
   the browser's later would make the Chromebook second-class for however long
   "later" turned out to be.
7. **The VS Code extension.** Boards view, flash, Run, REPL terminal, the
   debugger, and the field in a panel beside the code — a thin shell over
   `rcja`, with no protocol of its own and no credential store of its own. Its
   one server-side dependency is the short-lived field-view token the webview
   needs, which is worth deciding before it is discovered.
8. **Docs.** `writing-a-robot.md` and `practising.md` both shrink a lot.

Slices 1–3 change the student's mental model; 4–6 make it feel like hardware
and give it a debugger; 7 is convenience over all of it.

**Thonny is deliberately not in here.** At the young end of RCJ it is the more
common tool, and its backend interface is a plausible second wrapper over the
same CLI. Building the CLI first is what keeps that door open; building the
extension first would quietly close it.

## Verification

- `make test-py` and `bun test` per slice.
- **Live per slice**, not tests alone: a real `league` server, two teams, a
  project flashed from a terminal, placed on a field, checked in, played — the
  shape that caught the referee console's cached seat names and the arena's 790
  abandoned socket directories.
- Slice 2 specifically: all three project layouts, including two browsers
  editing one team at once.
- Slice 4: measure a pit's actual cost before the ceiling changes; then fill a
  venue to the new ceiling and watch it.
- Slice 5: interrupt a robot *mid-match* on a practice field, read a sensor,
  soft-reset it, and confirm the field never noticed — then confirm a fixture
  arena refuses the same thing.
- Slice 3 specifically: a code approved from the wrong team's session is
  refused; an expired code is refused; a code is single-use; and `rcja login`
  against a laptop `serve` writes nothing and says so.
- Slice 6: a breakpoint hit on a field with an invited team's robot on it —
  everybody's robot stops, everybody is told why, and nobody times out. The
  field is not reclaimed while somebody sits at a breakpoint. A fixture arena
  refuses a debugger. And the same arrangement, run at wall-clock afterwards,
  still reports the CPU budget honestly.
- Slice 6, in both front ends: the same breakpoint, hit from the browser and
  from VS Code, reporting the same stack. A Chromebook with nothing installed
  debugs a robot end to end.
- Slice 7: drive the extension on a machine with no repo checkout, to catch
  anything the CLI was quietly getting from the working directory — and on one
  where `rcja` is in a virtualenv rather than on `PATH`, which is the failure
  every MicroPython extension ships with at least once. A field-view token is
  refused once expired, and never opens a fixture arena.
