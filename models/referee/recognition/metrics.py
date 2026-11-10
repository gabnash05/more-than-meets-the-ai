"""Ranking and threshold metrics for Referee evidence channels."""

from __future__ import annotations

import numpy as np


def _as_arrays(scores, labels) -> tuple[np.ndarray, np.ndarray]:
    scores = np.asarray(scores, dtype=np.float64)
    labels = np.asarray(labels, dtype=bool)
    if scores.shape != labels.shape or scores.ndim != 1:
        raise ValueError("scores and labels must be 1-D and the same length")
    return scores, labels


def average_precision(scores, labels) -> float | None:
    """Compute average precision with tied scores handled as one threshold.

    Returns None when the slice has no positive examples; a missing positive
    class is not an accuracy of zero.
    """
    scores, labels = _as_arrays(scores, labels)
    positives = int(labels.sum())
    if positives == 0:
        return None

    order = np.argsort(-scores, kind="mergesort")
    scores, labels = scores[order], labels[order]
    precision: list[float] = []
    recall: list[float] = []
    true_positives = false_positives = 0
    index = 0
    while index < len(scores):
        end = index
        while end + 1 < len(scores) and scores[end + 1] == scores[index]:
            end += 1
        group = labels[index : end + 1]
        true_positives += int(group.sum())
        false_positives += int(len(group) - group.sum())
        precision.append(true_positives / (true_positives + false_positives))
        recall.append(true_positives / positives)
        index = end + 1

    result = 0.0
    previous_recall = 0.0
    for point_precision, point_recall in zip(precision, recall):
        result += (point_recall - previous_recall) * point_precision
        previous_recall = point_recall
    return float(result)


def threshold_metrics(scores, labels, threshold: float) -> dict:
    """Return counts and precision/recall/F1/FPR at one score threshold."""
    scores, labels = _as_arrays(scores, labels)
    predicted = scores >= threshold
    tp = int((predicted & labels).sum())
    fp = int((predicted & ~labels).sum())
    fn = int((~predicted & labels).sum())
    tn = int((~predicted & ~labels).sum())
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = (
        None
        if precision is None or recall is None or precision + recall == 0
        else 2 * precision * recall / (precision + recall)
    )
    false_positive_rate = fp / (fp + tn) if fp + tn else None
    return {
        "threshold": float(threshold),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "falsePositiveRate": false_positive_rate,
    }


def sweep_thresholds(
    scores,
    labels,
    *,
    start: float = 0.05,
    stop: float = 0.95,
    step: float = 0.01,
) -> list[dict]:
    """Evaluate a fixed threshold grid without fitting a policy."""
    if step <= 0 or start > stop:
        raise ValueError("Invalid threshold sweep")
    thresholds = np.arange(start, stop + step / 2, step)
    return [threshold_metrics(scores, labels, round(float(value), 4)) for value in thresholds]


def best_f1(sweep: list[dict]) -> dict | None:
    """Return the best observed-F1 point, or None when no point is defined."""
    defined = [point for point in sweep if point["f1"] is not None]
    return max(defined, key=lambda point: point["f1"]) if defined else None
