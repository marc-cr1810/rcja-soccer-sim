# MicroPython Compatibility Layer Plan

## Goal

Create a `machine` module that lets students write robot code using MicroPython's hardware API. The same code runs on both:
- Real MicroPython robots (ESP32, RP2040, OpenMV, micro:bit, etc.)
- The simulator (transparently via WebSocket protocol)

---

## Architecture Overview

```
Student Code (Pure MicroPython)       Simulator Infrastructure
───────────────────────────────       ────────────────────────
from machine import Pin, PWM, ADC     WebSocket / Unix Socket
import time                           ↓
                                      SensorFrame / ActuatorFrame
while True:                           ↓
    # Read ADC / Pin                  Physics Step (50 Hz / 20ms)
    # Compute motor speeds
    # Set PWM duty
    time.sleep_ms(20)  ─────────────── Flushes ActuatorFrame & awaits next SensorFrame
```

### Key Insight
The simulator runs Python on the host/server. We provide a `machine` module and `time`/`utime` shim in Python that maps hardware pin operations, ADC reads, and PWM duties to the existing 50 Hz WebSocket protocol.

The student's `main.py` requires **zero simulator imports, zero decorators, and zero simulator boilerplate**. It runs directly on physical hardware and in the simulator without modification.

---

## Library Philosophies

The two libraries serve different audiences and purposes:

### 1. `rcja_soccer` — High-Level Soccer Library
**Purpose**: Rapid entry point for students focusing purely on soccer strategy.
```python
from rcja_soccer import Robot, drive

robot = Robot()

@robot.tick
def think(s, me):
    if s.ball is None:
        return robot.coast()
    return robot.motors(drive(bearing=s.ball.bearing, speed=0.8))

robot.run()
```
* Automatic omniwheel kinematics (`drive()`).
* High-level state tracking (`Locator`, `BallTracker`, `shot_is_open`).
* Minimal lines of code.

### 2. `machine` — Authentic MicroPython Hardware API
**Purpose**: Authentic embedded hardware programming for advanced teams and real robotics classes.
```python
from machine import Pin, PWM, ADC
import time

# Motor setup (FL, FR, RL, RR)
fl_pwm = PWM(Pin(12), freq=1000, duty_u16=0)
fl_dir = Pin(13, Pin.OUT)

ball = ADC(Pin(34))
line_front = ADC(Pin(32))

while True:
    strength = ball.read_u16()
    line_val = line_front.read_u16()
    
    if line_val > 30000:
        # Avoid boundary
        fl_dir.value(1)
        fl_pwm.duty_u16(40000)
    elif strength > 20000:
        # Chase ball
        fl_dir.value(0)
        fl_pwm.duty_u16(50000)
    else:
        fl_pwm.duty_u16(0)
        
    time.sleep_ms(20)
```
* Direct pin control (`Pin`, `PWM`, `ADC`, `I2C`).
* Manual motor direction and kinematics logic.
* Raw sensor readings (0–65535).
* 100% portable to physical ESP32 / RP2040 microcontrollers.

---

## Dual-Paradigm Runtime Engine

Both styles are supported through `machine._backend.Runtime`:
1. **Pure MicroPython (Top-Level Imperative Loop)**:
   - On first hardware access or `time.sleep_ms()`, `_backend.Runtime` initializes.
   - Automatically parses `sys.argv` for `--url`, `--token`, `--team`, `--number`, `--name`.
   - Opens the socket connection, sends `join`, receives `welcome`, and awaits the first `SensorFrame`.
   - `time.sleep_ms(ms)` serializes pending PWM/Pin states into an `ActuatorFrame`, sends it to the server, and blocks until the next `SensorFrame` arrives.
2. **Hybrid Mode (Decorated `rcja_soccer` Loop)**:
   - Students using `rcja_soccer.Robot` can also import `machine.Pin` or `PWM`.
   - `Robot.run()` drives the tick loop, and `machine` classes read from the current tick's frame.

---

## Virtual Board Specification & Default Pinout

The simulator models a standard ESP32-inspired robotics controller pinout:

