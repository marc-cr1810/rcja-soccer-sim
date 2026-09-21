"""Internal simulator runtime and hardware abstraction engine for MicroPython."""

from __future__ import annotations

import json
import math
import os
import struct
import sys
import time
from typing import Any, Callable

from . import _sched, _timebase, constants
from ._proto import decode_server_message, encode_client_message
from ._transport import (
    TransportError,
    current_transport,
    join_token,
    join_url,
)
from .config import get_config

PROTOCOL_VERSION = 6
DEFAULT_URL = "ws://localhost:8080/agent"
#: How long to keep retrying a lost connection, in seconds, before giving up
#: and letting the error propagate. The clock restarts on every successful
#: connection, so a practice session survives any number of server restarts;
#: what it will not do is retry a port that is never coming back forever: a
#: harness that spawns robots detached cannot clean up a process that outlives
#: it.
DEFAULT_RECONNECT_FOR = 120.0


def _clamp(val: float, low: float, high: float) -> float:
    return max(low, min(high, val))


def _wrap_angle(rad: float) -> float:
    return (rad + math.pi) % (2 * math.pi) - math.pi


#: One quadrature cycle. Stepping by one changes exactly one of the two lines,
#: which is what makes a standard decoder able to tell direction.
_QUAD_A = (0, 1, 1, 0)
_QUAD_B = (0, 0, 1, 1)

#: Sync bytes the camera puts in front of every packet, so a program that
#: started listening halfway through one can find the start of the next.
CAMERA_SYNC = b"\xaa\x55"

#: Blobs in one packet. `len` is a byte and a blob is seven, so this is a
#: ceiling the format needs, not a judgement about how many a goal can break
#: into. The `truncated` flag says when it bit.
CAMERA_MAX_BLOBS = 16


def _crc8(data: bytes) -> int:
    """CRC-8, polynomial 0x07, initial value 0 - the ordinary one.

    A serial line drops and mangles bytes, so a packet that arrives is not the
    same thing as a packet that is right. Checking it is three lines here and
    three lines in the robot, and leaving it out is the kind of saving that
    reads as a mystery in a match.
    """
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def _mrad(radians: float) -> int:
    """An angle as milliradians, clamped to a signed 16-bit field."""
    return int(_clamp(round(radians * 1000.0), -32768, 32767))


def _mm(millimetres: float) -> int:
    """A distance as whole millimetres, clamped to an unsigned 16-bit field."""
    return int(_clamp(round(millimetres), 0, 65535))


