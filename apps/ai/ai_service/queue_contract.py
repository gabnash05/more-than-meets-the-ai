"""Versioned wire contract for inference jobs consumed from Redis Streams.

The game API owns the JSON envelope. Jobs contain public canvas identity plus a
short-lived payload key; results echo that identity so the API can reject any
result that does not belong to the turn or canvas it published. Keep this file
in lockstep with packages/game-contracts/src/ai-inference.ts.

Both roles share the queue. A Guesser job can carry a public hint and returns an
answer or pass; a Referee job returns two evidence scores.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

PAYLOAD_PREFIX = "mmtai:ai:payload:"
MAX_ID = 128


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Binding(_Strict):
    version: Literal[1]
    role: Literal["guesser", "referee"]
    jobId: str = Field(min_length=1, max_length=MAX_ID)
    turnId: str = Field(min_length=1, max_length=MAX_ID)
    canvasId: str = Field(min_length=1, max_length=MAX_ID)
    generation: int = Field(ge=0)
    sequence: int = Field(ge=1)
    deadlineAt: int = Field(gt=0)
    modelId: str = Field(min_length=1, max_length=64)
    artifactRevision: str = Field(min_length=1, max_length=MAX_ID)


class GuessJobV1(_Binding):
    """One Guesser observation published by the game API."""

    payloadKey: str = Field(min_length=1, max_length=200)
    hint: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def _guesser_role(self) -> "GuessJobV1":
        if self.role != "guesser":
            raise ValueError("invalid-role")
        return self

    @model_validator(mode="after")
    def _payload_key_matches_job(self) -> "GuessJobV1":
        if self.payloadKey != f"{PAYLOAD_PREFIX}{self.jobId}":
            raise ValueError("invalid-payload-key")
        return self


class RefereeJobV1(_Binding):
    """One Referee observation; it never carries a hint."""

    payloadKey: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _referee_role(self) -> "RefereeJobV1":
        if self.role != "referee":
            raise ValueError("invalid-role")
        return self

    @model_validator(mode="after")
    def _payload_key_matches_job(self) -> "RefereeJobV1":
        if self.payloadKey != f"{PAYLOAD_PREFIX}{self.jobId}":
            raise ValueError("invalid-payload-key")
        return self


InferenceJobV1 = GuessJobV1 | RefereeJobV1


class GuessAnswerResultV1(_Binding):
    status: Literal["answer"]
    answer: str = Field(min_length=1, max_length=100)
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _guesser_role(self) -> "GuessAnswerResultV1":
        if self.role != "guesser":
            raise ValueError("invalid-role")
        return self


class GuessPassResultV1(_Binding):
    status: Literal["pass"]
    reason: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def _guesser_role(self) -> "GuessPassResultV1":
        if self.role != "guesser":
            raise ValueError("invalid-role")
        return self


class RefereeEvidenceResultV1(_Binding):
    status: Literal["evidence"]
    scores: list[float] = Field(min_length=2, max_length=2)

    @model_validator(mode="after")
    def _referee_role(self) -> "RefereeEvidenceResultV1":
        if self.role != "referee":
            raise ValueError("invalid-role")
        return self

    @model_validator(mode="after")
    def _scores_are_probabilities(self) -> "RefereeEvidenceResultV1":
        if any(score < 0 or score > 1 for score in self.scores):
            raise ValueError("invalid-scores")
        return self


class UnavailableResultV1(_Binding):
    status: Literal["unavailable"]
    reason: str = Field(min_length=1, max_length=128)


GuessResultV1 = Annotated[
    GuessAnswerResultV1 | GuessPassResultV1 | UnavailableResultV1,
    Field(discriminator="status"),
]
RefereeResultV1 = Annotated[
    RefereeEvidenceResultV1 | UnavailableResultV1,
    Field(discriminator="status"),
]
InferenceResultV1 = Annotated[
    GuessAnswerResultV1 | GuessPassResultV1 | RefereeEvidenceResultV1 | UnavailableResultV1,
    Field(discriminator="status"),
]

JOB_ADAPTER: TypeAdapter[InferenceJobV1] = TypeAdapter(InferenceJobV1)
RESULT_ADAPTER: TypeAdapter[InferenceResultV1] = TypeAdapter(InferenceResultV1)


def parse_job_json(raw: str | bytes) -> InferenceJobV1:
    """Validate one job envelope; raise pydantic.ValidationError on bad input."""
    return JOB_ADAPTER.validate_json(raw)


def parse_result_json(raw: str | bytes) -> InferenceResultV1:
    """Validate one result envelope; raise pydantic.ValidationError on bad input."""
    return RESULT_ADAPTER.validate_json(raw)


def result_binding(job: InferenceJobV1) -> dict[str, object]:
    """Return the identity fields a worker must echo in its result.

    The payload key and hint are intentionally excluded: they are transport
    details for the request and must not travel back to the game API.
    """
    return job.model_dump(exclude={"payloadKey", "hint"})


def validate_result_binding(result: InferenceResultV1, job: InferenceJobV1) -> None:
    """Reject a result whose identity fields do not match the dispatched job."""
    actual = result.model_dump(exclude={"status", "answer", "confidence", "reason", "scores"})
    if actual != result_binding(job):
        raise ValueError("invalid-result-binding")
