"""Shared inference behavior used by both HTTP and queue transports."""

from io import BytesIO
from time import time

import pytest
from PIL import Image

from ai_service.bundles import Bundle
from ai_service.inference import (
    InvalidImage,
    Observation,
    _sanitise_heatmap,
    infer_observation,
)


def canonical_png() -> bytes:
    data = BytesIO()
    Image.new("RGB", (1024, 768), "white").save(data, format="PNG")
    return data.getvalue()


def job(**overrides) -> Observation:
    values = {
        "jobId": "job-1",
        "turnId": "turn-1",
        "canvasId": "canvas-1",
        "generation": 1,
        "sequence": 4,
        "deadlineAt": int(time() * 1000) + 10000,
        "modelId": "guesser-vit-a-v1",
        "artifactRevision": "rev-1",
        "hint": "_ _ _",
    }
    values.update(overrides)
    return Observation(**values)


class Adapter:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = 0
        self.images = []

    def predict(self, image):
        self.calls += 1
        self.images.append(image)
        if self.error:
            raise self.error
        return self.result


def bundle(adapter, **overrides) -> Bundle:
    values = {"model_id": "guesser-vit-a-v1", "revision": "rev-1", "adapter": adapter}
    values.update(overrides)
    return Bundle(**values)


def test_answer_result_preserves_identity_and_confidence() -> None:
    adapter = Adapter({"status": "answer", "answer": "zigzag", "confidence": 0.82})
    value = job()
    result = infer_observation(value, bundle(adapter), canonical_png(), "guesser")
    assert result == {
        "jobId": "job-1",
        "turnId": "turn-1",
        "canvasId": "canvas-1",
        "generation": 1,
        "sequence": 4,
        "deadlineAt": value.deadlineAt,
        "modelId": "guesser-vit-a-v1",
        "artifactRevision": "rev-1",
        "status": "answer",
        "answer": "zigzag",
        "confidence": 0.82,
    }
    assert adapter.calls == 1
    assert adapter.images[0].size == (1024, 768)


def test_expired_or_foreign_bundles_skip_the_model() -> None:
    adapter = Adapter({"status": "answer", "answer": "zigzag", "confidence": 0.8})
    expired = infer_observation(job(deadlineAt=int(time() * 1000) - 1), bundle(adapter), canonical_png(), "guesser")
    assert expired["status"] == "unavailable"
    assert expired["reason"] == "deadline-expired"
    foreign = infer_observation(job(), bundle(adapter, revision="rev-2"), canonical_png(), "guesser")
    assert foreign["reason"] == "model-unavailable"
    assert adapter.calls == 0


def test_invalid_png_and_model_faults_are_distinct() -> None:
    adapter = Adapter({"status": "pass"})
    with pytest.raises(InvalidImage):
        infer_observation(job(), bundle(adapter), b"not-a-png", "guesser")
    failed = infer_observation(job(), bundle(Adapter(error=RuntimeError("boom"))), canonical_png(), "guesser")
    assert failed["status"] == "unavailable"
    assert failed["reason"] == "inference-failed"


def test_invalid_confidence_and_bad_pass_shape_are_rejected() -> None:
    adapter = Adapter({"status": "answer", "answer": "zigzag", "confidence": 1.5})
    result = infer_observation(job(), bundle(adapter), canonical_png(), "guesser")
    assert result["status"] == "unavailable"
    assert result["reason"] == "invalid-confidence"


def test_heatmaps_are_emitted_only_when_well_formed() -> None:
    geometry = {"x": 0, "y": 0, "width": 1024, "height": 768}
    grid = [index % 256 for index in range(196)]
    assert _sanitise_heatmap({"grid": grid, "frame": geometry, "content": geometry}) == {
        "grid": grid,
        "frame": {"x": 0.0, "y": 0.0, "width": 1024.0, "height": 768.0},
        "content": {"x": 0.0, "y": 0.0, "width": 1024.0, "height": 768.0},
    }
    for broken in (
        None,
        {"grid": grid[:195], "frame": geometry, "content": geometry},
        {"grid": [256] + grid[1:], "frame": geometry, "content": geometry},
        {"grid": [1.5] + grid[1:], "frame": geometry, "content": geometry},
        {"grid": grid, "frame": geometry},
        {"grid": grid, "frame": {**geometry, "extra": 1}, "content": geometry},
        {"grid": grid, "frame": {**geometry, "width": -1}, "content": geometry},
    ):
        assert _sanitise_heatmap(broken) is None


def test_a_bad_heatmap_never_costs_the_answer() -> None:
    adapter = Adapter({"status": "answer", "answer": "zigzag", "confidence": 0.82, "heatmap": {"grid": [1, 2, 3]}})
    result = infer_observation(job(), bundle(adapter), canonical_png(), "guesser")
    assert result["status"] == "answer"
    assert result["answer"] == "zigzag"
    assert "heatmap" not in result


def test_runner_ups_are_forwarded_only_when_complete() -> None:
    good = [{"answer": "hourglass", "confidence": 0.11}, {"answer": "triangle", "confidence": 0.04}]
    adapter = Adapter({"status": "answer", "answer": "zigzag", "confidence": 0.82, "alternatives": good})
    assert infer_observation(job(), bundle(adapter), canonical_png(), "guesser")["alternatives"] == [
        {"answer": "hourglass", "confidence": 0.11},
        {"answer": "triangle", "confidence": 0.04},
    ]
    for broken in (
        [{"answer": "hourglass", "confidence": 1.2}],
        [{"answer": "hourglass"}],
        good + [{"answer": "cloud", "confidence": 0.01}],
        "hourglass",
    ):
        result = infer_observation(
            job(),
            bundle(Adapter({"status": "answer", "answer": "zigzag", "confidence": 0.82, "alternatives": broken})),
            canonical_png(),
            "guesser",
        )
        assert result["answer"] == "zigzag"
        assert "alternatives" not in result
