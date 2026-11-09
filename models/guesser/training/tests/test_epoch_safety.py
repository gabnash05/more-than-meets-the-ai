"""Failure, publication and process-lifecycle checks for immutable Guesser views."""

from __future__ import annotations

import gc
import hashlib
import json
import multiprocessing as mp
import pickle
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from training import build_epoch_cache as builder
from training.epoch_cache import EpochViewReader, source_fingerprint
from training.render_cache import encode_sample
from training.tests.input_fixtures import prepare_drawings


@pytest.fixture
def bundle(tmp_path):
    """Build real synthetic views with multiple arms and epochs."""
    prepared = prepare_drawings(tmp_path)
    target = builder.build_bundle(
        prepared,
        tmp_path / "views",
        arms=["a", "b"],
        epochs=[0, 1, 2],
        max_bytes=10000000,
        reserve_bytes=0,
        workers=0,
    )
    return prepared, target


def open_reader(prepared, target):
    """Open with fresh caller-side identity, never trusting the bundle's own hash."""
    return EpochViewReader(
        target,
        fingerprint=source_fingerprint(prepared),
        candidate="foreground",
        sample_count=4,
    )


@pytest.mark.parametrize(
    "damage", ["row", "image", "descriptor", "fingerprint", "epoch", "index"]
)
def test_reader_damage_is_loud(bundle, damage):
    """No corruption/missing coverage can become a silent cache miss or render."""
    prepared, target = bundle
    with sqlite3.connect(target / "views.sqlite3") as db:
        if damage == "row":
            db.execute("DELETE FROM views WHERE arm='a' AND epoch=0 AND sample_index=0")
        elif damage == "image":
            db.execute(
                "UPDATE views SET image=x'00' WHERE arm='a' AND epoch=0 AND sample_index=0"
            )
        elif damage == "descriptor":
            descriptor = json.loads(
                db.execute("SELECT value FROM metadata").fetchone()[0]
            )
            descriptor["complete"] = False
            db.execute("UPDATE metadata SET value=?", (json.dumps(descriptor),))
    with pytest.raises((ValueError, IndexError)):
        if damage == "fingerprint":
            EpochViewReader(
                target, fingerprint="wrong", candidate="foreground", sample_count=4
            )
        else:
            reader = open_reader(prepared, target)
            try:
                reader.get(
                    "a", 9 if damage == "epoch" else 0, -1 if damage == "index" else 0
                )
            finally:
                reader.close()


def test_reader_releases_native_handles_without_cyclic_gc(bundle):
    """Discarding datasets/readers must not accumulate open SQLite handles."""
    prepared, target = bundle
    if not Path("/proc/self/fd").is_dir():
        pytest.skip("Linux descriptor accounting")
    gc.collect()
    before = len(list(Path("/proc/self/fd").iterdir()))
    gc.disable()
    try:
        for _ in range(20):
            reader = open_reader(prepared, target)
            reader.get("a", 0, 0)
            del reader
        assert len(list(Path("/proc/self/fd").iterdir())) <= before + 2
    finally:
        gc.enable()
        gc.collect()


