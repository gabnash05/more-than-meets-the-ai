"""Redis Streams worker behavior: binding, deadlines, recovery and readiness."""

import json
import os
from io import BytesIO
from pathlib import Path
from time import time
from uuid import uuid4

import pytest
import redis
from PIL import Image

from ai_service.bundles import Bundle
from ai_service.queue_worker import (
    JOBS_STREAM,
    RESULTS_STREAM,
    WORKER_PREFIX,
    QueueWorker,
    configured_worker,
)

FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "game-contracts"
    / "fixtures"
    / "ai-inference-v1"
)
JOB = json.loads((FIXTURES / "job.valid.json").read_text(encoding="utf-8"))
LABELS = [f"label-{index}" for index in range(345)]


class Adapter:
    def __init__(self, result=None, error=None):
        self.result = result or {"status": "answer", "answer": "zigzag", "confidence": 0.8}
        self.error = error
        self.calls = 0

    def predict(self, image):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


class FakeRedis:
    def __init__(self):
        self.values: dict[str, object] = {}
        self.commands: list[tuple[str, str]] = []
        self.results: list[tuple[str, dict[str, str]]] = []
        self.read_batches: list[list] = []
        self.claimed: list[tuple] = []
        self.inbox: list[tuple[bytes, dict[bytes, bytes]]] = []
        self.acked: list[str] = []
        self.deleted: list[str] = []
        self.fail_xadd = False

    def xgroup_create(self, name, groupname, id="$", mkstream=False):
        self.commands.append(("xgroup", f"{name}:{groupname}"))
        return True

    def xreadgroup(self, groupname, consumername, streams, count=None, block=None):
        self.commands.append(("xreadgroup", groupname))
        if self.inbox:
            return [[JOBS_STREAM, [self.inbox.pop(0)]]]
        return []

    def xautoclaim(self, name, groupname, consumername, min_idle_time, start_id="0-0", count=None):
        self.commands.append(("xautoclaim", name))
        return ["0-0", self.claimed, []]

    def xadd(self, name, fields, id="*"):
        self.commands.append(("xadd", name))
        if self.fail_xadd:
            raise redis.RedisError("publish-failed")
        self.results.append((name, dict(fields)))
        return "9-0"

    def xack(self, name, groupname, *ids):
        self.commands.append(("xack", name))
        self.acked.extend(ids)
        return 1

    def xdel(self, name, *ids):
        self.commands.append(("xdel", name))
        self.deleted.extend(ids)
        return 1

    def get(self, name):
        return self.values.get(name)

    def set(self, name, value, px=None):
        self.commands.append(("set", name))
        self.values[name] = value
        return True

    def delete(self, name):
        self.commands.append(("delete", name))
        self.values.pop(name, None)
        return 1


def png() -> bytes:
    data = BytesIO()
    Image.new("RGB", (1024, 768), "white").save(data, format="PNG")
    return data.getvalue()


def bundle(adapter: Adapter) -> Bundle:
    return Bundle(
        JOB["modelId"],
        JOB["artifactRevision"],
        labels=LABELS,
        adapter=adapter,
    )


def worker(adapter: Adapter, client: FakeRedis | None = None) -> tuple[QueueWorker, FakeRedis, Adapter]:
    fake = client or FakeRedis()
    return QueueWorker(fake, bundle(adapter), "worker-1"), fake, adapter


def job_json(**overrides) -> str:
    value = {**JOB, "deadlineAt": int(time() * 1000) + 10000, **overrides}
    return json.dumps(value, separators=(",", ":"))


def test_handle_publishes_a_bound_result_before_acknowledging() -> None:
    queue, fake, adapter = worker(Adapter())
    fake.values[JOB["payloadKey"]] = png()
    assert queue.handle("1-0", {"job": job_json()}) is True
    assert adapter.calls == 1
    assert len(fake.results) == 1
    stream, fields = fake.results[0]
    assert stream == RESULTS_STREAM
    result = json.loads(fields["result"])
    assert result["jobId"] == JOB["jobId"]
    assert result["canvasId"] == JOB["canvasId"]
    assert result["status"] == "answer"
    assert result["answer"] == "zigzag"
    assert "payloadKey" not in result
    assert "hint" not in result
    names = [name for name, _ in fake.commands]
    assert names.index("xadd") < names.index("xack")
    assert fake.acked == ["1-0"]
    assert fake.deleted == ["1-0"]


