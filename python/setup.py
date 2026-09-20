"""Build shim, for one job: getting `rcja_soccer_bootstrap.pth` into site-packages.

Everything else about this package is declared in `pyproject.toml`; setuptools
merges that with whatever this file adds.

A `.pth` file only does anything when it sits in a *site* directory, and
setuptools has no declarative way to put one there. `[tool.setuptools]
data-files` was tried and does not work: it lands the file in
`<prefix>/rcja_soccer_bootstrap.pth`, verified by installing the built wheel
into a fresh venv, and Python never looks at it there. Copying it into
`build_lib` does work, because that is what becomes the wheel's purelib.

What the hook is for is in `rcja_soccer_bootstrap.py`; in short, it makes
`from time import sleep_ms` work on a program's first line, as it does on a
board.
"""

import os

from setuptools import setup
from setuptools.command.build_py import build_py

PTH = "rcja_soccer_bootstrap.pth"


class build_py_with_pth(build_py):
    def run(self) -> None:
        super().run()
        if self.dry_run:
            return
        self.mkpath(self.build_lib)
        self.copy_file(PTH, os.path.join(self.build_lib, PTH), preserve_mode=False)

    def get_outputs(self, include_bytecode: int = 1) -> list[str]:
        return [*super().get_outputs(include_bytecode), os.path.join(self.build_lib, PTH)]


setup(cmdclass={"build_py": build_py_with_pth})
