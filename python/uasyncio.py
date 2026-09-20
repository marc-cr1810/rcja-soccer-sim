"""MicroPython's `uasyncio` - CPython's `asyncio` under the name a board uses.

On a real board `uasyncio` and `asyncio` are the same module; the `u` prefix is
historical. Binding the name to the standard library here rather than
reimplementing it means a program that imports either spelling gets exactly
one implementation, and the simulator never has a subtly different `asyncio`
of its own to keep in step.
"""

import sys as _sys

import asyncio as _impl

#: The import machinery hands back whatever is in `sys.modules` once this
#: file finishes, so this *is* the module - `import uasyncio; uasyncio is asyncio` holds,
#: and every name works, not just the ones a `from ... import *` would copy.
_sys.modules[__name__] = _impl
