import importlib
import io
import json
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from referee_data.cli import main
from referee_data.common import DataError
from referee_data.example import build_example_files
from referee_data.settings import TRAIN_ARCHIVE, Settings

acquire = importlib.import_module("referee_data.01-download")


def test_fixture_stages_and_reads(tmp_path: Path) -> None:
    settings = Settings(tmp_path / "data")
    archives = build_example_files(tmp_path / "input")
    receipt = acquire.stage_fixture(settings, archives)
    rows = [
        json.loads(line)
        for line in (settings.source / "pairs.jsonl").read_text().splitlines()
    ]
    assert receipt["source_kind"] == "fixture" and not receipt["complete"]
    assert receipt["pair_count"] == len(rows) > 0
    assert acquire.read_member(
        settings.source, TRAIN_ARCHIVE, rows[0]["png_member"]
    ).startswith(b"\x89PNG")
    with (settings.source / TRAIN_ARCHIVE).open("ab") as output:
        output.write(b"tamper")
    with pytest.raises(DataError, match="verification"):
        acquire.read_member(settings.source, TRAIN_ARCHIVE, rows[0]["png_member"])


def test_archive_path_traversal_rejected() -> None:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("../sample_1.png", b"x")
    with zipfile.ZipFile(stream) as archive, pytest.raises(DataError):
        acquire._pairs(archive, TRAIN_ARCHIVE)


class Response:
    def __init__(self, status: int, content_range: str, body: bytes):
        self.status = status
        self.headers = {"Content-Range": content_range}
        self.body = io.BytesIO(body)
        self.read_called = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, size: int = -1) -> bytes:
        self.read_called = True
        return self.body.read(size)


def test_range_checks_headers_before_body_and_enforces_budget() -> None:
    bad = Response(200, "bytes 0-3/8", b"abcd")
    with patch.object(acquire.urllib.request, "urlopen", return_value=bad):
        with pytest.raises(DataError, match="exact"):
            acquire.RangeFile("https://example.invalid", 8, 4).read(4)
    assert not bad.read_called
    with pytest.raises(DataError, match="budget"):
        acquire.RangeFile("https://example.invalid", 8, 3).read(4)
    good = Response(206, "bytes 0-3/8", b"abc")
    with patch.object(acquire.urllib.request, "urlopen", return_value=good):
        with pytest.raises(DataError, match="Truncated"):
            acquire.RangeFile("https://example.invalid", 8, 4).read(4)


def test_train_download_reports_which_source_request_failed(tmp_path, capsys) -> None:
    args = ["download", "--profile", "train", "--data-root", str(tmp_path)]
    with patch.object(
        acquire.urllib.request,
        "urlopen",
        side_effect=FileNotFoundError(2, "No such file or directory"),
    ):
        assert main(args) == 1
    error = capsys.readouterr().err
    assert "Fetch Zenodo record 7330402" in error
    assert "No such file or directory" in error


def test_mocked_download_sample_and_train(tmp_path: Path, monkeypatch) -> None:
    archives = build_example_files(tmp_path / "input")
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, path in archives.items():
            archive.writestr("DrawMon-ACMMM22_Dataset/" + name, path.read_bytes())
    payload = outer.getvalue()
    monkeypatch.setattr(acquire, "ARCHIVE_SIZE", len(payload))
    metadata = {
        "id": 7330402,
        "files": [
            {
                "key": acquire.ARCHIVE_NAME,
                "size": len(payload),
                "checksum": "md5:" + acquire.ARCHIVE_MD5,
                "links": {"self": "https://example.invalid/archive"},
            }
        ],
    }
    requested = []

    def open_mock(request, timeout=60):
        if isinstance(request, str):
            return Response(200, "", json.dumps(metadata).encode())
        start, end = map(
            int, request.get_header("Range").removeprefix("bytes=").split("-")
        )
        requested.append((start, end))
        return Response(
            206, f"bytes {start}-{end}/{len(payload)}", payload[start : end + 1]
        )

    monkeypatch.setattr(acquire.urllib.request, "urlopen", open_mock)
    sample_settings = Settings(tmp_path / "data", "sample")
    result = acquire.download(sample_settings)
    assert (
        result["pair_count"] <= 10
        and result["response_bytes"] <= acquire.SAMPLE_BYTE_CAP
    )
    assert all(
        row["source_partition"] == "train"
        for row in map(
            json.loads,
            (sample_settings.source / "pairs.jsonl").read_text().splitlines(),
        )
    )
    old_count = len(requested)
    again = acquire.download(sample_settings)
    assert again["pair_count"] == result["pair_count"] and len(requested) > old_count
    train_settings = Settings(tmp_path / "data", "train")
    train = acquire.download(train_settings)
    assert train["complete"] and train["pair_count"] > result["pair_count"]
    assert set(train["archive_sha256"]) == set(archives)
    assert not (train_settings.source / "members").exists()
    resumed = acquire.download(train_settings)
    assert resumed["archive_sha256"] == train["archive_sha256"]
    assert resumed["response_bytes"] < train["response_bytes"]
    rows = [
        json.loads(line)
        for line in (train_settings.source / "pairs.jsonl").read_text().splitlines()
    ]
    assert {row["source_partition"] for row in rows} == {"train", "test"}
    assert acquire.read_member(
        train_settings.source, TRAIN_ARCHIVE, rows[0]["png_member"]
    ).startswith(b"\x89PNG")


def test_missing_pairs_prevent_complete_receipt(tmp_path: Path) -> None:
    settings = Settings(tmp_path, "train")
    receipt = acquire._receipt(
        settings, "atypict_range_multiclass", [], missing_pairs=1
    )
    assert not receipt["complete"]
    receipt = acquire._receipt(
        settings, "atypict_range_multiclass", [], missing_pairs=0
    )
    assert receipt["complete"]
