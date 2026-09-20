"""Your robot's wiring, in one file.

This is the file you would rewrite first if you built the robot differently,
and the only one that knows a pin number. Above it, everything is arithmetic on
bearings and millimetres; below it, everything is `machine`. Nothing in here is
simulator-specific - it imports `machine` and the standard library and nothing
else, which is the test that it would still work with the motors actually wired
to those pins.

    board = Board()
    while True:
        s = board.read()
        board.apply(motors=[0.4, 0.4, 0.4, 0.4], dribbler=1.0)
        time.sleep_ms(20)

**`read()` polls every device and hands back one object.** That is how a real
robot is written - you do not sprinkle `adc.read_u16()` through your strategy,
you gather once at the top of the loop so that everything downstream is looking
at the same instant.

**Three things your robot genuinely cannot know**, and this file will not
pretend otherwise:

* *Whose kick-off it is.* The button tells you play restarted. It does not tell
  you who is taking it. You can work it out - at a kick-off the robot taking it
  is placed a few centimetres behind the ball and the other side is a goal-width
  away - but that is a decision, made from where you are, not a fact you are
  handed.
* *Whether you were picked up or the half restarted.* Both are the same event:
  somebody put the robot down and pressed start. `s.returned` is true on the
  first tick after any restart, and which kind it was is not knowable.
* *How long until the whistle.* There is no countdown. The button going down
  **is** the whistle.
* *That the kick-off is over.* `kickoff.pending` here means only "the whistle
  went less than three seconds ago", because that is the whole of what a button
  and a clock can tell you. Nobody sends an all-clear. Watch the ball leave the
  spot.
"""

import math
import time

from machine import ADC, PWM, Pin, time_pulse_us

from camera import Camera
from radio import Radio

# --- wiring -----------------------------------------------------------------
# Motors, in wheel order: front-left, front-right, rear-left, rear-right.
MOTOR_PINS = ((12, 13), (14, 15), (16, 17), (18, 19))
ENCODER_PINS = ((43, 44), (45, 46), (47, 48), (49, 50))
KICKER_PIN = 27
DRIBBLER_PIN = 26
BALL_GATE_PIN = 28

# Eight infrared photodiodes round the rim, at 45 degree spacing from straight
# ahead, and eight reflectance sensors under it at the same angles.
IR_RING_PINS = (0, 6, 7, 8, 23, 25, 1, 3)
LINE_PINS = (32, 33, 34, 35, 36, 37, 38, 39)
COMPASS_PIN = 21
GYRO_PIN = 22
ULTRASONIC_PINS = {"front": 2, "back": 10, "left": 9, "right": 11}

# The pins a human operates.
START_PIN = 31
TEAM_PIN = 40
ROBOT_PIN = 41
SIDE_PIN = 42

# --- constants of the parts -------------------------------------------------
#: Counts per wheel revolution counting every edge on both channels. We watch
#: one channel and both its edges, so a revolution is half this many calls.
ENCODER_CPR = 256
RADIANS_PER_COUNT = 2.0 * math.pi * 2.0 / ENCODER_CPR

#: Three surfaces, and a reflectance sensor can tell all three apart because
#: they are three different colours: the boundary line is white, the carpet is
#: green, and the penalty box and neutral points are marked in *black*. Black
#: reads darker than carpet, so "not white" is not the same as "safe" - a robot
#: that only thresholds one way calls its own penalty box a boundary and drives
#: out of its goal.
LINE_THRESHOLD = 0.45
MARKING_THRESHOLD = 0.14

#: Microseconds per millimetre, there and back, at 343 m/s.
ECHO_US_PER_MM = 5.83

#: How long after the whistle a restart could still be a kick-off. Rule 5.4.7
#: gives three seconds to strike the ball, so after that it certainly is not
#: one any more.
#:
#: This is a *ceiling*, not a state. The button says play restarted; nothing
#: says the kick-off has been taken, and a robot that waits out the whole three
#: seconds every time has stopped playing for most of the match. Working out
#: that the kick-off is over - the ball has left the spot, or you struck it -
#: is the robot's job, and both example robots do it.
KICKOFF_WINDOW = 3.0

#: Below this the ring is looking at an empty field, not a faint ball.
BALL_FLOOR = 0.01

#: What the vector sum of the ring comes to for a ball of strength 1.
#:
#: Each photodiode answers in proportion to the cosine of how far off-axis the
#: ball is and sees nothing behind it, so adding the readings as vectors gives
#: a sum of exactly `n/4` times the strength - the same number whichever way
#: the ball lies. Taking the brightest sensor instead is simpler and reads up
#: to 8% low when the ball sits between two of them, which is most of the time.
RING_GAIN = len(IR_RING_PINS) / 4.0


