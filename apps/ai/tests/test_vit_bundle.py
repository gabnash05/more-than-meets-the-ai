"""Contract tests for the ViT-Tiny serving-bundle loader."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest
from models.guesser.inference import vit

from ai_service.bundles import load_bundle


class DummyAdapter:
    def __init__(self, root: Path, manifest: dict, labels: list[str]):
        self.root = root
        self.manifest = manifest
        self.labels = labels

    def predict(self, image):
        return {"status": "pass", "reason": "no-evidence"}


def write_bundle(root: Path, model_id: str = "test-vit") -> Path:
    bundle = root / model_id
    bundle.mkdir()
    labels = [f"class-{index:03d}" for index in range(345)]
    labels_txt = ("\n".join(labels) + "\n").encode()
    labels_json = (
        json.dumps(
            [
                {"class_id": index, "source_name": name}
                for index, name in enumerate(labels)
            ],
            indent=2,
        )
        + "\n"
    ).encode()
    selection = {
        "backbone": vit.BACKBONE,
        "preprocess_candidate": "foreground",
        "labels_sha256": sha256(labels_json).hexdigest(),
        "num_classes": 345,
        "fast_dev": False,
        "best_model_path": "weights.safetensors",
        "best_model_score": 0.5,
    }
    selection_bytes = (json.dumps(selection, indent=2) + "\n").encode()
    weights = b"dummy weights"
    files = {
        "weights.safetensors": sha256(weights).hexdigest(),
        "labels.txt": sha256(labels_txt).hexdigest(),
        "labels.json": sha256(labels_json).hexdigest(),
        "checkpoint-selection.json": sha256(selection_bytes).hexdigest(),
    }
    manifest = {
        "version": 1,
        "role": "guesser",
        "modelId": model_id,
        "artifactRevision": "revision-1",
        "adapter": "vit-tiny",
        "preprocessing": "foreground",
        "preprocessingConfigHash": "hash",
        "input": [1, 3, 224, 224],
        "output": [1, 345],
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


def update_hash(bundle: Path, name: str) -> None:
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][name] = sha256((bundle / name).read_bytes()).hexdigest()
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def test_vit_bundle_reports_ready(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "ViTTiny", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    bundle = load_bundle("guesser", "test-vit", tmp_path)

    assert bundle.readiness()["status"] == "ready"
    assert bundle.model_id == "test-vit"
    assert bundle.revision == "revision-1"
    assert bundle.labels == [f"class-{index:03d}" for index in range(345)]
    assert bundle.adapter is not None
    assert bundle.adapter.root == bundle_path


def test_vit_bundle_requires_labels_json_in_manifest(tmp_path):
    bundle_path = write_bundle(tmp_path)
    manifest_path = bundle_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["files"]["labels.json"]
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )

    bundle = load_bundle("guesser", "test-vit", tmp_path)
    assert bundle.reason == "vit-contract-mismatch"
    assert bundle.adapter is None


def test_vit_bundle_missing_labels_json_file(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "ViTTiny", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    (bundle_path / "labels.json").unlink()

    bundle = load_bundle("guesser", "test-vit", tmp_path)
    assert bundle.reason == "bundle-file-missing"
    assert bundle.adapter is None


def test_vit_bundle_rejects_hash_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "ViTTiny", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    (bundle_path / "weights.safetensors").write_bytes(b"changed")

    bundle = load_bundle("guesser", "test-vit", tmp_path)
    assert bundle.reason == "artifact-hash-mismatch"
    assert bundle.adapter is None


def test_vit_bundle_rejects_label_order_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "ViTTiny", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    labels_json = json.loads(
        (bundle_path / "labels.json").read_text(encoding="utf-8")
    )
    labels_json[0], labels_json[1] = labels_json[1], labels_json[0]
    (bundle_path / "labels.json").write_text(
        json.dumps(labels_json, indent=2) + "\n", encoding="utf-8"
    )
    update_hash(bundle_path, "labels.json")

    bundle = load_bundle("guesser", "test-vit", tmp_path)
    assert bundle.reason == "invalid-label-order"
    assert bundle.adapter is None


def test_vit_bundle_rejects_malformed_labels_json(tmp_path, monkeypatch):
    monkeypatch.setattr(vit, "ViTTiny", DummyAdapter)
    bundle_path = write_bundle(tmp_path)
    (bundle_path / "labels.json").write_text("not json\n", encoding="utf-8")
    update_hash(bundle_path, "labels.json")

    bundle = load_bundle("guesser", "test-vit", tmp_path)
    assert bundle.reason == "invalid-label-order"
    assert bundle.adapter is None


def test_validate_selection_uses_labels_json_hash():
    manifest = {
        "preprocessing": "foreground",
        "files": {
            "labels.json": "labels-json-hash",
            "labels.txt": "labels-txt-hash",
        },
    }
    selection = {
        "backbone": vit.BACKBONE,
        "preprocess_candidate": "foreground",
        "labels_sha256": "labels-json-hash",
        "num_classes": 345,
        "fast_dev": False,
        "best_model_path": "weights.safetensors",
        "best_model_score": 0.5,
    }
    vit.validate_selection(selection, manifest, ["label"] * 345)

    with pytest.raises(ValueError, match="checkpoint-selection-mismatch"):
        vit.validate_selection(
            {**selection, "labels_sha256": "labels-txt-hash"},
            manifest,
            ["label"] * 345,
        )


def test_configure_cpu_threads_uses_available_cpu_count(monkeypatch):
    monkeypatch.setattr(
        vit,
        "os",
        SimpleNamespace(
            process_cpu_count=lambda: 6,
            cpu_count=lambda: 4,
        ),
        raising=False,
    )
    configured = []

    vit._configure_cpu_threads(configured.append)

    assert configured == [6]


def test_configure_cpu_threads_falls_back_to_one(monkeypatch):
    monkeypatch.setattr(
        vit,
        "os",
        SimpleNamespace(
            process_cpu_count=lambda: None,
            cpu_count=lambda: None,
        ),
        raising=False,
    )
    configured = []

    vit._configure_cpu_threads(configured.append)

    assert configured == [1]


def test_configure_cpu_threads_falls_back_to_system_cpu_count(monkeypatch):
    monkeypatch.setattr(
        vit,
        "os",
        SimpleNamespace(
            process_cpu_count=lambda: None,
            cpu_count=lambda: 4,
        ),
        raising=False,
    )
    configured = []

    vit._configure_cpu_threads(configured.append)

    assert configured == [4]
