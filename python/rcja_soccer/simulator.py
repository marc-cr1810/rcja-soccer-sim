"""The simulator's own back door. Nothing here exists on a board.

Everything else in this library is arithmetic you could run anywhere, and
everything in `machine` is a device you could buy. This module is neither: it
reaches past the hardware emulation and hands you the frame the match server
actually sent, and stages a command straight into the protocol.

It is named `simulator` so that a program using it cannot be mistaken for one
that would run on a robot. If you import this, you have written something for
the simulator specifically - which is a perfectly good thing to do while you
are working out why your locator disagrees with the field, and a bad thing to
build a season on.

    from rcja_soccer import simulator

    truth = simulator.frame()
    print(truth.camera.goals.cyan, truth.encoders, truth.kickoff.ours)

Two things live here that a robot genuinely cannot know, and they are the
honest reason to reach for this while debugging: `kickoff.ours`, because the
button on a real robot says a restart happened and not whose it is, and
`kickoff.countdown`, because on a real field the whistle is the countdown.
"""

from __future__ import annotations

from typing import Any

from machine._backend import Runtime

from .reading import Reading


def frame() -> Reading:
    """Everything the server sent this tick, not just the pin-shaped part.

    Camera blobs, team radio, wheel encoders, attack direction, whose kick-off
    it is - all of it, as the match server knows it rather than as a sensor
    would report it.
    """
    return Reading(Runtime.get().raw_frame())


def send_command(
    motors: Any = None,
    dribbler: float = 0.0,
    kicker: bool = False,
    say: Any = None,
) -> None:
    """Stage this tick's actuator frame directly, instead of writing pins.

    Consumed by the next `time.sleep_ms()`, and it replaces the pin-derived
    command for that tick - so calling this and then setting a pin in the same
    tick has the pin write silently thrown away.
    """
    Runtime.get().send_command(motors=motors, dribbler=dribbler, kicker=kicker, say=say)


def connected() -> bool:
    """Whether a match server is on the other end yet."""
    return Runtime.get().connected
