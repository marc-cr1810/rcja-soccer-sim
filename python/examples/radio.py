"""The team radio: rule 4.2.5, and about fifteen lines of code.

Two robots on a side may talk to each other, and on real hardware that is a
transparent serial link - an HC-12, an XBee, a pair of nRF24s behind a bridge.
Transparent means exactly what it says: whatever bytes you write come out of
your team mate's UART, and nothing in between knows or cares what they meant.

So the format is yours. This one sends a line of JSON per message, which is
easy to read in a terminal when you are trying to work out why your striker
and your keeper disagree, and small enough that the link keeps up. Change it
if you would rather.

What a radio does *not* give you is a guarantee. A message is a thing that was
true when it was sent, and the useful question about one is not what it says
but how old it is - the link here forgets anything older than 0.4 s, and at the
speed a struck ball travels that is most of a metre. Act on the freshest, and
be suspicious of all of it.
"""

import json
import time

from machine import UART


class Message:
    """Something the other robot said, and when you heard it."""

    __slots__ = ("sender", "body", "at")

    def __init__(self, sender, body, at):
        self.sender = sender
        self.body = body
        self.at = at

    @property
    def age(self):
        """Seconds since it arrived, which is as close to 'since sent' as you get."""
        return time.ticks_diff(time.ticks_ms(), self.at) / 1000.0


class Radio:
    def __init__(self, uart=None, id=1, baudrate=9600):
        self.uart = uart if uart is not None else UART(id, baudrate=baudrate)
        self._buffer = bytearray()

    def send(self, body):
        """Say something. Keep it short - this is 'I have the ball', not a plan."""
        self.uart.write(json.dumps(body).encode() + b"\n")

    def poll(self):
        """Everything that has arrived since the last call, oldest first."""
        chunk = self.uart.read()
        if chunk:
            self._buffer.extend(chunk)

        now = time.ticks_ms()
        messages = []
        while True:
            end = self._buffer.find(b"\n")
            if end < 0:
                return messages
            line = bytes(self._buffer[:end]).strip()
            del self._buffer[: end + 1]
            if not line:
                continue
            try:
                packet = json.loads(line.decode())
            except (ValueError, UnicodeError):
                # Radios produce rubbish. A robot that stops when it hears some
                # is a robot that stops when somebody walks past the antenna.
                continue
            messages.append(Message(packet.get("from"), packet.get("body"), now))
