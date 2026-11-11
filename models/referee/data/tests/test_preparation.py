"""Focused preparation checks using the shared offline fixture."""

import importlib
from contextlib import contextmanager
from pathlib import Path

import pytest
from referee_data.common import (
    DataError,
    atomic_json,
    iter_jsonl,
    read_json,
    write_jsonl,
)
from referee_data.example import build_example_files
from referee_data.settings import Settings


def _stage(tmp_path: Path) -> Settings:
    settings = Settings(tmp_path)
    settings.base.mkdir(parents=True, exist_ok=True)
    archives = build_example_files(settings.base)
    importlib.import_module("referee_data.01-download").stage_fixture(
        settings, archives
    )
    return settings


def test_fixture_grouping_and_determinism(tmp_path: Path) -> None:
    settings = _stage(tmp_path)
    prepare = importlib.import_module("referee_data.02-prepare").prepare
    first = prepare(settings)
    rows = [
        row
        for split in first["available_splits"]
        for row in iter_jsonl(settings.prepared / "manifests" / f"{split}.jsonl")
    ]
    ids = {row["sample_id"] for row in rows}
    assert not any(
        sid.endswith(":703")
        or sid.endswith(":706")
        or sid.endswith(":707")
        or sid.endswith(":708")
        or sid.endswith(":709")
        or sid.endswith(":4036")
        for sid in ids
    )
    assert sum(sid.endswith((":704", ":705")) for sid in ids) == 1
    assert first["exclusions"]["conflicting_exact_group"] == 2
    assert first["exclusions"]["disclosed_probe_group"] == 2
    assert first["exclusions"]["cross_source_train"] == 1
    assert all(
        row["known_mask"]
        == [row["text_present"] is not None, row["number_present"] is not None]
        for row in rows
    )
    assert prepare(settings) == first


def test_duplicate_corrections_fail(tmp_path: Path) -> None:
    settings = _stage(tmp_path)
    path = settings.base / "corrections.jsonl"
    rows = list(iter_jsonl(path))
    write_jsonl(path, [*rows, rows[0]])
    with pytest.raises(DataError, match="Duplicate correction"):
        importlib.import_module("referee_data.02-prepare").prepare(settings)


def test_small_pool_has_validation_and_bad_test_still_blocks_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _stage(tmp_path)
    pairs_path = settings.source / "pairs.jsonl"
    pairs = list(iter_jsonl(pairs_path))
    keep = [
        row
        for row in pairs
        if row["sample_id"].endswith(
            tuple(
                f":{n}"
                for n in (101, 102, 111, 112, 121, 122, 131, 132, 708, 901, 709, 4036)
            )
        )
    ]
    write_jsonl(pairs_path, keep)
    receipt_path = settings.source / "source-receipt.json"
    receipt = read_json(receipt_path)
    receipt["pair_count"] = len(keep)
    atomic_json(receipt_path, receipt)
    corrections_path = settings.base / "corrections.jsonl"
    ids = {row["sample_id"] for row in keep}
    write_jsonl(
        corrections_path,
        [row for row in iter_jsonl(corrections_path) if row["sample_id"] in ids],
    )
    download = importlib.import_module("referee_data.01-download")
    original = download.open_member_reader

    @contextmanager
    def bad_test_labels(source_root: Path):
        with original(source_root) as read:

            def wrapped(archive: str, member: str) -> bytes:
                if archive.endswith("test.zip") and member.endswith(
                    ("label_901.npy", "label_4036.npy")
                ):
                    return b"bad label"
                return read(archive, member)

            yield wrapped

    monkeypatch.setattr(download, "open_member_reader", bad_test_labels)
    with pytest.raises(DataError, match="901|4036"):
        importlib.import_module("referee_data.02-prepare").prepare(settings)


def test_missing_annotation_pairs_in_receipt_prevent_preparation(
    tmp_path: Path,
) -> None:
    settings = _stage(tmp_path)
    receipt_path = settings.source / "source-receipt.json"
    receipt = read_json(receipt_path)
    receipt["missing_pairs"] = 1
    atomic_json(receipt_path, receipt)
    with pytest.raises(DataError, match="missing annotation pairs.*1"):
        importlib.import_module("referee_data.02-prepare").prepare(settings)


def test_source_negative_and_review_overrides(tmp_path: Path) -> None:
    settings = _stage(tmp_path)
    prepare = importlib.import_module("referee_data.02-prepare").prepare
    prepare(settings)
    rows = [row for split in ("train", "validation", "test")
            for row in iter_jsonl(settings.prepared / "manifests" / f"{split}.jsonl")]
    assert any("encoded_negative" in row["label_origin"] for row in rows)
    for row in rows:
        for index, head in enumerate(("text", "number")):
            origin = row["label_origin"][index]
            if origin == "encoded_negative":
                assert row[f"{head}_present"] == row["encoded_presence"][index] == 0
                assert row["known_mask"][index] is True
            if origin == "encoded_positive":
                assert row[f"{head}_present"] == row["encoded_presence"][index] == 1
            if origin == "review_uncertain":
                assert row[f"{head}_present"] is None
                assert row["known_mask"][index] is False


def test_correction_source_hash_must_match(tmp_path: Path) -> None:
    settings = _stage(tmp_path)
    path = settings.base / "corrections.jsonl"
    rows = list(iter_jsonl(path))
    rows[0]["source_png_sha256"] = "0" * 64
    write_jsonl(path, rows)
    with pytest.raises(DataError, match="PNG hash mismatch"):
        importlib.import_module("referee_data.02-prepare").prepare(settings)
