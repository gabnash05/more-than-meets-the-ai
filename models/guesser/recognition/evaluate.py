"""Fixed ten-stage recognition evaluation for exported Guesser bundles."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from guesser_data import IndexedDrawings
from guesser_data.common import load_step
from safetensors.torch import load_file
from torch.utils.data import DataLoader, Dataset
from training.export_bundle import BACKBONE, BUNDLE_FILES, MODEL_ID

from . import metrics, report

STAGES = 10
DEFAULT_PREPARED_DIR = Path("data/.local/data/production/prepared")
DEFAULT_BUNDLE_ROOT = Path("checkpoints/notebook-production-full/bundles")
DEFAULT_MODEL_IDS = ("guesser-vit-a-v1", "guesser-vit-b-v1")
DEFAULT_WORKERS = 0
DEFAULT_MANIFEST_CACHE = (
    Path(__file__).resolve().parents[1] / ".local" / "cache" / "manifests"
)
CALIBRATION_CHUNK = 16384
DEFAULT_CALIBRATION_SAMPLES = 50000


@dataclass(frozen=True)
class Bundle:
    root: Path
    model_id: str
    artifact_revision: str
    labels: list[str]
    preprocessing: str
    preprocessing_hash: str
    weights_sha256: str
    labels_sha256: str
    manifest: dict


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Evaluate exported Guesser bundles on the fixed ten-stage validation grid."
        )
    )
    parser.add_argument(
        "--prepared-dir",
        type=Path,
        default=DEFAULT_PREPARED_DIR,
        help="Prepared profile directory containing manifests/ and records/.",
    )
    parser.add_argument(
        "--bundle-root",
        type=Path,
        default=DEFAULT_BUNDLE_ROOT,
        help="Directory containing one subdirectory per serving bundle.",
    )
    parser.add_argument(
        "--model-id",
        action="append",
        default=None,
        help="Bundle model ID to evaluate; repeat for an A/B pair.",
    )
    parser.add_argument(
        "--split",
        choices=("validation", "test"),
        default="validation",
        help="Evaluation split. test requires --freeze-record.",
    )
    parser.add_argument(
        "--limit-per-class",
        type=int,
        default=50,
        help="Balanced originals per class (default: 50).",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Evaluate every original instead of the balanced subset.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=128,
        help="Model batch size for usable views.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output root (default: <bundle-root>/../evaluation/ten-stage).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=198173,
        help="Subset, calibration and bootstrap seed.",
    )
    parser.add_argument(
        "--bootstrap",
        type=int,
        default=1000,
        help="Stratified bootstrap resamples (0 disables intervals).",
    )
    parser.add_argument(
        "--calibration-samples",
        type=int,
        default=DEFAULT_CALIBRATION_SAMPLES,
        help="Validation views used to fit scalar temperature.",
    )
    parser.add_argument(
        "--save-logits",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Save full float32 logits for exact calibration.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing output directory.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help=(
            "Continue a previous run when possible; start fresh when no "
            "subset.json exists."
        ),
    )
    parser.add_argument(
        "--freeze-record",
        type=Path,
        default=None,
        help="Frozen model/policy record required for --split test.",
    )
    parser.add_argument(
        "--validation-report",
        type=Path,
        default=None,
        help="Validation report whose hash is pinned by the freeze record.",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "cuda"),
        default="auto",
        help="Inference device (default: cuda when available).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=(
            "Render worker processes. Rendering and preprocessing dominate the "
            "run and are CPU-bound, so workers overlap them with GPU inference "
            "(0 renders in-process). Past the physical core count throughput "
            "stops improving; each worker holds one batch of views in memory."
        ),
    )
    parser.add_argument(
        "--manifest-cache-dir",
        type=Path,
        default=DEFAULT_MANIFEST_CACHE,
        help="Shared memory-mapped manifest cache for the render workers.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress per-class progress messages.",
    )
    args = parser.parse_args(argv)
    if args.full:
        args.limit_per_class = None
    if args.limit_per_class is not None and args.limit_per_class < 1:
        raise ValueError("--limit-per-class must be positive")
    if args.batch_size < 1:
        raise ValueError("--batch-size must be positive")
    if args.workers < 0:
        raise ValueError("--workers must be non-negative")
    if args.bootstrap < 0:
        raise ValueError("--bootstrap must be non-negative")
    if args.calibration_samples < 1:
        raise ValueError("--calibration-samples must be positive")
    if args.overwrite and args.resume:
        raise ValueError("--overwrite and --resume are mutually exclusive")
    if args.split == "test" and not args.save_logits:
        raise ValueError("--split test requires --save-logits")
    if args.split != "test" and (
        args.freeze_record is not None or args.validation_report is not None
    ):
        raise ValueError(
            "--freeze-record and --validation-report are only valid with --split test"
        )
    if args.model_id is None:
        args.model_id = list(DEFAULT_MODEL_IDS)
    if not args.model_id:
        raise ValueError("at least one --model-id is required")
    if args.output_dir is None:
        args.output_dir = args.bundle_root.parent / "evaluation" / "ten-stage"
    return args


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _artifact_revision(files: dict[str, str]) -> str:
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Any) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.part")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def validate_bundle(root: Path) -> Bundle:
    """Validate the serving manifest and ordered labels without loading weights."""
    root = root.resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"bundle manifest not found: {manifest_path}")
    manifest = _read_json(manifest_path)
    files = manifest.get("files")
    if (
        manifest.get("version") != 1
        or manifest.get("role") != "guesser"
        or not isinstance(manifest.get("modelId"), str)
        or not MODEL_ID.fullmatch(manifest["modelId"])
        or manifest.get("adapter") != "vit-tiny"
        or manifest.get("input") != [1, 3, 224, 224]
        or manifest.get("output") != [1, 345]
        or not isinstance(manifest.get("artifactRevision"), str)
        or not 1 <= len(manifest["artifactRevision"]) <= 128
        or not isinstance(files, dict)
        or set(files) != set(BUNDLE_FILES)
    ):
        raise ValueError(f"manifest contract mismatch: {root}")
    if manifest["modelId"] != root.name:
        raise ValueError(
            f"manifest modelId {manifest['modelId']} does not match {root.name}"
        )
    if manifest["artifactRevision"] != _artifact_revision(files):
        raise ValueError(f"artifact revision mismatch: {root}")
    for name in BUNDLE_FILES:
        if _sha256_file(root / name) != files[name]:
            raise ValueError(f"artifact hash mismatch: {root / name}")

    labels = (root / "labels.txt").read_text(encoding="utf-8").splitlines()
    if (
        len(labels) != 345
        or len({label.casefold() for label in labels}) != 345
        or any(not label.strip() for label in labels)
    ):
        raise ValueError(f"labels.txt order is invalid: {root}")
    labels_json = _read_json(root / "labels.json")
    if (
        not isinstance(labels_json, list)
        or len(labels_json) != 345
        or not all(isinstance(entry, dict) for entry in labels_json)
        or [entry.get("class_id") for entry in labels_json] != list(range(345))
        or [entry.get("source_name") for entry in labels_json] != labels
    ):
        raise ValueError(f"labels.json order is invalid: {root}")
    if files["labels.json"] != _sha256_file(root / "labels.json"):
        raise ValueError(f"labels.json hash mismatch: {root}")

    selection = _read_json(root / "checkpoint-selection.json")
    if (
        selection.get("backbone") != BACKBONE
        or selection.get("preprocess_candidate") != manifest["preprocessing"]
        or selection.get("labels_sha256") != files["labels.json"]
        or selection.get("num_classes") != len(labels)
        or selection.get("fast_dev")
        or not selection.get("best_model_path")
        or selection.get("best_model_score") is None
    ):
        raise ValueError(f"checkpoint-selection mismatch: {root}")

    images = load_step("06-images")
    if manifest.get("preprocessingConfigHash") != images.candidate_hash(
        manifest["preprocessing"]
    ):
        raise ValueError(f"preprocessing config mismatch: {root}")

    return Bundle(
        root=root,
        model_id=manifest["modelId"],
        artifact_revision=manifest["artifactRevision"],
        labels=labels,
        preprocessing=manifest["preprocessing"],
        preprocessing_hash=manifest["preprocessingConfigHash"],
        weights_sha256=files["weights.safetensors"],
        labels_sha256=files["labels.json"],
        manifest=manifest,
    )


def _load_model(bundle: Bundle, device: torch.device) -> torch.nn.Module:
    import timm

    state = load_file(str(bundle.root / "weights.safetensors"), device="cpu")
    model = timm.create_model(
        BACKBONE, pretrained=False, num_classes=len(bundle.labels)
    )
    model.load_state_dict(state, strict=True)
    model.eval()
    model.to(device)
    return model


def _read_manifest(prepared_dir: Path, split: str) -> tuple[list[int], str]:
    path = prepared_dir / "manifests" / f"{split}.parquet"
    if not path.is_file():
        raise FileNotFoundError(f"{split} manifest not found: {path}")
    table = pq.read_table(path, columns=["class_id"])
    classes = [int(value) for value in table["class_id"].to_pylist()]
    return classes, _sha256_file(path)


def _select_subset(
    classes: list[int],
    limit_per_class: int | None,
    seed: int,
    manifest_sha256: str,
) -> dict:
    by_class: dict[int, list[int]] = {}
    for index, class_id in enumerate(classes):
        by_class.setdefault(class_id, []).append(index)
    if set(by_class) != set(range(345)):
        raise ValueError("manifest must contain all 345 classes")
    indices: dict[str, list[int]] = {}
    per_class: dict[str, int] = {}
    for class_id in range(345):
        candidates = by_class[class_id]
        if limit_per_class is None or limit_per_class >= len(candidates):
            selected = candidates
        else:
            rng = random.Random(f"{seed}:{class_id}")
            selected = sorted(rng.sample(candidates, limit_per_class))
        indices[str(class_id)] = selected
        per_class[str(class_id)] = len(selected)
    payload = {
        "manifestSha256": manifest_sha256,
        "seed": seed,
        "limitPerClass": limit_per_class,
        "indices": indices,
    }
    digest = _sha256_bytes(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    )
    return {
        "schema": "guesser-ten-stage-subset-v1",
        "manifestSha256": manifest_sha256,
        "seed": seed,
        "limitPerClass": limit_per_class,
        "classIds": list(range(345)),
        "indices": indices,
        "perClass": per_class,
        "originals": sum(per_class.values()),
        "views": sum(per_class.values()) * STAGES,
        "sha256": digest,
    }


def _subset_info(subset: dict) -> dict:
    values = list(subset["perClass"].values())
    return {
        "originals": subset["originals"],
        "views": subset["views"],
        "limitPerClass": subset["limitPerClass"],
        "seed": subset["seed"],
        "sha256": subset["sha256"],
        "perClassMin": min(values) if values else 0,
        "perClassMax": max(values) if values else 0,
    }


def _directory_contains_files(path: Path) -> bool:
    return any(item.is_file() for item in path.rglob("*"))


def _prepare_output_dir(output_dir: Path, overwrite: bool, resume: bool) -> None:
    if output_dir.exists():
        if overwrite:
            shutil.rmtree(output_dir)
        elif not resume and _directory_contains_files(output_dir):
            raise FileExistsError(f"{output_dir} exists; pass --overwrite or --resume")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "predictions").mkdir(exist_ok=True)
    (output_dir / "logits").mkdir(exist_ok=True)
    (output_dir / "confusions").mkdir(exist_ok=True)


def _shard_path(output_dir: Path, model_id: str, class_id: int) -> Path:
    return output_dir / "predictions" / model_id / f"class-{class_id:03d}.parquet"


def _write_shard(path: Path, rows: list[dict], bundle: Bundle) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pylist(rows)
    table = table.replace_schema_metadata(
        {
            b"model_id": bundle.model_id.encode(),
            b"artifact_revision": bundle.artifact_revision.encode(),
            b"weights_sha256": bundle.weights_sha256.encode(),
            b"labels_sha256": bundle.labels_sha256.encode(),
            b"preprocessing": bundle.preprocessing.encode(),
            b"preprocessing_hash": bundle.preprocessing_hash.encode(),
        }
    )
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.part")
    pq.write_table(table, temporary, compression="zstd")
    os.replace(temporary, path)
    return _sha256_file(path)


def _load_progress(
    path: Path, subset_sha256: str, model_ids: list[str]
) -> dict[str, dict[str, str]]:
    if not path.is_file():
        return {model_id: {} for model_id in model_ids}
    progress = _read_json(path)
    if progress.get("subsetSha256") != subset_sha256:
        raise ValueError("progress file does not match the selected subset")
    models = progress.get("models")
    if not isinstance(models, dict):
        raise TypeError("progress file has no models mapping")
    return {model_id: dict(models.get(model_id, {})) for model_id in model_ids}


def _write_progress(
    path: Path,
    subset_sha256: str,
    progress: dict[str, dict[str, str]],
) -> None:
    _write_json(
        path,
        {
            "schema": "guesser-ten-stage-progress-v1",
            "subsetSha256": subset_sha256,
            "models": progress,
        },
    )


def _check_test_guard(args: argparse.Namespace, bundles: list[Bundle]) -> dict | None:
    if args.split != "test":
        return None
    if args.freeze_record is None:
        raise ValueError("--split test requires --freeze-record")
    freeze = _read_json(args.freeze_record)
    if freeze.get("schema") != "guesser-ten-stage-freeze-v1":
        raise ValueError("unsupported freeze record schema")
    if args.validation_report is None or not args.validation_report.is_file():
        raise ValueError(
            "--validation-report is required and must exist with --split test"
        )
    if _sha256_file(args.validation_report) != freeze.get("validationReportSha256"):
        raise ValueError("validation report hash does not match the freeze record")
    records = freeze.get("models")
    if not isinstance(records, dict):
        raise TypeError("freeze record has no models mapping")
    for bundle in bundles:
        if bundle.model_id not in records:
            raise ValueError(f"freeze record does not include {bundle.model_id}")
        record = records[bundle.model_id]
        if not isinstance(record, dict):
            raise TypeError(f"freeze record entry is invalid for {bundle.model_id}")
        for key, actual in (
            ("artifactRevision", bundle.artifact_revision),
            ("weightsSha256", bundle.weights_sha256),
            ("labelsSha256", bundle.labels_sha256),
            ("preprocessing", bundle.preprocessing),
            ("preprocessingHash", bundle.preprocessing_hash),
        ):
            if record.get(key) != actual:
                raise ValueError(
                    f"freeze record {key} does not match {bundle.model_id}"
                )
        if "temperature" not in record:
            raise ValueError(
                f"freeze record temperature is missing for {bundle.model_id}"
            )
        if not isinstance(record["temperature"], (int, float)):
            raise TypeError(
                f"freeze record temperature is invalid for {bundle.model_id}"
            )
        if "threshold" not in record:
            raise ValueError(
                f"freeze record threshold is missing for {bundle.model_id}"
            )
        if not isinstance(record["threshold"], (int, float)):
            raise TypeError(f"freeze record threshold is invalid for {bundle.model_id}")
    return freeze


def _flush(
    images: torch.Tensor | None,
    view_indices: np.ndarray,
    pending: dict[str, list[tuple[dict, int]]],
    bundles: list[Bundle],
    models: dict[str, torch.nn.Module],
    device: torch.device,
    logits_memmaps: dict[str, np.memmap] | None,
) -> None:
    """Score one batch of usable views on every arm and fill its rows.

    ``images`` holds only the usable views of the batch and ``view_indices``
    names the logits row of each one, so a resumed run writes exactly the rows
    an uninterrupted run would. Unusable views never reach a model: their rows
    keep the sentinel prediction and are counted as unsuccessful by the stage
    curve. ``pending`` pairs each row with its position inside ``images``.
    """
    if images is None:
        return
    batch = images.to(device)
    indices = np.asarray(view_indices, dtype=np.int64)
    for bundle in bundles:
        model = models[bundle.model_id]
        with torch.inference_mode():
            logits = model(batch)
        if tuple(logits.shape) != (batch.shape[0], len(bundle.labels)):
            raise ValueError(
                f"unexpected output shape from {bundle.model_id}: {tuple(logits.shape)}"
            )
        if not torch.isfinite(logits).all():
            raise ValueError(f"non-finite logits from {bundle.model_id}")
        probabilities = torch.softmax(logits.float(), dim=1)
        top3 = probabilities.topk(3, dim=1)
        top1_ids = top3.indices[:, 0].cpu().numpy()
        top1_probs = top3.values[:, 0].cpu().numpy()
        top3_ids = top3.indices.cpu().numpy()
        top3_probs = top3.values.cpu().numpy()
        if logits_memmaps is not None:
            memmap = logits_memmaps[bundle.model_id]
            memmap[indices] = logits.detach().cpu().numpy()
            memmap.flush()
        for row, image_index in pending[bundle.model_id]:
            top1 = int(top1_ids[image_index])
            top3_row = [int(value) for value in top3_ids[image_index]]
            row.update(
                {
                    "top1Id": top1,
                    "top1Label": bundle.labels[top1],
                    "top1Prob": float(top1_probs[image_index]),
                    "top3Ids": top3_row,
                    "top3Labels": [bundle.labels[value] for value in top3_row],
                    "top3Probs": [float(value) for value in top3_probs[image_index]],
                    "top1Correct": top1 == int(row["classId"]),
                    "top3Correct": int(row["classId"]) in top3_row,
                }
            )
        pending[bundle.model_id].clear()


class TenStageViewDataset(Dataset):
    """Render the ten fixed time views of each selected original.

    One item is one original together with all ten of its stages, so a record is
    read once and every cut prefix matches a serial run exactly. Workers use
    this to overlap CPU rendering and preprocessing with GPU inference.
    """

    def __init__(
        self,
        prepared_dir: Path,
        split: str,
        global_indices: list[int],
        manifest_indices: list[int],
        class_ids: list[int],
        candidate: str,
        manifest_cache_dir: Path | None,
    ) -> None:
        if not len(global_indices) == len(manifest_indices) == len(class_ids):
            raise ValueError("served positions, manifest rows and classes must align")
        self.global_indices = global_indices
        self.manifest_indices = manifest_indices
        self.class_ids = class_ids
        self.candidate = candidate
        # IndexedDrawings reopens per PID, so forked workers map the shared
        # manifest cache instead of decoding the split into private memory.
        self.drawings = IndexedDrawings(
            str(prepared_dir), split, manifest_cache_dir=manifest_cache_dir
        )

    def __len__(self) -> int:
        return len(self.manifest_indices)

    def __getitem__(self, position: int) -> list[tuple[dict, np.ndarray | None]]:
        """Return this original's ten stages in order with their view metadata.

        ``global_indices`` fixes the logits row of the first stage, and stage
        order advances it by one, matching the serial runner's view numbering.
        """
        base = self.global_indices[position] * STAGES
        class_id = self.class_ids[position]
        views: list[tuple[dict, np.ndarray | None]] = []
        for stage, view in enumerate(
            self.drawings.evaluation_images(
                self.manifest_indices[position], candidate=self.candidate
            )
        ):
            status = view["status"]
            coverage = view["diagnostics"].get("coverage")
            usable = status == "ok"
            metadata = {
                "viewIndex": base + stage,
                "drawingId": view["drawing_id"],
                "classId": class_id,
                "stage": stage + 1,
                "fraction": float(view["fraction"]),
                "unchanged": bool(view["unchanged"]),
                "preprocessStatus": status,
                "coverage": float(coverage) if coverage is not None else None,
                "inputSha256": _sha256_bytes(
                    np.ascontiguousarray(view["image"]).tobytes()
                )
                if usable
                else None,
            }
            views.append((metadata, view["image"] if usable else None))
        if len(views) != STAGES:
            raise ValueError(
                f"original {self.manifest_indices[position]} produced "
                f"{len(views)} views, expected {STAGES}"
            )
        return views


def _collate_views(
    batch: list[list[tuple[dict, np.ndarray | None]]],
) -> tuple[list[dict], torch.Tensor | None, list[int]]:
    """Flatten drawing items into ordered view metadata and one image tensor.

    The tensor carries usable views only; ``ok_positions`` names the flattened
    position of each tensor row so rows and predictions stay aligned.
    """
    metadata: list[dict] = []
    images: list[np.ndarray] = []
    ok_positions: list[int] = []
    for views in batch:
        for item, image in views:
            if image is not None:
                ok_positions.append(len(metadata))
                images.append(image)
            metadata.append(item)
    tensor = torch.from_numpy(np.stack(images)) if images else None
    return metadata, tensor, ok_positions


def _build_row(metadata: dict, bundle: Bundle) -> dict:
    """Seed one prediction row from a view; ``_flush`` fills the predictions."""
    class_id = metadata["classId"]
    return {
        "viewIndex": metadata["viewIndex"],
        "drawingId": metadata["drawingId"],
        "classId": class_id,
        "className": bundle.labels[class_id],
        "stage": metadata["stage"],
        "fraction": metadata["fraction"],
        "unchanged": metadata["unchanged"],
        "preprocessStatus": metadata["preprocessStatus"],
        "coverage": metadata["coverage"],
        "inputSha256": metadata["inputSha256"],
        "top1Id": -1,
        "top1Label": None,
        "top1Prob": 0.0,
        "top3Ids": [],
        "top3Labels": [],
        "top3Probs": [],
        "top1Correct": False,
        "top3Correct": False,
    }


def _finish_class(
    class_id: int,
    rows_by_model: dict[str, list[dict]],
    subset: dict,
    bundles: list[Bundle],
    progress: dict[str, dict[str, str]],
    progress_path: Path,
    output_dir: Path,
    quiet: bool,
) -> None:
    """Write one completed class's shards, record their hashes, announce it."""
    for bundle in bundles:
        digest = _write_shard(
            _shard_path(output_dir, bundle.model_id, class_id),
            rows_by_model[bundle.model_id],
            bundle,
        )
        progress[bundle.model_id][str(class_id)] = digest
    _write_progress(progress_path, subset["sha256"], progress)
    if not quiet:
        print(
            f"class {class_id + 1:03d}/345: "
            f"{len(subset['indices'][str(class_id)])} originals",
            flush=True,
        )


