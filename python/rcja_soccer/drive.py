"""Turning "go that way, face that way" into four wheel powers.

This is library code on purpose, and it is deliberately the simple version.

A team needs something that moves on day one, or the first afternoon is spent
on trigonometry rather than on football. But it should also be obvious, once
someone wants to win, that there is room above it: there is no acceleration
limit here, no compensation for a wheel that is slipping, and the normalisation
is the blunt kind. All of that is worth writing yourself, and none of it is
hidden from you.

Read it. Copy it. Replace it.
"""

from __future__ import annotations

import math

#: Where each wheel drives, in robot-frame radians. Four omni wheels mounted at
#: 45, 135, 225 and 315 degrees, each driving tangentially — the layout nearly
#: every Open and Lightweight team converges on, because it is the cheapest
#: arrangement that can translate in any direction while turning.
WHEEL_AXES = (
    math.radians(45),
    math.radians(135),
    math.radians(225),
    math.radians(315),
)


def drive(bearing: float = 0.0, speed: float = 1.0, spin: float = 0.0) -> list[float]:
    """Four motor powers.

    :param bearing: Direction to travel, robot-frame radians. 0 is straight
        ahead, positive turns towards the robot's left.
    :param speed: 0 to 1. How much of what the drive has to spend on going
        there.
    :param spin: -1 to 1. Turn while travelling. Positive turns left.

    Speed and spin compete for the same four motors. Ask for both at full and
    you get neither at full — everything scales down together, which keeps the
    robot going where it was pointed, just slower. Clipping each motor on its
    own instead would bend the path, and that is a bug teams spend a weekend
    finding.

    Note that ``speed=1`` does not mean the same top speed in every direction,
    and no mixing can make it: a wheel saturates at its own free speed, so the
    drive is about 1.4 times quicker between two wheel axes than along one.
    Forward is one of the quick ones.
    """
    dx = math.cos(bearing)
    dz = math.sin(bearing)

    # How much each wheel contributes to going that way.
    direction = [dx * math.cos(axis) + dz * math.sin(axis) for axis in WHEEL_AXES]
    spread = max((abs(value) for value in direction), default=1.0) or 1.0

    # Every tangential wheel turns the same way to spin the robot, so spin is
    # simply added to all four.
    combined = [value / spread * speed + spin for value in direction]

    peak = max([1.0] + [abs(value) for value in combined])
    return [value / peak for value in combined]


def coast() -> list[float]:
    """Motors off. The robot rolls to a stop; it does not brake."""
    return [0.0, 0.0, 0.0, 0.0]


def clamp(value: float, low: float, high: float) -> float:
    """Keep a number inside a range."""
    return max(low, min(high, value))


def wrap_angle(angle: float) -> float:
    """Fold an angle into -pi..pi, so headings can be compared and subtracted."""
    return (angle + math.pi) % (2 * math.pi) - math.pi
