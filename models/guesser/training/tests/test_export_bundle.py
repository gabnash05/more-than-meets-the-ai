"""Synthetic contract tests for the ViT-Tiny serving-bundle exporter."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
import timm
import torch
from training import export_bundle


def write_labels(root: Path) -> Path:
    labels = [
        {"class_id": index, "source_name": f"class-{index:03d}"}
        for index in range(345)
    ]
    path = root / "labels.json"
    path.write_text(json.dumps(labels, indent=2) + "\n", encoding="utf-8")
    return path


def write_selection(
    run_dir: Path,
    checkpoint: Path,
    labels_path: Path,
    *,
    labels_sha256: str | None = None,
) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    selection = {
        "run": "A_complete_only",
        "complete_only": True,
        "seed": 198173,
        "prepared_dir": str(run_dir / "prepared"),
        "backbone": export_bundle.BACKBONE,
        "preprocess_candidate": "foreground",
        "num_classes": 345,
        "monitor": "val_acc",
        "best_model_path": str(checkpoint),
        "best_model_score": 0.5,
        "last_model_path": None,
        "resumed_from": None,
        "fast_dev": False,
        "labels_path": str(labels_path),
        "labels_sha256": labels_sha256
        or hashlib.sha256(labels_path.read_bytes()).hexdigest(),
    }
    path = run_dir / "checkpoint-selection.json"
    path.write_text(json.dumps(selection, indent=2) + "\n", encoding="utf-8")
    return path


def write_checkpoint(path: Path) -> Path:
    model = timm.create_model(
        export_bundle.BACKBONE, pretrained=False, num_classes=345
    )
    state = {
        f"model.{key}": value.detach().clone()
        for key, value in model.state_dict().items()
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": state}, path)
    return path


def export_args(checkpoint_root: Path, output_dir: Path, *extra: str):
    return export_bundle.parse_args(
        [
            "--checkpoint-root",
            str(checkpoint_root),
            "--run",
            "a",
            "--output-dir",
            str(output_dir),
            *extra,
        ]
    )


def test_export_writes_hashed_bundle_and_sanitizes_selection(tmp_path):
    labels_path = write_labels(tmp_path)
    checkpoint = write_checkpoint(tmp_path / "weights.ckpt")
    run_dir = tmp_path / "A_complete_only"
    write_selection(run_dir, checkpoint, labels_path)
    output_dir = tmp_path / "bundles"

    summary = export_bundle.export_run(
        "a", export_args(tmp_path, output_dir, "--model-id", "guesser-vit-a-v1")
    )

    bundle = output_dir / "guesser-vit-a-v1"
    assert summary["modelId"] == "guesser-vit-a-v1"
    assert summary["parity"]["fixedTensor"] == {
        "maxAbsDiff": 0.0,
        "top1Match": True,
    }
    assert set(summary["files"]) == set(export_bundle.BUNDLE_FILES)
    assert {path.name for path in bundle.iterdir()} == {
        *export_bundle.BUNDLE_FILES,
        "manifest.json",
    }
    manifest = json.loads(
        (bundle / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["files"] == summary["files"]
    assert manifest["artifactRevision"] == summary["artifactRevision"]
    assert (
        export_bundle._artifact_revision(manifest["files"])
        == manifest["artifactRevision"]
    )
    assert manifest["output"] == [1, 345]
    assert manifest["preprocessingConfigHash"]
    for name, digest in manifest["files"].items():
        assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == digest

    labels = (bundle / "labels.txt").read_text(encoding="utf-8").splitlines()
    assert labels == [f"class-{index:03d}" for index in range(345)]
    assert (bundle / "labels.json").read_bytes() == labels_path.read_bytes()

    selection = json.loads(
        (bundle / "checkpoint-selection.json").read_text(encoding="utf-8")
    )
    assert selection["best_model_path"] == "weights.safetensors"
    assert selection["last_model_path"] is None
    assert selection["labels_path"] == "labels.json"
    assert selection["prepared_dir"] is None
    assert selection["sourceBestModelFile"] == checkpoint.name
    assert selection["labels_sha256"] == manifest["files"]["labels.json"]
    assert (
        json.loads((run_dir / "checkpoint-selection.json").read_text())[
            "best_model_path"
        ]
        == str(checkpoint)
    )


def test_existing_bundle_is_skipped_without_overwrite(tmp_path):
    labels_path = write_labels(tmp_path)
    checkpoint = write_checkpoint(tmp_path / "weights.ckpt")
    write_selection(tmp_path / "A_complete_only", checkpoint, labels_path)
    output_dir = tmp_path / "bundles"
    args = export_args(tmp_path, output_dir, "--model-id", "guesser-vit-a-v1")

    first = export_bundle.export_run("a", args)
    assert first["status"] == "exported"
    bundle = output_dir / "guesser-vit-a-v1"
    manifest_before = (bundle / "manifest.json").read_bytes()

    second = export_bundle.export_run("a", args)
    assert second["status"] == "skipped-existing"
    assert second["bundle"] == first["bundle"]
    assert (
        second["message"]
        == "bundle already exists; pass --overwrite to replace it"
    )
    assert (bundle / "manifest.json").read_bytes() == manifest_before
    assert not any(path.name.endswith(".part") for path in output_dir.iterdir())

    overwrite_args = export_args(
        tmp_path, output_dir, "--model-id", "guesser-vit-a-v1", "--overwrite"
    )
    third = export_bundle.export_run("a", overwrite_args)
    assert third["status"] == "exported"
    assert (bundle / "manifest.json").is_file()


def test_cli_skips_existing_bundle_without_error(tmp_path, capsys):
    labels_path = write_labels(tmp_path)
    checkpoint = write_checkpoint(tmp_path / "weights.ckpt")
    write_selection(tmp_path / "A_complete_only", checkpoint, labels_path)
    output_dir = tmp_path / "bundles"
    argv = [
        "--checkpoint-root",
        str(tmp_path),
        "--run",
        "a",
        "--model-id",
        "guesser-vit-a-v1",
        "--output-dir",
        str(output_dir),
    ]

    export_bundle.main(argv)
    capsys.readouterr()
    export_bundle.main(argv)
    summary = json.loads(capsys.readouterr().out)

    assert summary["bundles"][0]["status"] == "skipped-existing"


def test_publish_does_not_replace_existing_bundle(tmp_path):
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "new").write_text("new", encoding="utf-8")
    final = tmp_path / "final"
    final.mkdir()
    (final / "old").write_text("old", encoding="utf-8")

    assert export_bundle._publish(staging, final, False) is False
    assert (final / "old").read_text(encoding="utf-8") == "old"
    assert (staging / "new").is_file()


def test_failed_verification_does_not_publish(tmp_path, monkeypatch):
    labels_path = write_labels(tmp_path)
    checkpoint = write_checkpoint(tmp_path / "weights.ckpt")
    write_selection(tmp_path / "A_complete_only", checkpoint, labels_path)
    output_dir = tmp_path / "bundles"
    args = export_args(tmp_path, output_dir, "--model-id", "guesser-vit-a-v1")

    def fail(*args, **kwargs):
        raise ValueError("parity failed")

    monkeypatch.setattr(export_bundle, "_verify_bundle", fail)
    with pytest.raises(ValueError, match="parity failed"):
        export_bundle.export_run("a", args)
    assert not (output_dir / "guesser-vit-a-v1").exists()
    assert not any(path.name.endswith(".part") for path in output_dir.iterdir())


def test_state_dict_requires_model_prefix(tmp_path):
    path = tmp_path / "weights.ckpt"
    torch.save({"state_dict": {"head.weight": torch.zeros(1)}}, path)
    with pytest.raises(ValueError, match="model"):
        export_bundle._load_state_dict(path)

    torch.save({"state_dict": {}}, path)
    with pytest.raises(ValueError, match="state_dict"):
        export_bundle._load_state_dict(path)


def test_labels_reject_invalid_entries(tmp_path):
    labels_path = tmp_path / "labels.json"

    def write(entries):
        labels_path.write_text(
            json.dumps(entries) + "\n", encoding="utf-8"
        )

    entries = [
        {"class_id": index, "source_name": f"class-{index:03d}"}
        for index in range(345)
    ]

    write(entries[:344])
    with pytest.raises(ValueError, match="345"):
        export_bundle._load_labels(labels_path)

    swapped = list(entries)
    swapped[0], swapped[1] = swapped[1], swapped[0]
    write(swapped)
    with pytest.raises(ValueError, match="class_id"):
        export_bundle._load_labels(labels_path)

    duplicate = [
        {"class_id": index, "source_name": "same"}
        for index in range(345)
    ]
    write(duplicate)
    with pytest.raises(ValueError, match="unique"):
        export_bundle._load_labels(labels_path)

    empty = list(entries)
    empty[0] = {"class_id": 0, "source_name": "  "}
    write(empty)
    with pytest.raises(ValueError, match="non-empty"):
        export_bundle._load_labels(labels_path)


def test_fixed_tensor_comparison_requires_matching_models():
    class Fixed(torch.nn.Module):
        def forward(self, batch):
            return torch.zeros((1, 345))

    batch = torch.zeros((1, 3, 224, 224))
    assert export_bundle._compare_models(Fixed(), Fixed(), batch) == (
        0.0,
        True,
    )
