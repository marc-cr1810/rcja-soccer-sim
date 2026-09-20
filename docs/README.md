# Documentation

Eight things, in the order a team actually needs them:

1. **[Writing a robot](writing-a-robot.md)** — the folder format a submission
   is, the argv convention every entry script follows, and where the sensor
   and motor API itself is documented.
2. **[Running a server](running-a-server.md)** — watching a match, pushing a
   robot to it, and how it's kept validated and sandboxed once it's there.
3. **[Writing in a browser](writing-in-a-browser.md)** — for a team on a
   school machine that will not let them install Python: their code lives on
   the venue server and they edit it in a tab.
4. **[Practising](practising.md)** — a practice field: your own robots on a
   field you arrange by hand, started and stopped as you like, scored by
   nobody.
5. **[python/README.md](../python/README.md)** — the full reference for what
   a robot can see and do: every sensor field, the gotchas that catch a first
   attempt, and the helpers (`drive`, `field`, `sense`) that come with the
   library.
6. **[MicroPython](micropython.md)** — the robot is a MicroPython program, and
   the same file runs on a real ESP32. The virtual board and its pinout, the
   camera's serial protocol, what `time.sleep_ms()` actually does to the
   simulation, the three things a board genuinely cannot know, and the four
   places the simulator is honestly different from hardware.
7. **[Running a tournament](running-a-tournament.md)** — for whoever is
   running the event rather than entering it: a draw, a division played
   through with a referee, and a table that survives the laptop being closed.
8. **[Running a league](running-a-league.md)** — the venue deployment: a
   public front page, accounts for teams, referees and organisers, and the
   same fixture loop behind it. Watching still needs no account.

The top-level [README](../README.md) is the pitch — what this is, why the
physics is shaped the way it is, what the league itself looks like. These
eight are the manual.
