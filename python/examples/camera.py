"""The camera, which is another computer that has already done the seeing.

A 360 degree view of a soccer field is not a lens on your microcontroller. It
is a smart camera - an OpenMV, a Pi, a spare ESP32 with a sensor on it - aimed
into a mirror, running vision code of its own, and telling you the answer down
a serial line. Your board never sees a pixel. It sees bytes.

So this file is a parser, and it is the honest amount of work that link costs:
find the start of a packet, check the length, check the checksum, unpack the
fields. Nothing here is simulator-specific. Point it at a real camera sending
this format and it works; change the format to match the camera you own and
only this file changes.

The packet, little-endian throughout:

    aa 55 | len:u8 | payload | crc8      crc over the payload, poly 0x07

    payload:
      flags:u8        bit0 set if the camera had more blobs than it could send
      n_blobs:u8
      present:u8      bit0 cyan goal, bit1 yellow goal, bit2 ball
      cyan   bearing:i16 (milliradians)  range:u16 (mm)
      yellow bearing:i16                 range:u16
      ball   bearing:i16                 range:u16
      n_blobs x { colour:u8 (0 cyan, 1 yellow)
                  start:i16  end:i16  height:u16 }   all milliradians

`start` and `end` are the two edges of an unbroken patch of goal colour, and
`end` is always `start` plus the width rather than wrapped - so it can be
greater than pi, and subtracting the two always gives you the width. Anything
standing in front of the goal cuts the patch, which is why a goal with a keeper
in the middle of it arrives as two blobs with a gap between them.

`height` is the honest way to get a range out of a blob. A goal seen from an
angle is squashed across its width but not up its height, so the crossbar
subtends about `140 / range` from anywhere, and a blob somebody has cut in half
is narrower than the goal but no shorter.
"""

import struct

from machine import UART

SYNC = b"\xaa\x55"
HEADER = "<BBBhHhHhH"
HEADER_SIZE = 15
BLOB = "<BhhH"
BLOB_SIZE = 7


def crc8(data):
    """CRC-8, polynomial 0x07, starting at zero.

    A serial line drops bytes and flips them. A packet that arrives is not the
    same thing as a packet that is right, and finding that out costs three
    lines here.
    """
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


class Sighting:
    """One thing the camera resolved: a direction and a guess at how far."""

    __slots__ = ("bearing", "range")

    def __init__(self, bearing, range):
        self.bearing = bearing
        self.range = range


class Blob:
    """One unbroken arc of goal colour."""

    __slots__ = ("start", "end", "height")

    def __init__(self, start, end, height):
        self.start = start
        self.end = end
        self.height = height

    @property
    def width(self):
        return self.end - self.start


class Camera:
    """A serial camera, and the buffer of half a packet you are always holding."""

    def __init__(self, uart=None, id=0, baudrate=115200):
        self.uart = uart if uart is not None else UART(id, baudrate=baudrate)
        self._buffer = bytearray()
        self.truncated = False

    def read(self):
        """The newest complete picture, or `None` if there is no new one.

        `None` is the normal answer, not an error. The camera runs slower than
        your control loop - thirty frames a second against fifty ticks - so
        roughly two ticks in five it simply has not sent anything, and a robot
        that treats every tick's sighting as new information builds a
        controller that oscillates. Remember the last one; act on the new one.
        """
        chunk = self.uart.read()
        if chunk:
            self._buffer.extend(chunk)

        newest = None
        while True:
            packet = self._take_packet()
            if packet is None:
                return newest
            # Keep going: if two arrived while we were busy, the older one is
            # of no interest at all.
            newest = packet

    def _take_packet(self):
        buffer = self._buffer
        while True:
            start = buffer.find(SYNC)
            if start < 0:
                # Nothing that could be a packet. Keep the last byte in case it
                # is the first half of the sync pair.
                del buffer[: max(0, len(buffer) - 1)]
                return None
            if start:
                del buffer[:start]
            if len(buffer) < 3:
                return None
            length = buffer[2]
            if len(buffer) < 4 + length:
                return None

            payload = bytes(buffer[3 : 3 + length])
            checksum = buffer[3 + length]
            del buffer[: 4 + length]
            if checksum == crc8(payload):
                return self._unpack(payload)
            # A corrupt packet is dropped and the next one is looked for. It is
            # not worth guessing at.

    def _unpack(self, payload):
        if len(payload) < HEADER_SIZE:
            return None
        flags, n_blobs, present, cb, cr, yb, yr, bb, br = struct.unpack_from(
            HEADER, payload, 0
        )
        self.truncated = bool(flags & 0x01)

        blobs = {"cyan": [], "yellow": []}
        for i in range(n_blobs):
            offset = HEADER_SIZE + i * BLOB_SIZE
            if offset + BLOB_SIZE > len(payload):
                break
            colour, start, end, height = struct.unpack_from(BLOB, payload, offset)
            blobs["yellow" if colour else "cyan"].append(
                Blob(start / 1000.0, end / 1000.0, height / 1000.0)
            )

        return {
            "goals": {
                "cyan": Sighting(cb / 1000.0, float(cr)) if present & 0x01 else None,
                "yellow": Sighting(yb / 1000.0, float(yr)) if present & 0x02 else None,
            },
            "goal_blobs": blobs,
            "ball": Sighting(bb / 1000.0, float(br)) if present & 0x04 else None,
        }
