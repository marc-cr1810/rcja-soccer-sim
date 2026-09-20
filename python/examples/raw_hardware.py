"""One file, no library, no `board.py`. Everything inline.

The smallest complete robot: `machine` and the standard library, with the
wiring, the wheel mixing and the strategy all in the same file. It is here to
show that nothing else is *required* - not `rcja_soccer`, not even the
`board.py` that `main.py` uses to keep its pin numbers in one place.

That is also why it is not very good. It cannot tell you where it is, which
goal it is attacking or whether a shot is open, because all of that is real
work and it is the work the other files exist to share. Read this one to see
the floor, then read `main.py` and `striker.py` to see what gets built on it.

The exact same file runs on a physical ESP32 or RP2040 with the motors wired to
these pins.
"""

import math
import time
from machine import ADC, Pin, PWM

# --- Motor Setup (4-wheel omnidirectional drive) ---
# Each motor has a PWM pin (speed) and a DIR pin (direction: 0=forward, 1=reverse)
motor_pwms = [
    PWM(Pin(12), freq=1000, duty_u16=0),  # Motor 0: Front-Left
    PWM(Pin(14), freq=1000, duty_u16=0),  # Motor 1: Front-Right
    PWM(Pin(16), freq=1000, duty_u16=0),  # Motor 2: Rear-Left
    PWM(Pin(18), freq=1000, duty_u16=0),  # Motor 3: Rear-Right
]

motor_dirs = [
    Pin(13, Pin.OUT),  # Motor 0 DIR
    Pin(15, Pin.OUT),  # Motor 1 DIR
    Pin(17, Pin.OUT),  # Motor 2 DIR
    Pin(19, Pin.OUT),  # Motor 3 DIR
]

# --- Kicker & Dribbler ---
kicker = Pin(27, Pin.OUT)
dribbler = PWM(Pin(26), freq=1000, duty_u16=0)

# --- Sensors ---
# Ball IR sensors
ball_strength = ADC(Pin(4))
ball_bearing = ADC(Pin(5))

# Perimeter Line Sensors (8 sensors: 0=Front, 1=FL, 2=Left, 3=RL, 4=Rear, 5=RR, 6=Right, 7=FR)
line_sensors = [ADC(Pin(p)) for p in range(32, 40)]

# Compass Heading (0-65535 mapped from -pi to +pi)
compass = ADC(Pin(21))


def set_motor(idx: int, speed: float) -> None:
    """Set motor speed between -1.0 and 1.0."""
    speed = max(-1.0, min(1.0, speed))
    duty = int(abs(speed) * 65535)

    if speed >= 0:
        motor_dirs[idx].value(0)
    else:
        motor_dirs[idx].value(1)

    motor_pwms[idx].duty_u16(duty)


def drive_omni(vx: float, vz: float, spin: float) -> None:
    """4-wheel X-omniwheel drive kinematics.

    vx: forward/backward velocity (-1.0 to 1.0)
    vz: left/right strafe velocity (-1.0 to 1.0)
    spin: rotational velocity (-1.0 to 1.0)
    """
    # Standard 45-degree 4-wheel omni matrix
    m0 = vx + vz + spin   # Front-Left
    m1 = -vx + vz + spin  # Front-Right
    m2 = vx - vz + spin   # Rear-Left
    m3 = -vx - vz + spin  # Rear-Right

    # Normalize if any motor exceeds 1.0
    max_val = max(abs(m0), abs(m1), abs(m2), abs(m3), 1.0)
    set_motor(0, m0 / max_val)
    set_motor(1, m1 / max_val)
    set_motor(2, m2 / max_val)
    set_motor(3, m3 / max_val)


def get_ball_bearing_rad() -> float:
    """Read ball angle in radians (-pi to +pi)."""
    raw = ball_bearing.read_u16()
    return (raw / 65535.0) * (2 * math.pi) - math.pi


def check_lines() -> tuple[float, float]:
    """Check line sensors and return an avoidance vector (vx, vz) pushing back inside."""
    push_x = 0.0
    push_z = 0.0
    threshold = 30000  # White line reflectance threshold

    # Sensor angles for 8 perimeter sensors around chassis
    angles = [0.0, math.pi / 4, math.pi / 2, 3 * math.pi / 4, math.pi, -3 * math.pi / 4, -math.pi / 2, -math.pi / 4]

    for sensor, angle in zip(line_sensors, angles):
        val = sensor.read_u16()
        if val > threshold:
            # Push opposite to sensor location
            push_x -= math.cos(angle)
            push_z -= math.sin(angle)

    return push_x, push_z


def main() -> None:
    # Run dribbler at moderate speed
    dribbler.duty_u16(32768)

    while True:
        strength = ball_strength.read_u16()
        line_vx, line_vz = check_lines()

        # 1. Line Avoidance Priority
        if line_vx != 0.0 or line_vz != 0.0:
            drive_omni(line_vx, line_vz, 0.0)
        # 2. Ball Seeking & Striking
        elif strength > 15000:
            bearing = get_ball_bearing_rad()

            # Aim forward towards ball
            spin = max(-0.8, min(0.8, bearing * 1.5))
            fwd = 0.85

            drive_omni(fwd, 0.0, spin)

            # Fire kicker if ball is close and centered
            if strength > 55000 and abs(bearing) < 0.2:
                kicker.on()
        else:
            # Ball lost: spin to search
            drive_omni(0.0, 0.0, 0.4)

        # 50 Hz control loop tick
        time.sleep_ms(20)


if __name__ == "__main__":
    main()
