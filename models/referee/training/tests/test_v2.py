"""Regression checks for v2 labels, masking, and provenance."""

import json

import pytest
import torch
from PIL import Image, ImageDraw

from training.dataset import RefereeDataset
from training.module import RefereeViTModule
from training.train import dataset_fingerprint


def make_dataset(tmp_path, rows):
    (tmp_path / "manifests").mkdir()
    (tmp_path / "images").mkdir()
    for i, row in enumerate(rows):
        image = Image.new("RGB", (100, 100), "white")
        ImageDraw.Draw(image).line((10, 10, 80, 80), fill="black", width=4)
        image.save(tmp_path / "images" / f"{i}.png")
        row["image_path"] = f"images/{i}.png"
    for split in ("train", "validation"):
        (tmp_path / "manifests" / f"{split}.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8"
        )


def test_masked_loss_ignores_unknown_and_empty():
    logits = torch.tensor([[0.0, 10.0], [-2.0, 1.0]], requires_grad=True)
    targets = torch.tensor([[1.0, 0.0], [0.0, 1.0]])
    mask = torch.tensor([[True, False], [False, True]])
    loss = RefereeViTModule.masked_loss(logits, targets, mask)
    expected = torch.nn.functional.binary_cross_entropy_with_logits(
        logits[mask], targets[mask]
    )
    assert torch.allclose(loss, expected)
    loss.backward()
    assert logits.grad[0, 1] == 0 and logits.grad[1, 0] == 0
    assert RefereeViTModule.masked_loss(logits, targets, torch.zeros_like(mask)) is None


def test_loader_excludes_unknown_and_rejects_missing(tmp_path):
    rows = [
        {"text_present": 1, "number_present": None, "known_mask": [True, False]},
        {"text_present": None, "number_present": None, "known_mask": [False, False]},
    ]
    make_dataset(tmp_path, rows)
    dataset = RefereeDataset(str(tmp_path))
    assert len(dataset) == 1
    assert dataset[0]["known_mask"].tolist() == [True, False]
    (tmp_path / "images" / "1.png").unlink()
    with pytest.raises(FileNotFoundError):
        RefereeDataset(str(tmp_path))


def test_fingerprint_changes_with_training_image(tmp_path):
    make_dataset(
        tmp_path, [{"text_present": 1, "number_present": 0, "known_mask": [True, True]}]
    )
    before = dataset_fingerprint(tmp_path)
    Image.new("RGB", (10, 10), "white").save(tmp_path / "images" / "0.png")
    assert dataset_fingerprint(tmp_path) != before


@pytest.mark.parametrize(
    "logits,targets,mask",
    [
        ([[float("nan"), 0.0]], [[0.0, 0.0]], [[1, 1]]),
        ([[0.0, 0.0]], [[float("inf"), 0.0]], [[1, 1]]),
        ([[0.0, 0.0]], [[2.0, 0.0]], [[1, 1]]),
        ([[0.0, 0.0]], [[0.0, 0.0]], [[2, 1]]),
        ([[0.0]], [[0.0]], [[1]]),
    ],
)
def test_masked_loss_rejects_invalid_values(logits, targets, mask):
    with pytest.raises(ValueError):
        RefereeViTModule.masked_loss(
            torch.tensor(logits), torch.tensor(targets), torch.tensor(mask)
        )


def test_boolean_known_label_is_rejected(tmp_path):
    make_dataset(
        tmp_path,
        [{"text_present": True, "number_present": 0, "known_mask": [True, True]}],
    )
    with pytest.raises(ValueError):
        RefereeDataset(str(tmp_path))


def test_excluded_unknown_is_reported(tmp_path):
    make_dataset(
        tmp_path,
        [
            {
                "text_present": 1,
                "number_present": 0,
                "known_mask": [True, True],
                "sample_id": "known",
            },
            {
                "text_present": None,
                "number_present": None,
                "known_mask": [False, False],
                "sample_id": "unknown",
            },
        ],
    )
    dataset = RefereeDataset(str(tmp_path))
    assert dataset.excluded["unknown"] == ["unknown"]


def test_affine_uses_normalized_white(tmp_path, monkeypatch):
    from referee_data import preprocessing_config
    from torchvision.transforms import v2

    seen = {}

    class Capture:
        def __init__(self, **kwargs):
            seen.update(kwargs)

        def __call__(self, image):
            return image

    monkeypatch.setattr(v2, "RandomAffine", Capture)
    make_dataset(
        tmp_path, [{"text_present": 1, "number_present": 0, "known_mask": [True, True]}]
    )
    RefereeDataset(str(tmp_path), augment=True)[0]
    config = preprocessing_config()["foreground"]
    assert seen["fill"] == (1.0 - config["mean"]) / config["std"]
