"""Contract and orchestration tests for the ten-stage evaluation runner."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import torch
from guesser_data.common import load_step
from recognition import evaluate
from training.export_bundle import BACKBONE, BUNDLE_FILES


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_bundle(root: Path, model_id: str) -> Path:
    bundle = root / model_id
    bundle.mkdir(parents=True)
    labels = [f"class-{index:03d}" for index in range(345)]
    labels_json = [
        {"class_id": index, "source_name": label} for index, label in enumerate(labels)
    ]
    (bundle / "weights.safetensors").write_bytes(b"not-a-real-model")
    (bundle / "labels.txt").write_text("\n".join(labels) + "\n", encoding="utf-8")
    (bundle / "labels.json").write_text(
        json.dumps(labels_json, indent=2) + "\n", encoding="utf-8"
    )
    selection = {
        "backbone": BACKBONE,
        "preprocess_candidate": "foreground",
        "labels_sha256": _sha256(bundle / "labels.json"),
        "num_classes": 345,
        "fast_dev": False,
        "best_model_path": "weights.safetensors",
        "best_model_score": 0.5,
    }
    (bundle / "checkpoint-selection.json").write_text(
        json.dumps(selection, indent=2) + "\n", encoding="utf-8"
    )
    files = {name: _sha256(bundle / name) for name in BUNDLE_FILES}
    images = load_step("06-images")
    manifest = {
        "version": 1,
        "role": "guesser",
        "modelId": model_id,
        "adapter": "vit-tiny",
        "input": [1, 3, 224, 224],
        "output": [1, 345],
        "preprocessing": "foreground",
        "preprocessingConfigHash": images.candidate_hash("foreground"),
        "artifactRevision": evaluate._artifact_revision(files),
        "files": files,
    }
    (bundle / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return bundle


def test_validate_bundle_accepts_a_complete_contract(tmp_path: Path) -> None:
    root = write_bundle(tmp_path, "guesser-vit-a-v1")

    bundle = evaluate.validate_bundle(root)

    assert bundle.model_id == "guesser-vit-a-v1"
    assert bundle.labels[0] == "class-000"
    assert bundle.weights_sha256 == _sha256(root / "weights.safetensors")
    assert bundle.preprocessing == "foreground"


def test_validate_bundle_rejects_changed_weights(tmp_path: Path) -> None:
    root = write_bundle(tmp_path, "guesser-vit-a-v1")
    (root / "weights.safetensors").write_bytes(b"changed")

    with pytest.raises(ValueError, match="artifact hash mismatch"):
        evaluate.validate_bundle(root)


def test_validate_bundle_rejects_a_mismatched_directory_name(
    tmp_path: Path,
) -> None:
    root = write_bundle(tmp_path, "guesser-vit-a-v1")
    renamed = root.with_name("guesser-vit-b-v1")
    root.rename(renamed)

    with pytest.raises(ValueError, match="does not match"):
        evaluate.validate_bundle(renamed)


def test_select_subset_is_balanced_and_repeatable() -> None:
    classes = [class_id for class_id in range(345) for _ in range(3)]

    first = evaluate._select_subset(classes, 2, 198173, "a" * 64)
    second = evaluate._select_subset(classes, 2, 198173, "a" * 64)

    assert first == second
    assert first["originals"] == 690
    assert first["views"] == 6900
    assert set(first["perClass"].values()) == {2}
    assert all(len(indices) == 2 for indices in first["indices"].values())


def test_select_subset_can_keep_every_original() -> None:
    classes = [class_id for class_id in range(345) for _ in range(3)]

    subset = evaluate._select_subset(classes, None, 7, "b" * 64)

    assert subset["originals"] == 1035
    assert set(subset["perClass"].values()) == {3}


def test_prepare_output_dir_allows_an_empty_existing_directory(
    tmp_path: Path,
) -> None:
    output = tmp_path / "run"
    (output / "predictions").mkdir(parents=True)

    evaluate._prepare_output_dir(output, overwrite=False, resume=False)

    assert (output / "predictions").is_dir()
    assert (output / "logits").is_dir()
    assert (output / "confusions").is_dir()


def test_prepare_output_dir_rejects_existing_run_files(tmp_path: Path) -> None:
    output = tmp_path / "run"
    output.mkdir()
    (output / "subset.json").write_text("{}", encoding="utf-8")

    with pytest.raises(FileExistsError, match="exists"):
        evaluate._prepare_output_dir(output, overwrite=False, resume=False)


def test_prepare_output_dir_overwrite_removes_a_previous_run(
    tmp_path: Path,
) -> None:
    output = tmp_path / "run"
    output.mkdir()
    (output / "subset.json").write_text("{}", encoding="utf-8")

    evaluate._prepare_output_dir(output, overwrite=True, resume=False)

    assert not (output / "subset.json").exists()
    assert (output / "predictions").is_dir()


def test_parse_args_defaults_and_guards() -> None:
    args = evaluate.parse_args([])
    assert args.split == "validation"
    assert args.limit_per_class == 50
    assert args.save_logits is True
    assert args.model_id == list(evaluate.DEFAULT_MODEL_IDS)
    assert args.output_dir == args.bundle_root.parent / "evaluation" / "ten-stage"

    assert evaluate.parse_args(["--full"]).limit_per_class is None

    with pytest.raises(ValueError, match="non-negative"):
        evaluate.parse_args(["--bootstrap", "-1"])
    with pytest.raises(ValueError, match="requires --save-logits"):
        evaluate.parse_args(["--split", "test", "--no-save-logits"])
    with pytest.raises(ValueError, match="only valid with --split test"):
        evaluate.parse_args(["--freeze-record", "freeze.json"])
    with pytest.raises(ValueError, match="mutually exclusive"):
        evaluate.parse_args(["--overwrite", "--resume"])


def test_test_guard_pins_hashes_temperature_and_threshold(
    tmp_path: Path,
) -> None:
    root = write_bundle(tmp_path, "guesser-vit-a-v1")
    bundle = evaluate.validate_bundle(root)
    report = tmp_path / "report.md"
    report.write_text("validation report\n", encoding="utf-8")
    freeze = {
        "schema": "guesser-ten-stage-freeze-v1",
        "validationReportSha256": _sha256(report),
        "models": {
            bundle.model_id: {
                "artifactRevision": bundle.artifact_revision,
                "weightsSha256": bundle.weights_sha256,
                "labelsSha256": bundle.labels_sha256,
                "preprocessing": bundle.preprocessing,
                "preprocessingHash": bundle.preprocessing_hash,
                "temperature": 1.25,
                "threshold": 0.5,
            }
        },
    }
    freeze_path = tmp_path / "freeze.json"
    freeze_path.write_text(json.dumps(freeze), encoding="utf-8")
    args = evaluate.parse_args(
        [
            "--split",
            "test",
            "--freeze-record",
            str(freeze_path),
            "--validation-report",
            str(report),
        ]
    )

    assert evaluate._check_test_guard(args, [bundle]) == freeze

    with pytest.raises(ValueError, match="requires --freeze-record"):
        evaluate._check_test_guard(evaluate.parse_args(["--split", "test"]), [bundle])

    report.write_text("changed\n", encoding="utf-8")
    with pytest.raises(ValueError, match="does not match the freeze record"):
        evaluate._check_test_guard(args, [bundle])


def test_test_guard_requires_frozen_temperature_and_threshold(
    tmp_path: Path,
) -> None:
    root = write_bundle(tmp_path, "guesser-vit-a-v1")
    bundle = evaluate.validate_bundle(root)
    report = tmp_path / "report.md"
    report.write_text("validation report\n", encoding="utf-8")
    freeze = {
        "schema": "guesser-ten-stage-freeze-v1",
        "validationReportSha256": _sha256(report),
        "models": {
            bundle.model_id: {
                "artifactRevision": bundle.artifact_revision,
                "weightsSha256": bundle.weights_sha256,
                "labelsSha256": bundle.labels_sha256,
                "preprocessing": bundle.preprocessing,
                "preprocessingHash": bundle.preprocessing_hash,
                "temperature": 1.25,
            }
        },
    }
    freeze_path = tmp_path / "freeze.json"
    freeze_path.write_text(json.dumps(freeze), encoding="utf-8")
    args = evaluate.parse_args(
        [
            "--split",
            "test",
            "--freeze-record",
            str(freeze_path),
            "--validation-report",
            str(report),
        ]
    )

    with pytest.raises(ValueError, match="threshold is missing"):
        evaluate._check_test_guard(args, [bundle])


class FixedModel(torch.nn.Module):
    def __init__(self, classes: int = 3) -> None:
        super().__init__()
        self.classes = classes

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        return torch.zeros((images.shape[0], self.classes), dtype=torch.float32)


def test_flush_updates_pending_rows_and_logits(tmp_path: Path) -> None:
    bundle = evaluate.Bundle(
        root=tmp_path,
        model_id="model",
        artifact_revision="revision",
        labels=["cat", "dog", "bird"],
        preprocessing="foreground",
        preprocessing_hash="hash",
        weights_sha256="weights",
        labels_sha256="labels",
        manifest={},
    )
    rows = [
        {"classId": 0},
        {"classId": 1},
    ]
    pending = {"model": [(rows[0], 0), (rows[1], 1)]}
    images = [
        np.zeros((3, 2, 2), dtype=np.float32),
        np.ones((3, 2, 2), dtype=np.float32),
    ]
    logits = np.memmap(
        tmp_path / "logits.npy",
        dtype=np.float32,
        mode="w+",
        shape=(2, 3),
    )

    evaluate._flush(
        torch.from_numpy(np.stack(images)),
        np.asarray([0, 1], dtype=np.int64),
        pending,
        [bundle],
        {"model": FixedModel()},
        torch.device("cpu"),
        {"model": logits},
    )

    assert rows[0]["top1Id"] == 0
    assert rows[0]["top1Correct"] is True
    assert rows[1]["top1Id"] == 0
    assert rows[1]["top1Correct"] is False
    assert rows[0]["top3Ids"] == [0, 1, 2]
    assert rows[0]["top3Correct"] is True
    assert np.allclose(np.asarray(logits), 0.0)
    assert pending["model"] == []


def test_flush_with_no_images_is_a_noop(tmp_path: Path) -> None:
    bundle = evaluate.Bundle(
        root=tmp_path,
        model_id="model",
        artifact_revision="revision",
        labels=["cat", "dog", "bird"],
        preprocessing="foreground",
        preprocessing_hash="hash",
        weights_sha256="weights",
        labels_sha256="labels",
        manifest={},
    )
    pending = {"model": []}

    evaluate._flush(
        None,
        np.empty(0, dtype=np.int64),
        pending,
        [bundle],
        {"model": FixedModel()},
        torch.device("cpu"),
        None,
    )

    assert pending == {"model": []}


def test_calibrated_probabilities_zero_out_unusable_views(
    tmp_path: Path,
) -> None:
    logits = np.memmap(
        tmp_path / "logits.npy",
        dtype=np.float32,
        mode="w+",
        shape=(4, 3),
    )
    logits[:] = np.array(
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 1.0]],
        dtype=np.float32,
    )
    status_ok = np.array([[True, False], [True, True]])

    probabilities = evaluate._calibrated_probabilities(
        logits, temperature=1.0, status_ok=status_ok
    )

    assert probabilities.shape == (2, 2)
    assert probabilities[0, 1] == 0.0
    assert probabilities[0, 0] == pytest.approx(np.exp(1.0) / (np.exp(1.0) + 2))
    assert probabilities[1, 0] == pytest.approx(np.exp(1.0) / (np.exp(1.0) + 2))
    assert probabilities[1, 1] == pytest.approx(1 / 3)


def test_comparison_without_bootstrap_reports_observed_deltas() -> None:
    class_ids = np.array([0, 0, 1, 1], dtype=np.int64)
    correct_a = np.zeros((4, 10), dtype=bool)
    correct_b = np.ones((4, 10), dtype=bool)

    comparison = evaluate._comparison(
        ["a", "b"],
        {"a": correct_a, "b": correct_b},
        class_ids,
        2,
        bootstrap=0,
        seed=1,
    )

    assert comparison is not None
    assert comparison["earlyDelta"] == 1.0
    assert comparison["completeDelta"] == 1.0
    assert comparison["earlyDeltaLow"] is None
    assert comparison["earlyDeltaHigh"] is None
    assert comparison["goalMet"] is True


def test_comparison_without_bootstrap_keeps_a_loss_negative() -> None:
    class_ids = np.array([0, 0, 1, 1], dtype=np.int64)
    correct_a = np.ones((4, 10), dtype=bool)
    correct_b = np.zeros((4, 10), dtype=bool)

    comparison = evaluate._comparison(
        ["a", "b"],
        {"a": correct_a, "b": correct_b},
        class_ids,
        2,
        bootstrap=0,
        seed=1,
    )

    assert comparison is not None
    assert comparison["earlyDelta"] == -1.0
    assert comparison["completeDelta"] == -1.0
    assert comparison["goalMet"] is False


class StubDrawings:
    """Deterministic ten-stage views for the dataset numbering test."""

    def __init__(
        self, prepared_dir: str, split: str, manifest_cache_dir: Path | None = None
    ) -> None:
        self.prepared_dir = prepared_dir
        self.split = split
        self.manifest_cache_dir = manifest_cache_dir

    def evaluation_images(self, index: int, candidate: str = "foreground"):
        for stage in range(10):
            usable = (index + stage) % 10 != 0
            yield {
                "status": "ok" if usable else "blank",
                "image": np.full((3, 2, 2), float(index), dtype=np.float32)
                if usable
                else None,
                "fraction": (stage + 1) / 10,
                "unchanged": stage == 0,
                "drawing_id": f"drawing-{index}",
                "diagnostics": {"candidate": candidate, "coverage": 0.5},
            }


def test_dataset_numbers_view_indices_across_classes(monkeypatch) -> None:
    """View numbering must keep advancing across class boundaries."""
    monkeypatch.setattr(evaluate, "IndexedDrawings", StubDrawings)
    dataset = evaluate.TenStageViewDataset(
        Path("prepared"),
        "validation",
        global_indices=[0, 1, 2],
        manifest_indices=[40, 41, 99],
        class_ids=[0, 0, 1],
        candidate="foreground",
        manifest_cache_dir=None,
    )

    assert len(dataset) == 3
    first, second, third = (dataset[position] for position in range(3))
    assert [item[0]["viewIndex"] for item in first] == list(range(0, 10))
    assert [item[0]["viewIndex"] for item in second] == list(range(10, 20))
    assert [item[0]["viewIndex"] for item in third] == list(range(20, 30))
    assert [item[0]["stage"] for item in first] == list(range(1, 11))
    assert third[0][0]["classId"] == 1
    assert third[0][0]["drawingId"] == "drawing-99"
    # A blank stage carries no image and no input hash, but keeps its row.
    assert first[0][1] is None
    assert first[0][0]["inputSha256"] is None
    assert first[1][0]["inputSha256"] is not None


def test_collate_views_flattens_and_keeps_rows_aligned() -> None:
    image = np.zeros((3, 2, 2), dtype=np.float32)
    batch = [
        [({"viewIndex": 0}, image), ({"viewIndex": 1}, None)],
        [({"viewIndex": 2}, None), ({"viewIndex": 3}, image)],
    ]

    metadata, images, ok_positions = evaluate._collate_views(batch)

    assert [item["viewIndex"] for item in metadata] == [0, 1, 2, 3]
    assert ok_positions == [0, 3]
    assert images is not None
    assert tuple(images.shape) == (2, 3, 2, 2)


def test_collate_views_without_usable_views_returns_no_tensor() -> None:
    metadata, images, ok_positions = evaluate._collate_views(
        [[({"viewIndex": 0}, None)]]
    )

    assert [item["viewIndex"] for item in metadata] == [0]
    assert images is None
    assert ok_positions == []


def test_parse_args_accepts_workers_and_rejects_negative() -> None:
    args = evaluate.parse_args(["--workers", "6", "--batch-size", "240"])
    assert args.workers == 6
    assert args.batch_size == 240
    assert args.manifest_cache_dir == evaluate.DEFAULT_MANIFEST_CACHE

    with pytest.raises(ValueError, match="--workers must be non-negative"):
        evaluate.parse_args(["--workers", "-1"])
