"""Compatibility entrypoint for explicit offline fixture smoke training."""

import sys

from .train import main

if __name__ == "__main__":
    if "--fast" not in sys.argv:
        sys.argv.append("--fast")
    main()
