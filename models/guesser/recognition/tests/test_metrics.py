"""Unit tests for the pure ten-stage recognition metrics."""

from __future__ import annotations

import numpy as np
import pytest
from recognition import metrics


def stage_inputs() -> dict:
    class_ids = np.array([0, 0, 1, 1], dtype=np.int64)
    correct1 = np.zeros((4, metrics.STAGES), dtype=bool)
    correct1[0, :] = True
    correct1[1, -1] = True
    correct1[2, :5] = True
    correct1[3, 2] = True
    correct3 = correct1.copy()
    correct3[1, 8] = True
    status_ok = np.ones((4, metrics.STAGES), dtype=bool)
    status_ok[3, 4] = False
    blank = np.zeros_like(status_ok)
    blank[3, 4] = True
    uncertain = np.zeros_like(status_ok)
    unchanged = np.zeros_like(status_ok)
    unchanged[0, 0] = True
    return {
        "correct1": correct1,
        "correct3": correct3,
        "status_ok": status_ok,
        "blank": blank,
        "uncertain": uncertain,
        "unchanged": unchanged,
        "class_ids": class_ids,
    }


def test_stage_metrics_keep_all_views_in_the_denominator() -> None:
    inputs = stage_inputs()
    result = metrics.stage_metrics(
        inputs["correct1"],
        inputs["correct3"],
        inputs["status_ok"],
        inputs["blank"],
        inputs["uncertain"],
        inputs["unchanged"],
        inputs["class_ids"],
        n_classes=2,
    )

    assert len(result["stages"]) == metrics.STAGES
    first = result["stages"][0]
    assert first["top1Correct"] == 2
    assert first["top1Accuracy"] == 0.5
    assert first["top1AccuracyOk"] == 0.5
    assert first["macroTop1Accuracy"] == 0.5
    assert first["unchangedViews"] == 1

    fifth = result["stages"][4]
    assert fifth["top1Correct"] == 2
    assert fifth["blankViews"] == 1
    assert fifth["top1AccuracyOk"] == pytest.approx(2 / 3)

    assert result["completeTop1"] == 0.5
    assert result["completeTop3"] == 0.5
    assert result["blankRate"] == pytest.approx(1 / 40)
    assert result["uncertainRate"] == 0.0
    assert result["unchangedRate"] == pytest.approx(1 / 40)
    assert result["meanEarlyTop1"] == pytest.approx(
        np.mean([row["top1Accuracy"] for row in result["stages"][:9]])
    )


def test_stage_metrics_reject_mismatched_shapes() -> None:
    inputs = stage_inputs()
    with pytest.raises(ValueError, match="shape"):
        metrics.stage_metrics(
            inputs["correct1"][:, :9],
            inputs["correct3"],
            inputs["status_ok"],
            inputs["blank"],
            inputs["uncertain"],
            inputs["unchanged"],
            inputs["class_ids"],
            n_classes=2,
        )


def test_policy_metrics_report_coverage_and_emitted_accuracy() -> None:
    correct = np.ones((2, metrics.STAGES), dtype=bool)
    status_ok = np.ones((2, metrics.STAGES), dtype=bool)
    status_ok[0, 0] = False
    probabilities = np.full((2, metrics.STAGES), 0.9, dtype=np.float32)
    probabilities[1, 1] = 0.2

    rows = metrics.policy_metrics(
        probabilities, correct, status_ok, thresholds=(0.0, 0.5, 0.95)
    )

    assert [row["threshold"] for row in rows] == [0.0, 0.5, 0.95]
    assert rows[0]["coverage"] == pytest.approx(19 / 20)
    assert rows[0]["emitted"] == 19
    assert rows[0]["accuracyEmitted"] == 1.0
    assert rows[1]["emitted"] == 18
    assert rows[1]["overallCorrectness"] == pytest.approx(18 / 20)
    assert rows[2]["emitted"] == 0
    assert rows[2]["accuracyEmitted"] is None
    assert len(rows[0]["stages"]) == metrics.STAGES


