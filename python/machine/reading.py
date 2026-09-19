"""Wrap a JSON sensor frame so it reads the way it would be written on paper."""

from __future__ import annotations

from typing import Any


class Reading:
    """Sensor data, as attributes.

    Wraps the JSON the server sent so that ``s.camera.goals.yellow.bearing``
    reads the way it would be written on paper. Anything the sensor did not
    see is ``None`` rather than missing, so a program can ask and get an
    honest answer.
    """

    __slots__ = ("_data",)

    def __init__(self, data: dict[str, Any]) -> None:
        object.__setattr__(self, "_data", data)

    def __getattr__(self, name: str) -> Any:
        data = object.__getattribute__(self, "_data")
        if name in data:
            return _wrap(data[name])
        # The wire is camelCase because it is shared with a browser; Python is
        # not. Accept either, so ``s.ball_gate.held`` and ``s.ballGate.held``
        # both work and nobody has to remember which side of the socket they
        # are on.
        camel = _camel(name)
        if camel in data:
            return _wrap(data[camel])
        raise AttributeError(
            f"no sensor called {name!r}; this robot has: " + ", ".join(sorted(data))
        )

    def __contains__(self, name: str) -> bool:
        return name in object.__getattribute__(self, "_data")

    def __repr__(self) -> str:
        return f"Reading({object.__getattribute__(self, '_data')!r})"


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(word.capitalize() for word in rest)


def _wrap(value: Any) -> Any:
    if isinstance(value, dict):
        return Reading(value)
    if isinstance(value, list):
        return [_wrap(item) for item in value]
    return value
