"""Export the Referee checkpoint as a hashed serving bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import torch

BACKBONE = "vit_tiny_patch16_224.augreg_in21k_ft_in1k"
MODEL_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")
LABEL_ORDER = ("text", "number", "symbol", "circle")
CHANNEL_ORDER = ("text", "number")
PREPROCESSORS = ("foreground", "rgb_resize")
BUNDLE_FILES = (
    "weights.safetensors",
    "labels.txt",
    "labels.json",
    "checkpoint-selection.json",
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "checkpoints" / "bundles"
DEFAULT_CHECKPOINT = (
    Path(__file__).resolve().parents[1]
    / "checkpoints"
    / "referee-epoch=04-val_mean_ap=0.5564.ckpt"
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _artifact_revision(files: dict[str, str]) -> str:
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _labels() -> tuple[bytes, list[str]]:
    labels = [
        {"class_id": index, "source_name": name}
        for index, name in enumerate(LABEL_ORDER)
    ]
    labels_json = (json.dumps(labels, indent=2) + "\n").encode()
    return labels_json, list(LABEL_ORDER)


def _preprocessing_hash(candidate: str) -> str:
    if candidate == "foreground":
        from models.guesser.data.src.common import load_step

        return load_step("06-images").candidate_hash("foreground")
    if candidate == "rgb_resize":
        encoded = json.dumps(
            {"candidate": "rgb_resize", "size": [224, 224], "normalize": False},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return hashlib.sha256(encoded).hexdigest()
    raise ValueError(f"Unsupported preprocessing: {candidate}")


def _load_state(checkpoint_path: Path) -> dict[str, torch.Tensor]:
    # Lightning checkpoints contain non-tensor objects; only export the trusted teammate file.
    # Never use this loader on an untrusted checkpoint.
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    state = checkpoint.get("state_dict")
    if not isinstance(state, dict) or not state:
        raise ValueError("Checkpoint has no state_dict")
    stripped: dict[str, torch.Tensor] = {}
    for key, value in state.items():
        if not isinstance(key, str) or not key.startswith("model."):
            raise ValueError("Checkpoint state_dict keys are not model.*")
        if not isinstance(value, torch.Tensor):
            raise TypeError("Checkpoint state_dict contains a non-tensor value")
        stripped[key.removeprefix("model.")] = value.detach().cpu().contiguous()
    return stripped


def _manifest(
    model_id: str,
    preprocessing: str,
    files: dict[str, str],
    labels: list[str],
) -> dict:
    return {
        "version": 1,
        "role": "referee",
        "modelId": model_id,
        "artifactRevision": _artifact_revision(files),
        "adapter": "vit-tiny-referee",
        "backbone": BACKBONE,
        "preprocessing": preprocessing,
        "preprocessingConfigHash": _preprocessing_hash(preprocessing),
        "input": [1, 3, 224, 224],
        "output": [1, len(labels)],
        "labelOrder": list(labels),
        "channelOrder": list(CHANNEL_ORDER),
        "scoreActivation": "sigmoid",
        "files": files,
    }


def _selection(
    checkpoint_path: Path,
    preprocessing: str,
    labels_json: bytes,
    num_classes: int,
    epoch: int | None,
    best_model_score: float | None,
) -> dict:
    return {
        "backbone": BACKBONE,
        "preprocess_candidate": preprocessing,
        "labels_sha256": hashlib.sha256(labels_json).hexdigest(),
        "num_classes": num_classes,
        "fast_dev": False,
        "best_model_path": "weights.safetensors",
        "best_model_score": best_model_score,
        "sourceCheckpoint": checkpoint_path.name,
        "sourceCheckpointSha256": _sha256(checkpoint_path),
        "epoch": epoch,
        "createdUtc": datetime.now(UTC).isoformat(),
    }


def _build_model(state: dict[str, torch.Tensor]) -> torch.nn.Module:
    import timm

    model = timm.create_model(
        BACKBONE, pretrained=False, num_classes=int(state["head.weight"].shape[0])
    )
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def _fixed_batch() -> torch.Tensor:
    generator = torch.Generator().manual_seed(198173)
    return torch.randn((1, 3, 224, 224), generator=generator)


def _make_readable(root: Path) -> None:
    """Keep artifacts readable by the unprivileged inference service."""
    root.chmod(0o755)
    for path in root.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


def _verify(root: Path, checkpoint_model: torch.nn.Module) -> dict:
    from safetensors.torch import load_file

    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    files = manifest.get("files")
    if (
        manifest.get("version") != 1
        or manifest.get("role") != "referee"
        or manifest.get("adapter") != "vit-tiny-referee"
        or manifest.get("input") != [1, 3, 224, 224]
        or manifest.get("output") != [1, len(LABEL_ORDER)]
        or manifest.get("labelOrder") != list(LABEL_ORDER)
        or manifest.get("channelOrder") != list(CHANNEL_ORDER)
        or manifest.get("scoreActivation") != "sigmoid"
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
    if labels != list(LABEL_ORDER):
        raise ValueError("labels.txt order is invalid")
    labels_json = json.loads((root / "labels.json").read_text(encoding="utf-8"))
    if (
        not isinstance(labels_json, list)
        or [entry.get("class_id") for entry in labels_json] != list(range(4))
        or [entry.get("source_name") for entry in labels_json] != labels
    ):
        raise ValueError("labels.json order is invalid")

    exported = _build_model(load_file(root / "weights.safetensors", device="cpu"))
    with torch.inference_mode():
        left = checkpoint_model(_fixed_batch())
        right = exported(_fixed_batch())
    max_abs = float((left - right).abs().max().item())
    if max_abs > 1e-6:
        raise ValueError("fixed-tensor parity failed")
    return {"maxAbsDiff": max_abs, "output": list(left.shape)}


def export(
    checkpoint: Path,
    model_id: str,
    preprocessing: str,
    output_dir: Path,
    *,
    overwrite: bool = False,
) -> dict:
    """Export one trusted checkpoint; return a JSON-safe summary."""
    if not MODEL_ID.fullmatch(model_id):
        raise ValueError(f"Invalid model ID: {model_id}")
    if preprocessing not in PREPROCESSORS:
        raise ValueError(f"Unsupported preprocessing: {preprocessing}")
    if not checkpoint.is_file():
        raise FileNotFoundError(checkpoint)

    final = output_dir / model_id
    if final.exists() and not overwrite:
        return {"status": "skipped-existing", "bundle": str(final)}
    output_dir.mkdir(parents=True, exist_ok=True)

    state = _load_state(checkpoint)
    checkpoint_model = _build_model(state)
    labels_json, labels = _labels()
    epoch_match = re.search(r"epoch=(\d+)", checkpoint.name)
    epoch = int(epoch_match.group(1)) if epoch_match else None
    score_match = re.search(r"val_mean_ap=([0-9]+(?:\.[0-9]+)?)", checkpoint.name)
    selection = _selection(
        checkpoint,
        preprocessing,
        labels_json,
        len(labels),
        epoch,
        float(score_match.group(1)) if score_match else None,
    )
    selection_bytes = (json.dumps(selection, indent=2) + "\n").encode()

    staging = Path(tempfile.mkdtemp(prefix=f".{model_id}.", dir=output_dir))
    try:
        from safetensors.torch import save_file

        save_file(state, staging / "weights.safetensors")
        (staging / "labels.txt").write_text("\n".join(labels) + "\n", encoding="utf-8")
        (staging / "labels.json").write_bytes(labels_json)
        (staging / "checkpoint-selection.json").write_bytes(selection_bytes)
        files = {name: _sha256(staging / name) for name in BUNDLE_FILES}
        manifest = _manifest(model_id, preprocessing, files, labels)
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        _make_readable(staging)
        parity = _verify(staging, checkpoint_model)

        backup = None
        if final.exists():
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
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    return {
        "status": "exported",
        "modelId": model_id,
        "bundle": str(final),
        "artifactRevision": manifest["artifactRevision"],
        "preprocessing": preprocessing,
        "files": manifest["files"],
        "parity": parity,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a Referee serving bundle.")
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--model-id", default="referee-vit-a-v1")
    parser.add_argument("--preprocessing", choices=PREPROCESSORS, required=True)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--overwrite", action="store_true")
    arguments = parser.parse_args()
    print(json.dumps(
        export(
            arguments.checkpoint,
            arguments.model_id,
            arguments.preprocessing,
            arguments.output_dir,
            overwrite=arguments.overwrite,
        ),
        indent=2,
    ))


if __name__ == "__main__":
    main()
