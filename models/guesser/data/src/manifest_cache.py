"""Build immutable, uncompressed Arrow IPC manifests for OS-shared random access."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .common import DataError

CACHE_VERSION = 1


def source_identity(path: Path) -> tuple:
    """Identify one source generation without reading drawing payloads."""
    stat = path.stat()
    return (
        str(path.resolve()),
        stat.st_size,
        stat.st_mtime_ns,
        stat.st_ctime_ns,
        stat.st_ino,
        stat.st_dev,
    )


def check_source(path: Path, identity: tuple) -> None:
    """Reject replacement during construction or reopening rather than misindex."""
    if source_identity(path) != identity:
        raise DataError(
            "Indexed manifest changed; recreate loader and audit package",
            "audit_failed",
        )


def prepare_manifest_cache(
    source_path: Path, cache_dir: Path, identity: tuple, schema: pa.Schema
) -> Path:
    """Publish a batched IPC snapshot under a serialized cross-process build lock.

    The SQLite transaction releases automatically on process death. Readers only
    see a complete renamed file; failures remove this build's temporary output.
    """
    # Bind location, source generation, format version and every column's schema.
    key = hashlib.sha256(
        json.dumps([CACHE_VERSION, identity]).encode() + schema.serialize().to_pybytes()
    ).hexdigest()
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / f"{key}.arrow"
    check_source(source_path, identity)
    if target.exists():
        return target
    # Serialize conversion, not reads: competing cold workers cannot each decode
    # the split. A long timeout permits a full production manifest on slow disks.
    with (
        closing(
            sqlite3.connect(cache_dir / "manifest-build.sqlite3", timeout=300)
        ) as lock,
        lock,
    ):
        lock.execute("BEGIN IMMEDIATE")
        check_source(source_path, identity)
        if target.exists():
            return target
        with tempfile.NamedTemporaryFile(
            dir=cache_dir, suffix=".tmp", delete=False
        ) as f:
            temporary = Path(f.name)
        try:
            # Bound decoded buffers to one batch; never read/combine the full table.
            with pq.ParquetFile(source_path) as source:
                if not source.schema_arrow.equals(schema, check_metadata=True):
                    raise DataError("Indexed manifest changed schema", "audit_failed")
                with pa.OSFile(str(temporary), "wb") as sink:
                    with pa.ipc.new_file(sink, schema) as writer:
                        for batch in source.iter_batches(
                            batch_size=16384, use_threads=False
                        ):
                            writer.write_batch(batch)
            check_source(source_path, identity)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return target
