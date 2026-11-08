"""HTTP contract and input validation for the private inference service."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from threading import Event
from time import time

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image

from ai_service import main
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
