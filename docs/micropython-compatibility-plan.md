# MicroPython Compatibility Layer Plan

## Goal

Create a `machine` module that lets students write robot code using MicroPython's hardware API. The same code runs on both:
- Real MicroPython robots (ESP32, micro:bit, etc.)
- The simulator (transparently via WebSocket protocol)

## Architecture Overview

```
Student Code                    Simulator Infrastructure
─────────────                   ────────────────────────
from machine import Pin         rcja_soccer library
                                ↓
                                WebSocket/JSON protocol
                                ↓
                                SensorFrame / ActuatorFrame
```

**Key Insight**: The simulator already runs Python on the server. We create a `machine` module that maps hardware calls to the existing protocol.

### Library Philosophy

The two libraries serve different audiences and purposes:

#### `rcja_soccer` - Beginner-Friendly Soccer Library

**Purpose**: Easy entry point for students new to robotics

```python
# Simple, high-level API
from rcja_soccer import Robot, drive

robot = Robot()  # No args! Team/number come from token

@robot.tick
def think(s, me):
    if s.ball is None:
        return robot.coast()
    return robot.motors(drive(bearing=s.ball.bearing, speed=0.8))

robot.run()
```

**Features**:
- `drive()` - automatic omniwheel kinematics
- `sense.Locator()` - field position tracking
- `sense.BallTracker()` - predictive ball following
- `sense.shot_is_open()` - goal detection
- `field.in_penalty_box()` - geometry helpers
- `Memory` class - state persistence

**Pros**:
- Quick to learn (20 lines to a working robot)
- Soccer-specific logic handled for you
- Good for first-time programmers

**Cons**:
- Abstracts away hardware details
- Less control over low-level behavior
- Not how real MicroPython robots work

#### `machine` - Raw MicroPython API

**Purpose**: Authentic hardware programming for advanced teams

```python
# Low-level, hardware-focused
from machine import Pin, PWM, ADC
import time

left_pwm = PWM(Pin(12), freq=1000, duty_u16=0)
ball_sensor = ADC(Pin(32), atten=ADC.ATTN_11DB)

while True:
    if ball_sensor.read_u16() > 40000:
        left_pwm.duty_u16(50000)
    else:
        left_pwm.duty_u16(0)
    time.sleep_ms(10)
```

**Features**:
- Direct pin control (`Pin`, `PWM`, `ADC`)
- Manual motor direction logic
- Raw sensor readings
- Same API as real MicroPython robots
- Full control over hardware behavior

**Pros**:
- Authentic MicroPython experience
- Skills transfer directly to real robots
- More control and flexibility

**Cons**:
- Steeper learning curve
- More code for basic tasks
- Must implement own drive kinematics

### Usage Progression

```
Beginner                    Advanced
────────                    ────────
rcja_soccer.Robot           machine.Pin
rcja_soccer.drive()         machine.PWM
sense.BallTracker()         Manual ball tracking
sense.shot_is_open()        Manual goal detection
```

### Can They Mix?

Yes! Teams can use both:

```python
from machine import PWM, Pin
from rcja_soccer import sense

# Low-level motor control
left_pwm = PWM(Pin(12), freq=1000, duty_u16=0)

# High-level soccer helpers
ball_tracker = sense.BallTracker()

while True:
    ball_tracker.update(sensors)
    if ball_tracker.seen_recently:
        left_pwm.duty_u16(50000)
```

### Architecture: Approach A (Recommended)

The `machine` module wraps `rcja_soccer` internally to reuse connection logic:

```python
# machine/__init__.py
from rcja_soccer import Robot as _Robot

class Pin:
    _robot = None  # Set by Robot.run()
    
    def __init__(self, id, mode, ...):
        self._id = id
        # Map pin to sensor/actuator
    
    def value(self, x=None):
        if x is None:
            return Pin._robot._last_reading.sensors...
        else:
            # Update actuator frame
```

**Why this works**:
- `rcja_soccer` handles WebSocket connection, reconnection, tick loop
- `machine` classes map pin operations to sensor/actuator frames
- Students don't need to know about the connection layer
- Same code works on real robots (just different `machine` implementation)

**Implementation**:
- `machine` imports `rcja_soccer` internally (not exposed to students)
- `robot.py` sets `Pin._robot = self` during `run()`
- All Pin/PWM/ADC instances use this global robot reference

