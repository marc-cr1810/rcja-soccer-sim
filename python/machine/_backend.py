"""Internal simulator runtime and hardware abstraction engine for MicroPython."""

from __future__ import annotations

import json
import math
import os
import sys
import time
from typing import Any, Callable

from . import constants
from .config import get_config
from .reading import Reading

PROTOCOL_VERSION = 5
DEFAULT_URL = "ws://localhost:8080/agent"
#: How long to keep retrying a lost connection, in seconds, before giving up
#: and letting the error propagate. The clock restarts on every successful
#: connection, so a practice session survives any number of server restarts;
#: what it will not do is retry a port that is never coming back forever - the
#: same budget `rcja_soccer.Robot.run()` used to give, and for the same
#: reason: a harness that spawns robots detached cannot clean up a process
#: that outlives it.
DEFAULT_RECONNECT_FOR = 120.0


def _clamp(val: float, low: float, high: float) -> float:
    return max(low, min(high, val))


def _wrap_angle(rad: float) -> float:
    return (rad + math.pi) % (2 * math.pi) - math.pi


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

        self.last_frame: dict[str, Any] = {}
        self.clock: float = 0.0
        self.off_field = False
        self.last_kickoff = False

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
        propagate. This is the same retry `rcja_soccer.Robot.run()` used to
        do around its own socket - ported here because `machine` is now the
        only thing that owns a connection at all, so nothing else provides it.
        """
        if self.connected:
            return

        from rcja_soccer.transport import TransportError, current_transport, join_token, join_url

        opener = current_transport()
        while True:
            try:
                self._connect_once(opener, join_url(), join_token())
                return
            except (TransportError, OSError) as error:
                idle = time.monotonic() - self._last_connected
                if idle > self.reconnect_for:
                    raise
                time.sleep(1.0)

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
        }
        if self.token is not None:
            join_msg["token"] = self.token

        self.socket.send(json.dumps(join_msg))

        # 3. Receive welcome
        raw = self.socket.recv()
        hello = json.loads(raw)
        if hello.get("type") == "reject":
            raise ConnectionError(f"Server refused: {hello.get('reason')}")
        if hello.get("type") != "welcome":
            raise ConnectionError(f"Unexpected handshake response: {hello!r}")

        self.motor_count = hello.get("motors", 4)
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

        # 4. Wait for the first sensor frame before unblocking user hardware reads
        while True:
            msg = json.loads(self.socket.recv())
            if msg.get("type") == "sensors":
                self._update_sensor_frame(msg["frame"])
                break
            elif msg.get("type") == "disabled":
                self.off_field = True

    def _update_sensor_frame(self, frame: dict[str, Any]) -> None:
        self.last_frame = frame
        self.clock = frame.get("clock", 0.0)
        self.off_field = False

        # Reset kickoff flag on kick-off transition
        pending = frame.get("kickoff", {}).get("pending", False)
        self.last_kickoff = pending

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
        if pin_id == 28:
            return 1 if self.last_frame.get("ballGate", {}).get("held", False) else 0

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

        # Calculate number of physics ticks to advance
        ticks = max(1, int(round(self._sleep_accum_ms / 20.0)))
        self._sleep_accum_ms = 0.0

        from rcja_soccer.transport import TransportError

        for _ in range(ticks):
            while True:
                try:
                    cmd = self.build_actuator_frame()
                    self.socket.send(json.dumps({"type": "command", "frame": cmd}))

                    # Wait for next server response
                    while True:
                        msg = json.loads(self.socket.recv())
                        msg_type = msg.get("type")
                        if msg_type == "sensors":
                            self._update_sensor_frame(msg["frame"])
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
    # Full-frame reads and direct commands, for a program built on
    # `rcja_soccer` rather than on named hardware pins.
    # -------------------------------------------------------------------------

    def sensors(self) -> Reading:
        """The full sensor frame for this tick, as attributes.

        Everything the server sent - camera goal blobs, team radio messages,
        wheel encoders, attack direction and all - not just the
        hardware-shaped subset the Pin/PWM/ADC/I2C classes expose. The same
        shape `rcja_soccer.Robot`'s tick function used to hand a program as
        `s`, before there were two connections to reconcile.
        """
        self.ensure_connected()
        return Reading(self.last_frame)

    def send_command(
        self,
        motors: list[float] | None = None,
        dribbler: float = 0.0,
        kicker: bool = False,
        say: Any = None,
    ) -> None:
        """Set this tick's actuator command directly, bypassing Pin/PWM writes.

        For a program built on `rcja_soccer.drive()` rather than on named
        motor pins - the same shape `robot.motors()` used to return. Staged
        here and consumed by the next `build_actuator_frame()` (on the next
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
