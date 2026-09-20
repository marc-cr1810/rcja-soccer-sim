# MicroPython

The robot you write here is a MicroPython program. Not something shaped like
one — the same file, running unmodified on an ESP32 or an RP2040 with the
motors and sensors actually wired to those pins.

```python
from machine import ADC, Pin, PWM
import time

fl = PWM(Pin(12), freq=1000, duty_u16=0)
fl_dir = Pin(13, Pin.OUT)
ball = ADC(Pin(4))

while True:
    if ball.read_u16() > 20000:
        fl_dir.value(0)
        fl.duty_u16(50000)
    else:
        fl.duty_u16(0)
    time.sleep_ms(20)
```

No simulator imports, no decorators, no boilerplate. `machine` is what owns the
connection, the same way a real board has one already, and `time.sleep_ms()` is
what advances it.

## The one runtime

There used to be two: `rcja_soccer.Robot` with a tick decorator, and `machine`
with a real loop. They each opened their own connection for the same robot, so
a program touching both was rejected every tick and silently stopped sending.
That is gone. **`machine` is the only thing that connects, and the loop is
yours.**

`rcja_soccer` is still here and is worth using — but it is now a plain library
of functions that take readings and return numbers. It has no network code of
its own. The two meet at two methods on the runtime:

```python
import time
from machine import Runtime
from rcja_soccer import coast, drive

rt = Runtime.get()

while True:
    s = rt.sensors()                    # the whole frame, as attributes
    if s.ball is None:
        rt.send_command(motors=coast())
    else:
        rt.send_command(motors=drive(bearing=s.ball.bearing, speed=0.8))
    time.sleep_ms(20)
```

`rt.sensors()` gives you everything the server sent — camera, team radio,
encoders, attack direction — not just the pin-shaped subset `ADC` and `Pin`
expose. `rt.send_command()` sets the whole actuator frame at once, for a
program built on `drive()` rather than on named motor pins. Use either style,
or both; there is only one connection underneath.

One rule if you mix them: `send_command()` replaces the pin-derived frame for
that tick. Call it and then write a `Pin`, and the `Pin` write is the one that
gets dropped.

## Time is how the simulation advances

A board runs as fast as it can and your sleeps are real. Here, **sleeping is
what sends your motor command and fetches the next set of readings.** One
simulation step is 20 ms, fifty a second.

```python
time.sleep_ms(20)     # flush the actuators, wait for the next frame
time.sleep(0.02)      # identical — the seconds form works too
```

Both forms do the same thing. Sleep longer and the simulation advances further
with your last command still standing, exactly as a board keeps driving. Sleep
in something that is not a multiple of 20 ms and the remainder is carried, so a
30 ms loop paces as 1, 2, 1, 2 steps rather than drifting.

A loop that never sleeps never sends anything. That is the one way to write a
robot that connects, looks alive, and does nothing.

### `ticks_ms()` and friends

`ticks_ms()`, `ticks_us()`, `ticks_diff()` and `ticks_add()` are all here and
wrap at 2³⁰ the way MicroPython's do. The reading is the simulation's clock —
frames elapsed — plus however long your program has spent inside the current
frame:

```python
start = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), start) < 20:
    pass                      # terminates, as it would on a board
```

That host-time component is deliberate: counting whole frames alone would
leave the loop above spinning forever, because nothing in it sleeps. The
consequence is that `ticks_ms()` is not identical between two runs of the same
headless match — it can differ by up to one frame's worth. If you need a clock
that is exactly reproducible, use `rt.sensors().clock`, which is match time in
seconds. If you need one that never stops, use `ticks_ms()`: match time pauses
at every stoppage and half-time, and `ticks_ms()` does not.

## The virtual board

| Component | Pin(s) | Peripheral | What it maps to |
| :--- | :--- | :--- | :--- |
| Front-left motor | 12, 13 | PWM + DIR | `motors[0]`, −1.0 to +1.0 |
| Front-right motor | 14, 15 | PWM + DIR | `motors[1]` |
| Rear-left motor | 16, 17 | PWM + DIR | `motors[2]` |
| Rear-right motor | 18, 19 | PWM + DIR | `motors[3]` |
| Dribbler | 26 | PWM or digital | speed, 0.0 to 1.0 |
| Kicker | 27 | digital out | fires on a rising edge |
| Ball gate | 28 | digital in | 1 when the dribbler has the ball |
| Line sensors (8) | 32–39 | ADC | reflectance, 0–65535 |
| Ball strength | 4 | ADC | 0–65535, saturating close in |
| Ball bearing | 5 | ADC | −π…+π scaled onto 0–65535 |
| IR ring (8 zones) | 0, 6, 7, 8, 23, 25, 1, 3 | ADC | directional response per zone |
| Compass | 21 | ADC | heading, −π…+π onto 0–65535 |
| Gyro | 22 | ADC | rate, −10…+10 rad/s onto 0–65535 |
| Ultrasonics | front 2, back 10, left 9, right 11 | ADC or `time_pulse_us` | distance |
| IMU / IR seeker | — | I²C `0x68`, `0x28`, `0x1C`, `0x29` | heading, rate, ball direction |

