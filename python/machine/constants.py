"""MicroPython hardware constants and default virtual board pinouts."""

# --- Pin Modes & Pulls ---
IN = 0
OUT = 1
OPEN_DRAIN = 2
ALT = 3

PULL_NONE = 0
PULL_UP = 1
PULL_DOWN = 2

# --- ADC Constants ---
ATTN_0DB = 0     # 0 - 1.1V
ATTN_2_5DB = 1   # 0 - 1.5V
ATTN_6DB = 2     # 0 - 2.2V
ATTN_11DB = 3    # 0 - 3.9V

WIDTH_9BIT = 9
WIDTH_10BIT = 10
WIDTH_11BIT = 11
WIDTH_12BIT = 12

# --- Default Virtual Board Pinout (ESP32-style) ---
# Motors (FL, FR, RL, RR)
DEFAULT_MOTOR_PINS = [
    {"pwm": 12, "dir": 13},  # Motor 0: Front-Left
    {"pwm": 14, "dir": 15},  # Motor 1: Front-Right
    {"pwm": 16, "dir": 17},  # Motor 2: Rear-Left
    {"pwm": 18, "dir": 19},  # Motor 3: Rear-Right
]

# Kicker & Dribbler
DEFAULT_KICKER_PIN = 27
DEFAULT_DRIBBLER_PIN = 26

# Line Sensors (8 perimeter sensors spaced 45 deg, starting front=0 deg)
DEFAULT_LINE_PINS = [32, 33, 34, 35, 36, 37, 38, 39]

# Ball Sensors (Analog ADC)
DEFAULT_BALL_STRENGTH_PIN = 4
DEFAULT_BALL_BEARING_PIN = 5

# Directional IR photodiode ring (8 zones matching angles: 0, 45, 90, 135, 180, 225, 270, 315 deg)
# Must not collide with ANY other pin in this file - not just the other ADC
# categories. read_adc() picks the first matching category, so two sensors on
# one number silently shadow one of them; and a number shared with a motor or
# the kicker describes a board that cannot be built, because one physical pin
# cannot be both a direction output and a sensor input.
# `tests/test_config.py` enforces this across every category, actuators included.
DEFAULT_IR_RING_PINS = [0, 6, 7, 8, 23, 25, 1, 3]

# Analog Compass & Gyro
DEFAULT_COMPASS_PIN = 21
DEFAULT_GYRO_PIN = 22

# Ultrasonic Distance Sensors (Front, Back, Left, Right)
DEFAULT_ULTRASONIC_PINS = {
    "front": 2,
    "back": 10,
    "left": 9,
    "right": 11,
}

# Ball gate - the switch in the dribbler's mouth that closes when it has the
# ball. Named here rather than hardcoded in `Runtime.get_pin_value()`, where it
# used to live: a pin the config could not see was a pin the collision guard
# could not check, and a pin a team could not remap for their own board.
DEFAULT_BALL_GATE_PIN = 28

# Reset causes, for machine.reset_cause()
PWRON_RESET = 1
HARD_RESET = 2
WDT_RESET = 3
DEEPSLEEP_RESET = 4
SOFT_RESET = 5

# Standard I2C Addresses
I2C_ADDR_MPU6050 = 0x68
I2C_ADDR_BNO055 = 0x28
I2C_ADDR_IR_SEEKER = 0x1C
I2C_ADDR_VL53L0X = 0x29