def test_expired_cancelled_and_missing_payload_jobs_skip_the_model() -> None:
    queue, fake, adapter = worker(Adapter())
    expired = int(time() * 1000) - 1
    fake.values[JOB["payloadKey"]] = png()
    assert queue.handle("1-0", {"job": job_json(deadlineAt=expired)}) is True
    assert json.loads(fake.results[-1][1]["result"])["reason"] == "deadline-expired"

    fake.values[f"mmtai:ai:cancel:{JOB['jobId']}"] = "1"
    assert queue.handle("2-0", {"job": job_json()}) is True
    assert json.loads(fake.results[-1][1]["result"])["reason"] == "cancelled"

    fake.values.pop(f"mmtai:ai:cancel:{JOB['jobId']}")
    fake.values.pop(JOB["payloadKey"])
    assert queue.handle("3-0", {"job": job_json()}) is True
    assert json.loads(fake.results[-1][1]["result"])["reason"] == "missing-payload"
    assert adapter.calls == 0


def test_invalid_payload_and_envelope_do_not_publish_model_results() -> None:
    queue, fake, adapter = worker(Adapter())
    fake.values[JOB["payloadKey"]] = b"not-a-png"
    assert queue.handle("1-0", {"job": job_json()}) is True
    assert json.loads(fake.results[-1][1]["result"])["reason"] == "invalid-image"

    assert queue.handle("2-0", {"job": "not-json"}) is False
    assert fake.acked == ["1-0", "2-0"]
    assert adapter.calls == 0
    assert len(fake.results) == 1


def test_publish_failure_leaves_the_job_pending_for_reclaim() -> None:
    queue, fake, adapter = worker(Adapter())
    fake.values[JOB["payloadKey"]] = png()
    fake.fail_xadd = True
    with pytest.raises(redis.RedisError):
        queue.handle("1-0", {"job": job_json()})
    assert fake.acked == []
    assert fake.deleted == []
    assert adapter.calls == 1


def test_register_publishes_worker_identity_and_readiness_ttl() -> None:
    queue, fake, _ = worker(Adapter())
    queue.register(heartbeat_at=123456)
    key = f"{WORKER_PREFIX}worker-1"
    registration = json.loads(str(fake.values[key]))
    assert registration == {
        "workerId": "worker-1",
        "modelId": JOB["modelId"],
        "artifactRevision": JOB["artifactRevision"],
        "labels": LABELS,
        "heartbeatAt": 123456,
    }
    assert ("set", key) in fake.commands


def test_next_reclaims_an_abandoned_job_when_no_new_work_exists() -> None:
    queue, fake, _ = worker(Adapter())
    fake.claimed = [(b"7-0", {b"job": job_json().encode()})]
    entries = queue._next()
    assert entries == [("7-0", {"job": job_json()})]
    assert ("xautoclaim", JOBS_STREAM) in fake.commands

def test_configured_worker_respects_the_enable_switch(monkeypatch) -> None:
    monkeypatch.delenv("AI_QUEUE_WORKER", raising=False)
    assert configured_worker(bundle(Adapter())) is None
    monkeypatch.setenv("AI_QUEUE_WORKER", "1")
    monkeypatch.setenv("AI_QUEUE_REDIS_URL", "redis://127.0.0.1:6379/15")
    monkeypatch.delenv("AI_QUEUE_REDIS_PASSWORD_FILE", raising=False)
    queue = configured_worker(bundle(Adapter()))
    assert queue is not None
    assert queue.consumer

@pytest.mark.skipif(not os.getenv("REDIS_URL"), reason="REDIS_URL not configured")
def test_two_workers_share_the_consumer_group() -> None:
    client = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=False)
    for stream in (JOBS_STREAM, RESULTS_STREAM):
        client.delete(stream)
    adapter_a, adapter_b = Adapter(), Adapter()
    first = QueueWorker(client, bundle(adapter_a), "int-worker-a")
    second = QueueWorker(client, bundle(adapter_b), "int-worker-b")
    first.start()
    second.start()
    try:
        job_ids = []
        for _index in range(2):
            job_id = f"int-job-{uuid4()}"
            payload_key = f"mmtai:ai:payload:{job_id}"
            client.set(payload_key, png(), px=60000)
            client.xadd(JOBS_STREAM, {"job": job_json(jobId=job_id, payloadKey=payload_key)})
            job_ids.append(job_id)

        deadline = time() + 15
        seen: dict[bytes, dict] = {}
        while len(seen) < 2 and time() < deadline:
            response = client.xread({RESULTS_STREAM: "0"}, count=10, block=200)
            for _stream, entries in response or []:
                for message_id, fields in entries:
                    seen[message_id] = json.loads(fields[b"result"])

        assert len(seen) == 2, f"expected two results, received {len(seen)}"
        assert sorted(result["jobId"] for result in seen.values()) == sorted(job_ids)
        assert adapter_a.calls + adapter_b.calls == 2
    finally:
        first.stop_and_join()
        second.stop_and_join()
        client.delete(JOBS_STREAM, RESULTS_STREAM)
        for pattern in ("mmtai:ai:workers:int-worker-*", "mmtai:ai:payload:int-job-*"):
            for key in client.scan_iter(match=pattern):
                client.delete(key)
        client.close()
