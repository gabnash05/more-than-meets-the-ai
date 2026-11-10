"""Shared inference over one canonical PNG observation.

Both the private HTTP route and the Redis Streams worker call this module so
grid validation, bundle identity checks and deadline handling cannot drift
between transports.
"""

import json
import logging
from io import BytesIO
from time import time

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from .bundles import Bundle

MAX_IMAGE = 4 * 1024 * 1024
LOG = logging.getLogger(__name__)
EVENT_LOG = logging.getLogger("uvicorn.error")


class Observation(BaseModel):
    """Bounded public job metadata accepted from either transport."""

    model_config = ConfigDict(extra="forbid", strict=True)

    jobId: str = Field(min_length=1, max_length=128)
    turnId: str = Field(min_length=1, max_length=128)
    canvasId: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0)
    sequence: int = Field(ge=1)
    deadlineAt: int = Field(gt=0)
    modelId: str = Field(min_length=1, max_length=64)
    artifactRevision: str = Field(min_length=1, max_length=128)
    hint: str | None = Field(default=None, max_length=128)


class InvalidImage(ValueError):
    """Raised when the payload is not one canonical 1024x768 PNG."""


def decode_png(data: bytes) -> Image.Image:
    """Decode one canonical canvas PNG into an RGB image.

    RGBA canvases are composed over white first because the model was trained
    on the opaque review renderer output, not on transparent pixels.
    """
    try:
        with Image.open(BytesIO(data), formats=["PNG"]) as image:
            if image.size != (1024, 768) or getattr(image, "n_frames", 1) != 1:
                raise InvalidImage("bad-image-shape")
            rgba = image.convert("RGBA")
            white = Image.new("RGBA", rgba.size, "white")
            return Image.alpha_composite(white, rgba).convert("RGB")
    except (OSError, Image.DecompressionBombError) as exc:
        raise InvalidImage("expected-canonical-png") from exc


def infer_observation(job: Observation, bundle: Bundle, data: bytes, role: str) -> dict:
    """Run one model observation and return a result bound to ``job``.

    Steps:
    1. Copy the identity fields into the result envelope.
    2. Reject a bundle whose model or revision does not match the job.
    3. Reject an observation whose deadline already passed at admission.
    4. Decode the canonical PNG, raising InvalidImage for bad payloads so the
       HTTP route can return 422 while the worker records unavailable.
    5. Run the adapter, converting model faults into unavailable results.
    6. Re-check the deadline after the model call; a late answer must not count.
    7. Validate Guesser confidence and emit only safe correlation fields.
    """
    binding = job.model_dump(exclude={"hint"})

    def unavailable(reason: str) -> dict:
        return {**binding, "status": "unavailable", "reason": reason}

    if not bundle.adapter or bundle.model_id != job.modelId or bundle.revision != job.artifactRevision:
        return unavailable("model-unavailable")
    if job.deadlineAt <= time() * 1000:
        return unavailable("deadline-expired")

    image = decode_png(data)
    try:
        result = bundle.adapter.predict(image)
    except (RuntimeError, ValueError):
        LOG.warning("inference failed role=%s revision=%s", role, bundle.revision)
        return unavailable("inference-failed")
    if job.deadlineAt <= time() * 1000:
        return unavailable("deadline-expired")
    if role == "guesser" and result.get("status") == "answer":
        confidence = result.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            return unavailable("invalid-confidence")
        EVENT_LOG.info(json.dumps({
            "event": "guesser_prediction",
            "jobId": job.jobId,
            "canvasId": job.canvasId,
            "generation": job.generation,
            "sequence": job.sequence,
            "modelId": bundle.model_id,
            "artifactRevision": bundle.revision,
        }, separators=(",", ":")))
    return {**binding, **result}
