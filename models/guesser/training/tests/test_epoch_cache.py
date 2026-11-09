"""Tests for exact training-view cache storage."""

import numpy as np
import pytest
from training import render_cache


def test_codec_roundtrip_bitwise():
    channel = np.arange(12, dtype=np.float32).reshape(3, 4)
    image = np.stack([channel] * 3)
    encoded, payload = render_cache.encode_sample({"image": image, "class_id": 3})
    sample = render_cache.decode_sample(encoded, payload)
    assert sample["class_id"] == 3
    assert sample["image"].tobytes() == image.tobytes()


def test_reader_missing_bundle_does_not_create_files(tmp_path):
    import pytest
    from training.epoch_cache import EpochViewReader

    with pytest.raises((FileNotFoundError, OSError)):
        EpochViewReader(
            tmp_path / "missing",
            fingerprint="x",
            candidate="foreground",
            sample_count=1,
        )
    assert not (tmp_path / "missing").exists()


def test_reader_returns_detached_exact_sample(tmp_path):
    import hashlib
    import json
    import sqlite3

    from training.epoch_cache import SCHEMA, EpochViewReader

    channel = np.arange(12, dtype=np.float32).reshape(3, 4)
    image = np.stack([channel] * 3)
    metadata, payload = render_cache.encode_sample({"image": image, "class_id": 1})
    descriptor = {
        "format": 1,
        "complete": True,
        "fingerprint": "x",
        "candidate": "foreground",
        "sample_count": 1,
        "entry_count": 1,
        "arms": ["a"],
        "epochs": [0],
    }
    with sqlite3.connect(tmp_path / "views.sqlite3") as db:
        db.executescript(SCHEMA)
        db.execute(
            "INSERT INTO metadata VALUES (?, ?)", ("descriptor", json.dumps(descriptor))
        )
        db.execute(
            "INSERT INTO views VALUES (?, ?, ?, ?, ?, ?)",
            (
                "a",
                0,
                0,
                metadata,
                payload,
                hashlib.sha256(metadata.encode() + payload).hexdigest(),
            ),
        )
    reader = EpochViewReader(
        tmp_path, fingerprint="x", candidate="foreground", sample_count=1
    )
    result = reader.get("a", 0, 0)
    assert result["image"].tobytes() == image.tobytes()
    result["image"][:] = 0
    assert reader.get_channel("a", 0, 0)["image"].tobytes() == channel.tobytes()
    reader.close()


def test_fingerprint_changes_with_training_source(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    from training.epoch_cache import source_fingerprint

    (tmp_path / "manifests").mkdir()
    source = tmp_path / "train.jsonl"
    source.write_text("one")
    pq.write_table(
        pa.table({"record_file": ["train.jsonl"]}), tmp_path / "manifests/train.parquet"
    )
    first = source_fingerprint(tmp_path)
    source.write_text("two changed")
    assert source_fingerprint(tmp_path) != first


def test_builder_reads_original_once(tmp_path, monkeypatch):
    from training.build_epoch_cache import BuildViews
    from training.tests.input_fixtures import prepare_drawings

    views = BuildViews(prepare_drawings(tmp_path), ["a", "b"], [0, 1])
    original = type(views.drawings).__getitem__
    calls = []

    def counted(self, index):
        calls.append(index)
        return original(self, index)

    monkeypatch.setattr(type(views.drawings), "__getitem__", counted)
    assert len(views[0]) == 4
    assert calls == [0]


def test_reader_rejects_non_string_arm(tmp_path):
    import pytest
    from training.epoch_cache import EpochViewReader

    reader = object.__new__(EpochViewReader)
    reader.descriptor = {"arms": ["a"], "epochs": [0]}
    reader._open = lambda: None

    class Arm(str):
        pass

    with pytest.raises(ValueError):
        reader.require(Arm("a"), 0)


def test_build_publishes_exact_views_and_refuses_overwrite(tmp_path):
    """A real builder publishes all keys, then refuses to replace its output."""
    from training.build_epoch_cache import build_bundle
    from training.dataset import GuesserDataset
    from training.epoch_cache import EpochViewReader, source_fingerprint
    from training.tests.input_fixtures import prepare_drawings

    prepared = prepare_drawings(tmp_path)
    target = tmp_path / "views"
    build_bundle(
        prepared,
        target,
        arms=["a", "b"],
        epochs=[0, 1],
        max_bytes=10_000_000,
        reserve_bytes=0,
        workers=0,
    )
    reader = EpochViewReader(
        target,
        fingerprint=source_fingerprint(prepared),
        candidate="foreground",
        sample_count=4,
    )
    for arm in ("a", "b"):
        for epoch in (0, 1):
            reference = GuesserDataset(
                str(prepared), epoch=epoch, complete_only=arm == "a"
            )
            for index in range(4):
                expected, actual = (
                    reference._read_sample(index),
                    reader.get(arm, epoch, index),
                )
                assert expected.pop("image").tobytes() == actual.pop("image").tobytes()
                assert expected == actual
    with pytest.raises(FileExistsError):
        build_bundle(
            prepared,
            target,
            arms=["a"],
            epochs=[0],
            max_bytes=10_000_000,
            reserve_bytes=0,
            workers=0,
        )


def test_build_tiny_quota_never_publishes(tmp_path):
    """A full SQLite database is not a partially accepted bundle."""
    from training.build_epoch_cache import build_bundle
    from training.tests.input_fixtures import prepare_drawings

    prepared = prepare_drawings(tmp_path)
    with pytest.raises((ValueError, OSError)):
        build_bundle(
            prepared,
            tmp_path / "views",
            arms=["a"],
            epochs=[0],
            max_bytes=1,
            reserve_bytes=0,
            workers=0,
        )
    assert not (tmp_path / "views").exists()


def test_builder_uses_small_cap_without_disk_journal(tmp_path):
    """Private staging may use memory rollback so a fitting DB gets its full cap."""
    from training.build_epoch_cache import build_bundle
    from training.tests.input_fixtures import prepare_drawings

    prepared = prepare_drawings(tmp_path)
    target = build_bundle(
        prepared,
        tmp_path / "views",
        arms=["b"],
        epochs=[1],
        max_bytes=131072,
        reserve_bytes=0,
        workers=0,
    )
    assert (target / "views.sqlite3").stat().st_size <= 131072
    assert sorted(path.name for path in target.iterdir()) == ["views.sqlite3"]
