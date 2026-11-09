import importlib
import json
import shutil
import zipfile

import pytest
from referee_data.common import DataError, file_hash
from referee_data.example import build_example_files
from referee_data.settings import Settings

acquire = importlib.import_module("referee_data.01-download")
prepare = importlib.import_module("referee_data.02-prepare")
export = importlib.import_module("referee_data.04-export")


def test_export_separates_roles_and_detects_tampering(tmp_path, monkeypatch):
    settings = Settings(tmp_path / "data")
    fixture = tmp_path / "fixture"
    archives = build_example_files(fixture)
    acquire.stage_fixture(settings, archives)
    shutil.copyfile(fixture / "corrections.jsonl", settings.base / "corrections.jsonl")
    prepare.prepare(settings)
    monkeypatch.setattr(export, "_package_files", lambda root, referee: [])
    checksums = export.export_dataset(settings)
    assert set(checksums) == {"trainer", "held-out-test"}
    summaries = []
    for role, entry in checksums.items():
        archive_path = settings.exports / entry["file"]
        assert file_hash(archive_path) == entry["sha256"]
        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            summary = json.loads(archive.read("dataset-summary.json"))
            summaries.append(summary)
            assert summary["smoke_only"] and not summary["trainer_ready"]
            assert not any("corrections" in name or "preview" in name for name in names)
            if role == "trainer":
                assert "prepared/manifests/test.jsonl" not in names
                assert summary["splits"] == ["train", "validation"]
                assert "test" not in summary["counts"]
            else:
                assert summary["splits"] == ["test"]
    assert summaries[0]["dataset_id"] == summaries[1]["dataset_id"]
    review = settings.base / "corrections.jsonl"
    previous = review.read_bytes()
    review.write_bytes(previous + b"\n")
    with pytest.raises(DataError, match="inputs changed"):
        export.audit(settings)
    review.write_bytes(previous)
    image_path = next((settings.prepared / "images").glob("*.png"))
    with image_path.open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(DataError, match="hash mismatch"):
        export.audit(settings)
