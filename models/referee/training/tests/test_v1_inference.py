"""Offline legacy adapter regression with a synthetic four-output model."""

import json

import timm
import torch
from PIL import Image
from safetensors.torch import save_file

from inference.vit import BACKBONE, RefereeViT, preprocessing_hash


def test_v1_rgb_bundle_loads_and_predicts(tmp_path):
    torch.manual_seed(198173)
    model = timm.create_model(BACKBONE, pretrained=False, num_classes=4)
    save_file(model.state_dict(), tmp_path / "weights.safetensors")
    labels = ["text", "number", "symbol", "circle"]
    selection = {
        "backbone": BACKBONE,
        "preprocess_candidate": "rgb_resize",
        "labels_sha256": "synthetic-label-hash",
        "num_classes": 4,
        "fast_dev": False,
        "best_model_path": "weights.safetensors",
        "best_model_score": 0.5,
    }
    (tmp_path / "checkpoint-selection.json").write_text(
        json.dumps(selection), encoding="utf-8"
    )
    manifest = {
        "version": 1,
        "role": "referee",
        "adapter": "vit-tiny-referee",
        "preprocessing": "rgb_resize",
        "preprocessingConfigHash": preprocessing_hash("rgb_resize"),
        "input": [1, 3, 224, 224],
        "output": [1, 4],
        "labelOrder": labels,
        "channelOrder": labels[:2],
        "scoreActivation": "sigmoid",
        "files": {"labels.json": "synthetic-label-hash"},
    }
    adapter = RefereeViT(tmp_path, manifest, labels)
    result = adapter.predict(Image.new("RGB", (32, 32), "white"))
    assert result["status"] == "evidence"
    assert len(result["scores"]) == 2
    assert all(0 <= score <= 1 for score in result["scores"])
