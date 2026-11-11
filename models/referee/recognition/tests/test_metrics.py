import numpy as np
import pytest

from recognition.metrics import average_precision, threshold_metrics


def test_average_precision_perfect_and_reversed() -> None:
    labels = np.array([1, 1, 0, 0])
    assert average_precision(np.array([0.9, 0.8, 0.2, 0.1]), labels) == 1.0
    assert average_precision(np.array([0.1, 0.2, 0.8, 0.9]), labels) == pytest.approx(
        5 / 12
    )


def test_average_precision_groups_tied_scores() -> None:
    labels = np.array([1, 0])
    assert average_precision(np.array([0.5, 0.5]), labels) == 0.5


def test_average_precision_returns_none_without_positives() -> None:
    assert average_precision(np.array([0.2, 0.8]), np.array([0, 0])) is None


def test_threshold_metrics_counts_confusion() -> None:
    result = threshold_metrics(
        np.array([0.9, 0.8, 0.2, 0.1]),
        np.array([1, 0, 1, 0]),
        0.5,
    )
    assert result == {
        "threshold": 0.5,
        "tp": 1,
        "fp": 1,
        "fn": 1,
        "tn": 1,
        "precision": 0.5,
        "recall": 0.5,
        "f1": 0.5,
        "falsePositiveRate": 0.5,
    }


@pytest.mark.parametrize("labels", [[], [0, 0], [1, 1]])
def test_average_precision_requires_both_classes(labels):
    assert average_precision([0.5] * len(labels), labels) is None


@pytest.mark.parametrize(
    "scores,labels",
    [
        ([float("nan"), 0.5], [0, 1]),
        ([float("inf"), 0.5], [0, 1]),
        ([0.2, 0.5], [float("nan"), 1]),
        ([0.2, 0.5], [0, 2]),
        ([0.2, 0.5], [0, -1]),
        ([0.2, 0.5], ["0", "1"]),
    ],
)
def test_metrics_reject_invalid_inputs(scores, labels):
    with pytest.raises(ValueError):
        average_precision(scores, labels)
    with pytest.raises(ValueError):
        threshold_metrics(scores, labels, 0.5)