def test_temperature_fit_returns_a_positive_finite_scale() -> None:
    rng = np.random.default_rng(7)
    targets = rng.integers(0, 3, size=120)
    logits = rng.normal(size=(120, 3)).astype(np.float32)
    logits[np.arange(120), targets] += 3.0

    temperature = metrics.fit_temperature(logits, targets)
    assert np.isfinite(temperature)
    assert 0.05 <= temperature <= 10.0

    probabilities = metrics.softmax_top1_probs(logits, temperature)
    assert probabilities.shape == (120,)
    assert np.all((probabilities > 0) & (probabilities <= 1))


def test_bootstrap_is_stratified_and_can_be_disabled() -> None:
    values = np.zeros((10, metrics.STAGES), dtype=bool)
    values[:5, 0] = True
    values[5:, -1] = True
    class_ids = np.array([0] * 5 + [1] * 5, dtype=np.int64)

    result = metrics.bootstrap_ci(
        values,
        class_ids,
        2,
        metrics.early_mean_macro_metric,
        n_bootstrap=50,
        seed=3,
    )
    assert result["samples"] == 50
    assert result["low"] <= result["observed"] <= result["high"]

    with pytest.raises(ValueError, match="positive"):
        metrics.bootstrap_ci(
            values,
            class_ids,
            2,
            metrics.early_mean_macro_metric,
            n_bootstrap=0,
        )


def test_paired_bootstrap_uses_the_same_resampled_drawings() -> None:
    values_a = np.ones((6, metrics.STAGES), dtype=bool)
    values_b = np.zeros((6, metrics.STAGES), dtype=bool)
    class_ids = np.array([0, 0, 0, 1, 1, 1], dtype=np.int64)

    result = metrics.paired_bootstrap(
        values_a,
        values_b,
        class_ids,
        2,
        metrics.early_mean_macro_metric,
        n_bootstrap=20,
        seed=5,
    )

    assert result["delta"]["observed"] == 1.0
    assert result["delta"]["low"] == 1.0
    assert result["delta"]["high"] == 1.0
    assert result["delta"]["samples"] == 20


def test_trajectory_metrics_count_first_and_persistent_correctness() -> None:
    inputs = stage_inputs()
    result = metrics.trajectory_metrics(inputs["correct1"])

    assert result["firstCorrect"] == {
        "1": 2,
        "2": 0,
        "3": 1,
        "4": 0,
        "5": 0,
        "6": 0,
        "7": 0,
        "8": 0,
        "9": 0,
        "10": 1,
        "never": 0,
    }
    assert result["nextStageAfterFirst"]["eligible"] == 3
    assert result["nextStageAfterFirst"]["accuracy"] == pytest.approx(2 / 3)
    assert result["staysCorrectAfterFirst"]["accuracy"] == pytest.approx(1 / 3)
    assert result["censoredNever"] == 0
    assert result["censoredAtComplete"] == 1


def test_confusion_matrix_and_top_confusions_ignore_unusable_views() -> None:
    true = np.zeros((2, metrics.STAGES), dtype=np.int64)
    predicted = np.zeros((2, metrics.STAGES), dtype=np.int64)
    predicted[0, 0] = 1
    predicted[0, 1] = 1
    predicted[1, 0] = 2
    status_ok = np.ones((2, metrics.STAGES), dtype=bool)
    status_ok[1, 0] = False

    matrix = metrics.confusion_matrix(predicted, true, status_ok, n_classes=3)
    assert matrix[0, 0] == 17
    assert matrix[0, 1] == 2
    assert matrix[0, 2] == 0

    rows = metrics.top_confusions(matrix, ["cat", "dog", "bird"], limit=2)
    assert rows[0] == {
        "trueId": 0,
        "trueLabel": "cat",
        "predictedId": 1,
        "predictedLabel": "dog",
        "count": 2,
    }


def test_per_class_metrics_include_zero_support_classes() -> None:
    inputs = stage_inputs()
    rows = metrics.per_class_metrics(
        inputs["correct1"], inputs["class_ids"], ["cat", "dog", "bird"]
    )

    assert rows[0]["support"] == 2
    assert rows[0]["stageAccuracy"][0] == 0.5
    assert rows[0]["completeTop1"] == 1.0
    assert rows[2]["support"] == 0
    assert rows[2]["stageAccuracy"] == [None] * metrics.STAGES
    assert rows[2]["meanEarlyTop1"] is None
    assert rows[2]["completeTop1"] is None
