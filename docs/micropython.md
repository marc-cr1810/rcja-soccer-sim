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

## Every sensor is a device

There is no privileged reading. Everything the robot can know comes off a pin,
a bus or a serial port, and if the hardware could not tell you something, this
cannot tell you either.

| What | How you read it |
| :--- | :--- |
| The ball | Eight photodiodes on ADCs, or an IR seeker on I²C. Bearing is a vector sum you do yourself. |
| Heading, turn rate | An ADC each, or a BNO055 / MPU-6050 over I²C with their real register maps. |
| The walls | Four HC-SR04s. `time_pulse_us()` for the echo, or an ADC for a pre-scaled distance. |
| The white line | Eight reflectance sensors. White line, green carpet and *black* markings are three different readings. |
| The goals and the ball, seen | A smart camera on **UART 0**, sending framed packets. |
| Your team mate | A transparent radio on **UART 1**. Whatever you write comes out of their UART. |
| The wheels | Quadrature encoders. Count the edges with `Pin.irq()`. |
| Whether to play | A start button on a pin. Somebody presses it at the whistle. |
| Which end, which colour, which robot | Switches somebody set before the half. |

`python/examples/board.py` is one way to wire all of that into a single
`read()`, and it is 300 lines of ordinary `machine` calls with no imports a
board lacks. Copy it, change the pin numbers, and it is yours.

### The camera speaks a protocol

A 360° view is not a lens on your microcontroller. It is a smart camera — an
OpenMV, a Pi, a spare ESP32 — looking into a mirror, running vision code of its
own and sending you the answer. So the camera here is bytes on a serial port:

```
aa 55 | len:u8 | payload | crc8            crc over the payload, poly 0x07

payload, little-endian:
  flags:u8        bit0 set if there were more blobs than would fit
  n_blobs:u8
  present:u8      bit0 cyan goal, bit1 yellow goal, bit2 ball
  cyan   bearing:i16 (milliradians)  range:u16 (mm)
  yellow bearing:i16                 range:u16
  ball   bearing:i16                 range:u16
  n_blobs x { colour:u8 (0 cyan, 1 yellow)
              start:i16  end:i16  height:u16 }   all milliradians
```

`python/examples/camera.py` parses it in about ninety lines, and reading it is
the fastest way to understand what a camera actually hands a robot.

**A packet arrives only when the camera has a new picture.** It runs at 30 fps
against a 50 Hz loop, so on roughly two ticks in five `uart.any()` is zero.
That silence *is* the "is this frame new" flag, and a robot that treats every
tick's sighting as new information builds a controller that oscillates.

### Three things a board cannot know

Not "does not expose" — cannot. A robot on a real field is not told these, and
neither is this one:

- **Whose kick-off it is.** A referee tells a *person*, who places the robots.
  Being placed a chassis-width behind the ball is the whole of the message.
- **Whether you were picked up or the half restarted.** Both are somebody
  putting the robot down and pressing start.
- **That the kick-off is over.** Nothing sends an all-clear. The ball leaving
  the spot is the signal, and `examples/striker.py` shows one way to read it.

Nor is the match clock, or the score. And not "hidden behind the pins" but
never sent: the frame the server sends a robot is its start button, the
switches a person sets, its own clock and its sensors, and nothing else.
`rcja_soccer.simulator.frame()` hands you that frame as numbers rather than
pins - useful for working out why your locator disagrees with the field, and no
advantage, because there is nothing in it a board could not have.

## The optional library

`rcja_soccer` is a plain library of functions that take numbers and return
numbers. It has no network code and nothing privileged, and **nothing requires
it** — `examples/raw_hardware.py` is a complete legal robot that imports only
`machine`.

What it is for is the arithmetic that is tedious to get right: wheel mixing
(`drive`), the rulebook's geometry (`field`), working out where you are from a
sonar you should not trust (`sense.Locator`), and which way you are attacking
(`frame.GoalFrame`). Read it, copy it, replace it.

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
that is exactly reproducible, `rcja_soccer.simulator.frame().time` is the same
robot clock counted in whole frames. Neither is match time, which no board has:
both keep running through stoppages and half-time.

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
| Camera | tx 20, rx 24 | UART 0, 115200 | framed packets, see above |
| Team radio | tx 29, rx 30 | UART 1, 9600 | whatever you write |
| Start button | 31 | digital in | 1 while somebody is holding it down |
| Team / robot / end switches | 40, 41, 42 | digital in | violet or lime, 1 or 2, which way you attack |
| Wheel encoders (4) | 43–50 | digital in, A/B | 256 counts a revolution, all edges |

That is 51 named pins, more than a bare ESP32 has, and saying so is better than
pretending: a real robot at this sensor count reaches for a bigger part or a
multiplexer, and `robot_config.py` below is where a team says which.

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

**And nothing else.** Every name `machine` exports is one real MicroPython has.
There used to be a `machine.Runtime` here, which no board could possibly have,
and it was what the docs told students to build a robot on; the connection it
owned is still there, one layer down, where firmware belongs.

### Four places it is honestly different

**`Timer` fires between frames, not as an interrupt.** Your callback runs after
one frame arrives and before the next goes out, so it sees this tick's readings
and its writes land on the next frame — the same deal your main loop gets.
Nothing preempts anything, which is why `disable_irq()` has nothing to do. The
cost is resolution: the clock only moves in 20 ms steps, so `period=5` fires
once per tick rather than four times. A callback that raises prints its
traceback and the match carries on, as it would on a board.

**`Pin.irq()` delivers a whole frame's edges at once.** Same reason, and it
lands harder, because a wheel turns through dozens of encoder counts in one
20 ms frame. Every edge is delivered, in order, and an edge carries the state
the pins were in when it happened — so a quadrature decoder that reads B on an
edge of A gets the right count *and* the right direction. What is not real is
*when*: they all arrive at the frame boundary. Count them and you are exactly
right; timestamp them and you are not.

**`SPI` has nothing attached.** The camera is on UART 0 and the radio on
UART 1, but SPI has no device on the other end and says so: writes are accepted
and discarded, reads come back `0xff`. That is deliberate — a bus inventing
plausible bytes would read exactly like a working sensor and mean nothing.

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
