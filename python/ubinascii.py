"""MicroPython's `ubinascii` - CPython's `binascii` under the name a board uses.

On a real board `ubinascii` and `binascii` are the same module; the `u` prefix is
historical. Binding the name to the standard library here rather than
reimplementing it means a program that imports either spelling gets exactly
one implementation, and the simulator never has a subtly different `binascii`
of its own to keep in step.
"""

import sys as _sys

import binascii as _impl

#: The import machinery hands back whatever is in `sys.modules` once this
#: file finishes, so this *is* the module - `import ubinascii; ubinascii is binascii` holds,
#: and every name works, not just the ones a `from ... import *` would copy.
_sys.modules[__name__] = _impl
