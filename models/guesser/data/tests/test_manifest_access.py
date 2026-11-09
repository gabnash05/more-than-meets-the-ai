"""Synthetic manifest random-access and worker-lifecycle regression tests."""

from __future__ import annotations

import json
import multiprocessing
import os
import pickle
import tempfile
from multiprocessing.queues import Queue
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from guesser_data import IndexedDrawings
from guesser_data.common import DataError


@pytest.fixture
def manifest(tmp_path: Path) -> tuple[Path, list[dict]]:
    """Write distinct row groups, including nullable and nested audit metadata."""
    rows = [
        {
            "drawing_id": str(index),
            "class_id": index % 3,
            "record_file": f"records/train/c{index % 3:03}.jsonl",
            "byte_offset": index * 100,
            "byte_length": 100,
            "optional": None if index % 2 else "audit",
            "nested": {"values": [index, index + 1]},
        }
        for index in range(12)
    ]
    directory = tmp_path / "manifests"
    directory.mkdir()
    pq.write_table(
        pa.Table.from_pylist(rows), directory / "train.parquet", row_group_size=2
    )
    return tmp_path, rows


def test_random_access_decodes_manifest_only_once(
    manifest: tuple[Path, list[dict]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cross-cache random access must not decode any manifest rows repeatedly."""
    prepared, rows = manifest
    original = pq.ParquetFile
    decoded_rows = []

    class CountedParquetFile:
        """Count rows decoded by either full-table or row-group reads."""

        def __init__(self, *args, **kwargs):
            self.source = original(*args, **kwargs)
            self.metadata = self.source.metadata
            self.schema_arrow = self.source.schema_arrow

        def read(self, *args, **kwargs):
            assert kwargs["use_threads"] is False
            table = self.source.read(*args, **kwargs)
            decoded_rows.append(table.num_rows)
            return table

        def read_row_group(self, *args, **kwargs):
            table = self.source.read_row_group(*args, **kwargs)
            decoded_rows.append(table.num_rows)
            return table

        def close(self):
            self.source.close()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            self.close()

    monkeypatch.setattr(pq, "ParquetFile", CountedParquetFile)
    with IndexedDrawings(prepared, cached_row_groups=1) as drawings:
        # Revisit distant groups in caller order, not a reordered/locality shuffle.
        for index in [10, 0, 6, 2, 8, 4, 11, 1, 7, 3, 9, 5] * 3:
            assert drawings.manifest_row(index) == rows[index]
        assert sum(decoded_rows) == len(rows)
        assert isinstance(drawings._manifest, pa.Table)


def test_shared_manifest_cache_preserves_rows_without_worker_decode(
    manifest: tuple[Path, list[dict]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Build once in the parent, then map all columns without Parquet decoding."""
    prepared, rows = manifest
    cache = prepared / "cache"
    with IndexedDrawings(prepared, manifest_cache_dir=cache) as drawings:
        assert drawings.manifest_cache_dir == cache.resolve()
        assert len(list(cache.glob("*.arrow"))) == 1

        def no_decode(*args, **kwargs):
            raise AssertionError("Workers must not decode a full Parquet manifest")

        monkeypatch.setattr(pq.ParquetFile, "read", no_decode)
        monkeypatch.setattr(pq.ParquetFile, "iter_batches", no_decode)
        before = pa.total_allocated_bytes()
        for index in [10, 0, 6, 2, 8, 4, 11, 1, 7, 3, 9, 5] * 3:
            assert drawings.manifest_row(index) == rows[index]
        assert pa.total_allocated_bytes() - before < 1024
        with pickle.loads(pickle.dumps(drawings)) as restored:
            assert restored.manifest_row(-1) == rows[-1]
        drawings.close()
        assert drawings.manifest_row(0) == rows[0]


def test_source_race_does_not_leave_a_usable_stale_mapping(
    manifest: tuple[Path, list[dict]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A source replacement during mmap open must fail on every retry."""
    prepared, rows = manifest
    from guesser_data.common import load_step
    from guesser_data.manifest_cache import check_source

    loader = load_step("05-loader")
    calls = 0
    with IndexedDrawings(prepared, manifest_cache_dir=prepared / "cache") as drawings:

        def replace_on_second_check(path, identity):
            nonlocal calls
            calls += 1
            if calls == 2:
                pq.write_table(pa.Table.from_pylist(rows[::-1]), path)
            check_source(path, identity)

        monkeypatch.setattr(loader, "check_source", replace_on_second_check)
        for _ in range(2):
            with pytest.raises(DataError, match="Indexed manifest changed"):
                drawings.manifest_row(0)


def test_changed_manifest_length_requires_new_loader(
    manifest: tuple[Path, list[dict]],
) -> None:
    """Do not silently combine stale index bounds with a replaced manifest."""
    prepared, rows = manifest
    with IndexedDrawings(prepared) as drawings:
        pq.write_table(
            pa.Table.from_pylist(rows[:-1]), prepared / "manifests/train.parquet"
        )
        with pytest.raises(DataError, match="Indexed manifest changed"):
            drawings.manifest_row(0)


def test_complete_rows_are_independent_and_indices_keep_sequence_bounds(
    manifest: tuple[Path, list[dict]],
) -> None:
    """Keep all audit fields, support negative indices, and reject invalid ones."""
    prepared, rows = manifest
    with IndexedDrawings(prepared) as drawings:
        for index in (len(rows), -len(rows) - 1):
            with pytest.raises(IndexError):
                drawings.manifest_row(index)
        assert drawings._manifest is None
        assert drawings.manifest_row(-1) == rows[-1]
        assert drawings.manifest_row(-len(rows)) == rows[0]
        row = drawings.manifest_row(0)
        row["nested"]["values"].append(-1)
        row["drawing_id"] = "mutated"
        assert drawings.manifest_row(0) == rows[0]


def test_empty_manifest_has_no_valid_index(tmp_path: Path) -> None:
    """An empty split stays empty without trying to decode an indexed row."""
    (tmp_path / "manifests").mkdir()
    pq.write_table(
        pa.table({"drawing_id": pa.array([], type=pa.string())}),
        tmp_path / "manifests/train.parquet",
    )
    with IndexedDrawings(tmp_path) as drawings:
        assert len(drawings) == 0
        for index in (0, -1):
            with pytest.raises(IndexError):
                drawings.manifest_row(index)


def test_close_and_pickle_reload_current_manifest(
    manifest: tuple[Path, list[dict]],
) -> None:
    """Loaded tables are snapshots, not serialized caches or stale sidecars."""
    prepared, rows = manifest
    with IndexedDrawings(prepared) as drawings:
        assert drawings.manifest_row(0) == rows[0]
        state = drawings.__getstate__()
        assert state["_manifest"] is None
        assert not state["_handles"]
        restored = pickle.loads(pickle.dumps(drawings))
        changed = [dict(row, optional="replacement") for row in rows]
        pq.write_table(
            pa.Table.from_pylist(changed), prepared / "manifests/train.parquet"
        )
        assert drawings.manifest_row(0) == rows[0]
        with restored:
            assert restored.manifest_row(0) == changed[0]
        drawings.close()
        assert drawings._manifest is None
        assert drawings.manifest_row(0) == changed[0]


def _worker_row(drawings: IndexedDrawings, result: Queue) -> None:
    """Look up a row in an actual worker and report its process owner."""
    with drawings:
        row = drawings.manifest_row(0)
        assert drawings._pid == os.getpid()
        result.put((drawings._pid, row))


@pytest.mark.parametrize("method", ["spawn", "fork", "forkserver"])
def test_workers_drop_parent_manifest(
    manifest: tuple[Path, list[dict]], method: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each worker reopens the source, including a fork of an already warm reader."""
    if method not in multiprocessing.get_all_start_methods():
        pytest.skip(f"{method} is not supported on this platform")
    # Earlier CLI tests change tempfile.tempdir to their deep output path. Use
    # the configured scratch root so forkserver's Unix socket fits sun_path.
    monkeypatch.setattr(tempfile, "tempdir", os.environ.get("TMPDIR"))
    prepared, rows = manifest
    with IndexedDrawings(prepared) as drawings:
        assert drawings.manifest_row(0) == rows[0]
        changed = [dict(row, optional="child") for row in rows]
        pq.write_table(
            pa.Table.from_pylist(changed), prepared / "manifests/train.parquet"
        )
        # Pass the reader directly: fork inherits it, spawn pickles it. A finite
        # join and cleanup turn deadlocks into failures without orphan workers.
        context = multiprocessing.get_context(method)
        result = context.Queue()
        process = context.Process(target=_worker_row, args=(drawings, result))
        process.start()
        try:
            process.join(timeout=30)
            assert process.exitcode == 0
            pid, row = result.get(timeout=5)
        finally:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
            result.close()
        assert pid != os.getpid()
        assert row == changed[0]
        assert drawings.manifest_row(0) == rows[0]


@pytest.mark.parametrize("failure", ["path", "id", "length"])
def test_indexed_record_safety_is_preserved(
    manifest: tuple[Path, list[dict]], failure: str
) -> None:
    """Still reject path traversal, a changed record ID and stale byte lengths."""
    prepared, rows = manifest
    path = prepared / rows[0]["record_file"]
    path.parent.mkdir(parents=True)
    raw = json.dumps({"key_id": "0", "drawing": []}).encode() + b"\n"
    path.write_bytes(raw)
    row: dict = dict(rows[0], byte_length=len(raw))
    pq.write_table(pa.Table.from_pylist([row]), prepared / "manifests/train.parquet")
    with IndexedDrawings(prepared) as drawings:
        assert drawings[0]["record"]["key_id"] == "0"
        with pickle.loads(pickle.dumps(drawings)) as restored:
            assert restored[0] == drawings[0]
        handle = next(iter(drawings._handles.values()))
        if failure == "path":
            row["record_file"] = "../outside.jsonl"
        elif failure == "id":
            row["drawing_id"] = "changed"
        else:
            row["byte_length"] = len(raw) + 1
        drawings.close()
        assert handle.closed
        pq.write_table(
            pa.Table.from_pylist([row]), prepared / "manifests/train.parquet"
        )
        with pytest.raises(DataError):
            drawings[0]


@pytest.mark.parametrize("method", ["spawn", "fork", "forkserver"])
def test_mmap_workers_reopen_one_shared_file(
    manifest: tuple[Path, list[dict]], method: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Warm mappings are omitted on spawn and reset on fork without decoding."""
    if method not in multiprocessing.get_all_start_methods():
        pytest.skip(f"{method} is unsupported")
    monkeypatch.setattr(tempfile, "tempdir", os.environ.get("TMPDIR"))
    prepared, rows = manifest
    cache = prepared / "cache"
    with IndexedDrawings(prepared, manifest_cache_dir=cache) as drawings:
        assert drawings.manifest_row(0) == rows[0]
        assert drawings.__getstate__()["_mapping"] is None
        context = multiprocessing.get_context(method)
        result = context.Queue()
        process = context.Process(target=_worker_row, args=(drawings, result))
        process.start()
        try:
            process.join(timeout=30)
            assert process.exitcode == 0
            pid, row = result.get(timeout=5)
        finally:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
            result.close()
        assert pid != os.getpid()
        assert row == rows[0]
        assert drawings.manifest_row(0) == rows[0]
        assert len(list(cache.glob("*.arrow"))) == 1


def test_cache_generation_changes_on_same_length_replacement(
    manifest: tuple[Path, list[dict]],
) -> None:
    """Changed row order cannot reuse stale offsets even at the same length."""
    prepared, rows = manifest
    cache = prepared / "cache"
    with IndexedDrawings(prepared, manifest_cache_dir=cache) as old:
        replacement = prepared / "manifests/new.parquet"
        pq.write_table(pa.Table.from_pylist(rows[::-1]), replacement)
        replacement.replace(prepared / "manifests/train.parquet")
        for _ in range(2):
            with pytest.raises(DataError, match="Indexed manifest changed"):
                old.manifest_row(0)
        with IndexedDrawings(prepared, manifest_cache_dir=cache) as fresh:
            assert fresh.manifest_row(0) == rows[-1]
        assert len(list(cache.glob("*.arrow"))) == 2


def test_cache_build_uses_bounded_batches_and_rejects_source_race(
    manifest: tuple[Path, list[dict]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """An interrupted/replaced source never publishes a partially valid cache."""
    prepared, rows = manifest
    cache = prepared / "cache"
    original = pq.ParquetFile.iter_batches

    def changing_batches(source, *args, **kwargs):
        assert kwargs["batch_size"] <= 16384
        assert kwargs["use_threads"] is False
        yield from original(source, *args, **kwargs)
        replacement = prepared / "manifests/new.parquet"
        pq.write_table(pa.Table.from_pylist(rows[::-1]), replacement)
        replacement.replace(prepared / "manifests/train.parquet")

    monkeypatch.setattr(pq.ParquetFile, "iter_batches", changing_batches)
    with pytest.raises(DataError, match="Indexed manifest changed"):
        IndexedDrawings(prepared, manifest_cache_dir=cache)
    assert not list(cache.glob("*.arrow"))
    assert not list(cache.glob("*.tmp"))
    monkeypatch.setattr(pq.ParquetFile, "iter_batches", original)
    with IndexedDrawings(prepared, manifest_cache_dir=cache) as recovered:
        assert recovered.manifest_row(0) == rows[-1]


def _build_cache_worker(prepared: Path, start, result: Queue) -> None:
    """Record actual conversions while independent spawned readers race."""
    import time

    original = pq.ParquetFile.iter_batches

    def counted_batches(source, *args, **kwargs):
        with (prepared / "builds.log").open("a") as log:
            log.write(f"{os.getpid()}\n")
        time.sleep(0.2)
        yield from original(source, *args, **kwargs)

    pq.ParquetFile.iter_batches = counted_batches
    start.wait(timeout=20)
    with IndexedDrawings(prepared, manifest_cache_dir=prepared / "cache") as drawings:
        result.put(drawings.manifest_row(0))


def test_concurrent_initializers_convert_only_once(
    manifest: tuple[Path, list[dict]],
) -> None:
    """A shared lock prevents concurrent workers multiplying conversion memory."""
    prepared, rows = manifest
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    result = context.Queue()
    workers = [
        context.Process(target=_build_cache_worker, args=(prepared, start, result))
        for _ in range(3)
    ]
    for worker in workers:
        worker.start()
    start.set()
    try:
        for worker in workers:
            worker.join(timeout=30)
            assert worker.exitcode == 0
        assert [result.get(timeout=5) for _ in workers] == [rows[0]] * len(workers)
        assert len((prepared / "builds.log").read_text().splitlines()) == 1
        assert len(list((prepared / "cache").glob("*.arrow"))) == 1
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        result.close()


def test_large_mmap_does_not_allocate_decoded_split(tmp_path: Path) -> None:
    """Mapping many large audit values must not allocate a table-sized buffer."""
    (tmp_path / "manifests").mkdir()
    table = pa.table({"drawing_id": range(100_000), "audit": ["x" * 512] * 100_000})
    pq.write_table(table, tmp_path / "manifests/train.parquet", row_group_size=20_000)
    del table
    with IndexedDrawings(tmp_path, manifest_cache_dir=tmp_path / "cache") as drawings:
        before = pa.total_allocated_bytes()
        for index in [99999, 0, 50000, 20000, 80000] * 5:
            assert drawings.manifest_row(index) == {
                "drawing_id": index,
                "audit": "x" * 512,
            }
        assert pa.total_allocated_bytes() - before < 1024 * 1024
        assert drawings._manifest.nbytes > 50_000_000
