import importlib

import pytest
from PIL import Image
from referee_data.common import DataError, write_jsonl
from referee_data.settings import Settings

preview = importlib.import_module("referee_data.03-preview").preview


def _row(image_path: str, split: str = "train") -> dict:
    return {
        "image_path": image_path,
        "sample_id": "demo-id",
        "provenance_folder": "circle",
        "split": split,
        "text_present": 1,
        "number_present": None,
        "known_mask": [True, False],
    }


def test_preview_uses_training_rows_and_writes_labels(tmp_path):
    settings = Settings(data_root=tmp_path, profile="sample")
    images = settings.prepared / "images"
    images.mkdir(parents=True)
    Image.new("L", (512, 512), "white").save(images / "one.png")
    write_jsonl(
        settings.prepared / "manifests" / "train.jsonl", [_row("images/one.png")]
    )
    write_jsonl(
        settings.prepared / "manifests" / "validation.jsonl",
        [_row("images/does-not-exist.png", "validation")],
    )

    result = preview(settings)
    index = (settings.previews / "index.html").read_text(encoding="utf-8")
    assert result["sample_count"] == 1
    assert len(result["contact_sheets"]) == 1
    assert "unknown means the label is masked" in index
    assert Image.open(result["contact_sheets"][0]).size == (896, 1080)
    assert "Training split only" in index
    assert "validation" not in index
    assert (settings.previews / "train-001.png").is_file()


def test_preview_reports_missing_training_manifest(tmp_path):
    settings = Settings(data_root=tmp_path, profile="sample")
    with pytest.raises(DataError, match="Training manifest is missing"):
        preview(settings)


def test_preview_caps_sample_count(tmp_path):
    settings = Settings(data_root=tmp_path, profile="sample")
    image_dir = settings.prepared / "images"
    image_dir.mkdir(parents=True)
    Image.new("L", (512, 512), "white").save(image_dir / "one.png")
    rows = [_row("images/one.png") for _ in range(70)]
    write_jsonl(settings.prepared / "manifests" / "train.jsonl", rows)
    result = preview(settings)
    assert result["sample_count"] == 64
    assert len(result["contact_sheets"]) == 4
    index = (settings.previews / "index.html").read_text(encoding="utf-8")
    assert "Training samples 49-64" in index
