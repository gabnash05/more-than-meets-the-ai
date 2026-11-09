"""Private role-specific inference over bounded canonical PNG observations."""

import json
import logging
import os
from asyncio import Lock
from contextlib import asynccontextmanager
from hmac import compare_digest
from io import BytesIO
from pathlib import Path
from time import time

from fastapi import FastAPI, HTTPException, Request
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .bundles import load_bundle

MAX_IMAGE = 4 * 1024 * 1024
MAX_FORM = MAX_IMAGE + 8192
LOG = logging.getLogger(__name__)
EVENT_LOG = logging.getLogger("uvicorn.error")


class Observation(BaseModel):
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    artifact_root = Path(os.getenv("AI_ARTIFACT_ROOT", "/artifacts"))
    try:
        app.state.secret = Path(os.getenv("AI_SECRET_FILE", "/run/mmtai-secrets/ai-token")).read_bytes().strip()
    except OSError:
        app.state.secret = b""
    app.state.bundles = {
        role: load_bundle(role, os.getenv(f"{role.upper()}_MODEL_ID", ""), artifact_root)
        for role in ("guesser", "referee")
    }
    app.state.locks = {role: Lock() for role in app.state.bundles}
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def authorize(request: Request) -> None:
    secret = request.app.state.secret
    authorization = request.headers.get("authorization", "").encode()
    if not secret or not compare_digest(authorization, b"Bearer " + secret):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health/live")
async def live() -> dict:
    return {"live": True}


@app.get("/health/ready")
async def ready(request: Request) -> dict:
    authorize(request)
    return {role: bundle.readiness() for role, bundle in request.app.state.bundles.items()}


def decode_png(data: bytes) -> Image.Image:
    try:
        with Image.open(BytesIO(data), formats=["PNG"]) as image:
            if image.size != (1024, 768) or image.n_frames != 1:
                raise ValueError("bad-image-shape")
            rgba = image.convert("RGBA")
            white = Image.new("RGBA", rgba.size, "white")
            return Image.alpha_composite(white, rgba).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=422, detail="expected-canonical-png") from exc


async def infer(request: Request, role: str) -> dict:
    authorize(request)
    lock = request.app.state.locks[role]
    if lock.locked():
        raise HTTPException(status_code=429, detail="worker-busy")
    await lock.acquire()
    try:
        return await infer_admitted(request, role)
    finally:
        lock.release()


async def infer_admitted(request: Request, role: str) -> dict:
    size = request.headers.get("content-length", "")
    if not size.isascii() or not size.isdecimal() or request.headers.get("transfer-encoding"):
        raise HTTPException(status_code=411, detail="content-length-required")
    if int(size) > MAX_FORM:
        raise HTTPException(status_code=413, detail="request-too-large")
    if not request.headers.get("content-type", "").startswith("multipart/form-data"):
        raise HTTPException(status_code=415, detail="expected-multipart")
    async with request.form(max_files=1, max_fields=1, max_part_size=4096) as form:
        metadata = form.get("metadata")
        upload = form.get("image")
        if not isinstance(metadata, str) or not isinstance(upload, UploadFile) or upload.content_type != "image/png":
            raise HTTPException(status_code=422, detail="expected-metadata-and-png")
        try:
            job = Observation.model_validate_json(metadata)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="invalid-observation") from exc
        if role == "referee" and job.hint is not None:
            raise HTTPException(status_code=422, detail="referee-hint-disallowed")
        data = await upload.read(MAX_IMAGE + 1)
    if not data or len(data) > MAX_IMAGE:
        raise HTTPException(status_code=413, detail="invalid-image-size")

    bundle = request.app.state.bundles[role]
    binding = job.model_dump(exclude={"hint"})

    def unavailable(reason: str) -> dict:
        return {**binding, "status": "unavailable", "reason": reason}

    if not bundle.adapter or bundle.model_id != job.modelId or bundle.revision != job.artifactRevision:
        return unavailable("model-unavailable")
    if job.deadlineAt <= time() * 1000:
        return unavailable("deadline-expired")

    image = await run_in_threadpool(decode_png, data)
    try:
        result = await run_in_threadpool(bundle.adapter.predict, image)
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


@app.post("/v1/guess")
async def guess(request: Request) -> dict:
    return await infer(request, "guesser")


@app.post("/v1/referee")
async def referee(request: Request) -> dict:
    return await infer(request, "referee")
