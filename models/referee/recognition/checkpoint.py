"""Read a trusted Lightning Referee checkpoint without training dependencies."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import timm
import torch


@dataclass(frozen=True)
class CheckpointName:
    epoch: int
    best_model_score: float


@dataclass(frozen=True)
class CheckpointInfo:
    path: str
    sha256: str
    epoch: int | None
    global_step: int | None
    lightning_version: str | None
    num_classes: int
    head_in_features: int
    hyper_parameters: dict
    best_model_score: float | None


def parse_checkpoint_name(path: Path) -> CheckpointName:
    """Parse the Lightning filename fields used for provenance."""
    match = re.search(r"epoch=(\d+)-val_mean_ap=([0-9.]+)\.ckpt$", path.name)
    if not match:
        raise ValueError(f"Unrecognised checkpoint filename: {path.name}")
    return CheckpointName(int(match.group(1)), float(match.group(2)))


def strip_model_prefix(state: dict) -> dict:
    """Remove the Lightning wrapper prefix so timm can load the state dict."""
    return {key.removeprefix("model."): value for key, value in state.items()}


def inspect_checkpoint(path: Path) -> CheckpointInfo:
    """Load metadata and state shapes; the checkpoint is trusted local data."""
    # Lightning checkpoints contain non-tensor objects; only load the trusted teammate file.
    # Never use this loader on an untrusted checkpoint.
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    state = checkpoint["state_dict"]
    head = state.get("model.head.weight")
    if head is None or head.ndim != 2:
        raise ValueError("Checkpoint has no 2-D model.head.weight")
    name = parse_checkpoint_name(path)
    return CheckpointInfo(
        path=str(path.resolve()),
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        epoch=checkpoint.get("epoch"),
        global_step=checkpoint.get("global_step"),
        lightning_version=checkpoint.get("pytorch-lightning_version"),
        num_classes=int(head.shape[0]),
        head_in_features=int(head.shape[1]),
        hyper_parameters=dict(checkpoint.get("hyper_parameters") or {}),
        best_model_score=name.best_model_score,
    )


def load_model(path: Path):
    """Create the ViT-Tiny architecture offline and load the checkpoint strictly."""
    # Lightning checkpoints contain non-tensor objects; only load the trusted teammate file.
    # Never use this loader on an untrusted checkpoint.
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    state = strip_model_prefix(checkpoint["state_dict"])
    head = state["head.weight"]
    model = timm.create_model(
        "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
        pretrained=False,
        num_classes=int(head.shape[0]),
    )
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Inspect a Referee checkpoint.")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--json", action="store_true")
    arguments = parser.parse_args()
    info = inspect_checkpoint(arguments.checkpoint)
    if arguments.json:
        print(json.dumps(asdict(info), indent=2, sort_keys=True))
    else:
        print(info)
