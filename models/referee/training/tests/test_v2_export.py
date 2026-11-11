"""Synthetic, offline v2 export and inference integration test."""

import hashlib
import json

import pytest
import timm
import torch
from PIL import Image, ImageDraw
from referee_data import preprocessing_config, preprocessing_hash

from inference.vit import RefereeViT
from training.export_v2 import export


def test_synthetic_export_reload_and_tamper(tmp_path):
    torch.manual_seed(198173)
    model = timm.create_model(
        "vit_tiny_patch16_224.augreg_in21k_ft_in1k", pretrained=False, num_classes=2
    )
    checkpoint = tmp_path / "best.ckpt"
    provenance = {
        "model_id": "referee-vit-v2",
        "dataset_fingerprint": "synthetic-only",
        "config": {"fast": False},
        "preprocessing_config": preprocessing_config(),
        "preprocessing_hash": preprocessing_hash(),
    }
    torch.save(
        {
            "state_dict": {"model." + k: v for k, v in model.state_dict().items()},
            "hyper_parameters": {"provenance": provenance},
            "callbacks": {"test": {"best_model_score": torch.tensor(0.5)}},
        },
        checkpoint,
    )
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    report = tmp_path / "summary.json"
    report.write_text(
        json.dumps(
            {
                "split": "validation",
                "checkpoint": {"sha256": digest},
                "preprocessing": "referee_foreground",
            }
        ),
        encoding="utf-8",
    )
    result = export(checkpoint, tmp_path / "bundles", report)
    bundle = tmp_path / "bundles" / "referee-vit-v2"
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    included_report = bundle / "evaluation-summary.json"
    assert included_report.read_bytes() == report.read_bytes()
    selection = json.loads(
        (bundle / "checkpoint-selection.json").read_text(encoding="utf-8")
    )
    assert (
        selection["evaluationReportSha256"]
        == manifest["files"]["evaluation-summary.json"]
    )
    assert selection["sourceCheckpointSha256"] == digest
    adapter = RefereeViT(bundle, manifest, ["text", "number"])
    assert (
        adapter.predict(Image.new("RGB", (128, 128), "white"))["status"]
        == "unavailable"
    )
    canvas = Image.new("RGB", (128, 128), "white")
    ImageDraw.Draw(canvas).line((15, 15, 110, 110), fill="black", width=5)
    result_scores = adapter.predict(canvas)
    assert result_scores["status"] == "evidence" and len(result_scores["scores"]) == 2
    assert result["maxLogitDifference"] <= 1e-6
    included_report.write_text("tampered\n", encoding="utf-8")
    with pytest.raises(ValueError, match="hash"):
        RefereeViT(bundle, manifest, ["text", "number"])
    included_report.write_bytes(report.read_bytes())

    # Even a rehashed manifest cannot conceal a report for another checkpoint.
    altered = json.loads(report.read_text(encoding="utf-8"))
    altered["checkpoint"]["sha256"] = "0" * 64
    included_report.write_text(json.dumps(altered), encoding="utf-8")
    new_digest = hashlib.sha256(included_report.read_bytes()).hexdigest()
    selection["evaluationReportSha256"] = new_digest
    (bundle / "checkpoint-selection.json").write_text(
        json.dumps(selection), encoding="utf-8"
    )
    manifest["files"]["evaluation-summary.json"] = new_digest
    manifest["files"]["checkpoint-selection.json"] = hashlib.sha256(
        (bundle / "checkpoint-selection.json").read_bytes()
    ).hexdigest()
    manifest["artifactRevision"] = hashlib.sha256(
        json.dumps(manifest["files"], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    with pytest.raises(ValueError, match="evaluation-mismatch"):
        RefereeViT(bundle, manifest, ["text", "number"])