## Implementation Components

### 1. Core `machine` Module Structure

Create a new Python package: `python/micropython_compat/`

```
python/micropython_compat/
├── __init__.py          # Main entry point
├── pin.py               # Pin class implementation
├── pwm.py               # PWM class implementation
├── adc.py               # ADC class implementation
├── time_compat.py       # time.sleep_ms(), ticks_ms(), etc.
└── constants.py         # Pin.OUT, ADC.ATTN_11DB, etc.
```

### 2. Class Implementations

#### `machine.Pin`

```python
class Pin:
    IN = 0
    OUT = 1
    OPEN_DRAIN = 2
    PULL_UP = 1
    PULL_DOWN = 2
    
    def __init__(self, id, mode=-1, pull=-1, *, value=None):
        self._id = id
        self._mode = mode
        self._pull = pull
        self._value = value or 0
        # Map pin ID to simulator function
        self._register_with_protocol()
    
    def value(self, x=None):
        if x is None:
            return self._read_from_sensor_frame()
        else:
            self._write_to_actuator_frame(x)
    
    def on(self):
        self.value(1)
    
    def off(self):
        self.value(0)
    
    def irq(self, handler=None, trigger=...):
        # Simulated - no real interrupts in simulator
        pass
```

**Pin ID Mapping** (example for soccer robot):
- Pins 12-17: Motor control (mapped to `motors[]` in ActuatorFrame)
- Pins 32-35: Analog sensors (mapped to `lines[]`, `ball` in SensorFrame)
- Pin 2: Onboard LED (optional visual feedback)

#### `machine.PWM`

```python
class PWM:
    def __init__(self, dest, *, freq=1000, duty_u16=0, duty_ns=0):
        self._pin = dest
        self._freq = freq
        self._duty_u16 = duty_u16
        # Register with actuator frame
    
    def freq(self, value=None):
        if value is None:
            return self._freq
        self._freq = value
    
    def duty_u16(self, value=None):
        if value is None:
            return self._duty_u16
        self._duty_u16 = value
        self._update_actuator_frame()
    
    def duty_ns(self, value=None):
        # Convert nanoseconds to duty_u16 based on freq
        pass
    
    def deinit(self):
        self._duty_u16 = 0
        self._update_actuator_frame()
```

#### `machine.ADC`

```python
class ADC:
    ATTN_11DB = 11
    ATTN_6DB = 6
    ATTN_2_5DB = 2
    ATTN_0DB = 0
    
    def __init__(self, id, *, sample_ns=0, atten=0):
        self._id = id
        self._atten = atten
        # Map to sensor frame reading
    
    def read_u16(self):
        return self._read_from_sensor_frame()  # 0-65535
    
    def read_uv(self):
        # Convert u16 to microvolts based on atten
        raw = self.read_u16()
        return self._raw_to_uv(raw)
```

### 3. Protocol Integration

The compatibility layer needs to communicate with the existing WebSocket protocol. Two approaches:

#### Option A: Inject into `rcja_soccer.robot`

```python
# In micropython_compat/__init__.py
from .pin import Pin
from .pwm import PWM
from .adc import ADC

# Global robot instance (set by rcja_soccer.robot.Robot)
_robot = None

def _set_robot(robot):
    global _robot
    _robot = robot

# All Pin/PWM/ADC instances use _robot to read/write frames
```

#### Option B: Standalone with transport layer

```python
# micropython_compat uses the same transport as rcja_soccer
from rcja_soccer.transport import Channel

class Pin:
    def __init__(self, id, mode, ...):
        self._channel = Channel()  # Same WebSocket connection
        # ...
```

**Recommendation**: Option A - less duplication, reuses existing connection.

### 4. Sensor/Actuator Mapping

#### Motor Control (ActuatorFrame)

| Pin IDs | Function | ActuatorFrame Field |
|---------|----------|---------------------|
| 12 | Left motor PWM | `motors[0]` (scaled 0-1) |
| 13 | Left motor IN1 | Direction logic |
| 14 | Left motor IN2 | Direction logic |
| 15 | Right motor PWM | `motors[1]` |
| 16 | Right motor IN1 | Direction logic |
| 17 | Right motor IN2 | Direction logic |
| - | Dribbler | `dribbler` (0-1) |
| - | Kicker | `kicker` (trigger) |

