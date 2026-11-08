from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import zipfile
from contextlib import ExitStack
from pathlib import Path

from .common import (
    DataError,
    atomic_json,
    file_hash,
    json_bytes,
    load_step,
    progress,
    read_json,
)
from .settings import PACKAGE_ROOT, Settings

_download = load_step("01-download")
clean_record = _download.clean_record
trajectory_hash = _download.trajectory_hash

_prepare = load_step("02-prepare")
_classes = _prepare._classes
_summary = _prepare._summary
_validate_registry = _prepare._validate_registry
_validate_sources = _prepare._validate_sources
_verified_receipts = _prepare._verified_receipts


def read_indexed(prepared: str | Path, row: dict) -> dict:
    root = Path(prepared).resolve()
    path = (root / row["record_file"]).resolve()
    if not path.is_relative_to(root):
        raise DataError("Invalid record path", "invalid_path")
    with path.open("rb") as source:
        source.seek(row["byte_offset"])
        data = source.read(row["byte_length"])
    return json.loads(data)


def audit(settings: Settings) -> dict:
    settings.base.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=".audit-", suffix=".sqlite", dir=settings.base
    )
    os.close(descriptor)
    connection = sqlite3.connect(temporary_path)
    try:
        connection.execute("CREATE TABLE seen (id TEXT PRIMARY KEY, hash TEXT UNIQUE)")
        with ExitStack() as record_stream:
            return _audit_impl(settings, connection, record_stream)
    finally:
        connection.close()
        Path(temporary_path).unlink(missing_ok=True)


def _audit_impl(settings, connection, record_stream: ExitStack):
    import pyarrow.parquet as pq

    base = settings.base
    prepared = (base / "prepared").resolve()
    summary_path = base / "dataset-summary.json"
    existing_summary = read_json(summary_path) if summary_path.exists() else None
    if existing_summary is None:
        available_classes = _classes(settings)
        receipts = _verified_receipts(settings, available_classes)
    else:
        class_ids = {int(key) for key in existing_summary["counts"]}
        available_classes = [
            item for item in existing_summary["labels"] if item["class_id"] in class_ids
        ]
        receipts = {item["class_id"]: item for item in existing_summary["sources"]}
        if (
            existing_summary.get("profile") != settings.profile
            or existing_summary.get("trainable") is not settings.is_trainable
            or set(receipts) != class_ids
            or len(available_classes) != len(class_ids)
        ):
            raise DataError("Dataset summary class or profile mismatch", "audit_failed")
        _validate_registry(settings, existing_summary["labels"], available_classes)
        _validate_sources(settings, available_classes, receipts, summary=True)
    classes = {x["class_id"]: x for x in available_classes}
    offsets = {}
    record_digests = {}
    timing = {
        class_id: {"min_ms": None, "max_ms": None, "zero_count": 0}
        for class_id in classes
    }
    counts = {
        class_id: {s: 0 for s in ("train", "validation", "test")}
        for class_id in classes
    }
    hashes = {}
    current_file = None
    source = None
    progress("export", "auditing prepared manifests")
    for split in ("train", "validation", "test"):
        path = base / "prepared" / "manifests" / f"{split}.parquet"
        hashes[split] = file_hash(path)
        manifest = pq.ParquetFile(path)
        total_rows = manifest.metadata.num_rows
        processed = 0
        progress("export", f"auditing {split}: {total_rows:,} rows")
        for row in (
            item
            for batch in manifest.iter_batches(batch_size=4096)
            for item in batch.to_pylist()
        ):
            drawing_id = row["drawing_id"]
            digest = row["trajectory_hash"]
            class_id = row["class_id"]
            if (
                class_id not in classes
                or row["split"] != split
                or row["group_id"] != drawing_id
            ):
                raise DataError(
                    "Manifest duplication or invalid membership", "audit_failed"
                )
            relative = row["record_file"]
            offset, length = row["byte_offset"], row["byte_length"]
            next_path = None
            if source is None or relative != current_file:
                next_path = (prepared / relative).resolve()
                if not next_path.is_relative_to(prepared):
                    raise DataError("Invalid record path", "invalid_path")
            if offset != offsets.get(relative, 0) or length <= 0:
                raise DataError("Noncontiguous record offsets", "audit_failed")
            if next_path is not None:
                record_stream.close()
                source = record_stream.enter_context(next_path.open("rb"))
                source.seek(offset)
                current_file = relative
            assert source is not None
            raw = source.read(length)
            if len(raw) != length or raw.find(b"\n") != length - 1:
                raise DataError("Invalid record boundary", "audit_failed")
            offsets[relative] = offset + length
            if offset == 0:
                record_digests[relative] = hashlib.sha256()
            record_digests[relative].update(raw)
            record = json.loads(raw)
            clean, _ = clean_record(record, classes[class_id]["source_name"])
            strokes = record["drawing"]
            if (
                json_bytes(clean) != json_bytes(record)
                or record.get("recognized") != row["recognized"]
                or len(strokes) != row["stroke_count"]
                or sum(len(stroke[0]) for stroke in strokes) != row["point_count"]
                or strokes[-1][2][-1] - strokes[0][2][0] != row["duration_ms"]
            ):
                raise DataError("Manifest metadata mismatch", "audit_failed")
            if str(record["key_id"]) != drawing_id or trajectory_hash(record) != digest:
                raise DataError("Indexed record mismatch", "audit_failed")
            try:
                connection.execute(
                    "INSERT INTO seen VALUES (?,?)", (drawing_id, digest)
                )
            except sqlite3.IntegrityError as exc:
                raise DataError("Duplicate ID or trajectory", "audit_failed") from exc
            duration = row["duration_ms"]
            t = timing[class_id]
            t["min_ms"] = (
                duration if t["min_ms"] is None else min(t["min_ms"], duration)
            )
            t["max_ms"] = (
                duration if t["max_ms"] is None else max(t["max_ms"], duration)
            )
            t["zero_count"] += int(duration == 0)
            counts[class_id][split] += 1
            processed += 1
            if processed % 100_000 == 0:
                progress("export", f"audited {split} {processed:,}/{total_rows:,} rows")
    for relative, end in offsets.items():
        if (base / "prepared" / relative).stat().st_size != end:
            raise DataError("Unindexed record data", "audit_failed")
    expected_files = {
        f"records/{split}/c{class_id:03d}.jsonl"
        for class_id in classes
        for split in ("train", "validation", "test")
    }
    actual_files = {
        p.relative_to(base / "prepared").as_posix()
        for p in (base / "prepared" / "records").glob("*/*.jsonl")
    }
    if expected_files != actual_files:
        raise DataError("Unindexed record files", "audit_failed")
    for class_id, totals in counts.items():
        if any(totals[s] != settings.spec[s] for s in totals):
            raise DataError("Wrong split count", "audit_failed", class_id=class_id)
    summary = _summary(
        settings,
        available_classes,
        receipts,
        counts,
        timing,
        {relative: digest.hexdigest() for relative, digest in record_digests.items()},
        hashes,
        registry=existing_summary["labels"] if existing_summary is not None else None,
    )
    if existing_summary is not None and existing_summary != summary:
        raise DataError("Dataset summary mismatch", "audit_failed")
    if existing_summary is None:
        atomic_json(summary_path, summary)
    return {"status": "passed", "summary": summary}


