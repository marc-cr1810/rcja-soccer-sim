"""Our robot.

Drives at the ball and nothing else. It is deliberately not good - beating it
should be the first afternoon's work - but it is complete, legal, and made
entirely of things a real robot has. Change a number and watch what that did.

Everything it knows comes from `board.py`, which is the file that owns the pin
numbers. Everything it does goes back through the same place. There is no
framework here and nothing is hidden: `while True`, read, decide, drive, sleep.

When you want to know *where you are* rather than just where the ball is, the
`rcja_soccer` library has that - a locator that fuses the sonar and the camera,
a ball tracker, and the frame that stops your code getting the two ends of the
field the wrong way round. It is optional, and this file does not use it.
"""

import math
import time

from board import Board

board = Board()

#: Four omni wheels at 45, 135, 225 and 315 degrees, each driving tangentially.
WHEEL_AXES = (math.pi / 4, 3 * math.pi / 4, 5 * math.pi / 4, 7 * math.pi / 4)


def drive(bearing, speed, spin=0.0):
    """Four wheel powers that send the robot `bearing`-wards while turning `spin`.

    Speed and spin compete for the same four motors, so asking for both at full
    gets you neither at full - everything scales down together, which keeps the
    robot going where it was pointed, just slower. Clipping each motor on its
    own instead would bend the path.
    """
    along = [
        math.cos(bearing) * math.cos(axis) + math.sin(bearing) * math.sin(axis)
        for axis in WHEEL_AXES
    ]
    spread = max(abs(value) for value in along) or 1.0
    mixed = [value / spread * speed + spin for value in along]
    peak = max([1.0] + [abs(value) for value in mixed])
    return [value / peak for value in mixed]


while True:
    s = board.read()

    if not s.playing:
        # Nobody has pressed start, or the referee has stopped the game.
        board.coast()

    elif s.ball is None:
        # The infrared ring cannot see the ball at all - which usually means a
        # robot is standing between you and it, not that it is far away. Turn
        # and look rather than sitting still.
        board.apply(motors=drive(0.0, 0.0, spin=0.3), dribbler=0.0)

    else:
        # Drive straight at it and run the dribbler so it sticks. Driving
        # *straight* at it is the thing to fix first: it pushes the ball
        # wherever you happen to be coming from, which is how a robot scores at
        # its own end. Come round the side instead.
        board.apply(motors=drive(s.ball.bearing, 0.8), dribbler=1.0)

        # The gate says the ball is in the dribbler's mouth. The kicker needs
        # time to charge, and will not tell you when it is ready.
        if s.ball_gate.held:
            board.kick()

    # Sends everything above and waits for the next tick's sensors. A loop that
    # never sleeps never sends anything at all.
    time.sleep_ms(20)
