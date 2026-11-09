"""Referee data tools and their public canvas reader."""

from typing import Any

IndexedCanvases: type[Any]
__all__ = ["IndexedCanvases"]


def __getattr__(name: str) -> type[Any]:
    if name == "IndexedCanvases":
        from .common import load_step

        return load_step("05-loader").IndexedCanvases
    raise AttributeError(name)
