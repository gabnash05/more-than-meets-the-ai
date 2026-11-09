"""Indexed drawing access with optional OS-shared manifests; no model dependency."""

from __future__ import annotations

import hashlib
import json
import os
import random
from collections import OrderedDict
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pyarrow as pa

from .common import DataError, load_step
from .manifest_cache import check_source, prepare_manifest_cache, source_identity
from .settings import (
    BLANK_RETRIES,
    COMPLETE_PROBABILITY,
    DEFAULT_PREPROCESSOR,
    EVALUATION_FRACTIONS,
    PARTIAL_MAX,
    PARTIAL_MIN,
    PREPROCESS_DEFAULTS,
    SEED,
)

_images = load_step("06-images")
cut_prefix = _images.cut_prefix
preprocess = _images.preprocess
render_qd = _images.render_qd


class IndexedDrawings:
    """Seek records using a compact Arrow manifest and PID-local record handles.

    Supply the prepared/ folder of a prepared dataset. The model consumes only the
    resulting image and class_id; raw record metadata are for auditing.

    Flow: read one original -> cut by time -> render -> preprocess one image.
    PyTorch DataLoader batching belongs to the model project.
    With manifest_cache_dir, construction builds/reuses a batched Arrow IPC file;
    each process lazily maps it without copying the decoded split. None keeps the
    read-only-compatible, process-local Parquet fallback. Only the requested row
    becomes Python objects. cached_row_groups remains accepted but does not limit
    either full-split representation. Keep prepared data and cache files immutable
    while readers are active; source generation changes on mmap reopen fail loud.
    """

    def __init__(
        self,
        prepared: str | Path,
        split: str = "train",
        max_handles: int = 8,
        cached_row_groups: int = 2,
        manifest_cache_dir: str | Path | None = None,
    ):
        if (
            split not in ("train", "validation", "test")
            or max_handles < 1
            or cached_row_groups < 1
        ):
            raise DataError("Invalid loader configuration", "invalid_loader")
        self.prepared = Path(prepared).resolve()
        self.split = split
        self.max_handles = max_handles
        self.cached_row_groups = cached_row_groups
        self.manifest_cache_dir = (
            Path(manifest_cache_dir).resolve()
            if manifest_cache_dir is not None
            else None
        )
        import pyarrow.parquet as pq

        self._source_path = self.prepared / "manifests" / f"{split}.parquet"
        self._source_identity = source_identity(self._source_path)
        with pq.ParquetFile(self._source_path) as source:
            metadata = source.metadata
            schema = source.schema_arrow
        check_source(self._source_path, self._source_identity)
        # Training supplies a writable cache directory. Build eagerly here so
        # workers only map the published file, never all decode their own table.
        self._cache_path = (
            prepare_manifest_cache(
                self._source_path,
                self.manifest_cache_dir,
                self._source_identity,
                schema,
            )
            if self.manifest_cache_dir is not None
            else None
        )
        self.ends = []
        total = 0
        for row_group_index in range(metadata.num_row_groups):
            total += metadata.row_group(row_group_index).num_rows
            self.ends.append(total)
        self.total = total
        self._reset()

    def _reset(self) -> None:
        """Initialize an unloaded reader owned by the current process."""
        self._pid = os.getpid()
        self._handles = OrderedDict()
        self._manifest: pa.Table | None = None
        self._mapping = None

    def _check_process(self) -> None:
        """Discard inherited buffers and record handles before a worker reads."""
        if self._pid != os.getpid():
            self.close()
            self._pid = os.getpid()

    def __len__(self) -> int:
        return self.total

    def manifest_row(self, index: int) -> dict:
        """Return a fresh complete row; negative indices follow sequence bounds.

        Lazily map/decode one split per PID. Close/pickle omit mapped/native data.
        Cached readers reject changed source generations on reopening; fallback
        readers reload current data but require unchanged row counts.
        """
        self._check_process()
        if index < 0:
            index += self.total
        if not 0 <= index < self.total:
            raise IndexError(index)
        import pyarrow.parquet as pq

        # Map shared IPC when configured; otherwise decode the read-only fallback
        # once. Keep chunks rather than copying the split to consolidate them.
        if self._manifest is None:
            if self._cache_path is not None:
                import pyarrow as pa

                check_source(self._source_path, self._source_identity)
                # IPC read_all creates column/chunk wrappers over mapped buffers;
                # no decompression, combine_chunks, or full-table copy occurs.
                mapping = pa.memory_map(str(self._cache_path), "r")
                try:
                    table = pa.ipc.open_file(mapping).read_all()
                    check_source(self._source_path, self._source_identity)
                except BaseException:
                    mapping.close()
                    raise
                self._mapping = mapping
                self._manifest = table
                return table.slice(index, 1).to_pylist()[0]
            with pq.ParquetFile(
                self.prepared / "manifests" / f"{self.split}.parquet"
            ) as source:
                # Bounds came from construction; do not reuse them if a new
                # source has a different length. Recreate the loader instead.
                if source.metadata.num_rows != self.total:
                    raise DataError(
                        "Indexed manifest changed; recreate loader and audit package",
                        "audit_failed",
                    )
                # Workers may be forked; do not depend on an inherited Arrow
                # decoding thread pool when initializing their native table.
                table: pa.Table = source.read(use_threads=False)
                self._manifest = table
        # Slice before conversion, preserving nested/null audit columns while
        # materializing only the requested row as a fresh Python dictionary.
        assert self._manifest is not None
        return self._manifest.slice(index, 1).to_pylist()[0]

    def __getitem__(self, index: int) -> dict:
        row = self.manifest_row(index)
        path = (self.prepared / row["record_file"]).resolve()
        if not path.is_relative_to(self.prepared):
            raise DataError("Invalid indexed path", "invalid_path")
        if path not in self._handles:
            self._handles[path] = path.open("rb")
            if len(self._handles) > self.max_handles:
                self._handles.popitem(last=False)[1].close()
        self._handles.move_to_end(path)
        source = self._handles[path]
        source.seek(row["byte_offset"])
        raw = source.read(row["byte_length"])
        record = json.loads(raw)
        if len(raw) != row["byte_length"] or record["key_id"] != row["drawing_id"]:
            raise DataError("Indexed record changed; audit package", "audit_failed")
        return {
            "class_id": row["class_id"],
            "drawing_id": row["drawing_id"],
            "record": record,
        }

    def training_image(
        self, index: int, epoch: int, candidate: str = DEFAULT_PREPROCESSOR
    ) -> dict:
        """Read one training original and return its seeded, preprocessed time view."""
        if self.split != "train":
            raise DataError(
                "Training views require training originals", "invalid_split"
            )
        item = self[index]
        result = training_view(item["record"], epoch, candidate=candidate)
        return {
            **result,
            "class_id": item["class_id"],
            "drawing_id": item["drawing_id"],
        }

    def evaluation_images(
        self, index: int, candidate: str = DEFAULT_PREPROCESSOR
    ) -> Iterator[dict]:
        """Read one evaluation original and yield its ten fixed time views."""
        if self.split not in ("validation", "test"):
            raise DataError(
                "Evaluation views require validation/test originals", "invalid_split"
            )
        item = self[index]
        for result in evaluation_views(item["record"], candidate):
            yield {
                **result,
                "class_id": item["class_id"],
                "drawing_id": item["drawing_id"],
            }

    def close(self) -> None:
        """Release record handles, table wrappers and mapping; allow reopening."""
        for handle in getattr(self, "_handles", {}).values():
            handle.close()
        self._handles = OrderedDict()
        self._manifest = None
        mapping = getattr(self, "_mapping", None)
        if mapping is not None:
            mapping.close()
        self._mapping = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __getstate__(self) -> dict:
        """Serialize configuration only, never native buffers or open files."""
        state = dict(self.__dict__)
        state.update(_handles=OrderedDict(), _manifest=None, _mapping=None, _pid=-1)
        return state

    def __del__(self):
        self.close()


