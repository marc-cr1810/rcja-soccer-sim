# Phase 13 — The robot is a board

The working record of a phase being built in slices. The **gate** lives in
[PHASES.md](PHASES.md#phase-13--the-robot-is-a-board), the design is in
[docs/planning/the-robot-is-a-board.md](docs/planning/the-robot-is-a-board.md);
this file is the cut — what each slice decided, what running it taught, and
what is still ahead.

**Where it stands: scoped, nothing built (21 September 2026).** Eight slices,
none started. Slice 1 is cut below.

## The gate

> *A student who has used a Pico connects to their robot, copies files onto it,
> interrupts it, types `ball.read_u16()` at a `>>>` prompt and gets a number —
> then carries the same robot onto a practice field and into a match, without
> uploading anything a second time.*

## Decided before any of it was built

Settled over the scoping conversation of 20 September 2026. Recorded here so
they are not re-argued from scratch.

1. **Four nouns, one verb.** project (0..n per team) · `lib/` (team-level, lands
   on every board — MicroPython's own convention) · board (exactly two, a
   filesystem) · seat. The verb is **flash**.
2. **Two robots, three layouts, no modes.** One project to both, two projects
   one each, or two projects sharing `lib/`. All three fall out of
   projects → boards and the server never learns which was chosen. A single
   imposed layout was explicitly rejected: teams want all three at different
   times.
3. **No roles in the starter.** Both boards run the same program and fight over
   the ball on purpose — that is the team's first real problem. `board.robot`
   (pin 41) is there for the afternoon they want it. Roles are strategy, not
   platform.
4. **CLI first, the extension wraps it.** Thonny is deferred, not rejected —
   building the CLI first is what keeps that door open.
5. **The REPL is scoped to your own board on your own field.** A fixture arena
   refuses it, because a prompt into a scored match is cheating.
6. **Delete, do not shim.** Nothing has shipped to a team.
7. **`rcja login` is a device code**, in the shape of `gh auth login`: short
   code, browser approval, an ordinary `rcja_` key labelled with the machine
   name into `~/.config/rcja/`. Registration stays invite-first and unchanged.
   A laptop `serve` has no accounts, so login there writes nothing and says so.
8. **Breakpoints are in scope.** The mechanism is `playLockstep`, which is
   already written and was already planned for Phase 14's scrubber: it holds
   the world until every program answers, so a robot stopped in `think()`
   freezes the field instead of timing out. Practice-only — a fixture runs
   `playFast` and must. Robot side is stdlib `bdb`, nothing installed; the
   adapter is `rcja debug` speaking DAP on stdio, so an editor contributes only
   a launch type. Four traps: lift lockstep's `deadlineMs` while attached; tell
   everyone on the field why their robot froze; an attached debugger counts as
   presence for idle-reclaim (Phase 10 deliberately says a *connected robot*
   does not); and lockstep hides timing, so it is a mode you visibly leave.
9. **The browser editor keeps parity as a rule, not a preference.** Anything
   the extension can do, it can do, or the Chromebook is second-class and
   Phase 5's argument collapses. The three socket messages are the interface;
   DAP is one front end of two, and the browser's debugger ships in the *same*
   slice.
10. **The extension is MicroPico's surface plus a field panel**, a thin shell
    over `rcja` with no protocol and no credential store of its own.
    Distribution to school-managed laptops is deliberately left unguessed.
11. **Two extension mechanics reach back into slice 3**, so they are not
    deferred: `--json` on every command is designed with the human output, and
    the validator's failures grow file and line positions. `.rcja/` (tool
    state) is not `manifest.json` (robot identity) returning.
12. **You flash a board, never a seat, and there is no device discovery** —
    your two boards are always there by name. And **flash ≠ reset**, exactly as
    on hardware: flashing replaces files while a running program carries on;
    `rcja reset` / Ctrl-D / Phase 10's Restart re-runs `main.py`. The editors
    offer "flash and reset" as one command but keep them separable, because
    mid-match they are very different acts.
13. **Venue TLS is its own Phase 15**, not part of this. Credentials have
    crossed hall networks in the clear since Phase 6; the device code is
    single-use and short-lived but it is not encryption, and the plan says so.

## The slices

| | | |
| --- | --- | --- |
| 1 | Retire `manifest.json` | **cut below** |
| 2 | Projects and boards | |
| 3 | `rcja` CLI, and the device flow with it | |
| 4 | The pit, and seat-count capacity | |
| 5 | The REPL | |
| 6 | Lockstep fields, and breakpoints | |
| 7 | The VS Code extension | |
| 8 | Docs | |

