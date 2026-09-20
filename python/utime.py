"""MicroPython's `utime` - CPython's `time`, with the board functions on it.

`utime` and `time` are the same module on a board, and they are the same
module here: this file makes sure the MicroPython additions are installed and
then binds its own name to `time` itself.

That identity is not tidiness. This module used to do `from time import *`
*before* importing `machine`, which copied the unpatched `sleep` and kept it -
so `utime.sleep()` was CPython's blocking sleep and silently advanced nothing,
while `time.sleep()` did the right thing. Being the same object makes a whole
class of that bug impossible rather than fixed.
"""

import sys as _sys
import time as _time

from machine import _timebase

_timebase.install()

_sys.modules[__name__] = _time