def _rng(seed, record, epoch, purpose, attempt=0):
    key = f"views-v1|{seed}|{record['key_id']}|{epoch}|{purpose}|{attempt}".encode()
    return random.Random(int.from_bytes(hashlib.sha256(key).digest(), "big"))


def training_view(
    record: dict, epoch: int, seed: int = SEED, candidate: str = DEFAULT_PREPROCESSOR
) -> dict:
    """Choose a repeatable full/partial view from drawing ID, epoch and purpose."""
    width = _rng(seed, record, epoch, "width").uniform(
        PREPROCESS_DEFAULTS["training_width_min"],
        PREPROCESS_DEFAULTS["training_width_max"],
    )
    for attempt in range(BLANK_RETRIES):
        rng = _rng(seed, record, epoch, "cut", attempt)
        fraction = (
            1.0
            if rng.random() < COMPLETE_PROBABILITY
            else rng.uniform(PARTIAL_MIN, PARTIAL_MAX)
        )
        result = preprocess(render_qd(cut_prefix(record, fraction), width), candidate)
        if result["status"] != "blank":
            return {
                **result,
                "fraction": fraction,
                "width": width,
                "attempt": attempt,
                "skipped": result["status"] == "uncertain",
            }
    return {
        **result,
        "fraction": fraction,
        "width": width,
        "attempt": attempt,
        "skipped": True,
    }


def evaluation_views(record: dict, candidate: str = DEFAULT_PREPROCESSOR):
    """Yield all ten evaluation stages, including blank or unchanged views."""
    previous = None
    for fraction in EVALUATION_FRACTIONS:
        prefix = cut_prefix(record, fraction)
        rendered = render_qd(prefix)
        key = hashlib.sha256(rendered.tobytes()).hexdigest()
        result = preprocess(rendered, candidate)
        yield {**result, "fraction": fraction, "unchanged": key == previous}
        previous = key
