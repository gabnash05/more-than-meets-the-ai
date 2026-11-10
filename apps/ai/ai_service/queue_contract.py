"""Versioned wire contract for Guesser jobs consumed from Redis Streams.

The game API owns the JSON envelope. Jobs contain public canvas identity plus a
short-lived payload key; results echo that identity so the API can reject any
result that does not belong to the turn or canvas it published. Keep this file
in lockstep with packages/game-contracts/src/ai-inference.ts.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

PAYLOAD_PREFIX = "mmtai:ai:payload:"
MAX_ID = 128


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _ResultBinding(_Strict):
    version: Literal[1]
    role: Literal["guesser"]
    jobId: str = Field(min_length=1, max_length=MAX_ID)
    turnId: str = Field(min_length=1, max_length=MAX_ID)
    canvasId: str = Field(min_length=1, max_length=MAX_ID)
    generation: int = Field(ge=0)
    sequence: int = Field(ge=1)
    deadlineAt: int = Field(gt=0)
    modelId: str = Field(min_length=1, max_length=64)
    artifactRevision: str = Field(min_length=1, max_length=MAX_ID)


class GuessJobV1(_ResultBinding):
    """One Guesser observation published by the game API."""

    payloadKey: str = Field(min_length=1, max_length=200)
    hint: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def _payload_key_matches_job(self) -> "GuessJobV1":
        if self.payloadKey != f"{PAYLOAD_PREFIX}{self.jobId}":
            raise ValueError("invalid-payload-key")
        return self


class GuessAnswerResultV1(_ResultBinding):
    status: Literal["answer"]
    answer: str = Field(min_length=1, max_length=100)
    confidence: float = Field(ge=0, le=1)


class GuessPassResultV1(_ResultBinding):
    status: Literal["pass"]
    reason: str | None = Field(default=None, min_length=1, max_length=128)


class GuessUnavailableResultV1(_ResultBinding):
    status: Literal["unavailable"]
    reason: str = Field(min_length=1, max_length=128)


GuessResultV1 = Annotated[
    Union[GuessAnswerResultV1, GuessPassResultV1, GuessUnavailableResultV1],
    Field(discriminator="status"),
]

RESULT_ADAPTER: TypeAdapter[GuessResultV1] = TypeAdapter(GuessResultV1)


def parse_job_json(raw: str | bytes) -> GuessJobV1:
    """Validate one job envelope; raise pydantic.ValidationError on bad input."""
    return GuessJobV1.model_validate_json(raw)


def parse_result_json(raw: str | bytes) -> GuessResultV1:
    """Validate one result envelope; raise pydantic.ValidationError on bad input."""
    return RESULT_ADAPTER.validate_json(raw)


def result_binding(job: GuessJobV1) -> dict[str, object]:
    """Return the identity fields a worker must echo in its result.

    The payload key and hint are intentionally excluded: they are transport
    details for the request and must not travel back to the game API.
    """
    return job.model_dump(exclude={"payloadKey", "hint"})


def validate_result_binding(result: GuessResultV1, job: GuessJobV1) -> None:
    """Reject a result whose identity fields do not match the dispatched job."""
    actual = result.model_dump(exclude={"status", "answer", "confidence", "reason"})
    if actual != result_binding(job):
        raise ValueError("invalid-result-binding")
