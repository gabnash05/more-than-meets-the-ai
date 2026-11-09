"""Identity and strict read-only access for immutable training views."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
from guesser_data import settings

if __package__:
    from .render_cache import decode_sample
else:
    from render_cache import decode_sample

FORMAT = 1
SCHEMA = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE views (
    arm TEXT NOT NULL CHECK(arm IN ('a', 'b')),
    epoch INTEGER NOT NULL CHECK(epoch >= 0),
    sample_index INTEGER NOT NULL CHECK(sample_index >= 0),
    metadata TEXT NOT NULL, image BLOB NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY (arm, epoch, sample_index)
) WITHOUT ROWID;
"""


def source_fingerprint(prepared: Path) -> str:
    """Identify the train manifest, referenced files, and rendering recipe."""
    root = Path(prepared).resolve()
    # Hash only the train manifest and scan record names in bounded batches;
    # held-out payloads never participate in training cache preparation.
    manifest = root / "manifests" / "train.parquet"
    if not manifest.resolve().is_relative_to(root):
        raise ValueError("Training manifest escapes prepared directory")
    with manifest.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    names: set[str] = set()
    with pq.ParquetFile(manifest) as parquet:
        for batch in parquet.iter_batches(columns=["record_file"], use_threads=False):
            for name in batch.column(0).to_pylist():
                if not isinstance(name, str) or not name:
                    raise ValueError("Invalid record path")
                names.add(name)
    # Resolve paths before stat, rejecting escapes and binding replacements.
    # Exclude atime: ordinary reads must not invalidate this derived artifact.
    records = []
    for name in sorted(names):
        path = (root / name).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Record path escapes prepared directory")
        stat = path.stat()
        records.append(
            [
                name,
                str(path),
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            ]
        )
    data_root = Path(settings.__file__).resolve().parent
    training_root = Path(__file__).resolve().parent
    paths = [
        data_root / name
        for name in ("05-loader.py", "06-images.py", "settings.py", "common.py")
    ]
    paths += [
        training_root / name
        for name in ("dataset.py", "epoch_cache.py", "render_cache.py")
    ]
    recipe = {
        "format": FORMAT,
        "prepared": str(root),
        "train_manifest_sha256": digest,
        "records": records,
        "python": list(sys.version_info[:2]),
        "platform": [sys.platform, platform.machine(), sys.byteorder],
        "versions": {
            name: importlib.metadata.version(name)
            for name in (
                "numpy",
                "pillow",
                "opencv-python-headless",
                "pyarrow",
                "torch",
                "torchvision",
            )
        },
        "code": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths
        },
        "view_seed": settings.SEED,
        "preprocess": settings.PREPROCESS_DEFAULTS,
    }
    # Canonical JSON binds source identity, implementation and dependencies;
    # a changed recipe cannot silently reuse old normalized pixels.
    return hashlib.sha256(
        json.dumps(
            recipe, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


class EpochViewReader:
    """Read finalized views using a process-local, read-only SQLite connection."""

    def __init__(
        self, bundle: Path, *, fingerprint: str, candidate: str, sample_count: int
    ) -> None:
        self.path = (Path(bundle) / "views.sqlite3").resolve()
        if not self.path.is_file():
            raise FileNotFoundError(self.path)
        self.fingerprint = fingerprint
        self.candidate = candidate
        self.sample_count = sample_count
        self.descriptor: dict[str, Any] | None = None
        self._connection: sqlite3.Connection | None = None
        self._pid: int | None = None
        self._open()
        self.close()

    def _open(self) -> sqlite3.Connection:
        """Reopen read-only after process boundaries and validate immutable coverage."""
        if self._connection is not None and self._pid == os.getpid():
            return self._connection
        self.close()
        # Discard inherited connections before reopening. mode=ro prevents
        # creation; immutable requires callers to retain the published file.
        connection = sqlite3.connect(
            self.path.as_uri() + "?mode=ro&immutable=1", uri=True
        )
        try:
            connection.execute("PRAGMA cache_size=-2048")
            row = connection.execute(
                "SELECT value FROM metadata WHERE key='descriptor'"
            ).fetchone()
            if row is None:
                raise ValueError("Missing training-view descriptor")
            descriptor = json.loads(row[0])
            if not isinstance(descriptor, dict):
                raise TypeError("Invalid training-view descriptor")
            arms, epochs = descriptor.get("arms"), descriptor.get("epochs")
            if (
                type(self.sample_count) is not int
                or self.sample_count <= 0
                or type(descriptor.get("format")) is not int
                or descriptor["format"] != FORMAT
                or descriptor.get("complete") is not True
                or descriptor.get("fingerprint") != self.fingerprint
                or descriptor.get("candidate") != self.candidate
                or type(descriptor.get("sample_count")) is not int
                or descriptor["sample_count"] != self.sample_count
                or not isinstance(arms, list)
                or not arms
                or any(type(arm) is not str or arm not in ("a", "b") for arm in arms)
                or arms != sorted(set(arms))
                or not isinstance(epochs, list)
                or not epochs
                or any(type(epoch) is not int or epoch < 0 for epoch in epochs)
                or epochs != sorted(set(epochs))
                or type(descriptor.get("entry_count")) is not int
                or descriptor["entry_count"]
                != self.sample_count * len(arms) * len(epochs)
                or (self.descriptor is not None and self.descriptor != descriptor)
            ):
                raise ValueError("Invalid or incompatible training-view descriptor")
        except BaseException:
            connection.close()
            raise
        self.descriptor = descriptor
        self._connection = connection
        self._pid = os.getpid()
        return connection

    def require(self, arm: str, epoch: int) -> None:
        """Check requested coverage before loading samples."""
        self._open()
        assert self.descriptor is not None
        if (
            type(arm) is not str
            or type(epoch) is not int
            or arm not in self.descriptor["arms"]
            or epoch not in self.descriptor["epochs"]
        ):
            raise ValueError("Training-view bundle lacks requested coverage")

    def _get(self, arm: str, epoch: int, index: int, channels: int) -> dict[str, Any]:
        """Require a covered key and verify its bytes before bounded decoding."""
        if type(index) is not int or not 0 <= index < self.sample_count:
            raise IndexError(index)
        self.require(arm, epoch)
        row = (
            self._open()
            .execute(
                "SELECT metadata,image,digest FROM views WHERE arm=? AND epoch=? AND sample_index=?",
                (arm, epoch, index),
            )
            .fetchone()
        )
        if row is None:
            raise ValueError("Missing training-view row")
        metadata, image, digest = row
        # Missing/corrupt views are errors, not blank drawings eligible for the
        # original fallback policy. Verify compressed bytes before decoding.
        if (
            not isinstance(metadata, str)
            or not isinstance(image, bytes)
            or not isinstance(digest, str)
            or hashlib.sha256(metadata.encode() + image).hexdigest() != digest
        ):
            raise ValueError("Corrupt training-view row")
        return decode_sample(metadata, image, channels=channels)

    def get(self, arm: str, epoch: int, index: int) -> dict[str, Any]:
        """Return a detached three-channel sample."""
        return self._get(arm, epoch, index, 3)

    def get_channel(self, arm: str, epoch: int, index: int) -> dict[str, Any]:
        """Return a detached single-channel sample."""
        return self._get(arm, epoch, index, 1)

    def close(self) -> None:
        """Close this process's reader connection."""
        connection = getattr(self, "_connection", None)
        if connection is not None:
            connection.close()
        self._connection = None
        self._pid = None

    def __getstate__(self) -> dict[str, Any]:
        """Serialize only configuration; workers reopen their own connection."""
        state = dict(self.__dict__)
        state.update(_connection=None, _pid=None)
        return state

    def __del__(self) -> None:
        """Release native SQLite handles even when cyclic GC is deferred."""
        self.close()
