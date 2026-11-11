"""On-disk cache for preprocessed ten-stage evaluation views.

Rendering and preprocessing a view costs tens of milliseconds of CPU; scoring it
costs a fraction of a millisecond of GPU. Evaluation is deterministic and does
not depend on which weights are being scored, so the same view is rebuilt on
every run of the same split. This module stores those finished views once and
serves them on later runs.

Storage layout, one file per original::

    <root>/<recipe>/<split>/class-042/original-00007.bin

A file holds fixed-size stage records followed by the usable images:

    status     uint8   x stages   (0 ok, 1 blank, 2 uncertain)
    unchanged  uint8   x stages   (0/1)
    coverage   float32 x stages   (NaN when the view had none)
    images     uint8   x usable x height x width

One file per original is deliberate. A worker renders an entire original inside
a single dataset item, so it can publish that file atomically without agreeing
with the other workers about who owns which class. The recipe hash lives in the
directory name, so a changed split, preprocessing candidate or preprocessing
source writes a new tree instead of silently serving stale pixels.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import numpy as np

# Bump when the byte layout changes; it participates in the recipe hash.
CACHE_VERSION = 1

STATUS_CODES = {"ok": 0, "blank": 1, "uncertain": 2}
CODE_STATUSES = {code: name for name, code in STATUS_CODES.items()}


@dataclass(frozen=True)
class CachedViews:
    """One original's stored stages, already checked for structural validity.

    ``coverage`` entries may be None; they are stored as NaN because a view can
    be rendered before any coverage is computed.
    """

    statuses: tuple[str, ...]
    unchanged: tuple[bool, ...]
    coverage: tuple[float | None, ...]
    images: tuple[np.ndarray | None, ...]


class EvaluationViewCache:
    """Store and serve preprocessed evaluation views for one run configuration.

    Args:
        root: Parent directory holding one tree per recipe.
        recipe: JSON-serialisable facts that decide the pixels: split, candidate,
            preprocessing hashes, source digests and the cache format version.
        stages: Number of fixed time prefixes per original.
        image_size: Side length of the stored square images.
    """

    def __init__(
        self,
        root: Path,
        recipe: dict,
        *,
        stages: int,
        image_size: int,
    ) -> None:
        if stages < 1 or image_size < 1:
            raise ValueError("stages and image_size must be positive")
        self.root = root
        self.recipe = recipe
        self.stages = stages
        self.image_size = image_size
        self.digest = hashlib.sha256(
            json.dumps(
                {"version": CACHE_VERSION, **recipe},
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        self.directory = root / self.digest[:16]

    def path_for(self, split: str, class_id: int, local_index: int) -> Path:
        """Return the cache file for one original."""
        return (
            self.directory
            / split
            / f"class-{class_id:03d}"
            / f"original-{local_index:05d}.bin"
        )

    def _header_bytes(self) -> int:
        """Bytes used by the per-stage status, unchanged and coverage records."""
        return self.stages * (1 + 1 + 4)

    def load(
        self, split: str, class_id: int, local_index: int
    ) -> CachedViews | None:
        """Return cached views, or None when they are absent or unusable.

        A short or malformed file is treated as a miss rather than an error: it
        can only come from an interrupted write, and re-rendering repairs it.
        """
        path = self.path_for(split, class_id, local_index)
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        header = self._header_bytes()
        if len(raw) < header:
            return None

        statuses = np.frombuffer(raw, np.uint8, self.stages, 0)
        unchanged = np.frombuffer(raw, np.uint8, self.stages, self.stages)
        coverage = np.frombuffer(raw, np.float32, self.stages, self.stages * 2)
        usable = int(np.count_nonzero(statuses == STATUS_CODES["ok"]))
        expected = header + usable * self.image_size * self.image_size
        if len(raw) != expected:
            return None

        payload = np.frombuffer(
            raw, np.uint8, count=usable * self.image_size**2, offset=header
        ).reshape(usable, self.image_size, self.image_size)
        images: list[np.ndarray | None] = []
        cursor = 0
        for code in statuses:
            if CODE_STATUSES[int(code)] == "ok":
                images.append(payload[cursor])
                cursor += 1
            else:
                images.append(None)
        return CachedViews(
            statuses=tuple(CODE_STATUSES[int(code)] for code in statuses),
            unchanged=tuple(bool(value) for value in unchanged),
            coverage=tuple(
                None if np.isnan(value) else float(value) for value in coverage
            ),
            images=tuple(images),
        )

    def store(
        self,
        split: str,
        class_id: int,
        local_index: int,
        statuses: list[str],
        unchanged: list[bool],
        coverage: list[float | None],
        images: list[np.ndarray | None],
    ) -> None:
        """Publish one original's views atomically.

        The temporary file is renamed into place, so a run killed mid-write
        leaves either the previous entry or none, never a partial one.
        """
        if not len(statuses) == len(unchanged) == len(coverage) == len(images):
            raise ValueError("per-stage records must align")
        if len(statuses) != self.stages:
            raise ValueError(f"expected {self.stages} stages, got {len(statuses)}")

        payload = [
            np.ascontiguousarray(image, dtype=np.uint8)
            for image, status in zip(images, statuses)
            if status == "ok"
        ]
        for image in payload:
            if image.shape != (self.image_size, self.image_size):
                raise ValueError(
                    f"expected {self.image_size}x{self.image_size}, got {image.shape}"
                )

        header = np.empty(self._header_bytes(), dtype=np.uint8)
        header[0 : self.stages] = [STATUS_CODES[status] for status in statuses]
        header[self.stages : self.stages * 2] = [int(flag) for flag in unchanged]
        header[self.stages * 2 :] = np.asarray(
            [np.nan if value is None else value for value in coverage],
            dtype=np.float32,
        ).view(np.uint8)

        path = self.path_for(split, class_id, local_index)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.part")
        with temporary.open("wb") as sink:
            sink.write(header.tobytes())
            for image in payload:
                sink.write(image.tobytes())
        os.replace(temporary, path)

    def entries(self, split: str) -> int:
        """Count stored originals for a split; used to report cache coverage."""
        split_dir = self.directory / split
        if not split_dir.is_dir():
            return 0
        return sum(1 for _ in split_dir.glob("class-*/original-*.bin"))
