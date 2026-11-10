"""Smoke checks for the Referee evaluation notebook environment."""

from __future__ import annotations

import platform
import sys
from importlib.metadata import version

import matplotlib
import numpy as np
import pandas as pd
from PIL import Image

import referee_evaluation


def collect_environment() -> dict[str, object]:
    """Import the notebook stack and exercise small image/data operations."""
    # Fail early if Jupyter is using an unsupported Python interpreter.
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError(f"Expected Python 3.12, got {sys.version.split()[0]}")

    # Exercise grayscale image creation and conversion to a NumPy array.
    image = Image.new("L", (224, 224), color=255)
    pixels = np.asarray(image)
    if pixels.shape != (224, 224):
        raise RuntimeError(f"Unexpected image shape: {pixels.shape}")

    # Exercise tabular data creation without touching model or dataset files.
    frame = pd.DataFrame({"pixel": pixels[0, :2]})
    if frame.shape != (2, 1):
        raise RuntimeError(f"Unexpected dataframe shape: {frame.shape}")

    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "os": platform.system(),
        "architecture": platform.machine(),
        "workspace_package": referee_evaluation.__file__,
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
    """Print the environment report when run as a module."""
    from pprint import pprint

    pprint(collect_environment())


if __name__ == "__main__":
    main()
