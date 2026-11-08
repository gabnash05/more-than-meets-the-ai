import base64
import hashlib
import zipfile
from unittest.mock import patch

import pytest
from guesser_data.cli import parser
from guesser_data.common import (
    DataError,
    atomic_json,
    candidate_path,
    json_bytes,
    load_step,
    object_hash,
    receipt_path,
)
from guesser_data.settings import PACKAGE_ROOT, Settings

_download = load_step("01-download")
trajectory_hash = _download.trajectory_hash
sample_full_stream = _download.sample_full_stream
save_candidates = _download.save_candidates
_prepare = load_step("02-prepare")
prepare = _prepare.prepare
export_module = load_step("04-export")
export_dataset = export_module.export_dataset


def test_prepare_and_export_small_dataset(tmp_path):
    settings = Settings(tmp_path, profile="smoke")
    meta = {"class_id": 0, "source_name": "cat", "generation": "fixture"}
    atomic_json(settings.base / "labels.json", [meta | {}])
    lines = [
        json_bytes(
            {
                "key_id": str(i),
                "word": "cat",
                "recognized": True,
                "drawing": [[[i, i + 1], [0, i + 1], [0, 1]]],
            }
        )
        + b"\n"
        for i in range(30)
    ]
    lines.append(b"{malformed\n")
    payload = b"".join(lines)
    meta.update(
        size=str(len(payload)),
        md5Hash=base64.b64encode(hashlib.md5(payload).digest()).decode(),
    )
    rows, stats = sample_full_stream(lines, meta, settings)
    assert stats["counts"]["rejected:invalid_record"] == 1
    rows[0]["id_conflict"] = True
    rows[1]["record"]["drawing"] = rows[2]["record"]["drawing"]
    rows[1]["trajectory_hash"] = trajectory_hash(rows[1]["record"])
    rows[1]["content_sha256"] = object_hash(rows[1]["record"])
    receipt = save_candidates(
        settings, meta, rows, stats, source_kind="synthetic_validation"
    )
    candidates = candidate_path(settings, 0)
    candidate_bytes = candidates.read_bytes().replace(b"\n", b"\r\n\n", 1)
    candidates.write_bytes(candidate_bytes)
    receipt["candidate_sha256"] = hashlib.sha256(candidate_bytes).hexdigest()
    atomic_json(receipt_path(settings, 0), receipt)
    summary = prepare(settings)
    assert summary["counts"]["0"] == {"train": 16, "validation": 2, "test": 2}
    quarantine = (settings.base / "quarantine.jsonl").read_text(encoding="utf-8")
    assert rows[0]["drawing_id"] in quarantine
    assert "conflicting_id" in quarantine
    assert not (settings.base / "frozen.json").exists()
    assert not (settings.base / "qa" / "review-decisions.json").exists()
    with patch.object(export_module, "audit", wraps=export_module.audit) as audit_call:
        archives = export_dataset(settings)
        assert audit_call.call_count == 1
    import pyarrow.parquet as pq

    ids = []
    for split in ("train", "validation", "test"):
        ids.extend(
            pq.read_table(
                settings.base / "prepared/manifests" / f"{split}.parquet",
                columns=["drawing_id"],
            )
            .column("drawing_id")
            .to_pylist()
        )
    assert rows[0]["drawing_id"] not in ids
    assert len({rows[1]["drawing_id"], rows[2]["drawing_id"]} & set(ids)) <= 1
    with zipfile.ZipFile(archives["trainer"]["path"]) as archive:
        assert not any(
            "records/test/" in name or "manifests/test." in name
            for name in archive.namelist()
        )
    with zipfile.ZipFile(archives["held-out-test"]["path"]) as archive:
        assert "prepared/manifests/test.parquet" in archive.namelist()
    train_records = settings.base / "prepared/records/train/c000.jsonl"
    with train_records.open("r+b") as records:
        records.truncate(train_records.stat().st_size - 1)
    with pytest.raises(DataError, match="Invalid record boundary"):
        export_module.audit(settings)


def test_trainable_profile_helpers(tmp_path, monkeypatch):
    expected = {
        "production": (5500, 4000, 500, 500),
        "medium": (2200, 1600, 200, 200),
        "small": (550, 400, 50, 50),
    }
    for profile, values in expected.items():
        settings = Settings(tmp_path, profile=profile)
        assert settings.base == tmp_path / profile
        keys = ("candidates", "train", "validation", "test")
        assert tuple(settings.spec[key] for key in keys) == values
        assert parser().parse_args(["status", "--profile", profile]).profile == profile
    assert parser().parse_args(["status"]).profile == "production"
    assert parser().parse_args(["probe"]).profile == "smoke"
    with pytest.raises(DataError):
        parser().parse_args(["status", "--profile", "unknown"])

    names = (
        (PACKAGE_ROOT / "src" / "resources" / "categories.txt")
        .read_text(encoding="utf-8")
        .splitlines()
    )
    registry = [{"class_id": i, "source_name": name} for i, name in enumerate(names)]
    production = Settings(tmp_path, profile="production")
    medium = Settings(tmp_path, profile="medium")
    _prepare._validate_registry(production, registry, registry)
    with pytest.raises(DataError):
        _prepare._validate_registry(medium, registry[::-1], registry)
    with pytest.raises(DataError):
        _prepare._validate_registry(medium, registry, registry[:-1])

    item = registry[0]
    partial = {
        **item,
        "source_kind": "quickdraw_partial",
        "profile": "medium",
        "sampling_method": "prefix-v1",
        "complete": False,
        "full_source_verified": False,
        "source_bytes": 123,
        "source_md5": None,
    }
    full = {
        **item,
        "source_kind": "quickdraw",
        "complete": True,
        "full_source_verified": True,
    }
    _prepare._validate_sources(medium, [item], {0: partial})
    _prepare._validate_sources(production, [item], {0: full})
    with pytest.raises(DataError):
        _prepare._validate_sources(production, [item], {0: partial})
    with pytest.raises(DataError):
        _prepare._validate_sources(medium, [item], {0: full})

    monkeypatch.setattr(_prepare, "labels", lambda settings: registry)
    partial_summary = _prepare._summary(medium, [item], {0: partial}, {}, {}, {}, {})
    assert partial_summary["trainable"] is True
    provenance = ("profile", "sampling_method", "complete", "full_source_verified")
    assert {key: partial_summary["sources"][0][key] for key in provenance} == {
        key: partial[key] for key in provenance
    }
    production_summary = _prepare._summary(
        production, [item], {0: full}, {}, {}, {}, {}
    )
    assert set(production_summary["sources"][0]) == {
        "class_id",
        "source_name",
        "source_kind",
        "source_generation",
        "source_bytes",
        "source_md5",
        "candidate_sha256",
        "candidate_count",
        "keep",
    }