#### Sensor Input (SensorFrame)

| Pin IDs | Function | SensorFrame Field |
|---------|----------|-------------------|
| 32 | Ball IR sensor | `ball.strength` |
| 33 | Line front | `lines[0].value` |
| 34 | Line left | `lines[1].value` |
| 35 | Line right | `lines[2].value` |
| 36 | Compass | `compass.heading` |
| 37 | Gyro | `gyro.rate` |

**Note**: Actual pin assignments would be configurable via `manifest.json` or similar.

### 5. Time Module Compatibility

MicroPython's `time` module has some differences from CPython:

```python
# time_compat.py (imported as 'time' in student code)
import time as _time

def sleep(seconds):
    """Sleep for given seconds (same as CPython)"""
    _time.sleep(seconds)

def sleep_ms(ms):
    """Sleep for given milliseconds (MicroPython specific)"""
    _time.sleep(ms / 1000.0)

def ticks_ms():
    """Get millisecond counter (MicroPython specific)"""
    # Returns robot's clock from sensor frame
    return _robot._last_sensors.clock

def ticks_diff(a, b):
    """Compute difference between tick values (handles wraparound)"""
    return a - b
```

**Note**: `time.sleep()` already works in CPython. The `sleep_ms()` and `ticks_ms()` functions are the main additions needed for MicroPython compatibility.

**Alternative**: Don't create a `time` shim - just document that students should use:
```python
import time
time.sleep(0.01)  # instead of time.sleep_ms(10)
```

### 6. Configuration System

#### Robot Configuration File

```python
# robot_config.py (part of submission)
MOTOR_PINS = {
    'left': {'pwm': 12, 'in1': 13, 'in2': 14},
    'right': {'pwm': 15, 'in1': 16, 'in2': 17},
}

SENSOR_PINS = {
    'ball': 32,
    'lines': [33, 34, 35],
    'compass': 36,
}
```

Or map directly to sensor frame fields:

```python
SENSOR_MAP = {
    32: 'ball.strength',
    33: 'lines.0.value',
    34: 'lines.1.value',
    35: 'lines.2.value',
}
```

### 7. Integration with Competition Infrastructure

#### No Changes Required:
- ✅ Browser editor (code runs on server)
- ✅ Laptop uploads (`python/submit.py`)
- ✅ Server execution (sandbox)
- ✅ Competition submission flow

#### One Change Needed:
Add `machine` to allowed imports in `src/submission.ts:31`:

```typescript
// In submission.ts line 31
const ALLOWED_EXTRA = new Set(['rcja_soccer', 'machine']);
```

**How validation works** (from `submission.ts`):
1. `scanImports()` parses Python AST to extract import names
2. `checkStatic()` validates each import against:
   - `stdlibModules()` (Python standard library)
   - `ALLOWED_EXTRA` (currently just `rcja_soccer`)
   - Local `.py` files in submission folder
3. Only imports in this list are allowed at venues with no internet/pip

**The validation flow**:
```
Student code imports 'machine'
  → scanImports() extracts 'machine' from AST
  → checkStatic() checks if 'machine' is allowed
  → ALLOWED_EXTRA.has('machine') → true ✓
  → Code proceeds to sandbox execution
```

### 8. Example Usage

#### Current API (Problematic)

```python
# Current: students must hardcode team, number, and motor count
robot = Robot(team="violet", number=1, motors=4, token="abc123")
```

**Problems**:
1. Students shouldn't know team/number (assigned by competition)
2. Motor count is a hardware concern (all robots are the same)
3. Too many arguments for beginners

#### Improved API (Zero Args)

```python
# New: no arguments needed
robot = Robot()
```

**How it works**:
1. Token installed via `use_join()` or CLI args (not in code)
2. Server validates token and responds with team/number in welcome message
3. Client extracts team/number from welcome message
4. Motor count is fixed at 4 (all robots identical)

**Welcome message contains all needed info**:
```json
{
  "type": "welcome",
  "robot": "violet-1",
  "motors": 4,
  "protocol": 5
}
```

#### Beginner: `rcja_soccer` Library

