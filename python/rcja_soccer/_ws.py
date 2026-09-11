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
import ssl
import struct
from urllib.parse import urlparse

_OP_CONTINUATION = 0x0
_OP_TEXT = 0x1
_OP_BINARY = 0x2
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA

_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11A"


class WebSocketError(Exception):
    """The connection failed, or the peer said something unexpected."""


class WebSocket:
    """A text-only client connection."""

    def __init__(self, url: str, timeout: float | None = 10.0) -> None:
        parsed = urlparse(url)
        secure = parsed.scheme in ("wss", "https")
        host = parsed.hostname or "localhost"
        port = parsed.port or (443 if secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        self._sock = socket.create_connection((host, port), timeout=timeout)
        if secure:
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
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

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
                more = bytes(b ^ mask[i % 4] for i, b in enumerate(more))
            payload += more

        return opcode, payload

    def recv(self) -> str:
        """The next text message. Blocks; control frames are handled quietly."""
        while True:
            opcode, payload = self._read_frame()
            if opcode == _OP_TEXT or opcode == _OP_CONTINUATION:
                return payload.decode("utf-8", errors="replace")
            if opcode == _OP_PING:
                self._send_frame(_OP_PONG, payload)
            elif opcode == _OP_CLOSE:
                self._closed = True
                raise WebSocketError("server closed the connection")
            # Binary and pong are ignored: nothing here sends either.

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
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def send(self, text: str) -> None:
        self._send_frame(_OP_TEXT, text.encode("utf-8"))

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(_OP_CLOSE, b"")
        except OSError:
            pass
        finally:
            self._sock.close()

    def __enter__(self) -> "WebSocket":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
