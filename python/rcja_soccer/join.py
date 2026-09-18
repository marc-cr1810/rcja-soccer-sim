"""Module entrypoint for rcja-join."""

from __future__ import annotations

import sys
from pathlib import Path

# Support running as a package or installed console script
try:
    from ..join import main
except (ImportError, ValueError):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from join import main

if __name__ == "__main__":
    main()
