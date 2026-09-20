"""A WebSocket client, in the standard library and nothing else.

There are better WebSocket libraries. This exists so that ``pip install
rcja-soccer`` pulls in nothing at all, because the schools this league is
supposed to reach are the ones where pip is behind a proxy, or offline, or
simply not something a student is allowed to run. A dependency is a reason a
team cannot enter.

Only what the protocol needs: a client handshake, text frames out, text frames
in, and enough of the control frames to be a well-behaved peer. It is not a
general implementation and should not be lifted into one.
"""

from __future__ import annotations

import base64
import os
import socket
import struct
from urllib.parse import parse_qs, urlparse

from ._transport import TransportError

_OP_CONTINUATION = 0x0
_OP_TEXT = 0x1
_OP_BINARY = 0x2
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA

_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11A"


class WebSocketError(TransportError):
    """This socket failed, or the peer said something unexpected."""


def _apply_mask(data: bytes, mask: bytes) -> bytes:
    if not data or not mask:
        return data
    n = len(data)
    full_mask = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "little") ^ int.from_bytes(full_mask, "little")).to_bytes(n, "little")


class WebSocket:
    """A text-only client connection."""

    def __init__(self, url: str, timeout: float | None = 10.0) -> None:
        parsed = urlparse(url)

        if parsed.scheme == "unix":
            # A filesystem socket instead of a network one. Nothing a robot
            # program writes against ever needs this directly - it exists so
            # a submission being validated inside a sandboxed, network-less
            # process can still reach the one local endpoint that is meant
            # to check it, without opening a network hole to do it.
            self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            if timeout is not None:
                self._sock.settimeout(timeout)
            self._sock.connect(parsed.path)
            request_path = (parse_qs(parsed.query).get("path") or ["/"])[0]
            self._buffer = b""
            self._closed = False
            self._handshake("localhost", 80, request_path, secure=False)
            return

        secure = parsed.scheme in ("wss", "https")
        host = parsed.hostname or "localhost"
        port = parsed.port or (443 if secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        self._sock = socket.create_connection((host, port), timeout=timeout)
        if secure:
            # Imported here rather than at the top of the file so that plain
            # ``ws://`` works on a Python without a usable ``ssl`` — which is
            # not a hypothetical: it is every robot running in a browser tab.
            import ssl

            context = ssl.create_default_context()
            self._sock = context.wrap_socket(self._sock, server_hostname=host)

        self._buffer = b""
        self._closed = False
        self._handshake(host, port, path, secure)

    # -- setup ------------------------------------------------------------

    def _handshake(self, host: str, port: int, path: str, secure: bool) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        default_port = 443 if secure else 80
        hostheader = host if port == default_port else f"{host}:{port}"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {hostheader}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode())

        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise WebSocketError("server closed during handshake")
            header += chunk
        head, _, rest = header.partition(b"\r\n\r\n")
        # Anything after the headers is already frame data.
        self._buffer = rest

        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if "101" not in status:
            raise WebSocketError(f"server refused the upgrade: {status}")

    # -- reading ----------------------------------------------------------

    def _recv_exactly(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise WebSocketError("connection closed")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    def _read_frame(self) -> tuple[int, bytes]:
        first, second = self._recv_exactly(2)
        opcode = first & 0x0F
        final = bool(first & 0x80)
        masked = bool(second & 0x80)
        length = second & 0x7F

        if length == 126:
            (length,) = struct.unpack("!H", self._recv_exactly(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._recv_exactly(8))

        mask = self._recv_exactly(4) if masked else b""
        payload = self._recv_exactly(length) if length else b""
        if masked:
            payload = _apply_mask(payload, mask)

        # The server never fragments here, but a peer is allowed to, and a
        # client that falls over when one does is a client that fails at an
        # event rather than in testing.
        while not final:
            first, second = self._recv_exactly(2)
            final = bool(first & 0x80)
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", self._recv_exactly(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._recv_exactly(8))
            mask = self._recv_exactly(4) if masked else b""
            more = self._recv_exactly(length) if length else b""
            if masked:
                more = _apply_mask(more, mask)
            payload += more

        return opcode, payload

    def recv_raw(self) -> tuple[int, bytes | str]:
        """The next message. Returns (opcode, str | bytes)."""
        while True:
            opcode, payload = self._read_frame()
            if opcode == _OP_TEXT or opcode == _OP_CONTINUATION:
                return opcode, payload.decode("utf-8", errors="replace")
            if opcode == _OP_BINARY:
                return opcode, payload
            if opcode == _OP_PING:
                self._send_frame(_OP_PONG, payload)
            elif opcode == _OP_CLOSE:
                self._closed = True
                raise WebSocketError("server closed the connection")

    def recv(self) -> str | bytes:
        """The next message. Returns str for text frames and bytes for binary frames."""
        _, payload = self.recv_raw()
        return payload

    # -- writing ----------------------------------------------------------

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            raise WebSocketError("connection is closed")
        header = bytearray()
        header.append(0x80 | opcode)

        length = len(payload)
        # A client must always mask, per RFC 6455.
        if length < 126:
            header.append(0x80 | length)
        elif length < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)

        mask = os.urandom(4)
        header += mask
        masked = _apply_mask(payload, mask)
        self._sock.sendall(bytes(header) + masked)

    def send(self, data: str | bytes) -> None:
        if isinstance(data, (bytes, bytearray, memoryview)):
            self._send_frame(_OP_BINARY, bytes(data))
        else:
            self._send_frame(_OP_TEXT, data.encode("utf-8"))

    def close(self) -> None:
        """Say goodbye if we still can, and never raise for trying.

        The order matters, and getting it wrong was invisible for a long time.
        Marking the socket closed *before* sending the courtesy close frame
        makes :meth:`_send_frame` refuse it — so ``close()`` raised
        ``WebSocketError`` every single time, and because ``Robot._play``
        closes in a ``finally``, that exception replaced whatever had actually
        gone wrong. Every refusal a server can give a joining robot — a bad
        token, a seat already taken, a protocol from last season — reached the
        student as "connection is closed", which is the one thing it never
        was.
        """
        if self._closed:
            return
        try:
            self._send_frame(_OP_CLOSE, b"")
        except (OSError, WebSocketError):
            # The peer has already gone, which is the normal way a match ends.
            pass
        finally:
            self._closed = True
            self._sock.close()

    def __enter__(self) -> "WebSocket":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
