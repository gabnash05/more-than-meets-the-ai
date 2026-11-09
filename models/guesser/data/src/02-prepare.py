from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path

from .common import (
    DataError,
    atomic_json,
    atomic_output,
    candidate_path,
    file_hash,
    json_bytes,
    labels,
    load_step,
    priority,
    progress,
    read_json,
)
from .settings import PACKAGE_ROOT, Settings

_download = load_step("01-download")
clean_record = _download.clean_record
trajectory_hash = _download.trajectory_hash
verify_receipt = _download.verify_receipt


def _validate_registry(settings, all_labels, present):
    if settings.is_trainable:
        names = (
            (PACKAGE_ROOT / "src" / "resources" / "categories.txt")
            .read_text(encoding="utf-8")
            .splitlines()
        )
        if (
            len(names) != 345
            or any(type(x.get("class_id")) is not int for x in all_labels)
            or all_labels
            != [{"class_id": i, "source_name": name} for i, name in enumerate(names)]
        ):
            raise DataError(
                "Labels do not match official category order", "invalid_registry"
            )
        if len(present) != 345:
            raise DataError(
                "Trainable profiles require all 345 classes", "incomplete_classes"
            )
    if not present:
        raise DataError("No candidates available", "missing_candidates")


def _classes(settings):
    all_labels = labels(settings)
    present = [
        x for x in all_labels if candidate_path(settings, x["class_id"]).exists()
    ]
    _validate_registry(settings, all_labels, present)
    return present


def _validate_sources(settings, classes, receipts, *, summary=False):
    if not settings.is_trainable:
        return
    for item in classes:
        receipt = receipts.get(item["class_id"], {})
        if receipt.get("source_name") != item["source_name"]:
            raise DataError("Source class mismatch", "unverified_source")
        if settings.download_method == "full_source":
            valid = receipt.get("source_kind") == "quickdraw" and (
                (
                    summary
                    and "complete" not in receipt
                    and "full_source_verified" not in receipt
                )
                or (
                    receipt.get("complete") is True
                    and receipt.get("full_source_verified") is True
                )
            )
        else:
            valid = (
                receipt.get("source_kind") == "quickdraw_partial"
                and receipt.get("profile") == settings.profile
                and receipt.get("sampling_method") == "prefix-v1"
                and receipt.get("complete") is False
                and receipt.get("full_source_verified") is False
                and receipt.get("source_md5") is None
                and type(receipt.get("source_bytes")) is int
                and receipt["source_bytes"] > 0
            )
        if not valid:
            raise DataError("Source does not match profile policy", "unverified_source")


def _verified_receipts(settings, classes):
    inventory = read_json(settings.base / "inventory.json", {"categories": []})
    metadata = {item["class_id"]: item for item in inventory["categories"]}
    total = len(classes)
    # Hashing every cached candidate file takes minutes, so report it advancing.
    progress("prepare", f"verifying {total} cached candidate files")
    receipts = {}
    for index, item in enumerate(classes, start=1):
        class_id = item["class_id"]
        receipts[class_id] = verify_receipt(settings, metadata.get(class_id, item))
        if index % 25 == 0 or index == total:
            progress("prepare", f"verified {index}/{total} candidate files")
    _validate_sources(settings, classes, receipts)
    return receipts


def _summary(
    settings,
    classes,
    receipts,
    counts,
    statistics,
    record_hashes,
    manifest_hashes,
    registry=None,
):
    kinds = sorted(
        {receipt.get("source_kind", "unknown") for receipt in receipts.values()}
    )
    return {
        "version": 1,
        "profile": settings.profile,
        "data_kind": kinds[0] if len(kinds) == 1 else "mixed",
        "trainable": settings.is_trainable,
        "seed": settings.seed,
        "labels": labels(settings) if registry is None else registry,
        "counts": {str(key): value for key, value in counts.items()},
        "sources": [
            {
                key: receipt.get(key)
                for key in (
                    "class_id",
                    "source_name",
                    "source_kind",
                    "source_generation",
                    "source_bytes",
                    "source_md5",
                    "candidate_sha256",
                    "candidate_count",
                    "keep",
                )
                + (
                    ("profile", "sampling_method", "complete", "full_source_verified")
                    if settings.download_method == "prefix"
                    else ()
                )
            }
            for receipt in receipts.values()
        ],
        "statistics": {str(key): value for key, value in statistics.items()},
        "record_sha256": record_hashes,
        "manifest_sha256": manifest_hashes,
        "attribution": "Google Quick, Draw! Dataset, Google Creative Lab, CC BY 4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
    }


def _exclusions(settings):
    path = settings.base / "excluded-ids.txt"
    if not path.exists():
        legacy = read_json(settings.base / "qa" / "review-decisions.json", {}).get(
            "excluded_ids", []
        )
        if legacy:
            with atomic_output(path) as output:
                output.write(
                    ("\n".join(sorted(str(value) for value in legacy)) + "\n").encode(
                        "utf-8"
                    )
                )
    return (
        set(path.read_text(encoding="utf-8").splitlines()) if path.exists() else set()
    )


