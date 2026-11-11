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
from .metrics import average_precision, best_f1, sweep_thresholds, threshold_metrics

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
    if set(scores) != {"foreground", "rgb_resize"}:
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
    allow_threshold_sweep: bool,
    frozen_threshold: float | None,
) -> dict:
    scored = [row for row in predictions if row["status"] == "ok"]
    scores = np.asarray([row["scores"][index] for row in scored], dtype=np.float64)
    encoded = np.asarray([row["encoded"][index] for row in scored])
    encoded_ap = average_precision(scores, encoded)

    known_scores, known_labels = [], []
    reviewed_scores, reviewed_labels = [], []
    proxy_scores, proxy_labels = [], []
    positives = negatives = 0
    for row in scored:
        label = row[known_key]
        if not row[f"{known_key}_known"] or label is None:
            continue
        if type(label) not in (bool, int) or label not in (0, 1):
            raise ValueError(f"Invalid {known_key} label: {label!r}")
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
    reviewed_scores_array = np.asarray(reviewed_scores, dtype=np.float64)
    reviewed_labels_array = np.asarray(reviewed_labels, dtype=bool)
    proxy_scores_array = np.asarray(proxy_scores, dtype=np.float64)
    proxy_labels_array = np.asarray(proxy_labels, dtype=bool)
    known_has_both_classes = positives > 0 and negatives > 0
    thresholds = (
        sweep_thresholds(known_scores_array, known_labels_array)
        if known_has_both_classes and allow_threshold_sweep
        else []
    )

    def support_details(labels: list | np.ndarray) -> dict:
        positive = int(np.sum(labels))
        negative = len(labels) - positive
        reason = (
            "no_positive_or_negative"
            if not labels_any(labels)
            else "no_positive"
            if positive == 0
            else "no_negative"
            if negative == 0
            else None
        )
        return {"positive": positive, "negative": negative, "undefinedReason": reason}

    def labels_any(labels: list | np.ndarray) -> bool:
        return len(labels) > 0

    return {
        "apSupport": {
            "encoded": support_details(encoded),
            "known": support_details(known_labels),
            "reviewed": support_details(reviewed_labels),
            "proxy": support_details(proxy_labels),
        },
        "encodedAp": encoded_ap,
        "knownAp": average_precision(known_scores_array, known_labels_array)
        if known_has_both_classes
        else None,
        "reviewedAp": average_precision(reviewed_scores_array, reviewed_labels_array)
        if np.any(reviewed_labels_array) and np.any(~reviewed_labels_array)
        else None,
        "proxyAp": average_precision(proxy_scores_array, proxy_labels_array)
        if np.any(proxy_labels_array) and np.any(~proxy_labels_array)
        else None,
        "support": {
            "scored": len(scored),
            "known": len(known_labels),
            "positive": positives,
            "negative": negatives,
            "reviewed": len(reviewed_labels),
            "proxy": len(proxy_labels),
        },
        "thresholds": thresholds,
        "bestF1": best_f1(thresholds) if allow_threshold_sweep else None,
        "frozenThreshold": frozen_threshold,
        "encodedAtFrozenThreshold": (
            threshold_metrics(scores, encoded, frozen_threshold)
            if frozen_threshold is not None
            else None
        ),
    }


