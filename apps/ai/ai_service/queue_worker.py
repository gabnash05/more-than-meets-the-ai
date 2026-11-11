"""Redis Streams consumer that runs one inference at a time.

Each AI container owns one consumer in the shared ``guesser-workers-v1`` group.
The worker dispatches each job to the bundle named by its role, so adding AI
replicas adds both Guesser and Referee capacity without changing the room
process. A message is acknowledged only after its result is written, so a crash
leaves the job reclaimable instead of silently losing it.
"""

import json
import logging
import os
import socket
from collections.abc import Mapping
from pathlib import Path
from threading import Event, Thread
from time import time
from typing import Any, Protocol, cast

import redis
from pydantic import ValidationError

from .bundles import Bundle
from .inference import InvalidImage, Observation, infer_observation
from .queue_contract import InferenceJobV1, parse_job_json, result_binding

JOBS_STREAM = "mmtai:ai:guess:jobs:v1"
RESULTS_STREAM = "mmtai:ai:guess:results:v1"
WORKER_GROUP = "guesser-workers-v1"
WORKER_PREFIX = "mmtai:ai:workers:"
CANCEL_PREFIX = "mmtai:ai:cancel:"
WORKER_TTL_MS = 15000
HEARTBEAT_SECONDS = 5
RECLAIM_IDLE_MS = 30000
BLOCK_MS = 1000
LOG = logging.getLogger(__name__)


class StreamClient(Protocol):
    """The subset of redis.Redis used by the worker (fake-friendly)."""

    def xgroup_create(self, name: str, groupname: str, id: str = "$", mkstream: bool = False) -> Any: ...
    def xreadgroup(self, groupname: str, consumername: str, streams: Mapping[str, str], count: int | None = None, block: int | None = None) -> Any: ...
    def xautoclaim(self, name: str, groupname: str, consumername: str, min_idle_time: int, start_id: str = "0-0", count: int | None = None) -> Any: ...
    def xack(self, name: str, groupname: str, *ids: str) -> Any: ...
    def xdel(self, name: str, *ids: str) -> Any: ...
    def xadd(self, name: str, fields: Mapping[str, str], id: str = "*") -> Any: ...
    def get(self, name: str) -> Any: ...
    def set(self, name: str, value: str, px: int | None = None) -> Any: ...
    def delete(self, name: str) -> Any: ...


def _text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _fields(raw: Mapping[object, object]) -> dict[str, str]:
    return {_text(key): _text(value) for key, value in raw.items()}