def export_dataset(settings: Settings, output_dir: str | Path | None = None) -> dict:
    audit(settings)
    base = settings.base
    output = Path(output_dir) if output_dir else base / "exports"
    output.mkdir(parents=True, exist_ok=True)
    results = {}
    for role, splits in (
        ("trainer", ("train", "validation")),
        ("held-out-test", ("test",)),
    ):
        path = output / f"{role}-{settings.profile}.zip"
        temporary = path.with_suffix(".zip.part")
        progress("export", f"writing {path.name}")
        with zipfile.ZipFile(
            temporary, "w", zipfile.ZIP_DEFLATED, allowZip64=True
        ) as archive:
            for name in ("labels.json", "inventory.json", "dataset-summary.json"):
                source = base / name
                if source.exists():
                    archive.write(source, name)
            for name in (
                "pyproject.toml",
                "uv.lock",
                "README.md",
                "RUNBOOK.md",
                "guesser-data.ps1",
                ".python-version",
            ):
                source = PACKAGE_ROOT / name
                if source.exists():
                    archive.write(source, name)
            for folder in ("src",):
                for source in sorted((PACKAGE_ROOT / folder).rglob("*")):
                    if source.is_file() and (
                        source.suffix == ".py" or source.name == "categories.txt"
                    ):
                        archive.write(
                            source, source.relative_to(PACKAGE_ROOT).as_posix()
                        )
            for split in splits:
                manifest = base / "prepared/manifests" / f"{split}.parquet"
                archive.write(manifest, f"prepared/manifests/{split}.parquet")
                for source in sorted(
                    (base / "prepared/records" / split).glob("*.jsonl")
                ):
                    archive.write(source, f"prepared/records/{split}/{source.name}")
        os.replace(temporary, path)
        results[role] = {"path": str(path), "sha256": file_hash(path)}
        progress(
            "export", f"wrote {path.name} ({path.stat().st_size / 1024**2:,.1f} MiB)"
        )
    atomic_json(output / "checksums.json", results)
    progress("export", f"checksums written to {output / 'checksums.json'}")
    return results
