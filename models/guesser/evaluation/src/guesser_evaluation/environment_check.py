"""Smoke checks for the Guesser evaluation notebook environment."""

from __future__ import annotations

import platform
import sys
from importlib.metadata import version

import matplotlib
import numpy as np
import pandas as pd
from PIL import Image

import guesser_evaluation


def collect_environment() -> dict[str, object]:
    """Import the supported stack and exercise a small image/data operation."""
    # Fail early if Jupyter is using an unsupported Python interpreter.
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError(f"Expected Python 3.12, got {sys.version.split()[0]}")

    # Exercise grayscale image creation and conversion to a NumPy array.
    image = Image.new("L", (224, 224), color=255)
    pixels = np.asarray(image)
    if pixels.shape != (224, 224):
        raise RuntimeError(f"Unexpected image shape: {pixels.shape}")

    # Exercise tabular data creation using a small slice of the image.
    frame = pd.DataFrame({"pixel": pixels[0, :2]})
    if frame.shape != (2, 1):
        raise RuntimeError(f"Unexpected dataframe shape: {frame.shape}")

    # Report interpreter, platform, dependencies, and smoke-check shapes.
    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "os": platform.system(),
        "architecture": platform.machine(),
        "workspace_package": guesser_evaluation.__file__,
        "image_shape": pixels.shape,
        "dataframe_shape": frame.shape,
        "packages": {
            "ipykernel": version("ipykernel"),
            "jupyterlab": version("jupyterlab"),
            "matplotlib": matplotlib.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "pillow": version("pillow"),
        },
    }


def main() -> None:
    """Print the environment report when run as a module from the terminal."""
    from pprint import pprint

    pprint(collect_environment())


# Keep the smoke check runnable with `python -m guesser_evaluation.environment_check`.
if __name__ == "__main__":
    main()