Slices 1–3 change the student's mental model; 4–6 make it feel like hardware
and give it a debugger; 7 is convenience over all of it.

## Slice 1 — retire `manifest.json`

### What it is

`main.py` by convention. Team and robot from the credential and the folder.
The file goes away entirely rather than becoming optional.

It is already vestigial: the starter hardcodes `entry: "main.py"`, and both
`team` and `robot` are overridden by the credential at every door that matters.
What it still does is make a student learn a JSON format before they can run a
robot, and give three separate code paths a disagreement to police.

**Folded in: the validator's failures grow file and line positions.** Decision
11 puts this in slice 3; it belongs here instead, because slice 1 is already
rewriting `validateSubmission`'s return type and threading a `Result` change
through `submission.ts` → the workspace API → `--json` → the extension later is
the painful order.

### The one thing it forces a decision about

**Where the name on a scoreboard comes from.** Three call sites say in so many
words that it is `manifest.team` and not the folder slug:

- [`pushes.ts:51`](packages/server/src/match/pushes.ts:51) — *"the manifest's own team name, not the slug — that is what a table shows"*
- [`tournament-store.ts:225`](packages/server/src/league/tournament-store.ts:225) — *"the one a scoreboard should show"*
- [`arena.ts:995`](packages/server/src/league/arena.ts:995) — the middle rung of `resolveTeamNames`' fallback chain

The answer, and it needs no new file on disk:

- **On a league server, `accounts.display_name` is already authoritative** and
  keyed by the same slug the submissions tree uses. Fixtures already carry
  display names too — [`league.ts:1370`](packages/server/src/league/league.ts:1370)
  reads `fixture.home` and then slugs it, so the name was never really coming
  from the file on that path.
- **`listEntrants(submissionsDir)` returns display names today** and has no
  accounts handle. It should return **slugs**, and its callers should resolve.
  That is a smaller change than it sounds: it is the only function whose
  contract changes shape.
- **On a bare laptop `serve` there is no accounts store**, so the honest answer
  is the de-slugified folder name. That loses capitalisation — `ACT Robotics`
  comes back as `Act Robotics`. On a league server `configuredName` is set and
  the fallback should never fire; **that claim is to be checked live, not
  assumed**, because it is the one visible regression in the slice.

### File by file

**Twelve files with real work, five with an import-line change, one comment.**

`infra/manifest.ts` does not simply get deleted — `Result` / `ok` / `fail`,
`slugifyTeam` and `TOKEN_FILENAME` live in it and are imported all over. Split
it: `infra/result.ts` (the Result triplet) and `infra/submissions.ts`
(`slugifyTeam`, `TOKEN_FILENAME`). `parseManifest`, `Manifest`, `TEAM_NAME` and
`ENTRY_FILENAME` go. The five import-line-only files are `accounts.ts`,
`amendments.ts`, `tournament.ts`, `infra/cli.ts` and `sim/measure.ts`;
`authority.ts:31` is a comment.

| File | What changes |
| --- | --- |
| [`accounts/submission.ts`](packages/server/src/accounts/submission.ts) | `validateSubmission` stops parsing and takes `{ team, robot }` from the caller. `Result<Manifest>` becomes the positioned failure type. `checkStatic`'s queue seeds `['main.py']`; `checkSyntheticTick`'s seat id and argv come from the caller. |
| [`accounts/workspace.ts`](packages/server/src/accounts/workspace.ts) | `seed` stops writing the file; `starterManifest` deleted; `snapshot` returns `Result<{ dir }>`. The long comment at :206 about *"only `entry` is taken from the manifest"* gets much shorter and finally true. |
| [`accounts/team-api.ts`](packages/server/src/accounts/team-api.ts) | **The best deletion in the slice.** Three separate "the file says X but the credential says Y" refusals (:225–252, :341–357, :458–469) disappear, because the file no longer says anything. The module doc at :25 is entirely about this problem. |
| [`accounts/lineup.ts`](packages/server/src/accounts/lineup.ts) | `LineupEntry.manifest` goes; `entry` becomes `join(dir, 'main.py')`. The "robot number disagrees with its folder" skip disappears. Presence becomes: `main.py` exists and a token sits beside it. |
| [`match/pushes.ts`](packages/server/src/match/pushes.ts) | `opts.manifest` becomes `opts.team` / `opts.robot`. `PushRecord.entry` is dropped. |
| [`league/tournament-store.ts`](packages/server/src/league/tournament-store.ts) | `listEntrants` returns slugs; its three checks become two. |
| [`league/league.ts`](packages/server/src/league/league.ts) | Three sites: the push mtime at :1383, the `/admin/teams` listing at :3180, and a comment at :919. |
| [`league/arena.ts`](packages/server/src/league/arena.ts) | `startSeat` at :563 and the name fallback at :995. |
| [`sim/measure.ts`](packages/server/src/sim/measure.ts) | The calibration submission writes `main.py`, not `robot.py`, and no manifest. |
| [`packages/workspace/main.ts`](packages/workspace/main.ts) | `entryName()` deleted; the don't-delete-the-entry-point guard at :115 becomes a plain check for `main.py`. |
| [`infra/pyimports.ts`](packages/server/src/infra/pyimports.ts) | See below. |
| [`python/submit.py`](python/submit.py) | Slice 1 breaks it. See below. |