def test_fingerprint_excludes_test_payload_and_rejects_escape(tmp_path, monkeypatch):
    """Only train sources participate; path escapes fail before payload access."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    prepared = prepare_drawings(tmp_path)
    forbidden = prepared / "test.jsonl"
    forbidden.write_text("must not read")
    original = Path.open

    def guarded(path, *args, **kwargs):
        if path == forbidden:
            raise AssertionError("Held-out payload was read")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded)
    assert source_fingerprint(prepared) == source_fingerprint(prepared)
    pq.write_table(
        pa.table({"record_file": ["../outside.jsonl"]}),
        prepared / "manifests/train.parquet",
    )
    with pytest.raises(ValueError, match="escapes"):
        source_fingerprint(prepared)


@pytest.mark.parametrize(
    "failure", ["space", "interruption", "source", "quota", "lock"]
)
def test_builder_never_publishes_incomplete_work(tmp_path, monkeypatch, failure):
    """Budget/race/interruption guards preserve unrelated staging and all originals."""
    prepared = prepare_drawings(tmp_path)
    target = tmp_path / "views"
    unrelated = tmp_path / ".someone-else.building"
    unrelated.mkdir()
    if failure == "space":
        monkeypatch.setattr(
            builder.shutil, "disk_usage", lambda path: SimpleNamespace(free=0)
        )
    elif failure == "lock":
        (tmp_path / ".views.lock").mkdir()
    else:
        original = builder.BuildViews.__getitem__

        def injected(self, index):
            if failure == "interruption" and index == 1:
                raise RuntimeError("injected interruption")
            rows = original(self, index)
            if failure == "source" and index == 3:
                with (prepared / "train.jsonl").open("ab") as source:
                    source.write(b"\n")
            if failure == "quota":
                channel = np.random.default_rng(index).random(
                    (224, 224), dtype=np.float32
                )
                metadata, payload = encode_sample(
                    {"image": np.stack([channel] * 3), "status": "ok"}
                )
                rows = [
                    (
                        "a",
                        0,
                        index,
                        metadata,
                        payload,
                        hashlib.sha256(metadata.encode() + payload).hexdigest(),
                    )
                ]
            return rows

        monkeypatch.setattr(builder.BuildViews, "__getitem__", injected)
    with pytest.raises((OSError, RuntimeError, ValueError)):
        builder.build_bundle(
            prepared,
            target,
            arms=["a"],
            epochs=[0],
            max_bytes=131072 if failure == "quota" else 10000000,
            reserve_bytes=0,
            workers=0,
        )
    assert not target.exists()
    assert unrelated.is_dir()
    assert not list(tmp_path.glob(".views.building-*"))
    assert (tmp_path / ".views.lock").exists() is (failure == "lock")


def _read_child(reader, queue):
    """Read an inherited/pickled warm reader and close its process-local connection."""
    try:
        queue.put(reader.get("a", 0, 0)["image"].tobytes())
    finally:
        reader.close()


@pytest.mark.parametrize("context", mp.get_all_start_methods())
def test_warm_reader_survives_pickle_and_worker_contexts(bundle, context):
    """Neither native connections nor parent handles cross a worker boundary."""
    prepared, target = bundle
    reader = open_reader(prepared, target)
    expected = reader.get("a", 0, 0)["image"].tobytes()
    # Trusted round trip of this test's own object, never external pickle bytes.
    restored = pickle.loads(pickle.dumps(reader))
    assert restored.get("a", 0, 0)["image"].tobytes() == expected
    restored.close()
    ctx = mp.get_context(context)
    queue = ctx.Queue()
    process = ctx.Process(target=_read_child, args=(reader, queue))
    process.start()
    try:
        assert queue.get(timeout=30) == expected
        process.join(timeout=30)
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.terminate()
            process.join(timeout=10)
        reader.close()
        queue.close()
        queue.join_thread()


def test_parallel_builder_matches_serial(tmp_path):
    """Real spawned DataLoader workers produce the same encoded rows as serial."""
    prepared = prepare_drawings(tmp_path)
    options: dict[str, Any] = {
        "arms": ["a", "b"],
        "epochs": [0, 1],
        "max_bytes": 10000000,
        "reserve_bytes": 0,
    }
    serial = builder.build_bundle(prepared, tmp_path / "serial", workers=0, **options)
    parallel = builder.build_bundle(
        prepared, tmp_path / "parallel", workers=2, **options
    )
    with (
        sqlite3.connect(serial / "views.sqlite3") as left,
        sqlite3.connect(parallel / "views.sqlite3") as right,
    ):
        assert (
            left.execute(
                "SELECT * FROM views ORDER BY arm,epoch,sample_index"
            ).fetchall()
            == right.execute(
                "SELECT * FROM views ORDER BY arm,epoch,sample_index"
            ).fetchall()
        )


def _compete_build(prepared, target, start, queue):
    """Run a cooperating builder after both child processes have been started."""
    if not start.wait(timeout=30):
        raise TimeoutError("Publication race never started")
    try:
        builder.build_bundle(
            prepared,
            target,
            arms=["b"],
            epochs=[0],
            max_bytes=10000000,
            reserve_bytes=0,
            workers=0,
        )
        queue.put("published")
    except FileExistsError:
        queue.put("exists")


def test_competing_builders_publish_exactly_one_complete_bundle(tmp_path):
    """Two fresh processes cannot replace or remove the winner's artifact."""
    prepared = prepare_drawings(tmp_path)
    target = tmp_path / "views"
    ctx = mp.get_context("spawn")
    start, queue = ctx.Event(), ctx.Queue()
    processes = [
        ctx.Process(target=_compete_build, args=(prepared, target, start, queue))
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    try:
        start.set()
        assert sorted(queue.get(timeout=30) for _ in processes) == [
            "exists",
            "published",
        ]
        for process in processes:
            process.join(timeout=30)
            assert process.exitcode == 0
        reader = open_reader(prepared, target)
        assert reader.get("b", 0, 0)["class_id"] == 0
        reader.close()
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=10)
        queue.close()
        queue.join_thread()


