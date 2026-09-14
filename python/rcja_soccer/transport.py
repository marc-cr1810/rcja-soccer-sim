"""How a robot program reaches a match.

Getting frames to and from a program is somebody else's problem — usually a
WebSocket to a match server on the venue network. Usually, but not always:
the same library has to run inside a browser tab, for the student whose school
laptop will not let them install Python at all. There is no socket to open in
a tab, and the match is a few milliseconds away in another thread rather than
across a network.

So the connection is a seam rather than a constant. A channel is three
methods, and anything with those three can carry a match:

    send(text)   hand a JSON message to the other end
    recv()       block until the next one arrives, and return it
    close()      done

``_ws.WebSocket`` is one implementation and the default. A host embedding this
library installs its own with :func:`use_transport`, and every ``Robot`` in
the interpreter goes through it — without the program a student wrote
mentioning it, or knowing it happened.

That last part is the whole point, and the reason this is a seam under
``run()`` rather than an argument to it: a host can choose how frames travel,
but it cannot edit the file. The file a student writes in a tab is the file
they push, character for character. A browser dialect of this library would
be a toy, and worse, a toy that teaches habits a submission will not honour.
"""

from __future__ import annotations

from typing import Callable, Protocol


class TransportError(Exception):
    """The connection failed, or the peer said something unexpected.

    A channel raises this to mean *the far end is gone*. :meth:`Robot.run`
    treats it as a cue to reconnect rather than as a crash, which is why a
    practice session survives the server being restarted under it.
    """


class Channel(Protocol):
    """A two-way stream of JSON text messages."""

    def send(self, text: str) -> None:
        """Hand one message to the other end."""

    def recv(self) -> str:
        """Block until the next message arrives, and return it.

        Blocking is not an implementation detail that a cleverer transport
        could optimise away. A robot program is ordinary straight-line Python
        with ``robot.run()`` at the bottom of it, written by somebody who has
        not met ``async`` and should not have to; a channel that could only be
        awaited would change every program in the league.
        """

    def close(self) -> None:
        """Done. Called even when the match ended badly."""


#: Opens a channel to wherever ``url`` points.
Connect = Callable[[str], Channel]

_override: Connect | None = None


def use_transport(factory: Connect | None) -> None:
    """Route every robot in this interpreter through ``factory``.

    For a host that is embedding the library — the browser page, a test
    harness — and never for a robot program. Pass ``None`` to put the socket
    back.
    """
    global _override
    _override = factory


def current_transport() -> Connect:
    """Whatever :meth:`Robot.run` should open its connection with."""
    if _override is not None:
        return _override
    # Imported here rather than at the top of the file for two reasons: ``_ws``
    # imports this module for ``TransportError`` and a module cannot import its
    # own importer, and a host that has installed its own transport should not
    # pay for socket machinery it will never call.
    from ._ws import WebSocket

    return WebSocket
