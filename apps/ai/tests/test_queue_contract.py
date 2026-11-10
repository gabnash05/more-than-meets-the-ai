"""Mirror the TypeScript Guesser job/result contract fixtures."""

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


def test_result_binding_must_match_the_job() -> None:
    job = parse_job_json(read("job.valid.json"))
    result = parse_result_json(read("result.answer.valid.json"))
    validate_result_binding(result, job)

    drifted = read("result.answer.valid.json").decode().replace(
        '"jobId": "job-0001"', '"jobId": "job-9999"'
    )
    with pytest.raises(ValueError, match="invalid-result-binding"):
        validate_result_binding(parse_result_json(drifted), job)