def _encoded_channel(predictions: list[dict], index: int) -> dict:
    scored = [row for row in predictions if row["status"] == "ok"]
    scores = np.asarray([row["scores"][index] for row in scored], dtype=np.float64)
    encoded = np.asarray([row["encoded"][index] for row in scored])
    return {
        "encodedAp": average_precision(scores, encoded),
        "support": {
            "scored": len(scored),
            "positive": int(encoded.sum()),
            "negative": len(encoded) - int(encoded.sum()),
        },
        "undefinedReason": (
            "no_positive_or_negative"
            if not len(encoded)
            else "no_positive"
            if not encoded.sum()
            else "no_negative"
            if encoded.sum() == len(encoded)
            else None
        ),
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
    split: str = "validation",
    frozen_thresholds: dict[str, float] | None = None,
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
        "split": split,
        "preprocessing": preprocessing,
        "checkpoint": checkpoint,
        "prepared": prepared,
        "coverage": coverage,
        "channels": {
            "text": _channel(
                predictions,
                0,
                known_key="text",
                origin_key="text_origin",
                allow_threshold_sweep=split != "test",
                frozen_threshold=(frozen_thresholds or {}).get("text"),
            ),
            "number": _channel(
                predictions,
                1,
                known_key="number",
                origin_key="number_origin",
                allow_threshold_sweep=split != "test",
                frozen_threshold=(frozen_thresholds or {}).get("number"),
            ),
            **(
                {
                    "symbol": _encoded_channel(predictions, 2),
                    "circle": _encoded_channel(predictions, 3),
                }
                if any(
                    row["status"] == "ok" and len(row["scores"]) == 4
                    for row in predictions
                )
                else {}
            ),
        },
        "meanEncodedApTextNumber": None,
        "probe": probe,
        "frozenThresholds": frozen_thresholds,
        "warnings": [
            "Encoded ATYPICT bits are proxies; they are not reviewed game labels.",
            "The checkpoint score is a training-validation metric, not gameplay precision.",
        ],
        "limits": [
            (
                "Test metrics use the validation-frozen preprocessing and thresholds; "
                "test labels are not used to select either."
                if split == "test"
                else "Validation metrics only; the held-out test split requires a freeze record."
            ),
            "Original source session IDs are unavailable; session-level split independence is unverified.",
            "No replay or persistence timing is measured by this runner.",
        ],
    }
    # Cross-channel errors use only examples where both labels are known.
    paired = [
        row
        for row in predictions
        if row["status"] == "ok"
        and row["text_known"]
        and row["number_known"]
        and row["text"] is not None
        and row["number"] is not None
    ]
    number_only = [row for row in paired if row["number"] == 1 and row["text"] == 0]
    text_only = [row for row in paired if row["text"] == 1 and row["number"] == 0]
    summary["crossChannelConfusion"] = {
        "numberOnlySupport": len(number_only),
        "textOnlySupport": len(text_only),
        "thresholds": [
            {
                "threshold": point["threshold"],
                "numberOnlyFlaggedText": sum(
                    row["scores"][0] >= point["threshold"] for row in number_only
                ),
                "textOnlyFlaggedNumber": sum(
                    row["scores"][1] >= point["threshold"] for row in text_only
                ),
            }
            for point in summary["channels"]["text"]["thresholds"]
        ],
    }
    summary["meanEncodedApTextNumber"] = _mean_encoded(summary)
    return summary


