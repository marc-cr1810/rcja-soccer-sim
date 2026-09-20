"""Startup hook for a pip-installed copy, run from `rcja_soccer_bootstrap.pth`.

Same job as `sitecustomize.py` does for a checkout of this repository: put the
MicroPython time API onto `time` before any user code runs, so
`from time import sleep_ms` works on a program's first line the way it does on
a board. A `.pth` is used here rather than a second `sitecustomize.py`,
because site-packages is exactly where somebody else's `sitecustomize` is
likely to already live, and only one of them would ever be imported.

Must never raise: this runs in every interpreter the package is installed
into, whether or not a simulator is anywhere nearby.
"""

try:
    from machine import _timebase as _rcja_timebase

    _rcja_timebase.install()
except Exception:  # pragma: no cover - a broken hook must never break python
    pass