Every number above is distinct, and a test enforces that. It has to be: one
physical pin cannot be both a motor direction output and a sensor input, and a
default pinout that claimed otherwise would be a board nobody could build.

**Motor driver modes.** PWM + DIR is the default — one PWM pin for speed, one
digital pin where 0 is forward and 1 is reverse. Dual-PWM works too: give a
motor `in1` and `in2` instead, and the power is `(in1 − in2) / 65535`.

**Ultrasonics read either way.** `ADC(Pin(2)).read_u16()` gives you a scaled
distance; `time_pulse_us(Pin(2))` gives you the echo width in microseconds,
which is how an HC-SR04 is actually read, and returns `-2` when nothing comes
back.

### Your own pinout

Drop a `robot_config.py` beside your entry point to remap anything:

```python
PINS = {
    "motors": [
        {"pwm": 2, "dir": 3},
        {"pwm": 4, "dir": 5},
        {"pwm": 6, "dir": 7},
        {"pwm": 8, "dir": 9},
    ],
    "kicker": 10,
    "dribbler": 11,
    "lines": [26, 27, 28, 29],
}
```

Anything you leave out keeps its default.

## What `machine` has

`Pin`, `PWM`, `ADC`, `I2C`, `SoftI2C`, `SPI`, `SoftSPI`, `UART`, `RTC`, `WDT`,
`Timer`, `Signal`, plus `reset`, `soft_reset`, `reset_cause`, `freq`, `idle`,
`lightsleep`, `deepsleep`, `disable_irq`, `enable_irq`, `time_pulse_us` and
`unique_id`.

Alongside it: `micropython` (`const`, the `native`/`viper` decorators,
`schedule`), and the `u*` names a board uses for standard-library modules —
`utime`, `ustruct`, `ujson`, `urandom`, `ubinascii`, `uos`, `usys`, `uerrno`,
`uselect`, `ucollections`, `uhashlib`, `uheapq`, `uio`, `ure`, `usocket`,
`uzlib`, `uasyncio`. Each one *is* its standard-library module, not a copy, so
`ustruct is struct`.

### Three places it is honestly different

**`Timer` fires between frames, not as an interrupt.** Your callback runs after
one frame arrives and before the next goes out, so it sees this tick's readings
and its writes land on the next frame — the same deal your main loop gets.
Nothing preempts anything, which is why `disable_irq()` has nothing to do. The
cost is resolution: the clock only moves in 20 ms steps, so `period=5` fires
once per tick rather than four times. A callback that raises prints its
traceback and the match carries on, as it would on a board.

**`UART` and `SPI` have nothing attached.** The simulator models a robot on a
field, not the serial device you plugged into yours. Both present their real
API: writes are accepted and discarded, reads come back empty. That is
deliberate — a bus inventing plausible bytes would read exactly like a working
sensor and mean nothing.

**There is no memory map.** `mem8`/`mem16`/`mem32` and `bitstream` are absent
rather than faked, for the same reason.

## Getting the library

The entry script is executed directly — there is no separate runner — and
`machine`, `utime` and `rcja_soccer` are available to it at a venue with no
internet and no pip. For your own machine:

- `pip install rcja-soccer`, or the wheel attached to any GitHub release;
- or just run from a checkout: `cd python && PYTHONPATH=. python3 myrobot.py`.

Either way `from time import sleep_ms` works on the first line, the way it does
on a board — a startup hook installs the MicroPython time API before your code
runs.

## Where to go next

[python/README.md](../python/README.md) is the reference for what a robot can
*see* — every sensor field, the gotchas that catch a first attempt, and the
`drive`/`field`/`sense` helpers. [Writing a robot](writing-a-robot.md) is the
submission format and the argv convention a venue server expects.
