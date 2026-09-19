# Phase 12 — Administering a venue

The working record of a phase being built in slices. The **gate** lives in
[PHASES.md](PHASES.md#phase-12--administering-a-venue) and the screens it adds
up to are in [END-STATE.md](END-STATE.md); this file is the cut — what each
slice decided, what running it taught, and what is still ahead.

When the phase closes, its result collapses into PHASES.md the way Phase 10's
did, and this file goes with it.

**Where it stands: A to E are built and verified live (19 September 2026).
F to I are not started.**

## The gate, clause by clause

> *An admin reschedules a fixture, stops a runaway practice field, fixes a
> team's mis-uploaded file, and re-runs an abandoned game — all from a browser,
> with the audit log saying who did each one.*

| Clause | Where it stands |
| --- | --- |
| reschedules a fixture | **Done** — C wrote kick-off times, D put them behind a button |
| stops a runaway practice field | **Done** — it already worked; E gave it its own screen and the reasons beside it |
| fixes a team's mis-uploaded file | **Not built.** F1 then F2. The only clause with nothing behind it |
| re-runs an abandoned game | **Done** — D |
| the audit log saying who did each one | **Partly.** D made it true for draw corrections; H closes the rest |

## Four decisions, taken before any of it was built

1. **Rescheduling is real kick-off times** (`Fixture.playAt`), not reordering —
   the bigger option, chosen over the draw's own no-times grain. Effective order
   is by time. Being *late* is deliberately not modelled: a time says when a
   fixture is due, and Phase 11's referee-paced spawn is untouched by it.
2. **Team files are read-only, with rollback** — never a direct write into
   `submissions/`. That makes push history a prerequisite rather than a nicety,
   because `TeamApi.keep` today `rm -rf`s the folder and renames the new one in.
3. **An amendment reaches fixtures nobody has opened.** Anything in pre-game or
   on the pitch belongs to its referee and must be abandoned first. No admin
   button pulls a pitch out from under a whistle.
4. **Settings are editable from the browser**, live-applicable values only, and
   `league.json` stays the truth.

## The slices

```
A ─→ B ─→ C ─→ D      E      F1 ─→ F2      G      (A..G) ─→ H      I
```

A to D are a chain: each needs the one before it. E, F and G are independent of
them and of each other. H wants the rest done, because it is the screen that
shows what they all recorded.

### A — an amendment is an appended record ✅

`src/amendments.ts` (the record types, `parseAmendment`, `foldTournament`),
`loadAmendments` / `appendAmendment` / `loadTournament` in
[src/tournament-store.ts](src/tournament-store.ts), and `openTournament()` in
[src/cli.ts](src/cli.ts) as the one place the CLI reads a draw.

- **A withdrawal awards walkovers, not voids** — `goals`-0 to the opponent, one
  leg per `draw.legs`, reusing `walkoverResult` from pregame.ts. They are
  **synthesised by the fold and never written**, so a `restore` stays possible.
  The record carries its own `goals`, taken from the venue's mercy margin at the
  time, which keeps the fold pure over what is on disk.
- **`void-result` must name `completedAt`, not just the fixture.** Void by
  fixture id alone and the same record later swallows the *replayed* result.
- **Amendments fail loud** — `loadAmendments` throws and names the file, the
  opposite of the rule for results, because silently skipping one would un-void
  a fixture somebody voided.
- `assign --remove` now works on a voided fixture: it has left the effective
  draw, but its assignment row has not.

### B — a correction reaches a schedule already running ✅

The `amend` CLI (`void`, `restore`, `substitute`, `withdraw`, `void-result`,
`list`; `--why` required), `runDraw` re-reading the effective draw each pass,
`openPregame` resolving `'dropped'`, and `LeagueServer.sweepDue()` riding the
pre-game tick that already existed.

- **An offer is recalled, not failed.** `'dropped'` means *this is not the
  fixture it was*: the loop drops it, frees the teams through the `finally` every
  ending shares, and re-offers from the corrected draw. One mechanism covers
  void, substitute and restore.
- **A room somebody is standing in outlives the draw that named it.**
  `heldButVoided()` — a voided fixture whose referee is mid-pre-game keeps its
  page, marked `voided: true`, so they can abandon it and give the pitch back.
  The football is never interrupted; that is decision 3.
- The CLI cannot see the server's memory, so it records the amendment regardless
  and the server applies the reach rule. A running server notices within a tick.

### C — kick-off times ✅

`draw --start/--every/--pitches`, the `amend schedule` verb, and `playAt` on
every card that shows a fixture.

- **A programme is laid in rounds of `--pitches`, never with a team twice.** A
  fixture whose teams are already in the round is deferred to the next one
  (`kickoffTimes` in [src/tournament.ts](src/tournament.ts), shared by `makeDraw`
  and `amend schedule`). The clash rule is not politeness: the runner refuses to
  play a team twice anyway, so a programme that ignored it would be a printed
  lie.
- **`--every` defaults to the length of the football** — legs × 2 × half, rounded
  up to five minutes — and the CLI says which interval it chose.
- **Times reorder what is offered, and that is the only behaviour they have.**
  A reorder does *not* recall an offer already standing, which is right:
  rescheduling should not yank a fixture out from under a referee walking
  towards it.
- Times are stored UTC and rendered per reader, so a hall's phones and its
  projector agree without anybody setting anything.

### D — `/admin/tournaments`, and playing it again ✅

Every CLI verb as a button, `GET|POST /api/admin/tournament{,/amend,/replay}`,
and a supervisor loop around `runDraw`.

- **The schedule outlives the run.** `runDraw` still drains and returns — the
  batch `tournament` command depends on that — and the `league` command now
  wraps it: `for(;;) { runDraw(...); if (!await server.awaitWork()) return; }`.
- **The rule: work that appears wakes the schedule; work that already failed
  waits to be asked.** An abandoned match is abandoned for a reason, and a loop
  that retried it on a timer would spend the afternoon reopening a broken pitch.
- **`by.id` is the whole point of the browser path.** The CLI writes
  `{ id: null, slug: <unix user> }`; the server writes the account id. That is
  the difference between an audit log and a list of edits.
- `theirs: true` on a card means a referee has it: no buttons, and `replay`
  refuses it with a 409.

### E — `/admin/arenas` as its own screen ✅

Arenas move off `/admin`, which becomes a hub. `lastUsed`, `closingAt` and
`open` come out of `ArenaInfo`'s internals and onto the row, and the practice
queue goes at the bottom of the same page.

- **A row has to say why the field is still up**, not just that it is. `2 here`
  when somebody is on it, `quiet, 14m ago` when nobody is, `closing in 3m` once
  it has been warned. A **connected robot is deliberately not somebody** — that
  is Phase 10's rule, and the column is where it finally becomes visible.
- **The queue belongs on the same page as the fields**, because it is not only
  a list of teams: it is what makes the idle sweep impatient. With nobody
  waiting a field sits for the full idle time; with somebody waiting that halves
  and only the quietest field goes. Reading *closing in 3m* without the queue
  beside it is reading half the sentence.
- **Stop takes two presses.** The list re-polls every five seconds because every
  number on it is live, and one press on a row that moved under the cursor is
  not a decision anybody made. The poll pauses while a button is armed, or the
  re-render would put an unarmed button under the finger that was about to
  press.
- `tenancy.waiting()` has said it is "for an admin who wants to see the line"
  since Phase 8 and had no screen to say it on until now.

### F1 — push history

`data/pushes/<team>/<robot>/<stamp>/`, deliberately outside `submissions/` so
`listEntrants` and `resolveLineup` cannot trip over it. Not a screen: a
prerequisite, because there is nothing to roll back to until pushes are kept.

### F2 — `/admin/teams`, read-only, and rollback

The gate's *fixes a team's mis-uploaded file*. A rollback is replayed **as an
ordinary push** — validator, fresh join token, Phase 11's lineup lock — so
nothing gets a second code path into a team's folder.

### G — `/admin/people`

Accounts, roles, grants. `accounts.ts` already has list / grant / grantsFor /
assign / unassign / listAssignments / record / audit; the one thing missing is
**revoking a grant**.

### H — `/admin/audit`, and a sweep

The screen, plus filling the holes it would expose. The real gaps today are
field control, practice open/close, and workspace writes, none of which record
anything.

### I — settings from the browser

`saveSettings()` in settings.ts exists with **zero callers** — it was written
for this.

## What running it taught, that the tests did not

Every defect in this list was found by standing up a venue and using it, which
is why the phase is being walked in slices with a live pass at the end of each.

- **A withdrawal is not a disappearance.** Recalling an offer only when a
  fixture *left* the draw missed the withdrawn team entirely — the fixture is
  still there, it has just gained a synthesised walkover. A referee could open a
  pitch for a match that already had a score.
- **Voiding a fixture in pre-game orphaned a pitch** — its referee sat on a page
  answering *no such fixture* while the arena kept running. That is where
  `heldButVoided` came from.
- **A snapshot is not a register.** `RunOptions.skip` started life as a copied
  `Set`, so pressing *play it again* mid-run did nothing until the whole draw
  drained. The server's `stalled` map *is* the register `runDraw` asks.
- **Nothing settles on a quiet afternoon.** Even with a live register, the loop
  parks on `Promise.race(playing)`; with every other offer sitting with a
  referee, an un-stalled fixture waited for hours. Hence `RunOptions.poke`.
- **The browser had been showing 0–0 all along.** Building D's screen exposed a
  bug nobody had noticed: `Card` in site/main.ts read `homeGoals`/`awayGoals`
  while the server emits `homeScore`/`awayScore`, so **every played fixture on
  the public schedule and every team page showed 0–0** while the table beside it
  showed the real score. No test could have caught it — the server was right,
  and there is no DOM harness.
- **`bun test` forces `TZ=UTC`; a spawned CLI runs in the machine's own zone.**
  A test asserting on a bare `09:00` fails by the offset. Spell UTC in those.

## Known gaps, carried deliberately

- `docs/` has no account of the `amend` verbs from a terminal beyond C's
  kick-off section.
- `ScheduleFixtureSchema.state` and `MatchResponseSchema.state` still say
  `['played', 'playing', 'upcoming']` — three of the seven states that have
  existed since Phase 11.