def render_report(summary: dict) -> str:
    """Render a short human-readable report with provenance and limits."""
    checkpoint = summary["checkpoint"]
    lines = [
        f"# Referee {summary.get('split', 'validation')} report",
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
        "| Channel | Encoded AP | Known AP | Reviewed AP | Proxy AP | Known / Pos / Neg |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in ("text", "number"):
        channel = summary["channels"][name]
        support = channel["support"]
        lines.append(
            f"| {name} | {channel['encodedAp']} | {channel['knownAp']} | "
            f"{channel['reviewedAp']} | {channel['proxyAp']} | "
            f"{support['known']} / {support['positive']} / {support['negative']} |"
        )
    for name in ("symbol", "circle"):
        if name not in summary["channels"]:
            continue
        channel = summary["channels"][name]
        lines.append(f"| {name} (diagnostic) | {channel['encodedAp']} | — | — | — | — |")
    if summary.get("split") == "test":
        lines.extend(
            [
                "",
                "## Frozen threshold against encoded proxy labels",
                "",
                "| Channel | Threshold | Precision | Recall | F1 |",
                "| --- | ---: | ---: | ---: | ---: |",
            ]
        )
        for name in ("text", "number"):
            metrics = summary["channels"][name]["encodedAtFrozenThreshold"]
            lines.append(
                f"| {name} | {metrics['threshold']} | {metrics['precision']} | "
                f"{metrics['recall']} | {metrics['f1']} |"
            )
    lines.extend(
        [
            "",
            "## Limits",
            "",
            "- AP is undefined when a slice has no positives or no negatives; JSON apSupport records class counts and the reason.",
            "- Encoded ATYPICT bits are proxies; reviewed-label and proxy metrics are reported separately.",
            "- The filename score is a training-validation metric, not reviewed-label accuracy or gameplay precision.",
            (
                "- Test metrics use thresholds and preprocessing frozen from validation; "
                "test labels did not guide tuning."
                if summary.get("split") == "test"
                else (
                    "- Validation is for threshold review; the held-out test split "
                    "must not guide tuning."
                )
            ),
            "- Original source session IDs are unavailable; session-level split independence is unverified.",
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
                "text": None
                if np.isnan(sample["labels"][0].item())
                else int(sample["labels"][0].item()),
                "number": None
                if np.isnan(sample["labels"][1].item())
                else int(sample["labels"][1].item()),
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
    parser.add_argument(
        "--preprocessing", choices=("auto",) + PREPROCESSORS, default="auto"
    )
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
    if args.split == "test" and (
        args.freeze_record is None or args.validation_report is None
    ):
        raise ValueError("A test run requires --freeze-record and --validation-report")

    freeze: dict | None = None
    if args.split == "test":
        freeze = json.loads(args.freeze_record.read_text(encoding="utf-8"))
        if freeze.get("schema") != "referee-evaluation-freeze-v1":
            raise ValueError("Unsupported freeze record schema")
        if not isinstance(freeze.get("preparedSummarySha256"), str):
            raise ValueError("Freeze record must pin the prepared dataset summary")
        thresholds = freeze.get("thresholds")
        if not isinstance(thresholds, dict) or set(thresholds) != {"text", "number"}:
            raise ValueError("Freeze record must contain text and number thresholds")
        invalid_threshold = any(
            not isinstance(value, (int, float)) or not 0 <= value <= 1
            for value in thresholds.values()
        )
        if invalid_threshold:
            raise ValueError("Frozen thresholds must be numeric values in [0, 1]")
        if freeze.get("preprocessing") not in PREPROCESSORS:
            raise ValueError("Freeze record contains unknown preprocessing")

    output_dir = args.output_dir.expanduser().resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        if not args.overwrite:
            raise FileExistsError(f"Output directory is not empty: {output_dir}")
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    info = inspect_checkpoint(args.checkpoint)
    target = (
        args.target_score if args.target_score is not None else info.best_model_score
    )
    checkpoint_payload = torch.load(
        args.checkpoint, map_location="cpu", weights_only=False
    )
    provenance = checkpoint_payload.get("hyper_parameters", {}).get("provenance")
    if info.num_classes == 2:
        if (
            not isinstance(provenance, dict)
            or provenance.get("model_id") != "referee-vit-v2"
        ):
            raise ValueError("Two-output checkpoint is missing v2 provenance")
        from referee_data import preprocessing_hash

        if provenance.get("preprocessing_hash") != preprocessing_hash():
            raise ValueError(
                "Checkpoint preprocessing does not match installed referee-data"
            )
        if args.preprocessing in ("auto", "foreground"):
            args.preprocessing = "referee_foreground"
        if args.preprocessing != "referee_foreground":
            raise ValueError(
                "v2 requires its recorded referee foreground preprocessing"
            )
    if target is None and args.preprocessing == "auto":
        raise ValueError(
            "Set --target-score for legacy auto preprocessing, or select preprocessing explicitly"
        )

    if args.freeze_record is not None:
        freeze = freeze or json.loads(args.freeze_record.read_text(encoding="utf-8"))
        if freeze.get("checkpointSha256") != info.sha256:
            raise ValueError("Freeze record checkpoint hash does not match")
        if (
            args.preprocessing not in (None, "auto")
            and freeze.get("preprocessing") != args.preprocessing
        ):
            raise ValueError("Freeze record preprocessing does not match")
    if args.split == "test":
        if not args.validation_report.is_file():
            raise FileNotFoundError(args.validation_report)
        report_bytes = args.validation_report.read_bytes()
        report_text = report_bytes.decode("utf-8")
        if hashlib.sha256(report_bytes).hexdigest() != freeze.get("validationReportSha256"):
            raise ValueError("Validation report hash does not match freeze record")
        required_report_fields = (
            "- Split: `validation`",
            f"- Checkpoint SHA-256: `{info.sha256}`",
            f"- Preprocessing: `{freeze['preprocessing']}`",
        )
        if any(field not in report_text for field in required_report_fields):
            raise ValueError("Validation report does not match the frozen run")
        prepared_summary = args.prepared_dir.parent / "dataset-summary.json"
        if not prepared_summary.is_file():
            raise FileNotFoundError(prepared_summary)
        if _sha256(prepared_summary) != freeze["preparedSummarySha256"]:
            raise ValueError("Prepared dataset summary hash does not match freeze record")
        if args.preprocessing == "auto":
            args.preprocessing = freeze["preprocessing"]

    device = torch.device(
        "cuda"
        if args.device == "cuda"
        or (args.device == "auto" and torch.cuda.is_available())
        else "cpu"
    )
    model = load_model(args.checkpoint).to(device)

    probe = None
    preprocessing: str
    if args.preprocessing == "auto":
        probe = {}
        probe_limit = min(200, args.limit) if args.limit else 200
        for candidate in ("foreground", "rgb_resize"):
            probe_predictions = _score_dataset(
                model,
                args.prepared_dir,
                args.split,
                candidate,
                device,
                probe_limit,
                args.batch_size,
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
        model,
        args.prepared_dir,
        args.split,
        preprocessing,
        device,
        args.limit,
        args.batch_size,
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
            "manifestSha256": _sha256(
                args.prepared_dir / "manifests" / f"{args.split}.jsonl"
            ),
        },
        preprocessing=preprocessing,
        probe=probe,
        split=args.split,
        frozen_thresholds=freeze.get("thresholds") if args.split == "test" else None,
    )
    summary["elapsedSeconds"] = round(time.perf_counter() - started, 3)
    _write_json(output_dir / "summary.json", summary)
    (output_dir / "report.md").write_text(render_report(summary), encoding="utf-8")
    print(f"Wrote {output_dir}")


if __name__ == "__main__":
    main()