def _score_subset(
    prepared_dir: Path,
    split: str,
    subset: dict,
    bundles: list[Bundle],
    models: dict[str, torch.nn.Module],
    device: torch.device,
    output_dir: Path,
    progress: dict[str, dict[str, str]],
    progress_path: Path,
    resuming: bool,
    batch_size: int,
    workers: int,
    manifest_cache_dir: Path,
    logits_memmaps: dict[str, np.memmap] | None,
    quiet: bool,
) -> None:
    """Render, score and shard every selected original, class shard by shard.

    The plan fixes three numbers per original before any rendering starts: its
    position inside the subset (the logits row), its manifest row (the record),
    and its class (the output shard). Positions advance across classes exactly
    as in a serial run, so shards, logits and reported metrics do not depend on
    how the rendering is split across workers.
    """
    model_ids = [bundle.model_id for bundle in bundles]
    global_indices: list[int] = []
    manifest_indices: list[int] = []
    class_ids: list[int] = []
    offsets: dict[int, int] = {}
    offset = 0
    for class_id in subset["classIds"]:
        class_id = int(class_id)
        offsets[class_id] = offset
        for local_index, manifest_index in enumerate(
            subset["indices"][str(class_id)]
        ):
            global_indices.append(offset + local_index)
            manifest_indices.append(int(manifest_index))
            class_ids.append(class_id)
        offset += len(subset["indices"][str(class_id)])

    # A class counts as done only when every arm's shard still hashes to the
    # value recorded for it, so nothing partially written is ever reused.
    completed = {
        class_id
        for class_id in offsets
        if all(
            _shard_path(output_dir, model_id, class_id).is_file()
            and _sha256_file(_shard_path(output_dir, model_id, class_id))
            == progress[model_id].get(str(class_id))
            for model_id in model_ids
        )
    }
    if resuming:
        for class_id in sorted(completed):
            if not quiet:
                print(f"class {class_id + 1:03d}/345: resumed", flush=True)

    served = [
        position
        for position, class_id in enumerate(class_ids)
        if class_id not in completed
    ]
    if not served:
        return

    dataset = TenStageViewDataset(
        prepared_dir,
        split,
        [global_indices[position] for position in served],
        [manifest_indices[position] for position in served],
        [class_ids[position] for position in served],
        bundles[0].preprocessing,
        manifest_cache_dir,
    )
    loader = DataLoader(
        dataset,
        # One item is one original. This only bounds how much a worker renders
        # and ships per message; model batching is governed by --batch-size.
        batch_size=max(1, batch_size // STAGES),
        shuffle=False,
        num_workers=workers,
        collate_fn=_collate_views,
        prefetch_factor=1 if workers else None,
    )

    open_rows: dict[int, dict[str, list[dict]]] = {}
    buffered_images: list[np.ndarray | None] = []
    buffered_indices: list[int] = []
    buffered_rows: list[dict[str, dict]] = []
    buffered_usable = 0
    latest_class: int | None = None

    def flush_buffer() -> None:
        """Score the buffered views on every arm and empty the buffer.

        Views are buffered across render batches so a model forward sees
        exactly ``--batch-size`` usable views, which is what the serial runner
        did. Batch composition decides GPU kernel selection, so matching it
        keeps logits reproducible across runner versions.
        """
        nonlocal buffered_usable
        usable = [
            index for index, image in enumerate(buffered_images) if image is not None
        ]
        if usable:
            tensor = torch.from_numpy(
                np.stack([buffered_images[index] for index in usable])
            )
            indices = np.asarray(
                [buffered_indices[index] for index in usable], dtype=np.int64
            )
            pending = {
                model_id: [
                    (buffered_rows[index][model_id], rank)
                    for rank, index in enumerate(usable)
                ]
                for model_id in model_ids
            }
            _flush(
                tensor, indices, pending, bundles, models, device, logits_memmaps
            )
        buffered_images.clear()
        buffered_indices.clear()
        buffered_rows.clear()
        buffered_usable = 0

    def close_before(latest: int | None) -> None:
        """Write every open class older than ``latest``; the buffer must be empty."""
        if latest is None:
            return
        for class_id in sorted(open_rows):
            if class_id == latest:
                continue
            _finish_class(
                class_id,
                open_rows.pop(class_id),
                subset,
                bundles,
                progress,
                progress_path,
                output_dir,
                quiet,
            )

    for metadata, images, ok_positions in loader:
        # Position of a view inside ``images``, so a usable view keeps the
        # logits row an uninterrupted serial run would have written.
        row_of_view = {position: row for row, position in enumerate(ok_positions)}
        pixels = images.numpy() if images is not None else None
        for position, item in enumerate(metadata):
            class_id = item["classId"]
            if class_id != latest_class:
                # The serial runner scored one class at a time and flushed the
                # remainder when that class ended. Flushing here keeps model
                # batches -- and therefore logits -- identical to it.
                if buffered_rows:
                    flush_buffer()
                close_before(class_id)
                latest_class = class_id
            rows = open_rows.get(class_id)
            if rows is None:
                rows = {model_id: [] for model_id in model_ids}
                open_rows[class_id] = rows
            view_rows: dict[str, dict] = {}
            for bundle in bundles:
                row = _build_row(item, bundle)
                rows[bundle.model_id].append(row)
                view_rows[bundle.model_id] = row
            buffered_rows.append(view_rows)
            buffered_indices.append(item["viewIndex"])
            if position in row_of_view:
                assert pixels is not None
                buffered_images.append(pixels[row_of_view[position]])
                buffered_usable += 1
            else:
                buffered_images.append(None)
            if buffered_usable >= batch_size:
                flush_buffer()
                # The buffer is empty, so every row received so far is scored
                # and any class older than the current one is complete.
                close_before(latest_class)

    flush_buffer()
    close_before(None)
    for class_id in sorted(open_rows):
        _finish_class(
            class_id,
            open_rows.pop(class_id),
            subset,
            bundles,
            progress,
            progress_path,
            output_dir,
            quiet,
        )


def _load_arrays(
    output_dir: Path, model_id: str, subset: dict
) -> dict[str, np.ndarray]:
    originals = subset["originals"]
    n_views = originals * STAGES
    flat: dict[str, np.ndarray] = {
        "correct1": np.zeros(n_views, dtype=bool),
        "correct3": np.zeros(n_views, dtype=bool),
        "statusOk": np.zeros(n_views, dtype=bool),
        "blank": np.zeros(n_views, dtype=bool),
        "uncertain": np.zeros(n_views, dtype=bool),
        "unchanged": np.zeros(n_views, dtype=bool),
        "predicted": np.full(n_views, -1, dtype=np.int16),
        "true": np.zeros(n_views, dtype=np.int16),
        "top1Prob": np.zeros(n_views, dtype=np.float32),
    }
    for class_id in subset["classIds"]:
        path = _shard_path(output_dir, model_id, int(class_id))
        table = pq.read_table(path)
        view_indices = table["viewIndex"].to_numpy().astype(np.int64)
        flat["correct1"][view_indices] = table["top1Correct"].to_numpy()
        flat["correct3"][view_indices] = table["top3Correct"].to_numpy()
        status = np.asarray(table["preprocessStatus"].to_pylist())
        flat["statusOk"][view_indices] = status == "ok"
        flat["blank"][view_indices] = status == "blank"
        flat["uncertain"][view_indices] = status == "uncertain"
        flat["unchanged"][view_indices] = table["unchanged"].to_numpy()
        flat["predicted"][view_indices] = table["top1Id"].to_numpy().astype(np.int16)
        flat["true"][view_indices] = table["classId"].to_numpy().astype(np.int16)
        flat["top1Prob"][view_indices] = table["top1Prob"].to_numpy()
    return {key: value.reshape(originals, STAGES) for key, value in flat.items()}


def _class_ids_for_subset(subset: dict) -> np.ndarray:
    parts = [
        np.full(
            len(subset["indices"][str(class_id)]),
            int(class_id),
            dtype=np.int64,
        )
        for class_id in subset["classIds"]
    ]
    return np.concatenate(parts)


def _calibrated_probabilities(
    logits: np.memmap, temperature: float, status_ok: np.ndarray
) -> np.ndarray:
    flat_ok = status_ok.reshape(-1)
    probabilities = np.zeros(flat_ok.size, dtype=np.float32)
    for start in range(0, flat_ok.size, CALIBRATION_CHUNK):
        end = min(start + CALIBRATION_CHUNK, flat_ok.size)
        probabilities[start:end] = metrics.softmax_top1_probs(
            logits[start:end], temperature
        )
    probabilities[~flat_ok] = 0.0
    return probabilities.reshape(status_ok.shape)


def _write_per_class_csv(path: Path, rows: list[dict]) -> None:
    fields = [
        "classId",
        "label",
        "support",
        "stage1",
        "stage2",
        "stage3",
        "stage4",
        "stage5",
        "stage6",
        "stage7",
        "stage8",
        "stage9",
        "stage10",
        "meanEarlyTop1",
        "completeTop1",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            payload = {
                "classId": row["classId"],
                "label": row["label"],
                "support": row["support"],
                "meanEarlyTop1": row["meanEarlyTop1"],
                "completeTop1": row["completeTop1"],
            }
            for stage, accuracy in enumerate(row["stageAccuracy"], start=1):
                payload[f"stage{stage}"] = accuracy
            writer.writerow(payload)


def _observed_interval(
    values: np.ndarray,
    class_ids: np.ndarray,
    metric_fn: Callable[[np.ndarray, np.ndarray], float | None],
) -> dict:
    return {
        "observed": metric_fn(values, class_ids),
        "mean": None,
        "low": None,
        "high": None,
        "samples": 0,
    }


def _bootstrap_ci(
    values: np.ndarray,
    class_ids: np.ndarray,
    n_classes: int,
    metric_fn: Callable[[np.ndarray, np.ndarray], float | None],
    n_bootstrap: int,
    seed: int,
) -> dict:
    if n_bootstrap == 0:
        return _observed_interval(values, class_ids, metric_fn)
    return metrics.bootstrap_ci(
        values,
        class_ids,
        n_classes,
        metric_fn,
        n_bootstrap=n_bootstrap,
        seed=seed,
    )


def _paired_bootstrap(
    values_a: np.ndarray,
    values_b: np.ndarray,
    class_ids: np.ndarray,
    n_classes: int,
    metric_fn: Callable[[np.ndarray, np.ndarray], float | None],
    n_bootstrap: int,
    seed: int,
) -> dict:
    if n_bootstrap == 0:
        observed_a = metric_fn(values_a, class_ids)
        observed_b = metric_fn(values_b, class_ids)
        observed_delta = (
            float(observed_a - observed_b)
            if observed_a is not None and observed_b is not None
            else None
        )
        return {
            "a": {"observed": observed_a},
            "b": {"observed": observed_b},
            "delta": {
                "observed": observed_delta,
                "mean": None,
                "low": None,
                "high": None,
                "samples": 0,
            },
        }
    return metrics.paired_bootstrap(
        values_a,
        values_b,
        class_ids,
        n_classes,
        metric_fn,
        n_bootstrap=n_bootstrap,
        seed=seed,
    )


def _comparison(
    model_ids: list[str],
    correct_by_model: dict[str, np.ndarray],
    class_ids: np.ndarray,
    n_classes: int,
    bootstrap: int,
    seed: int,
) -> dict | None:
    if len(model_ids) != 2:
        return None
    first, second = model_ids
    early = _paired_bootstrap(
        correct_by_model[second],
        correct_by_model[first],
        class_ids,
        n_classes,
        metrics.early_mean_macro_metric,
        n_bootstrap=bootstrap,
        seed=seed,
    )
    complete = _paired_bootstrap(
        correct_by_model[second],
        correct_by_model[first],
        class_ids,
        n_classes,
        metrics.complete_top1_metric,
        n_bootstrap=bootstrap,
        seed=seed,
    )
    early_delta = early["delta"]["observed"]
    complete_delta = complete["delta"]["observed"]
    goal_met = (
        early_delta is not None
        and complete_delta is not None
        and early_delta >= 0.05
        and complete_delta >= -0.02
    )
    return {
        "first": first,
        "second": second,
        "earlyDelta": early_delta,
        "earlyDeltaLow": early["delta"]["low"],
        "earlyDeltaHigh": early["delta"]["high"],
        "completeDelta": complete_delta,
        "completeDeltaLow": complete["delta"]["low"],
        "completeDeltaHigh": complete["delta"]["high"],
        "goalMet": bool(goal_met),
        "goal": {"earlyGain": 0.05, "completeLoss": -0.02},
    }


def run(args: argparse.Namespace) -> dict:
    started = datetime.now(UTC)
    prepared_dir = args.prepared_dir.resolve()
    bundle_root = args.bundle_root.resolve()
    output_dir = args.output_dir.resolve()
    if not prepared_dir.is_dir():
        raise FileNotFoundError(f"prepared directory not found: {prepared_dir}")
    if not bundle_root.is_dir():
        raise FileNotFoundError(f"bundle root not found: {bundle_root}")

    classes, manifest_sha256 = _read_manifest(prepared_dir, args.split)
    bundles = [validate_bundle(bundle_root / model_id) for model_id in args.model_id]
    if len({bundle.labels_sha256 for bundle in bundles}) != 1:
        raise ValueError("paired bundles must share the same labels.json hash")
    if len({bundle.preprocessing for bundle in bundles}) != 1:
        raise ValueError("paired bundles must share the same preprocessing")
    if len({bundle.preprocessing_hash for bundle in bundles}) != 1:
        raise ValueError("paired bundles must share the same preprocessing config hash")
    freeze = _check_test_guard(args, bundles)

    subset_path = output_dir / "subset.json"
    resuming = args.resume and subset_path.is_file()
    if args.resume and not resuming:
        if output_dir.exists() and _directory_contains_files(output_dir):
            raise FileExistsError(
                f"{output_dir} contains files but no subset.json; "
                "pass --overwrite to start fresh"
            )
        if not args.quiet:
            print(
                f"no resumable subset at {subset_path}; starting a new run",
                flush=True,
            )
    _prepare_output_dir(output_dir, args.overwrite, resuming)
    if resuming:
        subset = _read_json(subset_path)
        expected = _select_subset(
            classes,
            args.limit_per_class,
            args.seed,
            manifest_sha256,
        )
        if subset.get("sha256") != expected["sha256"]:
            raise ValueError(
                "existing subset does not match the requested split/seed/limit"
            )
    else:
        subset = _select_subset(
            classes,
            args.limit_per_class,
            args.seed,
            manifest_sha256,
        )
        _write_json(subset_path, subset)

    # The test split is never used for subset or threshold tuning.
    if args.split == "test" and subset["manifestSha256"] != manifest_sha256:
        raise ValueError("subset manifest does not match the test manifest")
    if freeze is not None:
        temperatures = {
            bundle.model_id: float(freeze["models"][bundle.model_id]["temperature"])
            for bundle in bundles
        }
        thresholds_by_model = {
            bundle.model_id: [float(freeze["models"][bundle.model_id]["threshold"])]
            for bundle in bundles
        }
        calibration_mode = "frozen"
        calibration_sample = 0
    else:
        temperatures = {}
        thresholds_by_model = {
            bundle.model_id: list(metrics.THRESHOLDS) for bundle in bundles
        }
        calibration_mode = "temperature" if args.save_logits else "raw"
        calibration_sample = 0

    device_name = args.device
    if device_name == "auto":
        device_name = "cuda" if torch.cuda.is_available() else "cpu"
    if device_name == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")
    device = torch.device(device_name)
    models = {bundle.model_id: _load_model(bundle, device) for bundle in bundles}

    logits_memmaps: dict[str, np.memmap] | None = None
    if args.save_logits:
        logits_memmaps = {}
        for bundle in bundles:
            path = output_dir / "logits" / f"{bundle.model_id}.npy"
            shape = (subset["views"], len(bundle.labels))
            if resuming:
                if not path.is_file():
                    raise FileNotFoundError(
                        f"{path} is missing; pass --overwrite to start fresh "
                        "or restore the previous logits file"
                    )
                expected_bytes = shape[0] * shape[1] * np.dtype(np.float32).itemsize
                if path.stat().st_size != expected_bytes:
                    raise ValueError(f"{path} size does not match the selected subset")
                logits_memmaps[bundle.model_id] = np.memmap(
                    path, dtype=np.float32, mode="r+", shape=shape
                )
            elif path.is_file():
                raise FileExistsError(f"{path} exists; pass --overwrite or --resume")
            else:
                logits_memmaps[bundle.model_id] = np.memmap(
                    path, dtype=np.float32, mode="w+", shape=shape
                )

    progress_path = output_dir / "progress.json"
    progress = _load_progress(
        progress_path, subset["sha256"], [bundle.model_id for bundle in bundles]
    )
    _score_subset(
        prepared_dir=prepared_dir,
        split=args.split,
        subset=subset,
        bundles=bundles,
        models=models,
        device=device,
        output_dir=output_dir,
        progress=progress,
        progress_path=progress_path,
        resuming=resuming,
        batch_size=args.batch_size,
        workers=args.workers,
        manifest_cache_dir=args.manifest_cache_dir.resolve(),
        logits_memmaps=logits_memmaps,
        quiet=args.quiet,
    )

    class_ids = _class_ids_for_subset(subset)
    n_classes = len(bundles[0].labels)
    arrays_by_model = {
        bundle.model_id: _load_arrays(output_dir, bundle.model_id, subset)
        for bundle in bundles
    }
    status_ok = arrays_by_model[bundles[0].model_id]["statusOk"]
    flat_ok = status_ok.reshape(-1)
    ok_indices = np.flatnonzero(flat_ok)
    if ok_indices.size == 0:
        raise ValueError("no usable views were produced")
    calibration_indices: np.ndarray | None = None
    if calibration_mode == "temperature":
        calibration_rng = np.random.default_rng(args.seed)
        if ok_indices.size > args.calibration_samples:
            calibration_indices = np.sort(
                calibration_rng.choice(
                    ok_indices, args.calibration_samples, replace=False
                )
            )
        else:
            calibration_indices = ok_indices
        calibration_sample = int(calibration_indices.size)

    model_metrics: dict[str, dict] = {}
    for bundle in bundles:
        arrays = arrays_by_model[bundle.model_id]
        if freeze is not None:
            temperature = temperatures[bundle.model_id]
        elif calibration_mode == "temperature":
            assert logits_memmaps is not None
            assert calibration_indices is not None
            sample_logits = np.asarray(
                logits_memmaps[bundle.model_id][calibration_indices]
            )
            sample_targets = arrays["true"].reshape(-1)[calibration_indices]
            temperature = metrics.fit_temperature(sample_logits, sample_targets)
            temperatures[bundle.model_id] = temperature
        else:
            temperature = None
        if temperature is not None and logits_memmaps is not None:
            calibrated = _calibrated_probabilities(
                logits_memmaps[bundle.model_id], temperature, status_ok
            )
        else:
            calibrated = arrays["top1Prob"]
        stage = metrics.stage_metrics(
            arrays["correct1"],
            arrays["correct3"],
            arrays["statusOk"],
            arrays["blank"],
            arrays["uncertain"],
            arrays["unchanged"],
            class_ids,
            n_classes,
        )
        policy = metrics.policy_metrics(
            calibrated,
            arrays["correct1"],
            arrays["statusOk"],
            thresholds_by_model[bundle.model_id],
        )
        trajectory = metrics.trajectory_metrics(arrays["correct1"])
        confusion = metrics.confusion_matrix(
            arrays["predicted"],
            arrays["true"],
            arrays["statusOk"],
            n_classes,
        )
        np.save(output_dir / "confusions" / f"{bundle.model_id}.npy", confusion)
        top_confusions = metrics.top_confusions(confusion, bundle.labels, limit=20)
        per_class = metrics.per_class_metrics(
            arrays["correct1"], class_ids, bundle.labels
        )
        _write_per_class_csv(output_dir / f"per-class-{bundle.model_id}.csv", per_class)
        bootstrap = {
            "earlyMean": _bootstrap_ci(
                arrays["correct1"],
                class_ids,
                n_classes,
                metrics.early_mean_macro_metric,
                n_bootstrap=args.bootstrap,
                seed=args.seed,
            ),
            "completeTop1": _bootstrap_ci(
                arrays["correct1"],
                class_ids,
                n_classes,
                metrics.complete_top1_metric,
                n_bootstrap=args.bootstrap,
                seed=args.seed,
            ),
        }
        model_metrics[bundle.model_id] = {
            "identity": {
                "modelId": bundle.model_id,
                "artifactRevision": bundle.artifact_revision,
                "weightsSha256": bundle.weights_sha256,
                "labelsSha256": bundle.labels_sha256,
                "preprocessing": bundle.preprocessing,
                "preprocessingHash": bundle.preprocessing_hash,
            },
            "stage": stage,
            "policy": policy,
            "trajectory": trajectory,
            "bootstrap": bootstrap,
            "topConfusions": top_confusions,
        }

    comparison = _comparison(
        [bundle.model_id for bundle in bundles],
        {model_id: arrays["correct1"] for model_id, arrays in arrays_by_model.items()},
        class_ids,
        n_classes,
        args.bootstrap,
        args.seed,
    )
    finished = datetime.now(UTC)
    run_info = {
        "split": args.split,
        "preparedDir": str(prepared_dir),
        "manifestSha256": manifest_sha256,
        "bundleRoot": str(bundle_root),
        "outputDir": str(output_dir),
        "device": str(device),
        "torch": torch.__version__,
        "numpy": np.__version__,
        "pyarrow": pa.__version__,
        "startedUtc": started.isoformat(),
        "finishedUtc": finished.isoformat(),
        "resumed": resuming,
        "resumeRequested": bool(args.resume),
        "resumeFallback": bool(args.resume and not resuming),
        "saveLogits": bool(args.save_logits),
        "command": " ".join(sys.argv),
    }
    calibration = {
        "mode": calibration_mode,
        "sampleSize": calibration_sample,
        "seed": args.seed,
        "temperatures": temperatures,
    }
    if freeze is not None:
        calibration["thresholds"] = {
            bundle.model_id: float(freeze["models"][bundle.model_id]["threshold"])
            for bundle in bundles
        }
        run_info["freezeRecord"] = str(args.freeze_record.resolve())
        run_info["freezeRecordSha256"] = _sha256_file(args.freeze_record)
        run_info["validationReport"] = str(args.validation_report.resolve())
        run_info["validationReportSha256"] = freeze["validationReportSha256"]
    subset_info = _subset_info(subset)
    payload = {
        "schema": "guesser-ten-stage-metrics-v1",
        "run": run_info,
        "subset": subset_info,
        "calibration": calibration,
        "models": model_metrics,
        "comparison": comparison,
        "test": "run" if args.split == "test" else "not-run",
        "hints": "not-run",
    }
    _write_json(output_dir / "metrics.json", payload)
    summary = report.build_summary(
        run_info, subset_info, calibration, model_metrics, comparison
    )
    summary["test"] = "run" if args.split == "test" else "not-run"
    _write_json(output_dir / "summary.json", summary)
    (output_dir / "report.md").write_text(
        report.build_report(summary), encoding="utf-8"
    )
    return {
        "split": args.split,
        "originals": subset_info["originals"],
        "views": subset_info["views"],
        "outputDir": str(output_dir),
        "models": {
            model_id: {
                "meanEarlyTop1": model_metrics[model_id]["stage"]["meanEarlyTop1"],
                "completeTop1": model_metrics[model_id]["stage"]["completeTop1"],
                "completeTop3": model_metrics[model_id]["stage"]["completeTop3"],
            }
            for model_id in model_metrics
        },
        "comparison": comparison,
    }


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    print(json.dumps(run(args), indent=2))


if __name__ == "__main__":
    main()
