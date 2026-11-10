"""Offline validation evaluation for the Referee ViT checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from pathlib import Path

import numpy as np
import torch

from .checkpoint import CheckpointInfo, inspect_checkpoint, load_model
from .dataset import LABEL_ORDER, PREPROCESSORS, RefereeEvaluationDataset
from .metrics import average_precision, best_f1, sweep_thresholds

SCHEMA = "referee-evaluation-v1"
ENCODED_ORDER = ("text", "number", "symbol", "circle")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _checkpoint_payload(info: CheckpointInfo) -> dict:
    return {
        "path": info.path,
        "sha256": info.sha256,
        "epoch": info.epoch,
        "globalStep": info.global_step,
        "lightningVersion": info.lightning_version,
        "numClasses": info.num_classes,
        "headInFeatures": info.head_in_features,
        "hyperParameters": info.hyper_parameters,
        "bestModelScore": info.best_model_score,
    }


def choose_preprocessing(
    scores: dict[str, float],
    target: float,
    *,
    tolerance: float = 0.03,
    separation: float = 0.01,
) -> str:
    """Pick the candidate closest to the checkpoint's recorded score.

    Ambiguity is an error. The caller must ask the training owner or pass an
    explicit candidate rather than silently choosing a preprocessing path.
    """
    if set(scores) != set(PREPROCESSORS):
        raise ValueError(f"Expected scores for {PREPROCESSORS}")
    ranked = sorted(scores.items(), key=lambda item: abs(item[1] - target))
    best_name, best_score = ranked[0]
    runner_score = ranked[1][1]
    if abs(best_score - target) > tolerance:
        raise ValueError(
            f"No preprocessing candidate is within {tolerance:.2f} of target {target:.4f}: {scores}"
        )
    if abs(runner_score - target) - abs(best_score - target) < separation:
        raise ValueError(f"Preprocessing candidates are ambiguous: {scores}")
    return best_name


def _channel(
    predictions: list[dict],
    index: int,
    *,
    known_key: str,
    origin_key: str,
) -> dict:
    scored = [row for row in predictions if row["status"] == "ok"]
    scores = np.asarray([row["scores"][index] for row in scored], dtype=np.float64)
    encoded = np.asarray([row["encoded"][index] for row in scored], dtype=bool)
    encoded_ap = average_precision(scores, encoded)

    known_scores, known_labels = [], []
    reviewed_scores, reviewed_labels = [], []
    proxy_scores, proxy_labels = [], []
    positives = negatives = 0
    for row in scored:
        label = row[known_key]
        if not row[f"{known_key}_known"] or label is None:
            continue
        label = bool(label)
        known_scores.append(row["scores"][index])
        known_labels.append(label)
        positives += int(label)
        negatives += int(not label)
        if row[origin_key] == "reviewed":
            reviewed_scores.append(row["scores"][index])
            reviewed_labels.append(label)
        elif row[origin_key] == "encoded_positive":
            proxy_scores.append(row["scores"][index])
            proxy_labels.append(label)

    known_scores_array = np.asarray(known_scores, dtype=np.float64)
    known_labels_array = np.asarray(known_labels, dtype=bool)
    thresholds = (
        sweep_thresholds(known_scores_array, known_labels_array)
        if len(known_labels_array)
        else []
    )
    return {
        "encodedAp": encoded_ap,
        "knownAp": average_precision(known_scores_array, known_labels_array)
        if len(known_labels_array)
        else None,
        "reviewedAp": average_precision(
            np.asarray(reviewed_scores, dtype=np.float64),
            np.asarray(reviewed_labels, dtype=bool),
        )
        if reviewed_labels
        else None,
        "proxyAp": average_precision(
            np.asarray(proxy_scores, dtype=np.float64),
            np.asarray(proxy_labels, dtype=bool),
        )
        if proxy_labels
        else None,
        "support": {
            "scored": len(scored),
            "known": len(known_labels),
            "positive": positives,
            "negative": negatives,
        },
        "thresholds": thresholds,
        "bestF1": best_f1(thresholds),
    }


def _encoded_channel(predictions: list[dict], index: int) -> dict:
    scored = [row for row in predictions if row["status"] == "ok"]
    scores = np.asarray([row["scores"][index] for row in scored], dtype=np.float64)
    encoded = np.asarray([row["encoded"][index] for row in scored], dtype=bool)
    return {
        "encodedAp": average_precision(scores, encoded),
        "support": {"scored": len(scored), "positive": int(encoded.sum())},
    }


def _mean_encoded(summary: dict) -> float | None:
    values = [
        summary["channels"]["text"]["encodedAp"],
        summary["channels"]["number"]["encodedAp"],
    ]
    return None if any(value is None for value in values) else float(sum(values) / 2)


def summarize_predictions(
    predictions: list[dict],
    *,
    checkpoint: dict,
    prepared: dict,
    preprocessing: str,
    probe: dict | None,
) -> dict:
    """Build a JSON-safe summary from per-row predictions."""
    coverage = {
        "rows": len(predictions),
        "scored": sum(row["status"] == "ok" for row in predictions),
        "blank": sum(row["status"] == "blank" for row in predictions),
        "uncertain": sum(row["status"] == "uncertain" for row in predictions),
        "missing": sum(row["status"] == "missing" for row in predictions),
        "text": {"known": 0, "positive": 0, "negative": 0},
        "number": {"known": 0, "positive": 0, "negative": 0},
    }
    for row in predictions:
        if row["status"] != "ok":
            continue
        for channel in LABEL_ORDER:
            if row[f"{channel}_known"] and row[channel] is not None:
                coverage[channel]["known"] += 1
                coverage[channel]["positive" if row[channel] == 1 else "negative"] += 1

    summary = {
        "schema": SCHEMA,
        "preprocessing": preprocessing,
        "checkpoint": checkpoint,
        "prepared": prepared,
        "coverage": coverage,
        "channels": {
            "text": _channel(
                predictions, 0, known_key="text", origin_key="text_origin"
            ),
            "number": _channel(
                predictions, 1, known_key="number", origin_key="number_origin"
            ),
            "symbol": _encoded_channel(predictions, 2),
            "circle": _encoded_channel(predictions, 3),
        },
        "meanEncodedApTextNumber": None,
        "probe": probe,
        "warnings": [
            "Encoded ATYPICT bits are proxies; they are not reviewed game labels.",
            "The checkpoint score is a training-validation metric, not gameplay precision.",
        ],
        "limits": [
            "Validation metrics only; the held-out test split requires a freeze record.",
            "No replay or persistence timing is measured by this runner.",
        ],
    }
    summary["meanEncodedApTextNumber"] = _mean_encoded(summary)
    return summary


def render_report(summary: dict) -> str:
    """Render a short human-readable report with provenance and limits."""
    checkpoint = summary["checkpoint"]
    lines = [
        "# Referee validation report",
        "",
        f"- Split: `{summary.get('split', 'validation')}`",
        f"- Preprocessing: `{summary['preprocessing']}`",
        f"- Checkpoint SHA-256: `{checkpoint['sha256']}`",
        f"- Checkpoint score (filename): `{checkpoint['bestModelScore']}`",
        f"- Encoded mean AP (text+number): `{summary['meanEncodedApTextNumber']}`",
        "",
        "## Coverage",
        "",
        "| Rows | Scored | Blank | Uncertain | Missing |",
        "| ---: | ---: | ---: | ---: | ---: |",
        (
            f"| {summary['coverage']['rows']} | {summary['coverage']['scored']} | "
            f"{summary['coverage']['blank']} | {summary['coverage']['uncertain']} | "
            f"{summary['coverage']['missing']} |"
        ),
        "",
        "## Channels",
        "",
        "| Channel | Encoded AP | Known AP | Reviewed AP | Proxy AP | Known / Positive |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in ("text", "number"):
        channel = summary["channels"][name]
        support = channel["support"]
        lines.append(
            f"| {name} | {channel['encodedAp']} | {channel['knownAp']} | "
            f"{channel['reviewedAp']} | {channel['proxyAp']} | "
            f"{support['known']} / {support['positive']} |"
        )
    for name in ("symbol", "circle"):
        channel = summary["channels"][name]
        lines.append(f"| {name} (diagnostic) | {channel['encodedAp']} | — | — | — | — |")
    lines.extend(
        [
            "",
            "## Limits",
            "",
            "- Encoded ATYPICT bits are proxies; reviewed-label and proxy metrics are reported separately.",
            "- The filename score is a training-validation metric, not reviewed-label accuracy or gameplay precision.",
            "- Validation is for threshold review; the held-out test split must not guide tuning.",
            "- No serving, replay or persistence timing is validated here.",
            "",
        ]
    )
    return "\n".join(lines)


def _score_dataset(
    model,
    prepared: Path,
    split: str,
    preprocessing: str,
    device: torch.device,
    limit: int | None,
    batch_size: int,
) -> list[dict]:
    dataset = RefereeEvaluationDataset(prepared, split, preprocessing)
    rows = range(len(dataset)) if limit is None else range(min(limit, len(dataset)))
    output: list[dict] = []
    pending: list[tuple[int, dict]] = []

    def flush() -> None:
        if not pending:
            return
        images = torch.stack([sample["image"] for _, sample in pending]).to(device)
        with torch.inference_mode():
            logits = model(images)
            probabilities = torch.sigmoid(logits).cpu().numpy()
        for (index, sample), scores in zip(pending, probabilities):
            output[index] = {
                "sample_id": sample["sample_id"],
                "status": "ok",
                "scores": [float(value) for value in scores],
                "encoded": [int(value) for value in sample["encoded"].tolist()],
                "text": None if np.isnan(sample["labels"][0].item()) else int(sample["labels"][0].item()),
                "number": None if np.isnan(sample["labels"][1].item()) else int(sample["labels"][1].item()),
                "text_known": bool(sample["known"][0].item()),
                "number_known": bool(sample["known"][1].item()),
                "text_origin": sample["origins"][0],
                "number_origin": sample["origins"][1],
            }
        pending.clear()

    output = [{} for _ in rows]
    for index, row_index in enumerate(rows):
        sample = dataset[row_index]
        if sample["status"] != "ok" or sample["image"] is None:
            output[index] = {
                "sample_id": sample["sample_id"],
                "status": sample["status"],
                "scores": None,
                "encoded": [int(value) for value in sample["encoded"].tolist()],
                "text": None,
                "number": None,
                "text_known": False,
                "number_known": False,
                "text_origin": sample["origins"][0],
                "number_origin": sample["origins"][1],
            }
            continue
        pending.append((index, sample))
        if len(pending) >= batch_size:
            flush()
    flush()
    return output


def _write_json(path: Path, payload: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a Referee checkpoint.")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--split", choices=("validation", "test"), default="validation")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--preprocessing", choices=("auto",) + PREPROCESSORS, default="auto")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--bootstrap", type=int, default=1000)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--target-score", type=float, default=None)
    parser.add_argument("--freeze-record", type=Path, default=None)
    parser.add_argument("--validation-report", type=Path, default=None)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if args.batch_size < 1:
        raise ValueError("batch-size must be positive")
    if args.limit is not None and args.limit < 1:
        raise ValueError("limit must be positive")
    if args.split == "test" and (args.freeze_record is None or args.validation_report is None):
        raise ValueError("A test run requires --freeze-record and --validation-report")

    output_dir = args.output_dir.expanduser().resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        if not args.overwrite:
            raise FileExistsError(f"Output directory is not empty: {output_dir}")
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    info = inspect_checkpoint(args.checkpoint)
    target = args.target_score if args.target_score is not None else info.best_model_score
    if target is None:
        raise ValueError("Set --target-score; the checkpoint filename has no score")

    if args.freeze_record is not None:
        freeze = json.loads(args.freeze_record.read_text(encoding="utf-8"))
        if freeze.get("checkpointSha256") != info.sha256:
            raise ValueError("Freeze record checkpoint hash does not match")
        if args.preprocessing not in (None, "auto") and freeze.get("preprocessing") != args.preprocessing:
            raise ValueError("Freeze record preprocessing does not match")
    if args.validation_report is not None and not args.validation_report.is_file():
        raise FileNotFoundError(args.validation_report)

    device = torch.device(
        "cuda" if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available()) else "cpu"
    )
    model = load_model(args.checkpoint).to(device)

    probe = None
    preprocessing: str
    if args.preprocessing == "auto":
        probe = {}
        probe_limit = min(200, args.limit) if args.limit else 200
        for candidate in PREPROCESSORS:
            probe_predictions = _score_dataset(
                model, args.prepared_dir, args.split, candidate, device, probe_limit, args.batch_size
            )
            probe_summary = summarize_predictions(
                probe_predictions,
                checkpoint=_checkpoint_payload(info),
                prepared={},
                preprocessing=candidate,
                probe=None,
            )
            probe[candidate] = probe_summary["meanEncodedApTextNumber"]
        _write_json(output_dir / "preprocessing-probe.json", probe)
        preprocessing = choose_preprocessing(
            {key: value for key, value in probe.items() if value is not None}, target
        )
    else:
        preprocessing = str(args.preprocessing)

    predictions = _score_dataset(
        model, args.prepared_dir, args.split, preprocessing, device, args.limit, args.batch_size
    )
    predictions_path = output_dir / "predictions.jsonl"
    with predictions_path.open("w", encoding="utf-8") as stream:
        for row in predictions:
            stream.write(json.dumps(row, sort_keys=True) + "\n")

    summary = summarize_predictions(
        predictions,
        checkpoint=_checkpoint_payload(info),
        prepared={
            "summarySha256": _sha256(args.prepared_dir.parent / "dataset-summary.json"),
            "manifestSha256": _sha256(args.prepared_dir / "manifests" / f"{args.split}.jsonl"),
        },
        preprocessing=preprocessing,
        probe=probe,
    )
    summary["split"] = args.split
    summary["elapsedSeconds"] = round(time.perf_counter() - started, 3)
    _write_json(output_dir / "summary.json", summary)
    (output_dir / "report.md").write_text(render_report(summary), encoding="utf-8")
    print(f"Wrote {output_dir}")


if __name__ == "__main__":
    main()
