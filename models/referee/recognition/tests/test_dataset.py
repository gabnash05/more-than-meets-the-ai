import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from recognition.dataset import RefereeEvaluationDataset


def _prepared(tmp_path: Path) -> Path:
    prepared = tmp_path / "sample" / "prepared"
    (prepared / "manifests").mkdir(parents=True)
    (prepared / "images").mkdir()
    pixels = np.full((512, 512), 255, dtype=np.uint8)
    pixels[100:200, 100:200] = 0
    digest = hashlib.sha256(pixels.tobytes()).hexdigest()
    Image.fromarray(pixels, mode="L").save(prepared / "images" / f"{digest}.png")
    row = {
        "sample_id": "sample-1",
        "image_path": f"images/{digest}.png",
        "pixel_sha256": digest,
        "group_id": "group-1",
        "split": "validation",
        "encoded_presence": [1, 0, 0, 1],
        "text_present": 1,
        "number_present": None,
        "known_mask": [True, False],
        "label_origin": ["reviewed", "unreviewed_proxy"],
    }
    (prepared / "manifests" / "validation.jsonl").write_text(json.dumps(row) + "\n")
    return prepared


def test_rgb_resize_returns_a_model_tensor(tmp_path: Path) -> None:
    dataset = RefereeEvaluationDataset(_prepared(tmp_path), "validation", "rgb_resize")
    sample = dataset[0]
    assert tuple(sample["image"].shape) == (3, 224, 224)
    assert tuple(sample["encoded"].shape) == (4,)
    assert sample["known"].tolist() == [True, False]
    assert np.isnan(sample["labels"][1].item())


def test_foreground_returns_a_status_and_tensor_or_none(tmp_path: Path) -> None:
    dataset = RefereeEvaluationDataset(_prepared(tmp_path), "validation", "foreground")
    sample = dataset[0]
    assert sample["status"] in {"ok", "blank", "uncertain"}
    if sample["status"] == "ok":
        assert tuple(sample["image"].shape) == (3, 224, 224)
    else:
        assert sample["image"] is None


def test_rejects_missing_image(tmp_path: Path) -> None:
    prepared = _prepared(tmp_path)
    row = json.loads((prepared / "manifests" / "validation.jsonl").read_text())
    row["image_path"] = "images/missing.png"
    (prepared / "manifests" / "validation.jsonl").write_text(json.dumps(row) + "\n")
    with pytest.raises(FileNotFoundError):
        RefereeEvaluationDataset(prepared, "validation", "rgb_resize")[0]


def test_rejects_unknown_preprocessing(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        RefereeEvaluationDataset(_prepared(tmp_path), "validation", "imagenet")