| Component | Pin(s) | Mode / Peripheral | Simulator Mapping / Formula |
| :--- | :--- | :--- | :--- |
| **Front-Left Motor** | Pin 12, Pin 13 | PWM / DIR or Dual-PWM | `motors[0]`: scaled -1.0 to +1.0 |
| **Front-Right Motor**| Pin 14, Pin 15 | PWM / DIR or Dual-PWM | `motors[1]`: scaled -1.0 to +1.0 |
| **Rear-Left Motor**  | Pin 16, Pin 17 | PWM / DIR or Dual-PWM | `motors[2]`: scaled -1.0 to +1.0 |
| **Rear-Right Motor** | Pin 18, Pin 19 | PWM / DIR or Dual-PWM | `motors[3]`: scaled -1.0 to +1.0 |
| **Dribbler** | Pin 26 | PWM / Pin.OUT | `dribbler`: 0.0 to 1.0 (speed) |
| **Kicker** | Pin 27 | Pin.OUT | `kicker`: True on rising edge / `value(1)` |
| **Line Sensors (8x)**| Pins 32–39 | ADC / Pin.IN | `lines[0..7]`: 0–65535 (`read_u16()`) |
| **Ball Sensor (IR)** | Pin 34 | ADC | `ball.strength`: 0–65535 (`read_u16()`) |
| **Ball Angle (IR)**  | Pin 35 | ADC | `ball.bearing`: scaled -π..+π to 0–65535 |
| **TSOP Ring (8x)**   | Pins 4,5,21,22,23,25,1,3 | ADC / Pin.IN | 8 directional IR zones around chassis |
| **Compass / IMU**   | I2C (`0x68`, `0x28`) | I2C / SoftI2C | Heading & gyro rate registers |
| **Compass (Analog)** | Pin 36 | ADC | Heading: -π..+π mapped to 0–65535 |
| **Gyro (Analog)**    | Pin 39 | ADC | Angular velocity `gyro.rate` |
| **Ultrasonics (4x)** | Pins 2, 4, 15, 13 (alt)| ADC / Distance | Front, Back, Left, Right distances |

### Motor Driver Modes
* **DIR + PWM Mode**: One PWM pin (duty 0–65535) and one digital output pin (0 = forward, 1 = reverse).
* **Dual-PWM Mode**: Two PWM pins per motor (e.g. forward PWM and reverse PWM). The effective power is `(pwmA - pwmB) / 65535`.

### Custom Pin Mapping (`robot_config.py`)
Teams with custom PCBs can place an optional `robot_config.py` in their submission folder to remap pins without changing their code:
```python
# robot_config.py
PINS = {
    "motors": [
        {"pwm": 2, "dir": 3},   # FL
        {"pwm": 4, "dir": 5},   # FR
        {"pwm": 6, "dir": 7},   # RL
        {"pwm": 8, "dir": 9},   # RR
    ],
    "kicker": 10,
    "dribbler": 11,
    "lines": [26, 27, 28, 29],
}
```

---

## Time & Timing Compatibility

MicroPython uses millisecond and microsecond timing functions rather than fractional seconds.
When `machine`, `utime`, or `rcja_soccer` is imported, `sys.modules['time']` is automatically augmented with:
* `sleep_ms(ms)`: Synchronizes with the simulator's 50 Hz physics step.
* `sleep_us(us)`: Microsecond sleep.
* `ticks_ms()`: Millisecond tick counter tied to `s.clock * 1000` for 100% deterministic simulation and benchmark playback.
* `ticks_us()`: Microsecond counter.
* `ticks_diff(t1, t2)`: Handles tick arithmetic and wraparound.
* `ticks_add(t, delta)`: Adds millisecond offset.

The `utime` module is provided as an alias to `time`.

---

## Distribution & Package Pipeline

Teams without this repository access the library through three standard channels:

1. **Public PyPI Package (`pip install rcja-soccer`)**:
   Contains `rcja_soccer`, `machine`, `utime`, and console commands `rcja-join` and `rcja-submit`.
2. **GitHub Releases Asset**:
   Each release automatically builds `rcja_soccer-<version>-py3-none-any.whl` via `.github/workflows/release.yml`.
3. **Offline Venue Match Server**:
   The match server hosts `/rcja-soccer.whl` for competition networks without internet access.
4. **Browser Workspace (`/workspace/`)**:
   Zero-install environment running on the venue server.

---

## Planned VS Code Extension Integration (Phase 13)

The Phase 13 VS Code extension integrates the MicroPython layer:
* **Dual-Target Execution**: "Run in Simulator" vs "Flash to ESP32" via `mpremote`.
* **Virtual Hardware Inspector**: Live visual display of motor PWM % duties, line sensor reflectance bars, kicker pulses, and virtual I2C bus transactions.
* **Bundled Type Stubs (`.pyi`)**: Full IntelliSense, code completion, and docstrings for `machine` and `utime`.
* **Lockstep Debugger**: Step tick-by-tick and inspect ADC values at every moment of the match.
