"""Private role-specific inference over bounded canonical PNG observations."""

import os
from asyncio import Lock
from contextlib import asynccontextmanager
from hmac import compare_digest
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .bundles import load_bundle
from .inference import MAX_IMAGE, InvalidImage, Observation, infer_observation
from .queue_worker import configured_worker

MAX_FORM = MAX_IMAGE + 8192


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
    app.state.worker = configured_worker(app.state.bundles)
    if app.state.worker:
        app.state.worker.start()
    yield
    if app.state.worker:
        app.state.worker.stop_and_join()


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
    try:
        return await run_in_threadpool(infer_observation, job, bundle, data, role)
    except InvalidImage as exc:
        raise HTTPException(status_code=422, detail="expected-canonical-png") from exc


@app.post("/v1/guess")
async def guess(request: Request) -> dict:
    return await infer(request, "guesser")


@app.post("/v1/referee")
async def referee(request: Request) -> dict:
    return await infer(request, "referee")
