"""Install the MicroPython time API before any user code runs.

A real board has `time.sleep_ms`, `time.ticks_ms` and the rest built in, so
`from time import sleep_ms` works on line one of `main.py`. Here they have to
be attached to CPython's `time` module by something, and if that something is
`import machine`, then import *order* becomes load-bearing: a file whose first
line is `from time import sleep_ms` raises ImportError before `machine` has
had a chance to run, and the failure surfaces as an unexplained "did not
connect" rather than as anything to do with imports.

CPython imports `sitecustomize` at startup from anywhere on `sys.path`, and
every way this project runs a robot puts `python/` there: the match sandbox
sets `PYTHONPATH=<repo>/python` (`packages/server/src/match/sandbox.ts`) and
passes no `-S`, and the documented local form is `cd python && PYTHONPATH=.
python3 ...`. So the patch lands before the first student line either way.

Anything in here runs in *every* interpreter that can see this directory,
including ones with no simulator anywhere near them - `python3 -c "..."` from
the repo, a linter, an editor's language server. So it does the least possible
and refuses to fail: an interpreter that cannot import `machine` for any
reason must still start normally.
"""

try:
    from machine import _timebase as _rcja_timebase

    _rcja_timebase.install()
except Exception:  # pragma: no cover - a broken hook must never break python
    pass
