"""Contract tests for the packaged Referee serving bundle."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

from ai_service.bundles import load_bundle

from models.referee.inference import vit

LABELS = ["text", "number", "symbol", "circle"]


class DummyAdapter:
    def __init__(self, root: Path, manifest: dict, labels: list[str]):
        self.root = root
        self.manifest = manifest
        self.labels = labels

    def predict(self, image):
        return {"status": "evidence", "scores": [0.2, 0.1]}


def write_bundle(root: Path, model_id: str = "referee-vit-a-v1") -> Path:
    bundle = root / model_id
    bundle.mkdir()
    labels_txt = ("\n".join(LABELS) + "\n").encode()
    labels_json = (
        json.dumps(
            [{"class_id": index, "source_name": name} for index, name in enumerate(LABELS)],
            indent=2,
        )
        + "\n"
    ).encode()
    selection = {
        "backbone": vit.BACKBONE,
        "preprocess_candidate": "rgb_resize",
        "labels_sha256": sha256(labels_json).hexdigest(),
        "num_classes": 4,
        "fast_dev": False,
        "best_model_path": "weights.safetensors",
        "best_model_score": 0.5564,
    }
    selection_bytes = (json.dumps(selection, indent=2) + "\n").encode()
    weights = b"dummy referee weights"
    files = {
        "weights.safetensors": sha256(weights).hexdigest(),
        "labels.txt": sha256(labels_txt).hexdigest(),
        "labels.json": sha256(labels_json).hexdigest(),
        "checkpoint-selection.json": sha256(selection_bytes).hexdigest(),
    }
    manifest = {
        "version": 1,
        "role": "referee",
        "modelId": model_id,
        "artifactRevision": "revision-1",
        "adapter": "vit-tiny-referee",
        "backbone": vit.BACKBONE,
        "preprocessing": "rgb_resize",
        "preprocessingConfigHash": vit.preprocessing_hash("rgb_resize"),
        "input": [1, 3, 224, 224],
        "output": [1, 4],
        "labelOrder": LABELS,
        "channelOrder": ["text", "number"],
        "scoreActivation": "sigmoid",
        "files": files,
    }
    (bundle / "weights.safetensors").write_bytes(weights)
    (bundle / "labels.txt").write_bytes(labels_txt)
    (bundle / "labels.json").write_bytes(labels_json)
    (bundle / "checkpoint-selection.json").write_bytes(selection_bytes)
    (bundle / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return bundle


def test_referee_bundle_reports_ready(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "RefereeViT", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    bundle = load_bundle("referee", "referee-vit-a-v1", tmp_path)

    assert bundle.readiness()["status"] == "ready"
    assert bundle.model_id == "referee-vit-a-v1"
    assert bundle.revision == "revision-1"
    assert bundle.labels == LABELS
    assert bundle.adapter.root == bundle_path


def test_referee_bundle_rejects_missing_labels_json(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "RefereeViT", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    manifest = json.loads((bundle_path / "manifest.json").read_text(encoding="utf-8"))
    del manifest["files"]["labels.json"]
    (bundle_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    bundle = load_bundle("referee", "referee-vit-a-v1", tmp_path)
    assert bundle.reason == "referee-contract-mismatch"
    assert bundle.adapter is None


def test_referee_bundle_rejects_hash_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "RefereeViT", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    (bundle_path / "weights.safetensors").write_bytes(b"changed")

    bundle = load_bundle("referee", "referee-vit-a-v1", tmp_path)
    assert bundle.reason == "artifact-hash-mismatch"
    assert bundle.adapter is None


def test_referee_bundle_rejects_label_order(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "RefereeViT", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    (bundle_path / "labels.txt").write_text("number\ntext\nsymbol\ncircle\n", encoding="utf-8")
    manifest = json.loads((bundle_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["files"]["labels.txt"] = sha256((bundle_path / "labels.txt").read_bytes()).hexdigest()
    (bundle_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    bundle = load_bundle("referee", "referee-vit-a-v1", tmp_path)
    assert bundle.reason == "invalid-label-order"
    assert bundle.adapter is None