```python
# Simple ball chaser - 20 lines!
from rcja_soccer import Robot, drive

robot = Robot()  # No args! Token installed via use_join() or CLI

@robot.tick
def think(s, me):
    if s.ball is None:
        return robot.coast()
    return robot.motors(drive(bearing=s.ball.bearing, speed=0.8))

robot.run()
```

#### Changes to `Robot` Class

```python
class Robot:
    def __init__(self) -> None:
        # No args! Team, number, motor count all come from server/token
        self.team = None
        self.number = None
        self.motor_count = 4  # Fixed: all robots are the same
        self.token = join_token()
        
        self._tick = None
        self._memory = Memory()
        self._last_kickoff = False
        self._off = False
        self._last_connected = time.monotonic()
    
    def _play(self, url, quiet, connect):
        socket = connect(url)
        try:
            # Token tells server who we are
            join_message = {
                "type": "join",
                "protocol": PROTOCOL_VERSION,
                "token": self.token,
            }
            # ... rest of _play method
        
    def _handle_welcome(self, welcome):
        # Extract team and number from welcome message
        robot_id = welcome.get("robot", "")  # "violet-1"
        if "-" in robot_id:
            team, number = robot_id.split("-", 1)
            self.team = team
            self.number = int(number)
        
        self.motor_count = welcome.get("motors", 4)
```

**Key changes**:
- `Robot()` takes NO arguments
- Token is installed via `use_join()` or CLI args
- Team/number come from welcome message
- Motor count is fixed at 4 (all robots identical)
- No robot design considerations in code - just logic

```python
# Goalkeeper - using sense helpers
from rcja_soccer import Robot, sense

robot = Robot()  # No args!

@robot.tick
def think(s, me):
    # Stay on goal line
    if sense.in_penalty_box(s, me):
        # Clear the ball if it's close
        if s.ball and s.ball.strength > 0.8:
            return robot.motors([1, 0, 0, 1])  # Forward kick
        return robot.coast()
    # Return to goal
    return robot.motors(drive(bearing=0, speed=0.5))

robot.run()
```

#### Advanced: `machine` API (Raw MicroPython)

```python
# Ball chaser with manual motor control
from machine import Pin, PWM, ADC
import time

# Motor setup (4-wheel omni)
motors = [
    PWM(Pin(12), freq=1000, duty_u16=0),  # Front left
    PWM(Pin(13), freq=1000, duty_u16=0),  # Front right
    PWM(Pin(14), freq=1000, duty_u16=0),  # Rear left
    PWM(Pin(15), freq=1000, duty_u16=0),  # Rear right
]

# Direction pins
dir_pins = [
    (Pin(16, Pin.OUT), Pin(17, Pin.OUT)),  # Front left
    (Pin(18, Pin.OUT), Pin(19, Pin.OUT)),  # Front right
    (Pin(20, Pin.OUT), Pin(21, Pin.OUT)),  # Rear left
    (Pin(22, Pin.OUT), Pin(23, Pin.OUT)),  # Rear right
]

# Ball sensor
ball = ADC(Pin(32), atten=ADC.ATTN_11DB)

def set_motor(idx, speed):
    in1, in2 = dir_pins[idx]
    in1.value(1 if speed > 0 else 0)
    in2.value(0 if speed > 0 else 1)
    motors[idx].duty_u16(int(min(abs(speed), 100) * 65535 / 100))

def drive_omni(x, z, spin):
    # Omniwheel mixing (your implementation)
    set_motor(0, x + z + spin)
    set_motor(1, -x + z - spin)
    set_motor(2, x - z - spin)
    set_motor(3, -x - z + spin)

while True:
    strength = ball.read_u16()
    if strength > 40000:
        drive_omni(70, 0, 0)  # Forward
    else:
        drive_omni(0, 0, 40)  # Spin to search
    time.sleep_ms(10)
```

#### Mixed: `machine` + `rcja_soccer` Helpers

```python
# Low-level motors + high-level soccer sense
from machine import PWM, Pin
from rcja_soccer import sense, Robot

robot = Robot()  # No args!

# Manual motor control
left_pwm = PWM(Pin(12), freq=1000, duty_u16=0)

# Use rcja_soccer's ball tracker
tracker = sense.BallTracker()

@robot.tick
def think(s, me):
    tracker.update(s)
    
    if tracker.seen_recently():
        # Ball in front - chase it
        left_pwm.duty_u16(50000)
    else:
        # Lost ball - spin to search
        left_pwm.duty_u16(20000)
    
    return {"motors": [0.5, 0, 0, 0]}

robot.run()
```

