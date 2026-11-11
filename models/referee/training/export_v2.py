"""Export a provenance-bearing production referee-vit-v2 bundle."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

import torch
from referee_data import preprocessing_config, preprocessing_hash
from safetensors.torch import load_file, save_file

from .export_bundle import (
    BACKBONE,
    _artifact_revision,
    _build_model,
    _fixed_batch,
    _load_state,
    _sha256,
)


def export(checkpoint: Path, output_dir: Path, evaluation_report: Path) -> dict:
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    provenance = payload.get("hyper_parameters", {}).get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("model_id") != "referee-vit-v2"
    ):
        raise ValueError("Checkpoint is not a provenance-bearing v2 checkpoint")
    if provenance.get("config", {}).get("fast") is not False:
        raise ValueError("Smoke checkpoints cannot be exported")
    if (
        provenance.get("preprocessing_hash") != preprocessing_hash()
        or provenance.get("preprocessing_config") != preprocessing_config()
    ):
        raise ValueError("Preprocessing differs from training checkpoint")
    report_bytes = evaluation_report.read_bytes()
    report = json.loads(report_bytes)
    if (
        report.get("split") != "validation"
        or report.get("checkpoint", {}).get("sha256") != _sha256(checkpoint)
        or report.get("preprocessing") != "referee_foreground"
    ):
        raise ValueError("Validation report must match checkpoint and v2 preprocessing")
    callbacks = payload.get("callbacks", {})
    best_scores = [
        value.get("best_model_score")
        for value in callbacks.values()
        if isinstance(value, dict) and value.get("best_model_score") is not None
    ]
    if not best_scores:
        raise ValueError("Checkpoint lacks best-checkpoint selection score")
    best_score = float(best_scores[0])
    if not torch.isfinite(torch.tensor(best_score)):
        raise ValueError("Checkpoint selection score is not finite")
    state = _load_state(checkpoint)
    if state["head.weight"].shape[0] != 2:
        raise ValueError("v2 requires two output channels")
    original = _build_model(state)
    output_dir.mkdir(parents=True, exist_ok=True)
    final = output_dir / "referee-vit-v2"
    if final.exists():
        raise FileExistsError(final)
    stage = Path(tempfile.mkdtemp(prefix=".referee-vit-v2-", dir=output_dir))
    try:
        labels = ["text", "number"]
        save_file(state, stage / "weights.safetensors")
        (stage / "labels.txt").write_text("\n".join(labels) + "\n", encoding="utf-8")
        (stage / "labels.json").write_text(
            json.dumps(
                [{"class_id": i, "source_name": x} for i, x in enumerate(labels)],
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (stage / "evaluation-summary.json").write_bytes(report_bytes)
        selection = {
            "provenance": provenance,
            "sourceCheckpointSha256": _sha256(checkpoint),
            "epoch": payload.get("epoch"),
            "globalStep": payload.get("global_step"),
            "bestModelScore": best_score,
            "evaluationReportSha256": _sha256(stage / "evaluation-summary.json"),
            "evaluationReport": "evaluation-summary.json",
        }
        (stage / "checkpoint-selection.json").write_text(
            json.dumps(selection, indent=2) + "\n", encoding="utf-8"
        )
        files = {
            name: _sha256(stage / name)
            for name in (
                "weights.safetensors",
                "labels.txt",
                "labels.json",
                "checkpoint-selection.json",
                "evaluation-summary.json",
            )
        }
        manifest = {
            "version": 2,
            "role": "referee",
            "modelId": "referee-vit-v2",
            "adapter": "vit-tiny-referee",
            "backbone": BACKBONE,
            "artifactRevision": _artifact_revision(files),
            "preprocessing": "referee-foreground-v2",
            "preprocessingConfig": preprocessing_config(),
            "preprocessingConfigHash": preprocessing_hash(),
            "input": [1, 3, 224, 224],
            "output": [1, 2],
            "labelOrder": labels,
            "channelOrder": labels,
            "scoreActivation": "sigmoid",
            "files": files,
        }
        (stage / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        exported = _build_model(load_file(stage / "weights.safetensors"))
        with torch.inference_mode():
            left, right = original(_fixed_batch()), exported(_fixed_batch())
        if not torch.allclose(left, right, atol=1e-6, rtol=0) or not torch.allclose(
            left.sigmoid(), right.sigmoid(), atol=1e-6, rtol=0
        ):
            raise ValueError("Logit/probability parity failed")
        os.rename(stage, final)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return {
        "bundle": str(final),
        "artifactRevision": manifest["artifactRevision"],
        "maxLogitDifference": float((left - right).abs().max()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--evaluation-report", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            export(args.checkpoint, args.output_dir, args.evaluation_report), indent=2
        )
    )


if __name__ == "__main__":
    main()
