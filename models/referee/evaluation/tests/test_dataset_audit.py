import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from referee_evaluation.dataset_audit import audit_prepared


def _image(prepared: Path, value: int = 0) -> tuple[str, str]:
    pixels = np.full((512, 512), 255, dtype=np.uint8)
    pixels[100:200, 100:200] = value
    digest = hashlib.sha256(pixels.tobytes()).hexdigest()
    path = prepared / "images" / f"{digest}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels, mode="L").save(path)
    return digest, f"images/{digest}.png"


def _row(split: str, sample_id: str, group_id: str, digest: str, image_path: str) -> dict:
    return {
        "sample_id": sample_id,
        "source_archive": "train.zip",
        "source_path": f"train/{sample_id}.png",
        "provenance_folder": "train/example",
        "image_path": image_path,
        "pixel_sha256": digest,
        "group_id": group_id,
        "split": split,
        "encoded_presence": [1, 0, 0, 1],
        "text_present": 1,
        "number_present": None,
        "known_mask": [True, False],
        "label_origin": ["reviewed", "unreviewed_proxy"],
        "policy_version": "separate-writing-advisories-v1",
    }


def write_prepared(tmp_path: Path) -> Path:
    prepared = tmp_path / "sample" / "prepared"
    (prepared / "manifests").mkdir(parents=True)
    digest, image_path = _image(prepared)
    train_digest, train_path = _image(prepared, value=64)
    rows = {
        "train": [_row("train", "sample-train", "group-train", train_digest, train_path)],
        "validation": [_row("validation", "sample-valid", "group-valid", digest, image_path)],
    }
    for split, split_rows in rows.items():
        (prepared / "manifests" / f"{split}.jsonl").write_text(
            "".join(json.dumps(row) + "\n" for row in split_rows), encoding="utf-8"
        )
    base = prepared.parent
    (base / "dataset-summary.json").write_text(json.dumps({
        "profile": "sample",
        "seed": 198173,
        "label_order": ["text", "number"],
        "policy_version": "separate-writing-advisories-v1",
        "available_splits": ["train", "validation"],
        "counts": {"train": {"rows": 1}, "validation": {"rows": 1}},
    }), encoding="utf-8")
    (base / "labels.json").write_text(json.dumps({
        "label_order": ["text", "number"],
        "policy_version": "separate-writing-advisories-v1",
        "schema_version": 1,
    }), encoding="utf-8")
    return prepared


def test_valid_prepared_dataset_reports_counts(tmp_path: Path) -> None:
    report = audit_prepared(write_prepared(tmp_path))
    validation = report["splits"]["validation"]
    assert validation["rows"] == 1
    assert validation["images_ok"] == 1
    assert validation["labels"]["text"]["positive"] == 1
    assert validation["labels"]["number"]["unknown"] == 1
    assert validation["origins"]["reviewed"] == 1
    assert report["totals"]["missing_images"] == 0


def test_rejects_wrong_split(tmp_path: Path) -> None:
    prepared = write_prepared(tmp_path)
    manifest = prepared / "manifests" / "validation.jsonl"
    row = json.loads(manifest.read_text())
    row["split"] = "train"
    manifest.write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="split"):
        audit_prepared(prepared)


def test_rejects_image_hash_mismatch(tmp_path: Path) -> None:
    prepared = write_prepared(tmp_path)
    manifest = prepared / "manifests" / "validation.jsonl"
    row = json.loads(manifest.read_text())
    row["pixel_sha256"] = "0" * 64
    manifest.write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="hash|filename"):
        audit_prepared(prepared)


def test_rejects_cross_split_group_leak(tmp_path: Path) -> None:
    prepared = write_prepared(tmp_path)
    manifest = prepared / "manifests" / "validation.jsonl"
    row = json.loads(manifest.read_text())
    row["group_id"] = "group-train"
    manifest.write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="group"):
        audit_prepared(prepared)


def test_rejects_invalid_encoded_presence(tmp_path: Path) -> None:
    prepared = write_prepared(tmp_path)
    manifest = prepared / "manifests" / "validation.jsonl"
    row = json.loads(manifest.read_text())
    row["encoded_presence"] = [1, 0, 0]
    manifest.write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="encoded"):
        audit_prepared(prepared)


def test_rejects_path_traversal(tmp_path: Path) -> None:
    prepared = write_prepared(tmp_path)
    manifest = prepared / "manifests" / "validation.jsonl"
    row = json.loads(manifest.read_text())
    row["image_path"] = "../outside.png"
    manifest.write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="path"):
        audit_prepared(prepared)
