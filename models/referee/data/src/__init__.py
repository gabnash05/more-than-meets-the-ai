"""Public Referee canvas and data-audit interfaces."""

from pathlib import Path
from typing import Any

from PIL import Image

from .common import DataError, load_step

IndexedCanvases: type[Any]

__all__ = [
    "DataError",
    "IndexedCanvases",
    "preprocess",
    "preprocessing_config",
    "preprocessing_hash",
    "preflight",
]


def __getattr__(name: str) -> Any:
    if name == "IndexedCanvases":
        return load_step("05-loader").IndexedCanvases
    raise AttributeError(name)


def preprocess(image: Image.Image) -> dict:
    return load_step("06-images").preprocess(image)


def preprocessing_config() -> dict:
    return load_step("06-images").preprocessing_config()


def preprocessing_hash() -> str:
    return load_step("06-images").preprocessing_hash()


def preflight(prepared_dir: str | Path, production: bool = True) -> dict:
    return load_step("04-export").preflight(prepared_dir, production=production)