### Key Differences

| Feature | `rcja_soccer` | `machine` |
|---------|---------------|-----------|
| Learning curve | Easy | Steeper |
| Lines of code | 10-50 | 50-200 |
| Control | High-level | Low-level |
| Real robot transfer | Some concepts | Direct transfer |
| Soccer helpers | Built-in | Manual implementation |
| Best for | Beginners, first robot | Advanced teams, competitions |

## Educational Progression

### Stage 1: First Robot (Week 1-2)
- Use `rcja_soccer` exclusively
- Learn: sensors, motors, basic logic
- Goal: Robot that chases ball and avoids lines

### Stage 2: Better Strategy (Week 3-4)
- Still using `rcja_soccer`
- Learn: state machines, memory, ball tracking
- Goal: Robot that scores goals consistently

### Stage 3: Understanding Hardware (Week 5-6)
- Start exploring `machine` API
- Learn: PWM, ADC, pin configuration
- Goal: Understand how real robots work

### Stage 4: Advanced Control (Week 7+)
- Use `machine` for full control
- Learn: omniwheel kinematics, sensor fusion
- Goal: Custom drive systems, advanced strategies

### Migration Path
```python
# Stage 1-2: rcja_soccer
from rcja_soccer import Robot, drive
robot = Robot()
# ... simple strategy

# Stage 3-4: machine + rcja_soccer helpers
from machine import PWM, Pin
from rcja_soccer import sense
# ... advanced control with helpers

# Stage 5: Pure machine (optional)
from machine import Pin, PWM, ADC
# ... full hardware control
```

## Implementation Phases

### Phase 1: Core Library (1-2 weeks)
- [ ] Create `python/micropython_compat/` package
- [ ] Implement `Pin` class with value(), on(), off()
- [ ] Implement `PWM` class with duty_u16(), freq()
- [ ] Implement `ADC` class with read_u16()
- [ ] Implement `time` compatibility (sleep_ms, ticks_ms)
- [ ] Basic constants (Pin.OUT, ADC.ATTN_11DB, etc.)

### Phase 2: Protocol Integration (1 week)
- [ ] Connect to existing `rcja_soccer.transport` layer
- [ ] Map Pin IDs to sensor/actuator frame fields
- [ ] Implement motor control mapping (direction + PWM → motors[])
- [ ] Implement sensor reading mapping (lines[], ball → ADC reads)

### Phase 3: Configuration & Mapping (1 week)
- [ ] Design robot configuration system
- [ ] Implement pin-to-sensor/actuator mapping
- [ ] Support multiple robot configurations (ESP32, micro:bit, etc.)
- [ ] Add validation for pin assignments

### Phase 4: Competition Integration (3-5 days)
- [ ] Update `pyimports.ts` to allow `machine` module
- [ ] Test with browser editor
- [ ] Test with laptop uploads
- [ ] Update documentation

### Phase 5: Example Robots & Documentation (1 week)
- [ ] Create example robots using `machine` API
- [ ] Write getting started guide
- [ ] Document pin mappings and configuration
- [ ] Create migration guide from `rcja_soccer` library

## Open Questions

1. **Pin Mapping**: Should pin assignments be:
   - Fixed in the compatibility layer?
   - Configurable per-robot via manifest?
   - Configurable via robot_config.py?

2. **Error Handling**: What happens when student code:
   - Uses invalid pin numbers?
   - Exceeds PWM range (0-65535)?
   - Calls ADC on output pin?

3. **rcja_soccer Integration**:
   - Should students use `machine` OR `rcja_soccer`, not both?
   - Or can they mix (e.g., `machine` for motors, `rcja_soccer` for high-level sense)?

4. **Board Variants**:
   - Support multiple board types (ESP32, micro:bit, pyboard)?
   - Or abstract away board differences with unified pin numbering?

5. **Debugging**:
   - How to help students debug pin mapping issues?
   - Visual feedback in viewer when pins toggle?

## Error Handling Strategy

### Validation Errors (push-time)

