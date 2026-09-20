"""How the board reaches a match. The simulator's stand-in for a radio.

On real hardware nothing in this file exists: `machine` is firmware, and the
link to the outside world is a peripheral. Here the link is a WebSocket to a
match server, and this module is the seam that owns it — which is why it sits
under `machine` and carries a private name. A robot program never imports it,
the same way a robot program never imports the ESP32's WiFi driver to make
`ADC.read_u16()` work.

It is a seam rather than a constant because the same code has to run where
there is no socket to open — a test harness, or a browser tab for the student
whose school laptop will not let them install Python at all. A channel is
three methods, and anything with those three can carry a match:

    send(text)   hand a message to the other end
    recv()       block until the next one arrives, and return it
    close()      done

`_ws.WebSocket` is one implementation and the default. A *host* embedding the
simulator installs its own with :func:`use_transport`, and every robot in the
interpreter goes through it without the program mentioning it, or knowing it
happened.

That last part is the whole point: a host can choose how frames travel, but it
cannot edit the file. The file a student writes in a tab is the file they push,
character for character. A browser dialect of this would be a toy, and worse, a
toy that teaches habits a submission will not honour.
"""

from __future__ import annotations

from typing import Callable, Protocol


class TransportError(Exception):
    """The connection failed, or the peer said something unexpected.

    A channel raises this to mean *the far end is gone*.
    `Runtime.ensure_connected` treats it as a cue to reconnect rather than as a
    crash, which is why a practice session survives the server being restarted
    under it.
    """


class Channel(Protocol):
    """A two-way stream of JSON text messages."""

    def send(self, text: str) -> None:
        """Hand one message to the other end."""

    def recv(self) -> str:
        """Block until the next message arrives, and return it.

        Blocking is not an implementation detail that a cleverer transport
        could optimise away. A robot program is an ordinary `while True:` loop
        written by somebody who has not met ``async`` and should not have to,
        and on a board `time.sleep_ms()` blocks; a channel that could only be
        awaited would change every program in the league.
        """

    def close(self) -> None:
        """Done. Called even when the match ended badly."""


#: Opens a channel to wherever ``url`` points.
Connect = Callable[[str], Channel]

_override: Connect | None = None


def use_transport(factory: Connect | None) -> None:
    """Route every robot in this interpreter through ``factory``.

    For a host that is embedding the simulator — the browser page, a test
    harness — and never for a robot program. Pass ``None`` to put the socket
    back.
    """
    global _override
    _override = factory


#: Credentials a *host* has installed for the robots in this interpreter:
#: which seat they are joining as and where. See :func:`use_join`.
_join_token: str | None = None
_join_url: str | None = None


def use_join(token: str | None = None, url: str | None = None) -> None:
    """Join as this seat, at this address, without editing the program.

    The same seam as :func:`use_transport`, and for the same reason. A team's
    field on a league server is at an address nobody can guess and a seat on it
    wants a token that was minted a minute ago — neither of which belongs in a
    file a student wrote and is about to push. ``join.py`` sets both here and
    then runs the file untouched.

    What is set here is only ever a *fallback*: a program that names its own
    token or its own url still wins, because a program saying something
    explicitly should never be quietly overruled by its launcher.

    Pass ``None`` for either to clear it.
    """
    global _join_token, _join_url
    if token is not None:
        _join_token = token
    if url is not None:
        _join_url = url


def clear_join() -> None:
    """Forget any installed credentials. Mostly for tests."""
    global _join_token, _join_url
    _join_token = None
    _join_url = None


def join_token() -> str | None:
    """The token a robot that did not name one should present, if any."""
    return _join_token


def join_url() -> str | None:
    """The address a robot that did not name one should connect to, if any."""
    return _join_url


def current_transport() -> Connect:
    """Whatever `Runtime` should open its connection with."""
    if _override is not None:
        return _override
    # Imported here rather than at the top of the file for two reasons: ``_ws``
    # imports this module for ``TransportError`` and a module cannot import its
    # own importer, and a host that has installed its own transport should not
    # pay for socket machinery it will never call.
    from ._ws import WebSocket

    return WebSocket
