"""HTTP contract and input validation for the private inference service."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import logging
from threading import Event
from time import time

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image

from ai_service import main
from ai_service.bundles import Bundle
from ai_service.main import app
from models.guesser.inference.quickdraw import prepare


def test_role_readiness_and_bound_fixture_scores(tmp_path, monkeypatch):
    credential = tmp_path / "credential"
    credential.write_text("fixture-secret-for-tests", encoding="utf-8")
    monkeypatch.setenv("AI_SECRET_FILE", str(credential))
    monkeypatch.setenv("AI_TEST_FIXTURES", "1")
    monkeypatch.setenv("REFEREE_MODEL_ID", "referee-fixture-v1")
    monkeypatch.delenv("GUESSER_MODEL_ID", raising=False)
    headers = {"Authorization": "Bearer fixture-secret-for-tests"}
    now = time()
    monkeypatch.setattr(main, "time", lambda: now)
    job = {
        "jobId": "job",
        "turnId": "turn",
        "canvasId": "canvas",
        "generation": 1,
        "sequence": 3,
        "deadlineAt": int(now * 1000) + 10000,
        "modelId": "referee-fixture-v1",
        "artifactRevision": "fixture-v1",
    }

    def png(size):
        data = BytesIO()
        Image.new("RGB", size, (204, 51, 0)).save(data, format="PNG")
        return ("canvas.png", data.getvalue(), "image/png")

    with TestClient(app) as client:
        assert client.get("/health/live").json() == {"live": True}
        assert client.get("/health/ready").status_code == 401
        roles = client.get("/health/ready", headers=headers).json()
        assert roles["guesser"]["status"] == "disabled"
        assert roles["referee"]["status"] == "ready"
        request = {"headers": headers, "data": {"metadata": json.dumps(job)}}
        assert client.post("/v1/referee", files={"image": png((8, 8))}, **request).status_code == 422
        result = client.post("/v1/referee", files={"image": png((1024, 768))}, **request)
        assert result.status_code == 200
        assert result.json() == {**job, "status": "evidence", "scores": [0.8, 0.2]}
        assert client.post("/v1/guess", files={"image": png((1024, 768))}, **request).json()["status"] == "unavailable"

        started, released = Event(), Event()
        adapter = app.state.bundles["referee"].adapter
        original_predict = adapter.predict

        def slow_predict(image):
            started.set()
            assert released.wait(timeout=30)
            return original_predict(image)

        monkeypatch.setattr(adapter, "predict", slow_predict)
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(client.post, "/v1/referee", files={"image": png((1024, 768))}, **request)
            try:
                assert started.wait(timeout=30)
                busy = client.post("/v1/referee", headers=headers, content=b"bad form")
                assert busy.status_code == 429
            finally:
                released.set()
            assert first.result(timeout=30).status_code == 200



def test_quickdraw_uses_light_ink_and_passes_blank():
    white = Image.new("RGB", (1024, 768), "white")
    assert prepare(white) is None
    white.paste("black", (495, 365, 530, 400))
    pixels = prepare(white)
    assert pixels.shape == (1, 28, 28, 1)
    assert pixels.dtype == np.float32
    assert pixels[0, 0, 0, 0] == 0 and pixels[0, 14, 14, 0] == 1


def test_guesser_prediction_logs_only_safe_correlation_fields(tmp_path, monkeypatch, caplog):
    credential = tmp_path / "credential"
    credential.write_text("fixture-secret-for-tests", encoding="utf-8")
    monkeypatch.setenv("AI_SECRET_FILE", str(credential))
    monkeypatch.setenv("GUESSER_MODEL_ID", "test-guesser")
    now = time()
    monkeypatch.setattr(main, "time", lambda: now)

    class AnswerAdapter:
        def predict(self, image):
            return {"status": "answer", "answer": "private-answer"}

    guesser = Bundle("test-guesser", "revision-1", adapter=AnswerAdapter())
    monkeypatch.setattr(
        main,
        "load_bundle",
        lambda role, model_id, artifact_root: guesser if role == "guesser" else Bundle(model_id),
    )
    headers = {"Authorization": "Bearer fixture-secret-for-tests"}
    job = {
        "jobId": "job-123",
        "turnId": "turn-456",
        "canvasId": "canvas-789",
        "generation": 4,
        "sequence": 12,
        "deadlineAt": int(now * 1000) + 10000,
        "modelId": "test-guesser",
        "artifactRevision": "revision-1",
        "hint": "private-hint",
    }
    data = BytesIO()
    Image.new("RGB", (1024, 768), "white").save(data, format="PNG")

    with caplog.at_level(logging.INFO, logger="uvicorn.error"), TestClient(app) as client:
        response = client.post(
            "/v1/guess",
            headers=headers,
            data={"metadata": json.dumps(job)},
            files={"image": ("canvas.png", data.getvalue(), "image/png")},
        )

    assert response.status_code == 200
    assert response.json()["answer"] == "private-answer"
    records = [record for record in caplog.records if record.name == "uvicorn.error"]
    assert len(records) == 1
    event = json.loads(records[0].message)
    assert event == {
        "event": "guesser_prediction",
        "jobId": "job-123",
        "canvasId": "canvas-789",
        "generation": 4,
        "sequence": 12,
        "modelId": "test-guesser",
        "artifactRevision": "revision-1",
    }
    assert "private-answer" not in records[0].message
    assert "private-hint" not in records[0].message
    assert "fixture-secret-for-tests" not in records[0].message
