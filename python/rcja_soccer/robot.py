"""Your robot.

A program is a function from what the sensors report to what the motors do,
called fifty times a second. There is no world here, no list of opponents and
no coordinates handed down from above — only what this robot can perceive, in
its own frame, the way a real one has it.

    from rcja_soccer import Robot, drive

    robot = Robot(team="violet", number=1, name="ACT")

    @robot.tick
    def think(s, me):
        if s.ball is None:
            return robot.coast()
        return robot.motors(drive(bearing=s.ball.bearing, speed=0.8))

    robot.run()
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable

from .drive import coast as _coast
from .transport import (
    Connect,
    TransportError,
    current_transport,
    join_token,
    join_url,
)

#: The wire contract this library speaks. The server refuses a mismatch, which
#: is a season boundary rather than a typo: the frame shape changed and this
#: program was written against the old one.
PROTOCOL_VERSION = 5

DEFAULT_URL = "ws://localhost:8080/agent"


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


class Memory:
    """Somewhere to keep things between ticks.

    A tick is called fifty times a second and gets no state of its own. Put
    anything the robot needs to remember here — where the ball was last seen,
    what it decided to do about it, how long it has been doing that — and it
    survives to the next one.

    Cleared at every kick-off, because a half should not start with the
    previous half's plan still in memory.
    """

    def __init__(self) -> None:
        self.__dict__["_store"] = {}

    def __getattr__(self, name: str) -> Any:
        try:
            return self.__dict__["_store"][name]
        except KeyError:
            raise AttributeError(
                f"nothing remembered under {name!r}. Set me.{name} first, or use "
                f"me.get({name!r}, default)"
            ) from None

    def __setattr__(self, name: str, value: Any) -> None:
        self.__dict__["_store"][name] = value

    def get(self, name: str, default: Any = None) -> Any:
        """What was remembered, or a default if this is the first time."""
        return self.__dict__["_store"].get(name, default)

    def __contains__(self, name: str) -> bool:
        return name in self.__dict__["_store"]

    def clear(self) -> None:
        self.__dict__["_store"].clear()


TickFunction = Callable[[Reading, Memory], dict]


class Robot:
    """One robot, connected to a match server."""

    def __init__(
        self,
        team: str | None = None,
        number: int | None = None,
        name: str | None = None,
        *,
        motors: int = 4,
        token: str | None = None,
    ) -> None:
        if team is None or number is None:
            # Check sys.argv for flags
            args = sys.argv[1:] if len(sys.argv) > 1 else []
            i = 0
            while i < len(args):
                arg = args[i]
                if arg == "--team" and i + 1 < len(args) and team is None:
                    team = args[i + 1]
                    i += 2
                elif arg == "--number" and i + 1 < len(args) and number is None:
                    try:
                        number = int(args[i + 1])
                    except ValueError:
                        pass
                    i += 2
                elif arg == "--name" and i + 1 < len(args) and name is None:
                    name = args[i + 1]
                    i += 2
                elif arg == "--token" and i + 1 < len(args) and token is None:
                    token = args[i + 1]
                    i += 2
                else:
                    i += 1

        team = team if team is not None else "violet"
        number = number if number is not None else 1

        if team not in ("violet", "lime"):
            raise ValueError(f'team must be "violet" or "lime", not {team!r}')
        if number not in (1, 2):
            raise ValueError(f"number must be 1 or 2, not {number!r}")
        self.team = team
        self.number = number
        self.name = name or team.capitalize()
        self.motor_count = motors
        #: Server-issued when this robot was pushed and validated, or minted
        #: for one seat on a practice field and installed by ``join.py``. A
        #: robot run without one (any --agents/local-dev use) joins exactly as
        #: it always has — a seat only requires a token if the server was told
        #: to expect one for it.
        #:
        #: An explicit token always wins over an installed one: a program that
        #: says something should not be quietly overruled by its launcher.
        self.token = token if token is not None else join_token()
        self._tick: TickFunction | None = None
        self._memory = Memory()
        self._last_kickoff = False
        #: Whether this robot is currently off the field under rule 5.7, so
        #: that being sent off is mentioned once rather than every second.
        self._off = False
        #: When this robot was last actually in a match. Reconnecting is
        #: measured from here, so any number of server restarts is fine as
        #: long as the robot gets back in between them.
        self._last_connected = time.monotonic()

    # -- writing a program -------------------------------------------------

    def tick(self, function: TickFunction) -> TickFunction:
        """Register the function that decides what to do. Use as a decorator."""
        self._tick = function
        return function

    def motors(
        self,
        powers: list[float],
        dribbler: float = 0.0,
        kicker: bool = False,
        say: Any = None,
    ) -> dict:
        """Drive the motors, and optionally the dribbler and kicker.

        Powers outside -1..1 are clamped by the server rather than refused, the
        same as a motor driver would. ``say`` is broadcast to the other robot on
        your team under rule 4.2.5; it must be JSON, and it expires after 0.4
        seconds, so it is for "I have the ball", not for a plan.
        """
        command: dict[str, Any] = {"motors": list(powers)}
        if dribbler:
            command["dribbler"] = dribbler
        if kicker:
            command["kicker"] = True
        if say is not None:
            command["say"] = say
        return command

    def coast(self, dribbler: float = 0.0) -> dict:
        """Motors off. The robot rolls to a stop; it does not brake."""
        return self.motors(_coast(), dribbler=dribbler)

    # -- running it --------------------------------------------------------

    def run(
        self,
        url: str = DEFAULT_URL,
        *,
        reconnect: bool = True,
        reconnect_for: float = 120.0,
        quiet: bool = False,
        connect: Connect | None = None,
    ) -> None:
        """Connect to a match server and play until it stops.

        Reconnects by default, because a practice session should survive the
        server being restarted and because a team debugging should not have to
        restart four programs every time.

        :param reconnect_for: How long to keep retrying with nothing answering,
            in seconds. The clock restarts every time the robot actually gets
            into a match, so a session survives as many restarts as you like;
            what it will not do is retry a port that is never coming back.

            That is not a tidiness preference. A harness that spawns robots
            detached - which is how you stop them dying with the shell that
            started them - cannot clean up if it is itself killed rather than
            asked to stop, and ``timeout``, ctrl-c and a supervisor all kill.
            A robot that retries for ever then sits on the machine until it is
            noticed, and the next measurement is taken against whatever those
            leftovers are doing to the load. Give up eventually and the leak
            has no way to happen, whatever became of the parent.

        :param connect: How to open the connection, for a test that would
            rather not open a socket. A host embedding this library wants
            :func:`~rcja_soccer.transport.use_transport` instead — it reaches
            programs that never pass this argument, which is all of them.
        """
        if self._tick is None:
            raise RuntimeError(
                "no tick function. Decorate one with @robot.tick before run()."
            )

        opener = connect or current_transport()
        # The same fallback rule as the token, and the same reason: a program
        # that passed its own url meant it. ``DEFAULT_URL`` is not a choice —
        # it is what every starter file and every example carries because
        # nobody has told them where the match is.
        if url == DEFAULT_URL:
            url = join_url() or url
        self._last_connected = time.monotonic()
        while True:
            try:
                self._play(url, quiet, opener)
            except (TransportError, OSError) as error:
                if not reconnect:
                    raise
                idle = time.monotonic() - self._last_connected
                if idle > reconnect_for:
                    if not quiet:
                        print(
                            f"[{self.name}/{self.number}] nothing answering at {url} "
                            f"for {idle:.0f}s; stopping",
                            file=sys.stderr,
                        )
                    return
                if not quiet:
                    print(f"[{self.name}/{self.number}] {error}; retrying", file=sys.stderr)
                time.sleep(1.0)
            except KeyboardInterrupt:
                return

    def _play(self, url: str, quiet: bool, connect: Connect) -> None:
        socket = connect(url)
        try:
            join_message: dict[str, Any] = {
                "type": "join",
                "protocol": PROTOCOL_VERSION,
                "team": self.team,
                "robot": self.number,
                "name": self.name,
            }
            if self.token is not None:
                join_message["token"] = self.token
            socket.send(json.dumps(join_message))

            hello = json.loads(socket.recv())
            if hello.get("type") == "reject":
                raise TransportError(f"server refused: {hello.get('reason')}")
            if hello.get("type") != "welcome":
                raise TransportError(f"unexpected reply: {hello!r}")
            self.motor_count = hello.get("motors", self.motor_count)
            if not quiet:
                print(f"[{self.name}] {hello['robot']} connected to {url}", file=sys.stderr)

            # In a match: whatever went wrong before does not count against
            # the reconnect budget any more.
            self._last_connected = time.monotonic()
            self._memory.clear()
            self._last_kickoff = False
            self._off = False

            while True:
                message = json.loads(socket.recv())

                # Off the field under rule 5.7. No sensors come while this is
                # true and the tick function does not run, because there is
                # nothing to decide: the robot is in somebody's hands beside
                # the pitch. Saying so once is the difference between "my robot
                # froze" and "my robot was sent off", which is a lot of a
                # student's afternoon.
                #
                # Older programs ignore this message without knowing what it
                # is, which was always the point: it is what keeps the socket
                # from going quiet for the whole stand-down.
                if message.get("type") == "disabled":
                    if not self._off:
                        self._off = True
                        if not quiet:
                            seconds = message.get("returnsIn", 0)
                            back = f"; back in {seconds:.0f}s" if seconds else ""
                            print(
                                f"[{self.name}/{self.number}] off the field under rule "
                                f"{message.get('rule', '5.7')} "
                                f"({message.get('reason', 'no reason given')}){back}",
                                file=sys.stderr,
                            )
                    continue

                if message.get("type") != "sensors":
                    continue

                frame = message["frame"]

                # Put back on, at a corner of your own penalty box (5.7.4).
                #
                # Your memory is NOT cleared for you, and that is a decision
                # rather than an oversight. Both habits are real: a team that
                # switches the robot off and on again restarts its software
                # from scratch, and a team with a start/stop button leaves it
                # running so it carries on with what it knew. This program was
                # never stopped, so it is the second kind - if you want the
                # first, call ``me.clear()`` when ``s.returned`` is true.
                if frame.get("returned"):
                    self._off = False
                    if not quiet:
                        print(
                            f"[{self.name}/{self.number}] back on the field",
                            file=sys.stderr,
                        )

                # A kick-off is a fresh start: whatever the robot was chasing
                # before is no longer where it was.
                pending = frame.get("kickoff", {}).get("pending", False)
                if pending and not self._last_kickoff:
                    self._memory.clear()
                self._last_kickoff = pending

                assert self._tick is not None
                try:
                    command = self._tick(Reading(frame), self._memory)
                except Exception as error:  # noqa: BLE001
                    # A program that throws keeps its last command standing, the
                    # same as a real robot whose loop has hung. Say so once per
                    # tick rather than dying, because a crash in the second half
                    # should not end the match.
                    if not quiet:
                        print(f"[{self.name}/{self.number}] {error!r}", file=sys.stderr)
                    continue

                if command is None:
                    continue
                socket.send(json.dumps({"type": "command", "frame": command}))
        finally:
            # A channel is closed even when the match ended badly, because the
            # reconnect loop above is about to open another one.
            socket.close()
