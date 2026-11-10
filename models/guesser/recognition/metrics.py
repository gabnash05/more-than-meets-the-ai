"""Pure recognition metrics for the fixed ten-stage Guesser evaluation.

The runner owns data access and inference; this module only scores arrays.  A
blank or uncertain preprocessor result is an unsuccessful recognition in the
end-to-end stage curve, while the policy table treats it as a pass.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np
import torch
import torch.nn.functional as F

STAGES = 10
EARLY_STAGES = 9
FRACTIONS = tuple(stage / STAGES for stage in range(1, STAGES + 1))
THRESHOLDS = tuple(round(0.05 * index, 2) for index in range(20))


def _mean(values: Sequence[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    return float(np.mean(present))


def _macro_accuracy(
    correct: np.ndarray, class_ids: np.ndarray, n_classes: int
) -> float | None:
    """Average per-class accuracy so every class has equal weight."""
    accuracies: list[float] = []
    for class_id in range(n_classes):
        mask = class_ids == class_id
        if mask.any():
            accuracies.append(float(correct[mask].mean()))
    return _mean(accuracies)


def stage_metrics(
    correct_top1: np.ndarray,
    correct_top3: np.ndarray,
    status_ok: np.ndarray,
    blank: np.ndarray,
    uncertain: np.ndarray,
    unchanged: np.ndarray,
    class_ids: np.ndarray,
    n_classes: int,
) -> dict:
    """Score the ten end-to-end recognition stages.

    ``correct_top1`` and ``correct_top3`` are ``(originals, stages)`` masks.
    Blank, uncertain and unchanged views remain in the denominator; the
    ``top1AccuracyOk`` diagnostic is the only metric limited to usable views.
    """
    if correct_top1.ndim != 2 or correct_top1.shape[1] != STAGES:
        raise ValueError("correct_top1 must have shape (originals, 10)")
    shape = correct_top1.shape
    for name, array in (
        ("correct_top3", correct_top3),
        ("status_ok", status_ok),
        ("blank", blank),
        ("uncertain", uncertain),
        ("unchanged", unchanged),
    ):
        if array.shape != shape:
            raise ValueError(f"{name} must have shape {shape}")
    if class_ids.shape != (shape[0],):
        raise ValueError("class_ids must have one entry per original")

    originals = shape[0]
    rows: list[dict] = []
    for stage in range(STAGES):
        ok = status_ok[:, stage]
        top1 = correct_top1[:, stage]
        top3 = correct_top3[:, stage]
        rows.append(
            {
                "stage": stage + 1,
                "fraction": FRACTIONS[stage],
                "originals": originals,
                "okViews": int(ok.sum()),
                "blankViews": int(blank[:, stage].sum()),
                "uncertainViews": int(uncertain[:, stage].sum()),
                "unchangedViews": int(unchanged[:, stage].sum()),
                "top1Correct": int(top1.sum()),
                "top1Accuracy": float(top1.mean()) if originals else None,
                "top1AccuracyOk": float(top1[ok].mean()) if ok.any() else None,
                "macroTop1Accuracy": _macro_accuracy(top1, class_ids, n_classes),
                "top3Correct": int(top3.sum()),
                "top3Accuracy": float(top3.mean()) if originals else None,
            }
        )

    early = rows[:EARLY_STAGES]
    return {
        "originals": originals,
        "stages": rows,
        "meanEarlyTop1": _mean([row["top1Accuracy"] for row in early]),
        "meanEarlyTop1Macro": _mean([row["macroTop1Accuracy"] for row in early]),
        "completeTop1": rows[-1]["top1Accuracy"],
        "completeTop3": rows[-1]["top3Accuracy"],
        "blankRate": float(blank.mean()) if blank.size else None,
        "uncertainRate": float(uncertain.mean()) if uncertain.size else None,
        "unchangedRate": float(unchanged.mean()) if unchanged.size else None,
    }


def policy_metrics(
    probabilities: np.ndarray,
    correct_top1: np.ndarray,
    status_ok: np.ndarray,
    thresholds: Sequence[float] = THRESHOLDS,
) -> list[dict]:
    """Report the coverage/accuracy trade-off for confidence thresholds."""
    if probabilities.shape != correct_top1.shape:
        raise ValueError("probabilities must match correct_top1")
    if status_ok.shape != correct_top1.shape:
        raise ValueError("status_ok must match correct_top1")
    originals, stages = correct_top1.shape
    opportunities = originals * stages
    rows: list[dict] = []
    for threshold in thresholds:
        emitted = status_ok & (probabilities >= float(threshold))
        emitted_count = int(emitted.sum())
        correct_emitted = int((emitted & correct_top1).sum())
        stage_rows: list[dict] = []
        for stage in range(stages):
            stage_emitted = emitted[:, stage]
            stage_count = int(stage_emitted.sum())
            stage_correct = int((stage_emitted & correct_top1[:, stage]).sum())
            stage_rows.append(
                {
                    "stage": stage + 1,
                    "coverage": float(stage_emitted.mean()) if originals else None,
                    "emitted": stage_count,
                    "accuracyEmitted": float(stage_correct / stage_count)
                    if stage_count
                    else None,
                    "overallCorrectness": float(stage_correct / originals)
                    if originals
                    else None,
                }
            )
        rows.append(
            {
                "threshold": float(threshold),
                "coverage": float(emitted_count / opportunities)
                if opportunities
                else None,
                "emitted": emitted_count,
                "accuracyEmitted": float(correct_emitted / emitted_count)
                if emitted_count
                else None,
                "overallCorrectness": float(correct_emitted / opportunities)
                if opportunities
                else None,
                "stages": stage_rows,
            }
        )
    return rows


def fit_temperature(logits: np.ndarray, targets: np.ndarray) -> float:
    """Fit one scalar temperature on validation logits with fixed weights."""
    if logits.ndim != 2 or logits.shape[0] != targets.shape[0]:
        raise ValueError("logits must be (samples, classes) and match targets")
    if logits.shape[0] == 0:
        raise ValueError("cannot fit temperature on zero samples")
    features = torch.from_numpy(np.ascontiguousarray(logits, dtype=np.float32))
    labels = torch.from_numpy(np.ascontiguousarray(targets, dtype=np.int64))
    log_temperature = torch.zeros((), dtype=torch.float32, requires_grad=True)
    optimizer = torch.optim.LBFGS(
        [log_temperature],
        lr=0.1,
        max_iter=50,
        line_search_fn="strong_wolfe",
    )

    def closure() -> torch.Tensor:
        optimizer.zero_grad()
        temperature = torch.exp(log_temperature).clamp(0.05, 10.0)
        loss = F.cross_entropy(features / temperature, labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    temperature = float(torch.exp(log_temperature).clamp(0.05, 10.0).item())
    if not np.isfinite(temperature):
        return 1.0
    return temperature


def softmax_top1_probs(logits: np.ndarray, temperature: float) -> np.ndarray:
    """Return calibrated top-1 probabilities for a logits batch."""
    if logits.ndim != 2:
        raise ValueError("logits must be (samples, classes)")
    scaled = np.asarray(logits, dtype=np.float32) / float(temperature)
    scaled = scaled - scaled.max(axis=1, keepdims=True)
    exp = np.exp(scaled)
    probabilities = exp / exp.sum(axis=1, keepdims=True)
    return probabilities.max(axis=1).astype(np.float32)


def _stratified_indices(
    class_ids: np.ndarray, n_classes: int, rng: np.random.Generator
) -> np.ndarray:
    parts: list[np.ndarray] = []
    for class_id in range(n_classes):
        indices = np.flatnonzero(class_ids == class_id)
        if indices.size:
            parts.append(rng.choice(indices, size=indices.size, replace=True))
    if not parts:
        raise ValueError("cannot bootstrap an empty evaluation")
    return np.concatenate(parts)


def bootstrap_ci(
    values: np.ndarray,
    class_ids: np.ndarray,
    n_classes: int,
    metric_fn: Callable[[np.ndarray, np.ndarray], float | None],
    n_bootstrap: int = 1000,
    seed: int = 198173,
) -> dict:
    """Bootstrap whole drawings within class, keeping all stages together."""
    if n_bootstrap < 1:
        raise ValueError("n_bootstrap must be positive")
    if values.shape[0] != class_ids.shape[0]:
        raise ValueError("values and class_ids must describe the same originals")
    rng = np.random.default_rng(seed)
    observed = metric_fn(values, class_ids)
    samples: list[float] = []
    for _ in range(n_bootstrap):
        sampled = _stratified_indices(class_ids, n_classes, rng)
        value = metric_fn(values[sampled], class_ids[sampled])
        if value is not None and np.isfinite(value):
            samples.append(float(value))
    return {
        "observed": observed,
        "mean": float(np.mean(samples)) if samples else None,
        "low": float(np.percentile(samples, 2.5)) if samples else None,
        "high": float(np.percentile(samples, 97.5)) if samples else None,
        "samples": len(samples),
    }


def paired_bootstrap(
    values_a: np.ndarray,
    values_b: np.ndarray,
    class_ids: np.ndarray,
    n_classes: int,
    metric_fn: Callable[[np.ndarray, np.ndarray], float | None],
    n_bootstrap: int = 1000,
    seed: int = 198173,
) -> dict:
    """Compare A and B on the same resampled drawings and stages."""
    if values_a.shape != values_b.shape:
        raise ValueError("paired arrays must have the same shape")
    if n_bootstrap < 1:
        raise ValueError("n_bootstrap must be positive")
    rng = np.random.default_rng(seed)
    observed_a = metric_fn(values_a, class_ids)
    observed_b = metric_fn(values_b, class_ids)
    deltas: list[float] = []
    for _ in range(n_bootstrap):
        sampled = _stratified_indices(class_ids, n_classes, rng)
        value_a = metric_fn(values_a[sampled], class_ids[sampled])
        value_b = metric_fn(values_b[sampled], class_ids[sampled])
        if (
            value_a is not None
            and value_b is not None
            and np.isfinite(value_a)
            and np.isfinite(value_b)
        ):
            deltas.append(float(value_a - value_b))
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
            "mean": float(np.mean(deltas)) if deltas else None,
            "low": float(np.percentile(deltas, 2.5)) if deltas else None,
            "high": float(np.percentile(deltas, 97.5)) if deltas else None,
            "samples": len(deltas),
        },
    }


def early_mean_metric(values: np.ndarray, class_ids: np.ndarray) -> float | None:
    """Overall end-to-end top-1 averaged over 10% through 90%."""
    del class_ids
    if values.size == 0:
        return None
    return float(values[:, :EARLY_STAGES].mean())


def early_mean_macro_metric(values: np.ndarray, class_ids: np.ndarray) -> float | None:
    """Macro class-averaged end-to-end top-1 over 10% through 90%."""
    if values.size == 0:
        return None
    classes = np.unique(class_ids)
    accuracies = [
        float(values[class_ids == class_id, :EARLY_STAGES].mean())
        for class_id in classes
        if np.any(class_ids == class_id)
    ]
    return _mean(accuracies)


def complete_top1_metric(values: np.ndarray, class_ids: np.ndarray) -> float | None:
    """End-to-end top-1 at the complete drawing."""
    del class_ids
    if values.size == 0:
        return None
    return float(values[:, STAGES - 1].mean())


def trajectory_metrics(correct_top1: np.ndarray) -> dict:
    """Describe when a drawing first becomes and stays correct."""
    if correct_top1.ndim != 2 or correct_top1.shape[1] != STAGES:
        raise ValueError("correct_top1 must have shape (originals, 10)")
    originals = correct_top1.shape[0]
    any_correct = correct_top1.any(axis=1)
    first = np.where(any_correct, correct_top1.argmax(axis=1), -1)
    histogram = {str(stage + 1): int((first == stage).sum()) for stage in range(STAGES)}
    histogram["never"] = int((first == -1).sum())
    eligible = (first >= 0) & (first < STAGES - 1)
    eligible_indices = np.flatnonzero(eligible)
    next_correct = (
        correct_top1[eligible_indices, first[eligible_indices] + 1]
        if eligible_indices.size
        else np.array([], dtype=bool)
    )
    persistent = [
        bool(correct_top1[index, first[index] :].all()) for index in eligible_indices
    ]
    return {
        "firstCorrect": histogram,
        "nextStageAfterFirst": {
            "eligible": int(eligible.sum()),
            "correct": int(next_correct.sum()),
            "accuracy": float(next_correct.mean()) if next_correct.size else None,
        },
        "staysCorrectAfterFirst": {
            "eligible": int(eligible.sum()),
            "correct": int(sum(persistent)),
            "accuracy": float(np.mean(persistent)) if persistent else None,
        },
        "censoredNever": int((first == -1).sum()),
        "censoredAtComplete": int((first == STAGES - 1).sum()),
        "originals": originals,
    }


def confusion_matrix(
    predicted: np.ndarray,
    true: np.ndarray,
    status_ok: np.ndarray,
    n_classes: int,
) -> np.ndarray:
    """Count true/predicted pairs for views that actually ran the model."""
    if predicted.shape != true.shape or predicted.shape != status_ok.shape:
        raise ValueError("predicted, true and status_ok must share a shape")
    mask = status_ok & (predicted >= 0)
    flat = true[mask].astype(np.int64) * n_classes + predicted[mask].astype(np.int64)
    return np.bincount(flat, minlength=n_classes * n_classes).reshape(
        n_classes, n_classes
    )


def top_confusions(
    matrix: np.ndarray, labels: Sequence[str], limit: int = 20
) -> list[dict]:
    """Return the most frequent off-diagonal true/predicted pairs."""
    if matrix.shape != (len(labels), len(labels)):
        raise ValueError("matrix shape must match labels")
    work = matrix.copy()
    np.fill_diagonal(work, 0)
    order = np.argsort(work, axis=None)[::-1]
    rows: list[dict] = []
    for flat_index in order[:limit]:
        true_id, predicted_id = divmod(int(flat_index), len(labels))
        count = int(work[true_id, predicted_id])
        if count == 0:
            break
        rows.append(
            {
                "trueId": true_id,
                "trueLabel": labels[true_id],
                "predictedId": predicted_id,
                "predictedLabel": labels[predicted_id],
                "count": count,
            }
        )
    return rows


def per_class_metrics(
    correct_top1: np.ndarray,
    class_ids: np.ndarray,
    labels: Sequence[str],
) -> list[dict]:
    """Return support and stage accuracy for every class, including zeroes."""
    rows: list[dict] = []
    for class_id, label in enumerate(labels):
        mask = class_ids == class_id
        support = int(mask.sum())
        stage_accuracy = [
            float(correct_top1[mask, stage].mean()) if support else None
            for stage in range(STAGES)
        ]
        rows.append(
            {
                "classId": class_id,
                "label": label,
                "support": support,
                "stageAccuracy": stage_accuracy,
                "meanEarlyTop1": _mean(stage_accuracy[:EARLY_STAGES]),
                "completeTop1": stage_accuracy[-1],
            }
        )
    return rows
