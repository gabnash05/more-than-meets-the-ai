"""Mirror the TypeScript Guesser job/result contract fixtures."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_service.queue_contract import (
    parse_job_json,
    parse_result_json,
    validate_result_binding,
)

FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "game-contracts"
    / "fixtures"
    / "ai-inference-v1"
)


def read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_shared_fixtures_validate() -> None:
    job = parse_job_json(read("job.valid.json"))
    assert job.jobId == "job-0001"
    assert job.payloadKey == f"mmtai:ai:payload:{job.jobId}"

    for name in (
        "result.answer.valid.json",
        "result.pass.valid.json",
        "result.unavailable.valid.json",
    ):
        result = parse_result_json(read(name))
        assert result.jobId == job.jobId
        assert result.canvasId == job.canvasId
        assert result.sequence == job.sequence


def test_invalid_jobs_are_rejected() -> None:
    raw = read("job.valid.json").decode()
    mutations = (
        raw.replace('"version": 1', '"version": 2'),
        raw.replace('"role": "guesser"', '"role": "referee"'),
        raw.replace("mmtai:ai:payload:job-0001", "mmtai:ai:payload:job-9999"),
        raw.replace('"generation": 2', '"generation": -1'),
        raw.replace('"sequence": 6', '"sequence": 0'),
        raw.replace('"hint": "_ _ _ _"', '"hint": "_ _ _ _", "extra": true'),
    )
    for value in mutations:
        with pytest.raises(ValidationError):
            parse_job_json(value)


def test_invalid_results_are_rejected() -> None:
    answer = read("result.answer.valid.json").decode()
    unavailable = read("result.unavailable.valid.json").decode()
    mutations = (
        answer.replace('"confidence": 0.82', '"confidence": 1.5'),
        answer.replace('"answer": "zigzag"', f'"answer": "{"x" * 101}"'),
        answer.replace('"status": "answer"', '"status": "evidence"'),
        answer.replace('"confidence": 0.82', '"confidence": 0.82, "extra": true'),
        unavailable.replace('"reason": "deadline-expired"', '"reason": ""'),
    )
    for value in mutations:
        with pytest.raises(ValidationError):
            parse_result_json(value)


def test_referee_fixtures_validate() -> None:
    job = parse_job_json(read("referee.job.valid.json"))
    assert job.role == "referee"
    assert job.jobId == "job-0002"
    assert not hasattr(job, "hint")

    result = parse_result_json(read("referee.result.evidence.valid.json"))
    assert result.status == "evidence"
    assert result.scores == [0.82, 0.21]
    validate_result_binding(result, job)


def test_invalid_referee_results_are_rejected() -> None:
    evidence = read("referee.result.evidence.valid.json").decode()
    mutations = (
        evidence.replace('"scores": [0.82, 0.21]', '"scores": [0.82]'),
        evidence.replace('"scores": [0.82, 0.21]', '"scores": [1.2, 0.21]'),
        evidence.replace('"status": "evidence"', '"status": "answer"'),
    )
    for value in mutations:
        with pytest.raises(ValidationError):
            parse_result_json(value)


def test_result_binding_must_match_the_job() -> None:
    job = parse_job_json(read("job.valid.json"))
    result = parse_result_json(read("result.answer.valid.json"))
    validate_result_binding(result, job)

    drifted = read("result.answer.valid.json").decode().replace(
        '"jobId": "job-0001"', '"jobId": "job-9999"'
    )
    with pytest.raises(ValueError, match="invalid-result-binding"):
        validate_result_binding(parse_result_json(drifted), job)


def test_answer_results_may_carry_a_bounded_heatmap() -> None:
    payload = json.loads(read("result.answer-heatmap.valid.json"))
    result = parse_result_json(json.dumps(payload))
    assert result.status == "answer"
    assert result.heatmap is not None
    assert len(result.heatmap.grid) == 196
    assert result.heatmap.frame.model_dump() == {"x": 96.5, "y": 32.0, "width": 832.0, "height": 704.0}
    assert result.alternatives is not None
    assert [(item.answer, item.confidence) for item in result.alternatives] == [("hourglass", 0.11), ("triangle", 0.04)]
    validate_result_binding(result, parse_job_json(read("job.valid.json")))


def test_heatmaps_outside_the_contract_are_rejected() -> None:
    payload = json.loads(read("result.answer-heatmap.valid.json"))

    def truncated(heatmap: dict) -> None:
        heatmap["grid"] = heatmap["grid"][:195]

    def out_of_range(heatmap: dict) -> None:
        heatmap["grid"][7] = 256

    def fractional(heatmap: dict) -> None:
        heatmap["grid"][7] = 1.5

    def missing_content(heatmap: dict) -> None:
        del heatmap["content"]

    for mutate in (truncated, out_of_range, fractional, missing_content):
        broken = json.loads(json.dumps(payload))
        mutate(broken["heatmap"])
        with pytest.raises(ValidationError):
            parse_result_json(json.dumps(broken))


def test_runner_up_guesses_are_bounded_to_two() -> None:
    payload = json.loads(read("result.answer-heatmap.valid.json"))

    def three(alternatives: list) -> None:
        alternatives.append({"answer": "cloud", "confidence": 0.01})

    def out_of_range(alternatives: list) -> None:
        alternatives[0]["confidence"] = 1.2

    def extra_field(alternatives: list) -> None:
        alternatives[0]["reason"] = "shape"

    for mutate in (three, out_of_range, extra_field):
        broken = json.loads(json.dumps(payload))
        mutate(broken["alternatives"])
        with pytest.raises(ValidationError):
            parse_result_json(json.dumps(broken))