def _candidate_entries(settings: Settings, item: dict):
    class_id = item["class_id"]
    next_offset = 0
    with candidate_path(settings, class_id).open("rb") as source:
        for raw in source:
            offset = next_offset
            length = len(raw)
            next_offset += length
            if not raw.strip():
                continue
            row = json.loads(raw)
            record = row["record"]
            cleaned, _ = clean_record(record, item["source_name"])
            record_bytes = json_bytes(record)
            content = hashlib.sha256(record_bytes).hexdigest()
            if (
                not isinstance(row.get("drawing_id"), str)
                or not row["drawing_id"]
                or row["drawing_id"] != record["key_id"]
                or row["class_id"] != class_id
                or row["priority_hex"]
                != f"{priority('select-v1', row['drawing_id'], settings.seed):064x}"
                or row["trajectory_hash"] != trajectory_hash(record)
                or json_bytes(cleaned) != record_bytes
                or row.get("content_sha256", content) != content
            ):
                raise DataError(
                    "Invalid candidate", "invalid_candidate", class_id=class_id
                )
            yield (
                row["drawing_id"],
                class_id,
                row["trajectory_hash"],
                content,
                row["priority_hex"],
                offset,
                length,
                int(row.get("id_conflict", False)),
            )


def prepare(settings: Settings) -> dict:
    import pyarrow as pa
    import pyarrow.parquet as pq

    classes = _classes(settings)
    receipts = _verified_receipts(settings, classes)
    exclusions = _exclusions(settings)
    settings.base.mkdir(parents=True, exist_ok=True)
    fd, index_path = tempfile.mkstemp(
        prefix=".candidates-", suffix=".sqlite", dir=settings.base
    )
    os.close(fd)
    db = sqlite3.connect(index_path)
    try:
        db.execute("""CREATE TABLE candidates (id TEXT, class_id INTEGER, hash TEXT,
            content TEXT, rank TEXT, offset INTEGER, length INTEGER, flagged INTEGER)""")
        total = len(classes)
        candidates = sum(row.get("candidate_count", 0) for row in receipts.values())
        progress("prepare", f"indexing {candidates:,} candidates from {total} classes")
        for index, item in enumerate(classes, start=1):
            db.executemany(
                "INSERT INTO candidates VALUES (?,?,?,?,?,?,?,?)",
                _candidate_entries(settings, item),
            )
            if index % 25 == 0 or index == total:
                progress("prepare", f"indexed {index}/{total} classes")
        db.executescript("""CREATE INDEX by_id ON candidates(id);
            CREATE INDEX by_hash ON candidates(hash);
            CREATE INDEX by_class_rank_id ON candidates(class_id, rank, id);
            CREATE TABLE conflicts AS SELECT id FROM candidates GROUP BY id
            HAVING COUNT(DISTINCT content)>1 OR COUNT(DISTINCT class_id)>1 OR MAX(flagged)>0;
            CREATE INDEX conflict_ids ON conflicts(id);
            CREATE TABLE cross_hashes AS SELECT hash FROM candidates GROUP BY hash
            HAVING COUNT(DISTINCT class_id)>1; CREATE INDEX cross_values ON cross_hashes(hash);""")
        quarantined = 0
        with atomic_output(settings.base / "quarantine.jsonl") as output:
            for (
                did,
                cid,
                digest,
                reason,
            ) in db.execute("""SELECT c.id, c.class_id, c.hash,
                CASE WHEN i.id IS NOT NULL THEN 'conflicting_id' ELSE 'cross_label_trajectory' END
                FROM candidates c LEFT JOIN conflicts i ON c.id=i.id
                LEFT JOIN cross_hashes h ON c.hash=h.hash
                WHERE i.id IS NOT NULL OR h.hash IS NOT NULL ORDER BY c.class_id,c.id,c.hash"""):
                output.write(
                    json_bytes(
                        {
                            "drawing_id": did,
                            "class_id": cid,
                            "trajectory_hash": digest,
                            "reason": reason,
                        }
                    )
                    + b"\n"
                )
                quarantined += 1
        progress("prepare", f"quarantined {quarantined} candidate records")
        db.execute(
            "CREATE TABLE selected (class_id INTEGER, id TEXT, hash TEXT, offset INTEGER, length INTEGER, split_rank TEXT)"
        )
        shortage = []
        progress(
            "prepare",
            f"selecting {settings.spec['final']:,} originals per class across {total} classes",
        )
        for index, item in enumerate(classes, start=1):
            cid = item["class_id"]
            chosen = []
            seen_ids, seen_hashes = set(), set()
            for did, digest, offset, length in db.execute(
                """SELECT c.id,c.hash,c.offset,c.length
                FROM candidates c LEFT JOIN conflicts i ON c.id=i.id
                LEFT JOIN cross_hashes h ON c.hash=h.hash WHERE c.class_id=?
                AND i.id IS NULL AND h.hash IS NULL ORDER BY c.rank,c.id""",
                (cid,),
            ):
                if did in exclusions or did in seen_ids or digest in seen_hashes:
                    continue
                seen_ids.add(did)
                seen_hashes.add(digest)
                chosen.append((did, digest, offset, length))
                if len(chosen) == settings.spec["final"]:
                    break
            if len(chosen) < settings.spec["final"]:
                shortage.append(
                    {
                        "class_id": cid,
                        "source_name": item["source_name"],
                        "available": len(chosen),
                        "required_keep": receipts[cid]["candidate_count"] + 1000,
                    }
                )
            db.executemany(
                "INSERT INTO selected VALUES (?,?,?,?,?,?)",
                (
                    (
                        cid,
                        did,
                        digest,
                        offset,
                        length,
                        f"{priority('split-v1', did, settings.seed):064x}",
                    )
                    for did, digest, offset, length in chosen
                ),
            )
            if index % 25 == 0 or index == total:
                progress("prepare", f"selected {index}/{total} classes")
        if shortage:
            hint = "; ".join(
                f"download --profile {settings.profile} --class "
                f"{json.dumps(item['source_name'])} --candidates {item['required_keep']}"
                for item in shortage
            )
            raise DataError(
                "Insufficient candidates after exclusions and deduplication",
                "needs_refill",
                hint=hint,
                classes=shortage,
            )
        db.execute("CREATE INDEX selected_class ON selected(class_id, split_rank, id)")
        schema = pa.schema(
            [
                (name, typ)
                for name, typ in [
                    ("drawing_id", pa.string()),
                    ("group_id", pa.string()),
                    ("class_id", pa.int64()),
                    ("record_file", pa.string()),
                    ("byte_offset", pa.int64()),
                    ("byte_length", pa.int64()),
                    ("split", pa.string()),
                    ("recognized", pa.bool_()),
                    ("stroke_count", pa.int64()),
                    ("point_count", pa.int64()),
                    ("duration_ms", pa.int64()),
                    ("trajectory_hash", pa.string()),
                ]
            ]
        )
        manifest_dir = settings.base / "prepared/manifests"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        writers = {}
        counts, timing, record_hashes = {}, {}, {}
        try:
            for split in ("train", "validation", "test"):
                writers[split] = pq.ParquetWriter(
                    manifest_dir / f"{split}.parquet.part", schema
                )
            progress(
                "prepare", f"writing split records and manifests for {total} classes"
            )
            for index, item in enumerate(classes, start=1):
                cid = item["class_id"]
                counts[cid] = {}
                timing[cid] = {"min_ms": None, "max_ms": None, "zero_count": 0}
                selected_rows = db.execute(
                    "SELECT id,hash,offset,length FROM selected WHERE class_id=? ORDER BY split_rank,id",
                    (cid,),
                )
                with candidate_path(settings, cid).open("rb") as source:
                    for split in ("train", "validation", "test"):
                        group = selected_rows.fetchmany(settings.spec[split])
                        relative = f"records/{split}/c{cid:03d}.jsonl"
                        digest = hashlib.sha256()
                        rows = []
                        with atomic_output(
                            settings.base / "prepared" / relative
                        ) as output:
                            for did, trajectory, offset, length in group:
                                source.seek(offset)
                                record = json.loads(source.read(length))["record"]
                                raw = json_bytes(record) + b"\n"
                                record_offset = output.tell()
                                output.write(raw)
                                digest.update(raw)
                                strokes = record["drawing"]
                                duration = strokes[-1][2][-1] - strokes[0][2][0]
                                t = timing[cid]
                                t["min_ms"] = (
                                    duration
                                    if t["min_ms"] is None
                                    else min(t["min_ms"], duration)
                                )
                                t["max_ms"] = (
                                    duration
                                    if t["max_ms"] is None
                                    else max(t["max_ms"], duration)
                                )
                                t["zero_count"] += int(duration == 0)
                                rows.append(
                                    {
                                        "drawing_id": did,
                                        "group_id": did,
                                        "class_id": cid,
                                        "record_file": relative,
                                        "byte_offset": record_offset,
                                        "byte_length": len(raw),
                                        "split": split,
                                        "recognized": record.get("recognized"),
                                        "stroke_count": len(strokes),
                                        "point_count": sum(len(s[0]) for s in strokes),
                                        "duration_ms": duration,
                                        "trajectory_hash": trajectory,
                                    }
                                )
                        record_hashes[relative] = digest.hexdigest()
                        counts[cid][split] = len(group)
                        writers[split].write_table(
                            pa.Table.from_pylist(rows, schema=schema)
                        )
                if index % 25 == 0 or index == total:
                    progress("prepare", f"wrote {index}/{total} classes")
        finally:
            for writer in writers.values():
                writer.close()
        manifest_hashes = {}
        for split in writers:
            os.replace(
                manifest_dir / f"{split}.parquet.part",
                manifest_dir / f"{split}.parquet",
            )
            manifest_hashes[split] = file_hash(manifest_dir / f"{split}.parquet")
        originals = sum(sum(row.values()) for row in counts.values())
        progress("prepare", f"prepared {originals:,} originals across {total} classes")
        summary = _summary(
            settings, classes, receipts, counts, timing, record_hashes, manifest_hashes
        )
        atomic_json(settings.base / "dataset-summary.json", summary)
        return summary
    finally:
        db.close()
        Path(index_path).unlink(missing_ok=True)