class Reading:
    """Attribute access over a dict, nested.

    So that `s.camera.goals.cyan.bearing` reads the way it looks, and a missing
    field raises instead of quietly being `None`.
    """

    __slots__ = ("_fields",)

    def __init__(self, fields):
        object.__setattr__(self, "_fields", fields)

    def __getattr__(self, name):
        fields = object.__getattribute__(self, "_fields")
        try:
            value = fields[name]
        except KeyError:
            raise AttributeError(
                "no sensor called %r - this reading has %s"
                % (name, ", ".join(sorted(fields)))
            )
        return _wrap_value(value)

    def __contains__(self, name):
        return name in object.__getattribute__(self, "_fields")

    def __repr__(self):
        return "Reading(%r)" % (object.__getattribute__(self, "_fields"),)


def _wrap_value(value):
    """Dicts become readings, lists of dicts become lists of readings.

    The list case is not decoration: `for sensor in s.lines: sensor.surface`
    is how the line ring is read, and a list of bare dicts would not answer to
    that.
    """
    if isinstance(value, dict):
        return Reading(value)
    if isinstance(value, list):
        return [_wrap_value(item) for item in value]
    return value


class Board:
    def __init__(self):
        self._pwm = [PWM(Pin(pwm), freq=1000, duty_u16=0) for pwm, _ in MOTOR_PINS]
        self._dir = [Pin(direction, Pin.OUT) for _, direction in MOTOR_PINS]
        self._dribbler = PWM(Pin(DRIBBLER_PIN), freq=1000, duty_u16=0)
        self._kicker = Pin(KICKER_PIN, Pin.OUT)

        self._ring = [ADC(Pin(pin)) for pin in IR_RING_PINS]
        self._lines = [ADC(Pin(pin)) for pin in LINE_PINS]
        self._compass = ADC(Pin(COMPASS_PIN))
        self._gyro = ADC(Pin(GYRO_PIN))
        self._sonar = {name: Pin(pin) for name, pin in ULTRASONIC_PINS.items()}
        self._gate = Pin(BALL_GATE_PIN, Pin.IN)

        self._start = Pin(START_PIN, Pin.IN)
        self._team_switch = Pin(TEAM_PIN, Pin.IN)
        self._robot_switch = Pin(ROBOT_PIN, Pin.IN)
        self._side_switch = Pin(SIDE_PIN, Pin.IN)

        self.camera = Camera()
        self.radio = Radio()

        # Wheel odometry, counted in an interrupt the way it is on a board.
        # One channel, both edges, reading the other channel to know which way
        # - "2x decoding", and the reason the B line is wired at all.
        self._counts = [0, 0, 0, 0]
        self._b = [Pin(b, Pin.IN) for _, b in ENCODER_PINS]
        for index, (a, _) in enumerate(ENCODER_PINS):
            Pin(a, Pin.IN).irq(self._counter(index), Pin.IRQ_RISING | Pin.IRQ_FALLING)

        self._was_playing = False
        self._restarted_at = None
        self._just_returned = False
        self._last_camera = {
            "goals": {"cyan": None, "yellow": None},
            "goal_blobs": {"cyan": [], "yellow": []},
            "ball": None,
        }

    # -- the switches somebody set -------------------------------------------

    @property
    def team(self):
        """"violet" or "lime", off the switch.

        A robot cannot see what colour it is painted. The person who put it on
        the field can, and this is how they tell it.
        """
        return "lime" if self._team_switch.value() else "violet"

    @property
    def robot(self):
        """1 or 2. Two robots a side, and the same program on both."""
        return 2 if self._robot_switch.value() else 1

    @property
    def attack_direction(self):
        """+1 if we are shooting at +x, -1 if at -x. Set at half time."""
        return 1 if self._side_switch.value() else -1

    # -- odometry ------------------------------------------------------------

    def _counter(self, index):
        b = self._b[index]

        def edge(pin):
            self._counts[index] += 1 if pin.value() != b.value() else -1

        return edge

    # -- reading -------------------------------------------------------------

    def read(self):
        """Poll every device once and return this instant as one object."""
        now = time.ticks_ms()
        playing = bool(self._start.value())

        # The button going down is the whistle, and every restart looks the
        # same from here.
        returned = playing and not self._was_playing
        if returned:
            self._restarted_at = now
        self._was_playing = playing

        since = None
        if self._restarted_at is not None and playing:
            since = time.ticks_diff(now, self._restarted_at) / 1000.0

        picture = self.camera.read()
        fresh = picture is not None
        if fresh:
            self._last_camera = picture
        camera = dict(self._last_camera)
        camera["fresh"] = fresh

        return Reading(
            {
                "clock": time.ticks_ms() / 1000.0,
                "playing": playing,
                "returned": returned,
                "kickoff": {
                    "pending": since is not None and since < KICKOFF_WINDOW,
                    "since": since,
                },
                "team": self.team,
                "robot": self.robot,
                "attack_direction": self.attack_direction,
                "ball": self._ball(),
                "compass": {"heading": self._heading()},
                "gyro": {"rate": self._rate()},
                "lines": self._line_sensors(),
                "range": self._ranges(),
                "encoders": [c * RADIANS_PER_COUNT for c in self._counts],
                "camera": camera,
                "ball_gate": {"held": bool(self._gate.value())},
                "messages": [
                    {"from": m.sender, "body": m.body, "age": m.age}
                    for m in self.radio.poll()
                ],
            }
        )

    def _ball(self):
        """Where the ball is, from the ring, as a direction and a strength.

        The ring is eight photodiodes and nothing more. Each one answers most
        strongly to light straight at it and falls away to nothing at ninety
        degrees off, so adding them up as vectors points at the ball - and the
        length of that same sum, divided by `RING_GAIN`, is how bright it is.

        Strength is not a distance. It falls off with the square of one, so it
        looks like one, but it saturates: against the dribbler's mouth it reads
        1.0 and keeps reading 1.0 for everything closer.

        `None` when the ring sees nothing at all, which is not the same as
        "far away": a robot standing between you and the ball blocks it
        completely, and that happens constantly.
        """
        values = [adc.read_u16() / 65535.0 for adc in self._ring]
        if max(values) < BALL_FLOOR:
            return None

        x = 0.0
        y = 0.0
        for index, value in enumerate(values):
            angle = index * math.pi / 4.0
            x += value * math.cos(angle)
            y += value * math.sin(angle)
        size = math.hypot(x, y)
        if size == 0.0:
            return None
        return {
            "bearing": math.atan2(y, x),
            "strength": min(1.0, size / RING_GAIN),
        }

    def _heading(self):
        return self._compass.read_u16() / 65535.0 * 2.0 * math.pi - math.pi

    def _rate(self):
        return self._gyro.read_u16() / 65535.0 * 20.0 - 10.0

    def _line_sensors(self):
        sensors = []
        for index, adc in enumerate(self._lines):
            value = adc.read_u16() / 65535.0
            sensors.append(
                {
                    # Where this sensor is bolted to the chassis. Your robot
                    # knows that because you built it.
                    "bearing": _wrap(index * math.pi / 4.0),
                    "surface": _surface(value),
                    "value": value,
                }
            )
        return sensors

    def _ranges(self):
        """Millimetres to a wall, or `None` where nothing echoed back."""
        distances = {}
        for name, pin in self._sonar.items():
            micros = time_pulse_us(pin, 1, 30000)
            distances[name] = None if micros < 0 else micros / ECHO_US_PER_MM
        return distances

    # -- driving -------------------------------------------------------------

    def apply(self, motors=None, dribbler=None, kicker=None, say=None):
        """Everything you want to do this tick, in one call.

        **What you leave out is left alone**, because that is what the hardware
        does: a PWM you do not write keeps the duty you last gave it. So
        `apply(motors=...)` with no `dribbler` does not stop the roller, it
        leaves it running - which is the right behaviour and an easy way to
        hold the ball through a shot you meant to take. Set every output every
        tick unless you mean otherwise.
        """
        if motors is not None:
            self.motors(motors)
        if dribbler is not None:
            self.dribbler(dribbler)
        if kicker:
            self.kick()
        if say is not None:
            self.radio.send(say)

    def motors(self, powers):
        """Four numbers, -1 to 1, one per wheel."""
        for index, power in enumerate(powers[: len(self._pwm)]):
            power = max(-1.0, min(1.0, power))
            self._dir[index].value(1 if power < 0 else 0)
            self._pwm[index].duty_u16(int(abs(power) * 65535))

    def dribbler(self, power):
        self._dribbler.duty_u16(int(max(0.0, min(1.0, power)) * 65535))

    def kick(self):
        """Fire the solenoid. It needs time to charge again; it will not say so."""
        self._kicker.value(1)

    def coast(self):
        self.motors([0.0, 0.0, 0.0, 0.0])
        self.dribbler(0.0)


def _surface(value):
    """White boundary line, black marking, or the carpet in between."""
    if value > LINE_THRESHOLD:
        return "line"
    if value < MARKING_THRESHOLD:
        return "marking"
    return "carpet"


def _wrap(angle):
    return (angle + math.pi) % (2.0 * math.pi) - math.pi