```python
# Invalid pin number
raise ValueError(f"Pin {id} not available. Valid pins: {VALID_PINS}")

# PWM on input pin
raise ValueError(f"Pin {id} is configured as INPUT, cannot create PWM")

# ADC on output pin
raise ValueError(f"Pin {id} is configured as OUTPUT, cannot read ADC")
```

### Runtime Errors (match-time)

```python
# PWM duty out of range - clamp silently (like real hardware)
duty = max(0, min(65535, duty_u16))

# Sensor not available - return sensible default
return 0  # or None, depending on context
```

### Debugging Features

1. **Verbose mode**: Print pin operations to stderr
   ```python
   # When --debug flag is passed
   [PIN] Pin(12) = OUTPUT
   [PWM] Pin(12) duty_u16 = 32768
   [ADC] Pin(32) read_u16() = 45000
   ```

2. **Pin visualization**: Show pin states in robot viewer
   - Motor pins: color intensity based on PWM duty
   - Digital pins: on/off indicator
   - Analog pins: bar graph

3. **Common mistake detection**:
   ```python
   # Warning if student uses CPython syntax
   if hasattr(pin, 'read'):  # Old MicroPython API
       print("Warning: use pin.read_u16() instead of pin.read()", file=sys.stderr)
   ```

## Success Criteria

### For `rcja_soccer` (Beginner Library)
1. **Easy**: Students can write a working robot in <20 lines
2. **Helpful**: Built-in helpers handle common soccer tasks
3. **Educational**: Teaches robotics concepts without hardware complexity
4. **Progressive**: Can migrate to `machine` when ready

### For `machine` (Advanced API)
1. **Authentic**: Same API as real MicroPython robots
2. **Compatible**: Code transfers directly to hardware
3. **Powerful**: Full control over motor/sensor behavior
4. **Transparent**: No exposure of simulator internals

### For Both
1. **Competitive**: Work with browser editor and laptop uploads
2. **Coexist**: Teams can mix both approaches
3. **Supported**: Good documentation and examples

## Implementation Checklist

### Phase 1: Core Library
- [ ] Create `python/micropython_compat/` directory structure
- [ ] Implement `Pin` class (value, on, off, init)
- [ ] Implement `PWM` class (freq, duty_u16, duty_ns, deinit)
- [ ] Implement `ADC` class (read_u16, read_uv)
- [ ] Add constants (Pin.OUT, Pin.IN, ADC.ATTN_11DB, etc.)
- [ ] Write unit tests for each class

### Phase 2: Protocol Integration
- [ ] Connect to `rcja_soccer.transport` layer
- [ ] Implement pin-to-sensor mapping
- [ ] Implement pin-to-actuator mapping
- [ ] Handle motor direction logic (IN1/IN2 + PWM)
- [ ] Test with synthetic sensor frames

### Phase 3: Configuration
- [ ] Design robot configuration schema
- [ ] Implement pin mapping configuration
- [ ] Add validation for pin assignments
- [ ] Create example configurations

### Phase 4: Competition Integration
- [ ] Update `src/submission.ts:31` to allow 'machine'
- [ ] Test with browser editor workflow
- [ ] Test with laptop upload workflow
- [ ] Verify sandbox execution works

### Phase 5: Documentation & Examples
- [ ] Write getting started guide
- [ ] Create example robots using `machine` API
- [ ] Document pin mappings and configuration
- [ ] Add troubleshooting section

## File Changes Summary

### New Files
```
python/micropython_compat/
├── __init__.py
├── pin.py
├── pwm.py
├── adc.py
├── constants.py
└── _robot.py  # Global robot instance

python/micropython_compat/examples/
├── basic_motors.py
├── ball_chaser.py
└── line_follower.py
```

### Modified Files
```
src/submission.ts:31  # Add 'machine' to ALLOWED_EXTRA
```

### Optional Files
```
python/micropython_compat/tests/
├── test_pin.py
├── test_pwm.py
└── test_adc.py
```

## Next Steps

1. **Review this plan** with stakeholders
2. **Decide on open questions** (pin mapping, board variants, etc.)
3. **Choose approach** (A: wrap rcja_soccer, or B: standalone)
4. **Start Phase 1** implementation
5. **Create test robot** to validate the approach works
6. **Iterate based on feedback** from actual students
