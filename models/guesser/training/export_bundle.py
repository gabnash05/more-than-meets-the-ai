"""Export a validation-selected ViT-Tiny checkpoint as a serving bundle."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

import torch

BACKBONE = "vit_tiny_patch16_224.augreg_in21k_ft_in1k"
MODEL_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")
RUN_DIRS = {
    "a": "A_complete_only",
    "b": "B_partial",
}
BUNDLE_FILES = (
    "weights.safetensors",
    "labels.txt",
    "labels.json",
    "checkpoint-selection.json",
)
DEFAULT_CHECKPOINT_ROOT = Path(__file__).resolve().parents[1] / "checkpoints"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export validated ViT-Tiny checkpoints as hashed serving bundles."
    )
    parser.add_argument(
        "--checkpoint-root",
        type=Path,
        default=DEFAULT_CHECKPOINT_ROOT,
        help="Root containing A_complete_only/ and B_partial/.",
    )
    parser.add_argument(
        "--run",
        choices=("a", "b", "both"),
        default="both",
        help="Export the complete-only run, the partial run, or both.",
    )
    parser.add_argument(
        "--model-prefix",
        default="guesser-vit",
        help="Prefix for derived model IDs (default: guesser-vit).",
    )
    parser.add_argument(
        "--model-id",
        default=None,
        help="Override the derived model ID for a single run.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Bundle root (default: <checkpoint-root>/bundles).",
    )
    parser.add_argument(
        "--labels-json",
        type=Path,
        default=None,
        help="Ordered labels.json; defaults to the selection record or prepared data.",
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=None,
        help="Override the selection record's best checkpoint for a single run.",
    )
    parser.add_argument(
        "--parity-samples",
        type=int,
        default=0,
        help="Validation originals to compare checkpoint and exported logits (0 disables).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing bundle directory.",
    )
    return parser.parse_args(argv)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _artifact_revision(files: dict[str, str]) -> str:
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _model_id(prefix: str, run: str) -> str:
    model_id = f"{prefix}-{run}-v1"
    if not MODEL_ID.fullmatch(model_id):
        raise ValueError(f"Invalid model ID: {model_id}")
    return model_id


def _validate_selection(selection: dict) -> None:
    if selection.get("backbone") != BACKBONE:
        raise ValueError("checkpoint-selection backbone does not match")
    if selection.get("preprocess_candidate") not in ("foreground", "edges"):
        raise ValueError("checkpoint-selection preprocessing is unsupported")
    if selection.get("num_classes") != 345:
        raise ValueError("checkpoint-selection num_classes is not 345")
    if selection.get("fast_dev"):
        raise ValueError("fast-dev checkpoints cannot be exported")
    if not selection.get("best_model_path"):
        raise ValueError("checkpoint-selection has no best_model_path")
    if selection.get("best_model_score") is None:
        raise ValueError("checkpoint-selection has no best_model_score")


def _resolve_checkpoint(
    selection: dict, run_dir: Path, override: Path | None
) -> Path:
    if override is not None:
        return override
    recorded = selection.get("best_model_path")
    if not isinstance(recorded, str) or not recorded:
        raise ValueError("checkpoint-selection has no best_model_path")
    path = Path(recorded)
    return path if path.is_absolute() else run_dir / path


def _resolve_labels_path(selection: dict, override: Path | None) -> Path:
    if override is not None:
        return override
    candidates: list[Path] = []
    recorded = selection.get("labels_path")
    if isinstance(recorded, str) and recorded:
        candidates.append(Path(recorded))
    prepared = selection.get("prepared_dir")
    if isinstance(prepared, str) and prepared:
        base = Path(prepared)
        candidates.extend((base.parent / "labels.json", base / "labels.json"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("labels.json not found; pass --labels-json")


def _load_labels(path: Path) -> tuple[bytes, list[str]]:
    data = path.read_bytes()
    parsed = json.loads(data)
    if not isinstance(parsed, list) or len(parsed) != 345:
        raise ValueError("labels.json must contain 345 entries")
    if not all(isinstance(entry, dict) for entry in parsed):
        raise ValueError("labels.json entries must be objects")
    class_ids = [entry.get("class_id") for entry in parsed]
    if class_ids != list(range(345)):
        raise ValueError("labels.json class_id order is invalid")
    names = [entry.get("source_name") for entry in parsed]
    if not all(isinstance(name, str) and name.strip() for name in names):
        raise ValueError("labels.json source_name values must be non-empty strings")
    labels = cast(list[str], names)
    if len({label.casefold() for label in labels}) != 345:
        raise ValueError("labels.json source_name values must be unique")
    return data, labels


def _load_state_dict(checkpoint_path: Path) -> dict[str, torch.Tensor]:
    checkpoint = torch.load(
        checkpoint_path, map_location="cpu", weights_only=True
    )
    if not isinstance(checkpoint, dict):
        raise ValueError("checkpoint is not a mapping")
    state = checkpoint.get("state_dict")
    if not isinstance(state, dict) or not state:
        raise ValueError("checkpoint has no state_dict")
    if not all(
        isinstance(key, str) and key.startswith("model.") for key in state
    ):
        raise ValueError("checkpoint state_dict keys are not model.*")
    stripped: dict[str, torch.Tensor] = {}
    for key, value in state.items():
        if not isinstance(value, torch.Tensor):
            raise ValueError("checkpoint state_dict contains a non-tensor value")
        stripped[key.removeprefix("model.")] = (
            value.detach().cpu().contiguous()
        )
    return stripped


def _build_model(state: dict[str, torch.Tensor], num_classes: int) -> torch.nn.Module:
    import timm

    model = timm.create_model(
        BACKBONE, pretrained=False, num_classes=num_classes
    )
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def _sanitize_selection(selection: dict) -> dict:
    sanitized = dict(selection)
    source_best = sanitized.get("best_model_path")
    source_last = sanitized.get("last_model_path")
    sanitized["best_model_path"] = "weights.safetensors"
    sanitized["last_model_path"] = None
    sanitized["labels_path"] = "labels.json"
    for key in (
        "prepared_dir",
        "manifest_cache_dir",
        "render_cache_dir",
        "training_view_cache",
        "resumed_from",
    ):
        sanitized[key] = None
    sanitized["sourceBestModelFile"] = (
        Path(source_best).name if isinstance(source_best, str) else None
    )
    sanitized["sourceLastModelFile"] = (
        Path(source_last).name if isinstance(source_last, str) else None
    )
    return sanitized


def _base_manifest(model_id: str, selection: dict, labels: list[str]) -> dict:
    from guesser_data.common import load_step

    images = load_step("06-images")
    candidate = selection["preprocess_candidate"]
    return {
        "version": 1,
        "role": "guesser",
        "modelId": model_id,
        "artifactRevision": None,
        "adapter": "vit-tiny",
        "backbone": BACKBONE,
        "preprocessing": candidate,
        "preprocessingConfigHash": images.candidate_hash(candidate),
        "input": [1, 3, 224, 224],
        "output": [1, len(labels)],
        "dependencies": {
            "torch": torch.__version__,
            "timm": importlib.metadata.version("timm"),
            "safetensors": importlib.metadata.version("safetensors"),
        },
        "files": {},
    }


def _write_bundle(
    root: Path,
    state: dict[str, torch.Tensor],
    labels_bytes: bytes,
    labels: list[str],
    selection: dict,
    manifest: dict,
) -> None:
    from safetensors.torch import save_file

    root.mkdir(parents=True, exist_ok=True)
    save_file(state, root / "weights.safetensors")
    (root / "labels.txt").write_text(
        "\n".join(labels) + "\n", encoding="utf-8"
    )
    (root / "labels.json").write_bytes(labels_bytes)
    (root / "checkpoint-selection.json").write_text(
        json.dumps(_sanitize_selection(selection), indent=2) + "\n",
        encoding="utf-8",
    )
    files = {name: _sha256(root / name) for name in BUNDLE_FILES}
    manifest["files"] = files
    manifest["artifactRevision"] = _artifact_revision(files)
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    _make_readable(root)


def _make_readable(root: Path) -> None:
    """Keep artifacts readable by the unprivileged inference service."""
    root.chmod(0o755)
    for path in root.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


def _fixed_batch() -> torch.Tensor:
    generator = torch.Generator().manual_seed(198173)
    return torch.randn((1, 3, 224, 224), generator=generator)


def _compare_models(
    checkpoint_model: torch.nn.Module,
    exported_model: torch.nn.Module,
    batch: torch.Tensor,
) -> tuple[float, bool]:
    with torch.inference_mode():
        left = checkpoint_model(batch)
        right = exported_model(batch)
    if tuple(left.shape) != (1, 345) or tuple(right.shape) != (1, 345):
        raise ValueError("model output shape is not (1, 345)")
    max_abs = float((left - right).abs().max().item())
    top1_match = int(left.argmax(dim=1).item()) == int(
        right.argmax(dim=1).item()
    )
    return max_abs, top1_match


def _validation_parity(
    checkpoint_model: torch.nn.Module,
    exported_model: torch.nn.Module,
    prepared_dir: Path,
    sample_count: int,
) -> dict:
    from .dataset import GuesserDataset

    dataset = GuesserDataset(
        str(prepared_dir),
        split="validation",
        complete_only=True,
        augment=False,
    )
    rows: list[dict] = []
    for index in range(min(sample_count, len(dataset))):
        sample = dataset[index]
        image = sample.get("image")
        if image is None:
            raise ValueError(f"validation sample {index} has no image")
        max_abs, top1_match = _compare_models(
            checkpoint_model, exported_model, image.unsqueeze(0)
        )
        rows.append(
            {
                "index": index,
                "classId": int(sample["class_id"]),
                "maxAbsDiff": max_abs,
                "top1Match": top1_match,
            }
        )
    if not rows:
        raise ValueError("no validation samples were evaluated")
    return {
        "samples": len(rows),
        "maxAbsDiff": max(row["maxAbsDiff"] for row in rows),
        "top1Agreement": sum(row["top1Match"] for row in rows) / len(rows),
        "rows": rows,
    }


def _verify_bundle(
    root: Path,
    checkpoint_model: torch.nn.Module,
    parity_samples: int,
    prepared_dir: Path | None,
) -> dict:
    from safetensors.torch import load_file

    manifest = json.loads(
        (root / "manifest.json").read_text(encoding="utf-8")
    )
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
        raise ValueError("manifest contract mismatch")
    if manifest["artifactRevision"] != _artifact_revision(files):
        raise ValueError("artifact revision mismatch")
    for name in BUNDLE_FILES:
        if _sha256(root / name) != files[name]:
            raise ValueError(f"artifact hash mismatch: {name}")

    labels = (root / "labels.txt").read_text(encoding="utf-8").splitlines()
    if (
        len(labels) != 345
        or len({label.casefold() for label in labels}) != 345
        or any(not label.strip() for label in labels)
    ):
        raise ValueError("labels.txt order is invalid")
    labels_json = json.loads(
        (root / "labels.json").read_text(encoding="utf-8")
    )
    if (
        not isinstance(labels_json, list)
        or len(labels_json) != 345
        or not all(isinstance(entry, dict) for entry in labels_json)
        or [entry.get("class_id") for entry in labels_json]
        != list(range(345))
        or [entry.get("source_name") for entry in labels_json] != labels
    ):
        raise ValueError("labels.json order is invalid")
    if files["labels.json"] != _sha256(root / "labels.json"):
        raise ValueError("labels.json hash mismatch")

    selection = json.loads(
        (root / "checkpoint-selection.json").read_text(encoding="utf-8")
    )
    if (
        selection.get("backbone") != BACKBONE
        or selection.get("preprocess_candidate") != manifest["preprocessing"]
        or selection.get("labels_sha256") != files["labels.json"]
        or selection.get("num_classes") != len(labels)
        or selection.get("fast_dev")
        or not selection.get("best_model_path")
        or selection.get("best_model_score") is None
    ):
        raise ValueError("checkpoint-selection mismatch")

    from guesser_data.common import load_step

    images = load_step("06-images")
    if manifest["preprocessingConfigHash"] != images.candidate_hash(
        manifest["preprocessing"]
    ):
        raise ValueError("preprocessing config mismatch")

    exported_model = _build_model(
        load_file(root / "weights.safetensors", device="cpu"), len(labels)
    )
    fixed_max, fixed_match = _compare_models(
        checkpoint_model, exported_model, _fixed_batch()
    )
    if fixed_max > 1e-6 or not fixed_match:
        raise ValueError("fixed-tensor parity failed")

    validation = None
    if parity_samples > 0:
        if prepared_dir is None or not prepared_dir.is_dir():
            raise FileNotFoundError(
                "prepared validation data is required for parity samples"
            )
        validation = _validation_parity(
            checkpoint_model, exported_model, prepared_dir, parity_samples
        )
        if validation["maxAbsDiff"] > 1e-6 or validation["top1Agreement"] != 1.0:
            raise ValueError("validation parity failed")

    return {
        "fixedTensor": {
            "maxAbsDiff": fixed_max,
            "top1Match": fixed_match,
        },
        "validation": validation,
    }


def _publish(staging: Path, final: Path, overwrite: bool) -> bool:
    backup: Path | None = None
    if final.exists():
        if not overwrite:
            return False
        backup = final.with_name(f".{final.name}.old-{uuid4().hex}")
        final.rename(backup)
    try:
        staging.rename(final)
    except Exception:
        if backup is not None:
            backup.rename(final)
        raise
    if backup is not None:
        shutil.rmtree(backup)
    return True


def _skipped_summary(
    model_id: str, final: Path, checkpoint_path: Path, selection: dict
) -> dict:
    return {
        "modelId": model_id,
        "bundle": str(final),
        "status": "skipped-existing",
        "message": "bundle already exists; pass --overwrite to replace it",
        "checkpoint": str(checkpoint_path),
        "bestModelScore": selection.get("best_model_score"),
        "createdUtc": datetime.now(UTC).isoformat(),
    }


def export_run(run: str, args: argparse.Namespace) -> dict:
    run_dir = args.checkpoint_root / RUN_DIRS[run]
    selection = json.loads(
        (run_dir / "checkpoint-selection.json").read_text(encoding="utf-8")
    )
    _validate_selection(selection)
    checkpoint_path = _resolve_checkpoint(
        selection, run_dir, args.checkpoint
    )
    model_id = args.model_id or _model_id(args.model_prefix, run)
    if not MODEL_ID.fullmatch(model_id):
        raise ValueError(f"Invalid model ID: {model_id}")
    output_dir = args.output_dir or args.checkpoint_root / "bundles"
    final = output_dir / model_id
    if final.exists() and not args.overwrite:
        return _skipped_summary(
            model_id, final, checkpoint_path, selection
        )

    labels_path = _resolve_labels_path(selection, args.labels_json)
    labels_bytes, labels = _load_labels(labels_path)
    if _sha256(labels_path) != selection.get("labels_sha256"):
        raise ValueError("labels.json hash does not match the selection record")
    state = _load_state_dict(checkpoint_path)
    checkpoint_model = _build_model(state, len(labels))
    manifest = _base_manifest(model_id, selection, labels)

    output_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(
            prefix=f".{model_id}.", suffix=".part", dir=output_dir
        )
    )
    try:
        _write_bundle(
            staging, state, labels_bytes, labels, selection, manifest
        )
        prepared_dir = selection.get("prepared_dir")
        parity = _verify_bundle(
            staging,
            checkpoint_model,
            args.parity_samples,
            Path(prepared_dir) if isinstance(prepared_dir, str) else None,
        )
        if not _publish(staging, final, args.overwrite):
            shutil.rmtree(staging, ignore_errors=True)
            return _skipped_summary(
                model_id, final, checkpoint_path, selection
            )
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    return {
        "modelId": model_id,
        "bundle": str(final),
        "status": "exported",
        "artifactRevision": manifest["artifactRevision"],
        "checkpoint": str(checkpoint_path),
        "bestModelScore": selection.get("best_model_score"),
        "files": manifest["files"],
        "parity": parity,
        "createdUtc": datetime.now(UTC).isoformat(),
    }


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.parity_samples < 0:
        raise ValueError("--parity-samples must be non-negative")
    if args.run == "both" and (
        args.model_id or args.checkpoint or args.labels_json
    ):
        raise ValueError(
            "--model-id, --checkpoint and --labels-json require a single --run"
        )
    if args.output_dir is None:
        args.output_dir = args.checkpoint_root / "bundles"
    runs = ("a", "b") if args.run == "both" else (args.run,)
    summaries = [export_run(run, args) for run in runs]
    print(json.dumps({"bundles": summaries}, indent=2))


if __name__ == "__main__":
    main()