def test_cached_blank_uncertain_wraparound_and_all_unusable(bundle):
    """Stored unusable records preserve the old next-index/wraparound policy."""
    from training.dataset import GuesserDataset

    prepared, target = bundle
    with sqlite3.connect(target / "views.sqlite3") as db:
        for index in (0, 1, 3):
            sample = {
                "image": None,
                "class_id": index,
                "drawing_id": f"train-{index}",
                "status": "uncertain" if index == 1 else "blank",
                "skipped": True,
            }
            metadata, payload = encode_sample(sample)
            digest = hashlib.sha256(metadata.encode() + payload).hexdigest()
            db.execute(
                "UPDATE views SET metadata=?,image=?,digest=? WHERE arm='b' AND epoch=0 AND sample_index=?",
                (metadata, payload, digest, index),
            )
    cached = GuesserDataset(str(prepared), training_view_cache=target)
    assert int(cached[0]["class_id"]) == int(cached[3]["class_id"]) == 2
    cached.training_cache.close()
    metadata, payload = encode_sample(
        {
            "image": None,
            "class_id": 2,
            "drawing_id": "train-2",
            "status": "blank",
            "skipped": True,
        }
    )
    with sqlite3.connect(target / "views.sqlite3") as db:
        db.execute(
            "UPDATE views SET metadata=?,image=?,digest=? WHERE arm='b' AND epoch=0 AND sample_index=2",
            (
                metadata,
                payload,
                hashlib.sha256(metadata.encode() + payload).hexdigest(),
            ),
        )
    with pytest.raises(RuntimeError, match="No usable image"):
        cached[0]
    cached.training_cache.close()


def test_codec_status_metadata_and_signed_zero_are_lossless():
    """Images are byte-identical across channels; skipped diagnostics stay intact."""
    from training.render_cache import decode_sample

    sample = {
        "image": None,
        "status": "uncertain",
        "skipped": True,
        "diagnostics": {"coverage": 0.1},
    }
    assert decode_sample(*encode_sample(sample)) == sample
    image = np.zeros((3, 4, 4), dtype=np.float32)
    image[1, 0, 0] = -0.0
    with pytest.raises(ValueError, match="bitwise"):
        encode_sample({"image": image})


def test_builder_rejects_interior_key_outside_declared_range(tmp_path, monkeypatch):
    """Counts plus endpoint readback must not bless a missing interior original."""
    prepared = prepare_drawings(tmp_path)
    original = builder.BuildViews.__getitem__

    def bad_index(self, index):
        rows = original(self, index)
        if index == 1:
            rows = [
                (arm, epoch, 101, metadata, image, digest)
                for arm, epoch, _, metadata, image, digest in rows
            ]
        return rows

    monkeypatch.setattr(builder.BuildViews, "__getitem__", bad_index)
    with pytest.raises(ValueError, match="coverage"):
        builder.build_bundle(
            prepared,
            tmp_path / "views",
            arms=["b"],
            epochs=[0],
            max_bytes=10000000,
            reserve_bytes=0,
            workers=0,
        )
    assert not (tmp_path / "views").exists()


def test_per_original_generation_consumes_no_global_rng(tmp_path):
    """Offline deterministic view generation must not sample affine/global RNG."""
    import random

    import torch

    prepared = prepare_drawings(tmp_path)
    views = builder.BuildViews(prepared, ["a", "b"], [0, 1])
    python_state, numpy_state, torch_state = (
        random.getstate(),
        np.random.get_state(),
        torch.get_rng_state(),
    )
    views[0]
    assert random.getstate() == python_state
    current = np.random.get_state()
    assert current[0] == numpy_state[0] and current[2:] == numpy_state[2:]
    assert np.array_equal(current[1], numpy_state[1])
    assert torch.equal(torch.get_rng_state(), torch_state)
