"""Bounded, transactional SQLite storage for deterministic validation views."""

from __future__ import annotations

import json
import sqlite3
import zlib
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

import numpy as np


def encode_sample(sample: dict[str, Any]) -> tuple[str, bytes]:
    """Encode identical float32 channels in the existing validation layout."""
    metadata = dict(sample)
    image = metadata.pop("image", None)
    if image is None:
        metadata["_cache_shape"] = None
        payload = b""
    else:
        if (
            not isinstance(image, np.ndarray)
            or image.dtype != np.float32
            or image.ndim != 3
            or image.shape[0] != 3
            or min(image.shape[1:]) <= 0
        ):
            raise ValueError("Cache requires three identical float32 channels")
        raw = image[0].tobytes()
        if image[1].tobytes() != raw or image[2].tobytes() != raw:
            raise ValueError("Cache requires bitwise-identical channels")
        metadata["_cache_shape"] = list(image.shape[1:])
        payload = zlib.compress(raw)
    return json.dumps(metadata, allow_nan=False), payload


def decode_sample(
    metadata: str, payload: bytes, *, channels: int = 3
) -> dict[str, Any]:
    """Decode a detached image with bounded decompression and strict layout checks."""
    if channels not in (1, 3):
        raise ValueError("Unsupported channel count")
    sample = json.loads(metadata)
    if not isinstance(sample, dict) or "_cache_shape" not in sample:
        raise ValueError("Invalid cached metadata")
    shape = sample.pop("_cache_shape")
    if shape is None:
        if payload:
            raise ValueError("Image-less cache entry contains image bytes")
        sample["image"] = None
        return sample
    if (
        not isinstance(shape, list)
        or len(shape) != 2
        or any(type(n) is not int or n <= 0 for n in shape)
    ):
        raise ValueError("Invalid cached image shape")
    size = shape[0] * shape[1] * 4
    if size > 64 * 1024 * 1024:
        raise ValueError("Cached image exceeds decode limit")
    decompressor = zlib.decompressobj()
    raw = decompressor.decompress(payload, size + 1)
    if (
        len(raw) != size
        or not decompressor.eof
        or decompressor.unused_data
        or decompressor.unconsumed_tail
    ):
        raise ValueError("Invalid cached image payload")
    channel = np.frombuffer(raw, dtype=np.float32).reshape(shape)
    sample["image"] = np.repeat(channel[None, :, :], channels, axis=0)
    return sample


class RenderCache:
    """Store lossless single-channel float32 views within a payload byte budget.

    Connections are short-lived and never cross worker boundaries. SQLite rolls
    back interrupted writes; database/permission/corruption errors remain visible.
    """

    def __init__(self, root: Path, max_bytes: int) -> None:
        """Create the shared cache database; reject nonpositive budgets."""
        if max_bytes <= 0:
            raise ValueError("cache_max_bytes must be positive")
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "validation.sqlite3"
        self.max_bytes = max_bytes
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS views ("
                "sequence INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, "
                "metadata TEXT NOT NULL, image BLOB NOT NULL, size INTEGER NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, bytes INTEGER)"
            )
            connection.execute("INSERT OR IGNORE INTO usage VALUES (1, 0)")
            used = connection.execute("SELECT bytes FROM usage WHERE id=1").fetchone()[
                0
            ]
            used = self._evict(connection, used, 0)
            connection.execute("UPDATE usage SET bytes=? WHERE id=1", (used,))

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """Open a bounded page cache with a timeout for other worker writers."""
        with closing(sqlite3.connect(self.path, timeout=60)) as connection:
            connection.execute("PRAGMA cache_size=-2048")
            with connection:
                yield connection

    def _evict(self, connection: sqlite3.Connection, used: int, incoming: int) -> int:
        """Remove oldest rows until the new payload fits; return remaining usage."""
        while used + incoming > self.max_bytes:
            sequence, old_size = connection.execute(
                "SELECT sequence, size FROM views ORDER BY sequence LIMIT 1"
            ).fetchone()
            connection.execute("DELETE FROM views WHERE sequence=?", (sequence,))
            used -= old_size
        return used

    def get(self, key: str) -> dict[str, Any] | None:
        """Return a detached sample, or None on a cache miss."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT metadata, image FROM views WHERE key=?", (key,)
            ).fetchone()
        if row is None:
            return None
        return decode_sample(row[0], row[1])

    def put(self, key: str, sample: dict[str, Any]) -> None:
        """Publish a sample if space remains, retaining reusable rows when full."""
        encoded, payload = encode_sample(sample)
        size = len(payload) + len(encoded.encode()) + len(key.encode())
        if size > self.max_bytes:
            return
        # A single writer transaction makes accounting and publication indivisible.
        # Keep the admitted subset when full: FIFO/LRU would miss on every sample
        # of repeated sequential validation passes larger than the cache budget.
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM views WHERE key=?", (key,)).fetchone():
                return
            used = connection.execute("SELECT bytes FROM usage WHERE id=1").fetchone()[
                0
            ]
            if used + size > self.max_bytes:
                return
            connection.execute(
                "INSERT INTO views(key, metadata, image, size) VALUES (?, ?, ?, ?)",
                (key, encoded, payload, size),
            )
            connection.execute("UPDATE usage SET bytes=? WHERE id=1", (used + size,))