### `python/submit.py`

The plan deletes it in slice 3, when `rcja push` replaces it. Slice 1 makes it
wrong three slices early: it reads `manifest.json` to learn the team and robot.

Patch it rather than bring the deletion forward — about ten lines: drop the
manifest read, take `--robot N` from a flag, take the team from the key. The
alternative leaves no terminal push at all between slices 1 and 3, which is
exactly the workflow the phase is supposed to be improving.

### Validator positions, folded in

Better news than expected: **the line number already exists and is thrown
away.** [`pyimports.ts`](packages/server/src/infra/pyimports.ts:38) catches
`SyntaxError` and flattens it into `f"line {e.lineno}: {e.msg}"`, discarding
`e.offset` and `e.text`.

So the work is:

1. `SCAN_SCRIPT` returns `{error: {msg, line, col, text}}` instead of a
   sentence. One line of Python.
2. `ast.walk` loses the node it found each module on — return
   `[{module, line, col}]` instead of `sorted(modules)`, so the "you imported
   `numpy`" refusal can point at the import rather than the file.
3. `validateSubmission` returns `{ ok: false; reason: string; at?: { file, line, col } }`.
   **Do not widen `Result`'s `fail`** — it is shared with `accounts.ts` and
   `amendments.ts`, whose failures have no position and never will.
4. `checkSyntheticTick` gets a traceback rather than a syntax error; extracting
   the innermost frame belonging to the submission is a separate, smaller job.
   **Position-on-runtime-failure is optional in this slice**; position on
   syntax and import failure is not.

### The tests

Fourteen files. [`tests/infra/manifest.test.ts`](packages/server/tests/infra/manifest.test.ts)
is deleted whole.

**Five tests assert a refusal that becomes unrepresentable** and are deleted
rather than rewritten — worth knowing before the count looks like a regression:

- `workspace.test.ts` — "manifest does not parse", "manifest names somebody else"
- `workspace-api.test.ts` — "a manifest that claims somebody else's team"
- `league.test.ts` — "a manifest naming somebody else's team"
- `lineup.test.ts` — "a manifest whose robot number disagrees with its folder"

The rest are fixtures writing `manifest.json` + `robot.py` into a temp dir.
They collapse into one shared `seedSubmission(dir, robot)` helper, which is
worth doing on the way past — the same four lines are currently repeated in
seven files.

Add: a syntax error in `main.py` is refused **with its line number**, and an
import of something unavailable is refused with the line of the import.

### Docs

`writing-a-robot.md` (4 mentions), `writing-in-a-browser.md` (3),
`running-a-league.md` (3), `running-a-server.md` (1), `README.md` (3). Slice 8
rewrites the first two properly; slice 1 only has to stop them lying.

### Two stale things to fix on the way past

- [`league.ts:1380`](packages/server/src/league/league.ts:1380) says *"No push
  time is recorded anywhere"*. That has been false since Phase 12's F1 —
  `PushRecord.at` exists. The comment is the fix; keep the mtime (now
  `main.py`'s), because push history is best-effort and `TeamApi.keep`
  deliberately does not fail a push over it.
- `PHASES.md` still says "seven slices". There are eight.

### Verification

- `bun test` and `make test-py`.
- **Live**, per the phase's standing rule: a real `league` server, two teams,
  a push from a terminal, seated, checked in, played. The scoreboard shows the
  right names on both sides — that is the regression this slice can cause and
  the tests cannot catch.
- A laptop `serve` with two folders and no accounts store still names both
  sides something a human recognises.
- A syntax error in `main.py` is refused with a line number.

### Open before starting

- **Slice 2 deletes "Push to the competition" rather than renaming it.**
  It does not block slice 1, but it is the one change that alters how *entering
  a competition* feels, and it is cheaper to confirm now than to unpick later.