class Runtime:
    """Singleton runtime managing simulator connection and virtual hardware."""

    _instance: Runtime | None = None

    @classmethod
    def get(cls) -> Runtime:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self) -> None:
        self.connected = False
        self.socket: Any = None
        self.team = "violet"
        self.number = 1
        self.name = "Violet"
        self.token: str | None = None
        self.motor_count = 4
        self.format: str = "json"

        self.last_frame: dict[str, Any] = {}
        #: The robot's own clock from the last frame (`SensorFrame.time`),
        #: seconds since it was switched on for this match.
        self.robot_time: float = 0.0
        #: Sensor frames received since this program started, across
        #: reconnects. `_timebase` counts milliseconds in these rather than in
        #: `robot_time`, which starts again at every match; a board's
        #: `ticks_ms()` only starts again when it is power-cycled.
        self.frames: int = 0
        #: Host monotonic at the last frame, for sub-tick interpolation.
        self.last_frame_at: float = _timebase._real_monotonic()
        #: Host milliseconds at this runtime's first successful join. Readings
        #: before it are host time since the program started; readings after
        #: it continue from exactly where that left off, which is what stops
        #: `ticks_ms()` jumping backwards the instant a robot joins a match.
        #: Only the *first* join sets it - a reconnect must not shift the
        #: clock, and does not have to, because the frame count survives one.
        self.tick_epoch_ms: float | None = None
        #: Highest value `ticks_ms()` has handed out, so it can never hand out
        #: a smaller one. See `_timebase._elapsed_ms()`.
        self.ticks_floor_ms: float = 0.0
        self.off_field = False

        #: One RX queue and one TX line-buffer per UART id. The camera fills
        #: its RX queue; the radio fills the other and reads writes back out of
        #: its TX buffer.
        self._uart_rx: dict[int, bytearray] = {}
        self._uart_tx: dict[int, bytearray] = {}
        #: UART ids a program has actually constructed. A packet nobody opened
        #: a port for is not worth building, and most programs open neither.
        self._uart_open: set[int] = set()
        #: When each team mate last said something, as `clock - age`. A
        #: message that is redelivered every tick for its whole 0.4s life
        #: reaches the radio once.
        self._radio_sent_at: dict[int, float] = {}

        #: Per wheel: accumulated rotation last frame, the fraction of a count
        #: left over from converting it, and where in the 4-state quadrature
        #: cycle the A/B lines currently sit.
        self._enc_prev: list[float | None] = [None] * 4
        self._enc_carry: list[float] = [0.0] * 4
        self._enc_phase: list[int] = [0] * 4
        #: Level each interrupt-watching pin had at the last frame, so a
        #: change can be spotted. Only pins somebody registered a handler on
        #: are in here.
        self._irq_levels: dict[int, int] = {}


        # Actuator State Buffers
        self.pin_values: dict[int, int] = {}       # Pin ID -> 0 or 1
        self.pwm_duties: dict[int, int] = {}       # Pin ID -> duty_u16 (0-65535)
        self.pwm_freqs: dict[int, int] = {}        # Pin ID -> frequency in Hz
        self.kicker_latched: bool = False
        self.say_data: Any = None
        #: Set by `send_command()`; consumed and cleared by the next
        #: `build_actuator_frame()` in place of the pin-derived command, for a
        #: program that would rather hand over a command dict directly than
        #: name individual motor pins.
        self._direct_command: dict[str, Any] | None = None

        # Time accumulation for sub-tick sleeps
        self._sleep_accum_ms: float = 0.0

        # Reconnection budget: how long ago the connection last succeeded,
        # and how long to keep retrying a lost one before giving up.
        self._last_connected: float = time.monotonic()
        self.reconnect_for: float = DEFAULT_RECONNECT_FOR

    # -------------------------------------------------------------------------
    # Connection Lifecycle
    # -------------------------------------------------------------------------

    def ensure_connected(self) -> None:
        """Connect to the match server if not already connected.

        Retries with a one-second backoff for as long as `reconnect_for`
        seconds since the last successful connection, then lets the error
        A board's radio comes up on its own and stays up; this is the closest
        equivalent, and it lives here because `machine` is the only thing that
        owns a connection at all, so nothing else can provide it.
        """
        if self.connected:
            return

        opener = current_transport()
        while True:
            try:
                self._connect_once(opener, join_url(), join_token())
                return
            except (TransportError, OSError) as error:
                idle = time.monotonic() - self._last_connected
                if idle > self.reconnect_for:
                    raise
                # Deliberately the captured CPython sleep, not `time.sleep`:
                # that name now advances the simulation, so going through it
                # here would recurse straight back into `ensure_connected`.
                _timebase._real_sleep(1.0)

    def _connect_once(self, opener: Callable[[str], Any], join_url_value: str | None, join_token_value: str | None) -> None:
        """One join attempt: open a socket, shake hands, wait for the first frame."""
        # 1. Parse connection arguments from sys.argv or join_url/token
        url = join_url_value or DEFAULT_URL
        token = join_token_value

        # Parse command line flags without crashing on unknown args
        args = sys.argv[1:] if len(sys.argv) > 1 else []
        i = 0
        while i < len(args):
            arg = args[i]
            if arg == "--url" and i + 1 < len(args):
                url = args[i + 1]
                i += 2
            elif arg == "--token" and i + 1 < len(args):
                token = args[i + 1]
                i += 2
            elif arg == "--team" and i + 1 < len(args):
                self.team = args[i + 1]
                i += 2
            elif arg == "--number" and i + 1 < len(args):
                try:
                    self.number = int(args[i + 1])
                except ValueError:
                    pass
                i += 2
            elif arg == "--name" and i + 1 < len(args):
                self.name = args[i + 1]
                i += 2
            else:
                i += 1

        self.token = token
        self.socket = opener(url)

        # 2. Send join handshake
        join_msg: dict[str, Any] = {
            "type": "join",
            "protocol": PROTOCOL_VERSION,
            "team": self.team,
            "robot": self.number,
            "name": self.name or self.team.capitalize(),
            "format": "protobuf",
        }
        if self.token is not None:
            join_msg["token"] = self.token

        self.socket.send(json.dumps(join_msg))

        # 3. Receive welcome
        raw = self.socket.recv()
        hello = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode("utf-8"))
        if hello.get("type") == "reject":
            raise ConnectionError(f"Server refused: {hello.get('reason')}")
        if hello.get("type") != "welcome":
            raise ConnectionError(f"Unexpected handshake response: {hello!r}")

        self.motor_count = hello.get("motors", 4)
        self.format = hello.get("format", "json")
        robot_id = hello.get("robot", "")
        if "-" in robot_id:
            team_part, num_part = robot_id.split("-", 1)
            self.team = team_part
            try:
                self.number = int(num_part)
            except ValueError:
                pass

        self.connected = True
        self._last_connected = time.monotonic()
        if self.tick_epoch_ms is None:
            self.tick_epoch_ms = _timebase._host_ms()

        # 4. Wait for the first sensor frame before unblocking user hardware reads
        while True:
            raw = self.socket.recv()
            if isinstance(raw, (bytes, bytearray, memoryview)):
                msg = decode_server_message(raw)
            else:
                msg = json.loads(raw)
            if not msg:
                continue
            if msg.get("type") == "sensors":
                self._update_sensor_frame(msg["frame"])
                break
            elif msg.get("type") == "disabled":
                self.off_field = True

    def _update_sensor_frame(self, frame: dict[str, Any]) -> None:
        self.last_frame = frame
        previous_time = self.robot_time
        self.robot_time = frame.get("time", 0.0)
        # The robot's clock only runs backwards when a new match has started,
        # and the server's encoder totals start again from zero with it. Differencing
        # across that would replay the whole last match backwards as edges -
        # one IRQ callback each, ~50ms of them in one frame, during which the
        # robot answers nothing while its kick-off goes by. The wheels did not
        # move: take the new totals as a fresh baseline.
        if self.robot_time < previous_time:
            self._enc_prev = [None] * len(self._enc_prev)
            self._enc_carry = [0.0] * len(self._enc_carry)
        self.frames += 1
        self.last_frame_at = _timebase._real_monotonic()
        self.off_field = False

        # The devices that are not pins: fill their buffers from this frame
        # before anything can read them, and work out which pins moved.
        self._feed_camera(frame)
        self._feed_radio(frame)
        self._step_encoders(frame)
        self._poll_irq_pins()

    # -------------------------------------------------------------------------
    # The devices that are not pins: camera, radio, encoders, interrupts
    # -------------------------------------------------------------------------

    def _feed_camera(self, frame: dict[str, Any]) -> None:
        """Push one packet per camera frame into the camera UART.

        Nothing arrives on a stale tick. The camera runs at 30fps against a
        50Hz loop, so roughly two ticks in five have no new picture, and on a
        board the way you find that out is that the serial line is quiet. That
        makes `uart.any() == 0` the `fresh` flag, learned from the wire instead
        of read off a field somebody filled in for you.
        """
        camera = frame.get("camera") or {}
        if not camera.get("fresh", False):
            return
        cfg = get_config()
        uart_id = cfg.camera_uart.get("id", 0)
        if uart_id not in self._uart_open:
            return

        goals = camera.get("goals") or {}
        cyan, yellow, ball = goals.get("cyan"), goals.get("yellow"), camera.get("ball")
        present = (0x01 if cyan else 0) | (0x02 if yellow else 0) | (0x04 if ball else 0)

        blobs: list[tuple[int, dict[str, Any]]] = []
        for colour, key in ((0, "cyan"), (1, "yellow")):
            for blob in (camera.get("goalBlobs") or {}).get(key, []) or []:
                blobs.append((colour, blob))
        truncated = len(blobs) > CAMERA_MAX_BLOBS
        blobs = blobs[:CAMERA_MAX_BLOBS]

        payload = bytearray()
        payload += struct.pack(
            "<BBBhHhHhH",
            0x01 if truncated else 0x00,
            len(blobs),
            present,
            _mrad(cyan["bearing"]) if cyan else 0,
            _mm(cyan["range"]) if cyan else 0,
            _mrad(yellow["bearing"]) if yellow else 0,
            _mm(yellow["range"]) if yellow else 0,
            _mrad(ball["bearing"]) if ball else 0,
            _mm(ball["range"]) if ball else 0,
        )
        for colour, blob in blobs:
            payload += struct.pack(
                "<BhhH",
                colour,
                _mrad(blob.get("start", 0.0)),
                _mrad(blob.get("end", 0.0)),
                _mm(blob.get("height", 0.0) * 1000.0),
            )

        packet = CAMERA_SYNC + bytes([len(payload)]) + bytes(payload) + bytes([_crc8(bytes(payload))])
        self._uart_rx.setdefault(uart_id, bytearray()).extend(packet)

    def _feed_radio(self, frame: dict[str, Any]) -> None:
        """Hand the team radio whatever arrived, once each.

        `messages` is redelivered in every frame for the whole 0.4s a message
        lives, so copying it straight across would put the same sentence on the
        wire twenty times over.

        What identifies a message is *when it was sent*, which the frame gives
        as `time - age`. Deduplicating on `age` alone looks equivalent and is
        not: a message arrives in consecutive frames at consecutive ages, so an
        age-based rule calls each one new. (When ages ran on the match clock
        they froze at a stoppage instead - a single `write()` arrived ninety
        times.) The link and the robot's clock both run every frame, so
        `time - age` is fixed for the life of a message.
        """
        cfg = get_config()
        uart_id = cfg.radio_uart.get("id", 1)
        if uart_id not in self._uart_open:
            self._radio_sent_at.clear()
            return

        now = float(frame.get("time", 0.0))
        seen: dict[int, float] = {}
        lines = bytearray()
        for message in frame.get("messages", []) or []:
            sender = message.get("from")
            if sender is None:
                continue
            sent_at = now - float(message.get("age", 0.0))
            seen[sender] = sent_at
            previous = self._radio_sent_at.get(sender)
            if previous is not None and abs(sent_at - previous) < 1e-6:
                continue
            lines += json.dumps({"from": sender, "body": message.get("body")}).encode()
            lines += b"\n"
        self._radio_sent_at = seen
        if lines:
            self._uart_rx.setdefault(uart_id, bytearray()).extend(lines)

    def _step_encoders(self, frame: dict[str, Any]) -> None:
        """Turn accumulated wheel rotation into the counts an encoder clicks out."""
        encoders = frame.get("encoders") or []
        if not encoders:
            return
        cfg = get_config()
        cpr = cfg.encoder_cpr
        if cpr <= 0:
            return
        count = min(len(encoders), self.motor_count, len(cfg.encoders), len(self._enc_prev))
        for idx in range(count):
            rad = float(encoders[idx])
            previous = self._enc_prev[idx]
            self._enc_prev[idx] = rad
            if previous is None:
                continue

            # The carry is what stops a slow wheel from being rounded away
            # every frame and reading as stopped.
            steps_float = (rad - previous) / (2.0 * math.pi) * cpr + self._enc_carry[idx]
            steps = int(steps_float)
            self._enc_carry[idx] = steps_float - steps
            if steps == 0:
                continue

            pins = cfg.encoders[idx]
            pin_a, pin_b = pins.get("a"), pins.get("b")
            watching = _sched.wants_edge(pin_a) or _sched.wants_edge(pin_b)
            phase = self._enc_phase[idx]
            if not watching:
                # Keep the lines where they would have ended up, so reading one
                # with `Pin.value()` still answers, but skip several hundred
                # callbacks a second nobody asked for.
                self._enc_phase[idx] = (phase + steps) % 4
                continue

            direction = 1 if steps > 0 else -1
            for _ in range(abs(steps)):
                nxt = (phase + direction) % 4
                # The phase travels with the edge, so a handler that reads the
                # other line sees where it was at *this* count rather than
                # where the wheel finished the tick. Without that a decoder
                # reads one direction for both.
                state = (self._enc_phase, idx, nxt)
                if _QUAD_A[nxt] != _QUAD_A[phase]:
                    _sched.queue_edge(pin_a, _QUAD_A[nxt], state)
                else:
                    _sched.queue_edge(pin_b, _QUAD_B[nxt], state)
                phase = nxt
            self._enc_phase[idx] = phase

    def watch_pin(self, pin_id: int, watching: bool) -> None:
        """Start or stop tracking a pin's level for `Pin.irq()`.

        The level is taken *here*, at the moment the handler is attached, so
        that attaching one to a pin that is already high is not reported as a
        rising edge. A board captures the level when it arms the interrupt;
        seeding it at the next frame instead would turn the state of the world
        into an event.
        """
        if not watching:
            self._irq_levels.pop(pin_id, None)
            return
        self._irq_levels[pin_id] = self.get_pin_value(pin_id)

    def _poll_irq_pins(self) -> None:
        """Queue an edge for every watched pin whose level changed this frame.

        The generic half of the interrupt story: a start button, a ball gate, a
        line sensor. Encoders do not come through here - they moved by more
        than one edge and `_step_encoders` already knows exactly how many.
        """
        watched = _sched.irq_pins()
        if not watched:
            self._irq_levels.clear()
            return

        cfg = get_config()
        encoder_pins = set()
        for pins in cfg.encoders:
            encoder_pins.add(pins.get("a"))
            encoder_pins.add(pins.get("b"))

        for pin_id in watched:
            if pin_id in encoder_pins:
                continue
            level = self.get_pin_value(pin_id)
            if self._irq_levels.get(pin_id, level) != level:
                self._irq_levels[pin_id] = level
                _sched.queue_edge(pin_id, level)
        # A pin nobody watches any more should not keep a stale level around to
        # fire a phantom edge if it is re-registered later.
        for pin_id in list(self._irq_levels):
            if pin_id not in watched:
                del self._irq_levels[pin_id]

    # -------------------------------------------------------------------------
    # UART
    # -------------------------------------------------------------------------

    def uart_open(self, uart_id: int) -> None:
        """A program constructed this UART, so start filling it."""
        self._uart_open.add(uart_id)
        self.ensure_connected()

    def uart_any(self, uart_id: int) -> int:
        self.ensure_connected()
        return len(self._uart_rx.get(uart_id, b""))

    def uart_read(self, uart_id: int, nbytes: int | None = None) -> bytes | None:
        self.ensure_connected()
        buffer = self._uart_rx.get(uart_id)
        if not buffer:
            return None
        take = len(buffer) if nbytes is None else min(nbytes, len(buffer))
        data = bytes(buffer[:take])
        del buffer[:take]
        return data

    def uart_readline(self, uart_id: int) -> bytes | None:
        self.ensure_connected()
        buffer = self._uart_rx.get(uart_id)
        if not buffer:
            return None
        end = buffer.find(b"\n")
        if end < 0:
            return None
        data = bytes(buffer[: end + 1])
        del buffer[: end + 1]
        return data

    def uart_write(self, uart_id: int, data: bytes) -> int:
        """Accept bytes on a UART, and act on them if anything is listening.

        The radio is the one device on the other end of a write: complete
        lines are JSON, and each becomes this tick's `say`. Anything else goes
        where a write with nothing plugged into it goes.
        """
        self.ensure_connected()
        cfg = get_config()
        if uart_id != cfg.radio_uart.get("id", 1):
            return len(data)

        buffer = self._uart_tx.setdefault(uart_id, bytearray())
        buffer.extend(data)
        while True:
            end = buffer.find(b"\n")
            if end < 0:
                break
            line = bytes(buffer[:end])
            del buffer[: end + 1]
            line = line.strip()
            if not line:
                continue
            try:
                self.say_data = json.loads(line.decode())
            except (ValueError, UnicodeDecodeError):
                # A radio carries whatever you put on it. A team mate that
                # cannot parse this is the team's problem, not a crash here.
                pass
        return len(data)

    # -------------------------------------------------------------------------
    # Actuator & Pin State Management
    # -------------------------------------------------------------------------

    def set_pin_value(self, pin_id: int, val: int) -> None:
        self.ensure_connected()
        self.pin_values[pin_id] = 1 if val else 0

        cfg = get_config()
        if pin_id == cfg.kicker and val:
            self.kicker_latched = True

    def get_pin_value(self, pin_id: int) -> int:
        self.ensure_connected()
        cfg = get_config()

        # If it's an output pin that was written to, return cached output
        if pin_id in self.pin_values:
            return self.pin_values[pin_id]

        # Line sensors digital threshold (white line > 0.45 reflectance)
        if pin_id in cfg.lines:
            idx = cfg.lines.index(pin_id)
            lines = self.last_frame.get("lines", [])
            if idx < len(lines):
                val = lines[idx].get("value", 0.0)
                return 1 if val > 0.45 else 0

        # Ball gate / held sensor
        if pin_id == cfg.ball_gate:
            return 1 if self.last_frame.get("ballGate", {}).get("held", False) else 0

        # The start button, which the server now sends as the button itself -
        # up through a stoppage, a kick-off countdown and the moment of every
        # restart. Up while off the field too: nobody presses start on a robot
        # in their hands.
        if pin_id == cfg.start:
            if self.off_field or not self.last_frame.get("start", False):
                return 0
            return 1

        # The switches somebody sets before a half, because a robot cannot see
        # its own colour and the ends swap at half time.
        if pin_id == cfg.team_switch:
            return 1 if self.last_frame.get("team") == "lime" else 0
        if pin_id == cfg.robot_switch:
            return 1 if self.last_frame.get("robot", 1) == 2 else 0
        if pin_id == cfg.side_switch:
            return 1 if self.last_frame.get("attackDirection", 1) > 0 else 0

        # Quadrature encoder lines, wherever the cycle has got to.
        for idx, pins in enumerate(cfg.encoders[: self.motor_count]):
            phase = self._enc_phase[idx]
            if pin_id == pins.get("a"):
                return _QUAD_A[phase]
            if pin_id == pins.get("b"):
                return _QUAD_B[phase]

        return 0

    def set_pwm(self, pin_id: int, freq: int | None = None, duty_u16: int | None = None) -> None:
        self.ensure_connected()
        if freq is not None:
            self.pwm_freqs[pin_id] = freq
        if duty_u16 is not None:
            self.pwm_duties[pin_id] = _clamp(duty_u16, 0, 65535)

    def deinit_pwm(self, pin_id: int) -> None:
        self.pwm_duties[pin_id] = 0

    def build_actuator_frame(self) -> dict[str, Any]:
        """Convert current virtual pin/PWM states into a simulator ActuatorFrame."""
        if self._direct_command is not None:
            cmd = self._direct_command
            self._direct_command = None
            return cmd

        cfg = get_config()
        motor_powers: list[float] = [0.0] * self.motor_count

        for i, m_cfg in enumerate(cfg.motors[: self.motor_count]):
            pwm_pin = m_cfg.get("pwm")
            dir_pin = m_cfg.get("dir")
            in1_pin = m_cfg.get("in1")
            in2_pin = m_cfg.get("in2")

            if pwm_pin is not None and dir_pin is not None:
                # DIR + PWM Mode
                duty = self.pwm_duties.get(pwm_pin, 0) / 65535.0
                direction = self.pin_values.get(dir_pin, 0)
                power = -duty if direction else duty
                motor_powers[i] = _clamp(power, -1.0, 1.0)

            elif in1_pin is not None and in2_pin is not None:
                # Dual-PWM / H-Bridge Mode (IN1 / IN2)
                p1 = self.pwm_duties.get(in1_pin, 65535 if self.pin_values.get(in1_pin, 0) else 0)
                p2 = self.pwm_duties.get(in2_pin, 65535 if self.pin_values.get(in2_pin, 0) else 0)
                power = (p1 - p2) / 65535.0
                motor_powers[i] = _clamp(power, -1.0, 1.0)

            elif pwm_pin is not None:
                # Single PWM pin (forward only or pre-calculated)
                duty = self.pwm_duties.get(pwm_pin, 0) / 65535.0
                motor_powers[i] = _clamp(duty, 0.0, 1.0)

        # Dribbler speed (0.0 to 1.0)
        dribbler = 0.0
        if cfg.dribbler in self.pwm_duties:
            dribbler = self.pwm_duties[cfg.dribbler] / 65535.0
        elif self.pin_values.get(cfg.dribbler, 0):
            dribbler = 1.0

        # Kicker
        kicker = self.kicker_latched
        self.kicker_latched = False  # Consumed on pulse

        cmd: dict[str, Any] = {
            "motors": motor_powers,
            "dribbler": dribbler,
            "kicker": kicker,
        }
        if self.say_data is not None:
            cmd["say"] = self.say_data
            self.say_data = None
        return cmd

    # -------------------------------------------------------------------------
    # ADC & Sensor Reading
    # -------------------------------------------------------------------------

    def read_adc(self, pin_id: int) -> int:
        """Read 16-bit analog value (0-65535) for a given virtual pin."""
        self.ensure_connected()
        cfg = get_config()

        # 1. Line Sensors (8 perimeter sensors: 0 = Front, 1 = FL, 2 = Left...)
        if pin_id in cfg.lines:
            idx = cfg.lines.index(pin_id)
            lines = self.last_frame.get("lines", [])
            if idx < len(lines):
                val = lines[idx].get("value", 0.0)
                return int(_clamp(val, 0.0, 1.0) * 65535)
            return 0

        # 2. Ball Strength (0 when no ball, up to 65535 when touching)
        ball = self.last_frame.get("ball")
        if pin_id == cfg.ball_strength:
            if ball is not None:
                strength = ball.get("strength", 0.0)
                return int(_clamp(strength, 0.0, 1.0) * 65535)
            return 0

        # 3. Ball Bearing (scaled -pi..+pi to 0..65535)
        if pin_id == cfg.ball_bearing:
            if ball is not None:
                bearing = ball.get("bearing", 0.0)
                normalized = (bearing + math.pi) / (2 * math.pi)
                return int(_clamp(normalized, 0.0, 1.0) * 65535)
            return 32768  # 0 radians (straight ahead)

        # 4. Directional TSOP / Photodiode Ring (8 zones)
        if pin_id in cfg.ir_ring:
            zone_idx = cfg.ir_ring.index(pin_id)
            zone_angle = _wrap_angle((zone_idx * 2 * math.pi) / len(cfg.ir_ring))
            if ball is not None:
                bearing = ball.get("bearing", 0.0)
                strength = ball.get("strength", 0.0)
                diff = abs(_wrap_angle(bearing - zone_angle))
                # Photodiode FOV model (~90 deg cutoff)
                response = max(0.0, math.cos(diff)) if diff < (math.pi / 2) else 0.0
                return int(_clamp(strength * response, 0.0, 1.0) * 65535)
            return 0

        # 5. Compass Heading (-pi..+pi to 0..65535)
        if pin_id == cfg.compass:
            compass = self.last_frame.get("compass", {})
            heading = compass.get("heading", 0.0)
            norm = (heading + math.pi) / (2 * math.pi)
            return int(_clamp(norm, 0.0, 1.0) * 65535)

        # 6. Gyro Angular Rate (-10..+10 rad/s mapped to 0..65535)
        if pin_id == cfg.gyro:
            gyro = self.last_frame.get("gyro", {})
            rate = gyro.get("rate", 0.0)
            norm = (rate + 10.0) / 20.0
            return int(_clamp(norm, 0.0, 1.0) * 65535)

        # 7. Ultrasonic / Distance Sensors (Front, Back, Left, Right)
        range_data = self.last_frame.get("range", {})
        for direction, u_pin in cfg.ultrasonics.items():
            if pin_id == u_pin:
                dist = range_data.get(direction)
                if dist is not None:
                    # Map 0 - 2400 mm to 0 - 65535
                    return int(_clamp(dist / 2400.0, 0.0, 1.0) * 65535)
                return 65535  # Max range / out of range

        return 0

    def pulse_us(self, pin_id: int, timeout_us: int = 1_000_000) -> int:
        """Round-trip echo width for an ultrasonic on this pin, in microseconds.

        `machine.time_pulse_us()` is how an HC-SR04 is actually read on a
        board - trigger, then measure how long the echo pin stays high - so a
        program written for real hardware reaches its rangefinders through
        this rather than through `ADC`. Sound covers a millimetre and back in
        about 5.83us at 343 m/s.

        Returns -2 for "no echo within the timeout", which is what the real
        function returns, and what an ultrasonic pointed at open space does.
        """
        self.ensure_connected()
        cfg = get_config()
        range_data = self.last_frame.get("range", {})
        for direction, u_pin in cfg.ultrasonics.items():
            if pin_id == u_pin:
                dist = range_data.get(direction)
                if dist is None:
                    return -2
                micros = int(dist * 5.83)
                return -2 if micros > timeout_us else micros
        return -2

    # -------------------------------------------------------------------------
    # Virtual I2C Bus Simulation
    # -------------------------------------------------------------------------

    def i2c_scan(self) -> list[int]:
        """Report simulated devices present on the virtual I2C bus."""
        self.ensure_connected()
        return [
            constants.I2C_ADDR_MPU6050,
            constants.I2C_ADDR_BNO055,
            constants.I2C_ADDR_IR_SEEKER,
            constants.I2C_ADDR_VL53L0X,
        ]

    def i2c_read_mem(self, addr: int, reg: int, length: int) -> bytes:
        """Read registers from simulated I2C sensors."""
        self.ensure_connected()

        # HiTechnic IR Seeker II (0x1C)
        if addr == constants.I2C_ADDR_IR_SEEKER:
            ball = self.last_frame.get("ball")
            if reg == 0x42:  # Direction (1-9)
                if ball is None:
                    return bytes([0] * length)
                # Bearing from -pi to +pi mapped to sectors 1-9 (5 is straight ahead)
                b = ball.get("bearing", 0.0)
                sector = int(round((b / (math.pi / 4)) + 5))
                sector = max(1, min(9, sector))
                return bytes([sector] * length)
            elif 0x43 <= reg <= 0x47:  # Sensor strengths 1-5
                strength = int(self.last_frame.get("ball", {}).get("strength", 0.0) * 255)
                return bytes([min(255, strength)] * length)

        # MPU-6050 IMU (0x68)
        if addr == constants.I2C_ADDR_MPU6050:
            if reg == 0x75:  # WHO_AM_I
                return bytes([0x68])
            elif reg == 0x47:  # Gyro Z High Byte
                rate = self.last_frame.get("gyro", {}).get("rate", 0.0)
                raw_z = int(rate * 131.0)  # LSB per deg/s scaling
                return raw_z.to_bytes(length, byteorder="big", signed=True)

        # BNO055 IMU (0x28)
        if addr == constants.I2C_ADDR_BNO055:
            if reg == 0x00:  # CHIP_ID
                return bytes([0xA0])
            elif reg == 0x1A:  # Heading Euler LSB
                heading_deg = math.degrees(self.last_frame.get("compass", {}).get("heading", 0.0)) % 360
                raw = int(heading_deg * 16)  # 16 LSB per degree
                return raw.to_bytes(length, byteorder="little", signed=False)

        return bytes([0] * length)

    # -------------------------------------------------------------------------
    # Tick Synchronization & Cadence Heartbeat
    # -------------------------------------------------------------------------

    def sync_tick(self, ms: float) -> None:
        """Called by time.sleep_ms(). Flushes ActuatorFrame and awaits next SensorFrame."""
        self.ensure_connected()

        # Accumulate sleep time (each simulation tick is ~20ms / 50Hz)
        self._sleep_accum_ms += ms
        if self._sleep_accum_ms < 15.0:
            return  # Allow small sub-tick intervals without forcing an early flush

        # Calculate number of physics ticks to advance. Floor, not round: a
        # rounded count overshoots (`sleep_ms(30)` became two whole ticks) and
        # leaves nothing to carry, so the correction below could never happen.
        # Flooring plus the carry paces a 30ms loop as 1, 2, 1, 2 ticks, which
        # averages to the 30ms that was actually asked for.
        ticks = max(1, int(self._sleep_accum_ms / 20.0))
        # Carry the remainder rather than discarding it. Zeroing here made a
        # program pacing on anything that is not a multiple of 20ms drift
        # against the simulation, a little further every iteration. Floored at
        # zero because a negative balance would make the next sleep fall under
        # the threshold above and skip its flush entirely - which is the
        # silent-no-op failure this whole slice exists to remove.
        self._sleep_accum_ms -= ticks * 20.0
        if self._sleep_accum_ms < 0.0:
            self._sleep_accum_ms = 0.0

        for _ in range(ticks):
            while True:
                try:
                    cmd = self.build_actuator_frame()
                    if self.format == "protobuf":
                        self.socket.send(encode_client_message(cmd))
                    else:
                        self.socket.send(json.dumps({"type": "command", "frame": cmd}))

                    # Wait for next server response
                    while True:
                        raw = self.socket.recv()
                        if isinstance(raw, (bytes, bytearray, memoryview)):
                            msg = decode_server_message(raw)
                        else:
                            msg = json.loads(raw)

                        if not msg:
                            continue
                        msg_type = msg.get("type")
                        if msg_type == "sensors":
                            self._update_sensor_frame(msg["frame"])
                            _sched.service()
                            break
                        elif msg_type == "disabled":
                            if not self.off_field:
                                self.off_field = True
                            # Zero motor outputs during stand-down
                            self.pwm_duties.clear()
                            break
                    break  # this tick advanced; move on to the next one
                except (TransportError, OSError):
                    # The far end is gone. `ensure_connected()` retries with a
                    # backoff, then re-raises once `reconnect_for` is spent -
                    # see its docstring.
                    self.connected = False
                    self.ensure_connected()

    # -------------------------------------------------------------------------
    # Full-frame reads and direct commands: the simulator's own back door,
    # reached through `rcja_soccer.simulator`, never through a pin.
    # -------------------------------------------------------------------------

    def raw_frame(self) -> dict[str, Any]:
        """The whole frame the server last sent, as it arrived.

        No board has this. It is reached through `rcja_soccer.simulator`, which
        says so in its name, and it exists because a simulator that could only
        be seen through its own pin emulation would be a simulator you could
        not debug.
        """
        self.ensure_connected()
        return self.last_frame

    def send_command(
        self,
        motors: list[float] | None = None,
        dribbler: float = 0.0,
        kicker: bool = False,
        say: Any = None,
    ) -> None:
        """Set this tick's actuator command directly, bypassing Pin/PWM writes.

        The actuator half of the same back door. Staged here and consumed by
        the next `build_actuator_frame()` (on the next
        `time.sleep_ms()`), the same as a Pin or PWM write is - so calling
        this and then setting an individual Pin in the same tick has the Pin
        write silently overridden, matching the general rule elsewhere in
        this library that an explicit command wins over an installed default.
        """
        self.ensure_connected()
        cmd: dict[str, Any] = {
            "motors": list(motors) if motors is not None else [0.0] * self.motor_count,
            "dribbler": dribbler,
            "kicker": kicker,
        }
        if say is not None:
            cmd["say"] = say
        self._direct_command = cmd