class QueueWorker:
    """Poll, execute and acknowledge role-tagged jobs on one model process."""

    def __init__(
        self,
        client: StreamClient,
        bundles: Bundle | Mapping[str, Bundle],
        consumer: str,
        stop: Event | None = None,
    ) -> None:
        self.client = client
        self.bundles = dict(bundles) if isinstance(bundles, Mapping) else {"guesser": bundles}
        self.consumer = consumer
        self.stop = stop or Event()
        self.thread: Thread | None = None

    def start(self) -> None:
        self.thread = Thread(target=self.run, name="ai-queue-worker", daemon=True)
        self.thread.start()

    def stop_and_join(self, timeout: float = 5.0) -> None:
        self.stop.set()
        if self.thread:
            self.thread.join(timeout)

    def ensure_group(self) -> None:
        try:
            self.client.xgroup_create(JOBS_STREAM, WORKER_GROUP, id="0", mkstream=True)
        except redis.ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def _registration_key(self, role: str) -> str:
        """Keep the historical Guesser key and suffix the Referee key."""
        return f"{WORKER_PREFIX}{self.consumer}" if role == "guesser" else f"{WORKER_PREFIX}{self.consumer}:{role}"

    def register(self, heartbeat_at: int | None = None) -> None:
        """Publish one short-lived readiness record per ready role."""
        for role, bundle in self.bundles.items():
            if not bundle.adapter or not bundle.revision:
                continue
            payload = {
                "workerId": self.consumer,
                "role": role,
                "modelId": bundle.model_id,
                "artifactRevision": bundle.revision,
                "heartbeatAt": heartbeat_at if heartbeat_at is not None else int(time() * 1000),
                **({"labels": bundle.labels} if role == "guesser" else {}),
            }
            self.client.set(self._registration_key(role), json.dumps(payload, separators=(",", ":")), px=WORKER_TTL_MS)

    def deregister(self) -> None:
        for role in self.bundles:
            self.client.delete(self._registration_key(role))

    def run(self) -> None:
        """Own the single consumer loop until ``stop`` is set."""
        while not self.stop.is_set():
            try:
                self.ensure_group()
                break
            except redis.RedisError:
                self.stop.wait(1.0)
        if self.stop.is_set():
            return
        last_heartbeat = 0.0
        while not self.stop.is_set():
            try:
                now = time()
                if now - last_heartbeat >= HEARTBEAT_SECONDS:
                    self.register(int(now * 1000))
                    last_heartbeat = now
                for message_id, fields in self._next():
                    self.handle(message_id, fields)
            except redis.RedisError as exc:
                LOG.warning("queue worker redis error: %s", type(exc).__name__)
                self.stop.wait(1.0)
        try:
            self.deregister()
        except redis.RedisError:
            pass

    def _next(self) -> list[tuple[str, dict[str, str]]]:
        response = self.client.xreadgroup(WORKER_GROUP, self.consumer, {JOBS_STREAM: ">"}, count=1, block=BLOCK_MS)
        entries: list[tuple[str, dict[str, str]]] = []
        for _stream, messages in response or []:
            for message_id, fields in messages:
                entries.append((_text(message_id), _fields(fields)))
        if entries:
            return entries
        claimed = self.client.xautoclaim(
            JOBS_STREAM, WORKER_GROUP, self.consumer, min_idle_time=RECLAIM_IDLE_MS, start_id="0-0", count=1
        )
        if len(claimed) < 2:
            return []
        return [(_text(message_id), _fields(fields)) for message_id, fields in claimed[1]]

    def handle(self, message_id: str, fields: Mapping[str, str]) -> bool:
        """Process one stream entry; return True when it was acknowledged.

        A successful result is published before the request is acknowledged.
        Malformed envelopes cannot be bound to a result and are dropped; every
        other path (cancelled, expired, missing payload, model fault) produces
        an explicit unavailable result.
        """
        raw = fields.get("job")
        if not raw:
            self._acknowledge(message_id)
            return False
        try:
            job = parse_job_json(raw)
        except ValidationError:
            LOG.warning("queue job rejected: invalid-envelope")
            self._acknowledge(message_id)
            return False
        outcome = self._observe(job)
        if outcome is None:
            return False
        payload = {**result_binding(job), **outcome}
        self.client.xadd(RESULTS_STREAM, {"result": json.dumps(payload, separators=(",", ":"))})
        self._acknowledge(message_id)
        return True

    def _observe(self, job: InferenceJobV1) -> dict | None:
        bundle = self.bundles.get(job.role)
        if bundle is None:
            return {"status": "unavailable", "reason": "model-unavailable"}
        if self.client.get(f"{CANCEL_PREFIX}{job.jobId}"):
            return {"status": "unavailable", "reason": "cancelled"}
        if job.deadlineAt <= time() * 1000:
            return {"status": "unavailable", "reason": "deadline-expired"}
        payload = self.client.get(job.payloadKey)
        if payload is None:
            return {"status": "unavailable", "reason": "missing-payload"}
        observation = Observation(
            jobId=job.jobId,
            turnId=job.turnId,
            canvasId=job.canvasId,
            generation=job.generation,
            sequence=job.sequence,
            deadlineAt=job.deadlineAt,
            modelId=job.modelId,
            artifactRevision=job.artifactRevision,
            hint=getattr(job, "hint", None),
        )
        try:
            return infer_observation(
                observation,
                bundle,
                payload if isinstance(payload, bytes) else str(payload).encode(),
                job.role,
            )
        except InvalidImage:
            return {"status": "unavailable", "reason": "invalid-image"}

    def _acknowledge(self, message_id: str) -> None:
        self.client.xack(JOBS_STREAM, WORKER_GROUP, message_id)
        self.client.xdel(JOBS_STREAM, message_id)


def configured_worker(bundles: Bundle | Mapping[str, Bundle]) -> QueueWorker | None:
    """Build a worker from environment settings, or None when disabled."""
    if os.getenv("AI_QUEUE_WORKER") != "1":
        return None
    try:
        url = os.getenv("AI_QUEUE_REDIS_URL") or os.getenv("REDIS_URL") or ""
        if not url.startswith(("redis://", "rediss://")):
            raise ValueError("invalid queue URL")
        password_file = os.getenv("AI_QUEUE_REDIS_PASSWORD_FILE")
        password = Path(password_file).read_text(encoding="utf-8").strip() if password_file else None
        if password_file and not password:
            raise ValueError("empty queue secret")
        client = redis.Redis.from_url(
            url,
            username=os.getenv("AI_QUEUE_REDIS_USERNAME") or None,
            password=password,
            decode_responses=False,
            socket_timeout=10,
            socket_connect_timeout=2,
            health_check_interval=30,
        )
        consumer = os.getenv("AI_QUEUE_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}"
        return QueueWorker(cast(StreamClient, client), bundles, consumer)
    except (OSError, ValueError):
        LOG.warning("queue worker configuration unavailable")
        return None
