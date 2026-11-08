from __future__ import annotations

import base64
import concurrent.futures
import contextlib
import hashlib
import heapq
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from collections.abc import Iterable

from .common import (
    DataError,
    acquisition_recipe,
    atomic_json,
    candidate_path,
    object_hash,
    priority,
    progress,
    read_json,
    receipt_path,
    write_jsonl,
)
from .settings import CONCURRENCY, Settings


def _coordinate(value: int | float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, int) and abs(value) > 2**53)
    ):
        raise DataError("Invalid coordinate", "invalid_coordinate")
    value = float(value)
    if not math.isfinite(value):
        raise DataError("Invalid coordinate", "invalid_coordinate")
    return 0.0 if value == 0 else value


def clean_record(record: dict, expected_word: str) -> tuple[dict, dict[str, int]]:
    """Clean exact repeats while preserving stroke order, pauses and metadata."""
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("key_id"), str)
        or not record["key_id"]
        or not record.get("word")
        or "drawing" not in record
    ):
        raise DataError("Missing ID, word or drawing", "missing_field")
    if record["word"] != expected_word:
        raise DataError("Category mismatch", "word_mismatch")
    if not isinstance(record["drawing"], list):
        raise DataError("Invalid drawing", "invalid_strokes")

    repairs = {"empty_strokes": 0, "duplicate_points": 0}
    strokes = []
    last_time = None
    for stroke in record["drawing"]:
        if (
            not isinstance(stroke, list)
            or len(stroke) != 3
            or not all(isinstance(axis, list) for axis in stroke)
        ):
            raise DataError("Malformed stroke arrays", "invalid_strokes")
        x_values, y_values, times = stroke
        if not len(x_values) == len(y_values) == len(times):
            raise DataError("Malformed stroke arrays", "invalid_strokes")
        if not x_values:
            repairs["empty_strokes"] += 1
            continue

        cleaned_x, cleaned_y, cleaned_times = [], [], []
        previous = None
        for x, y, time_ms in zip(x_values, y_values, times):
            x = _coordinate(x)
            y = _coordinate(y)
            if (
                isinstance(time_ms, bool)
                or not isinstance(time_ms, int)
                or not 0 <= time_ms <= 2**63 - 1
                or (last_time is not None and time_ms < last_time)
            ):
                raise DataError("Invalid chronology", "invalid_time")
            last_time = time_ms
            point = (x, y, time_ms)
            if point == previous:
                repairs["duplicate_points"] += 1
                continue
            cleaned_x.append(x)
            cleaned_y.append(y)
            cleaned_times.append(time_ms)
            previous = point
        strokes.append([cleaned_x, cleaned_y, cleaned_times])

    if not strokes:
        raise DataError("No visible extent", "no_extent")
    x_min = min(min(stroke[0]) for stroke in strokes)
    x_max = max(max(stroke[0]) for stroke in strokes)
    y_min = min(min(stroke[1]) for stroke in strokes)
    y_max = max(max(stroke[1]) for stroke in strokes)
    if not math.isfinite(x_max - x_min) or not math.isfinite(y_max - y_min):
        raise DataError("Non-finite drawing extent", "invalid_coordinate")
    if x_min == x_max and y_min == y_max:
        raise DataError("No visible extent", "no_extent")
    if strokes[-1][2][-1] == strokes[0][2][0]:
        raise DataError("Zero duration", "zero_duration")

    cleaned = dict(record)
    cleaned["drawing"] = strokes
    return cleaned, repairs


def trajectory_hash(cleaned_record: dict) -> str:
    """Hash the complete cleaned coordinates, times and stroke boundaries."""
    return object_hash(cleaned_record["drawing"])


REGISTRY = "https://raw.githubusercontent.com/googlecreativelab/quickdraw-dataset/master/categories.txt"
LISTING = "https://storage.googleapis.com/storage/v1/b/quickdraw_dataset/o?prefix=full%2Fraw%2F&maxResults=1000"
OBJECT = "https://storage.googleapis.com/quickdraw_dataset/full/raw/"


def _get_small(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 200:
                raise DataError("Metadata HTTP status", "http_status")
            return response.read()
    except (OSError, ValueError) as exc:
        raise DataError("Metadata request failed", "request_failed") from exc


def inventory(settings: Settings) -> dict:
    """Save the official label order and generation/checksum inventory."""
    raw = _get_small(REGISTRY)
    try:
        names = raw.decode("utf-8").splitlines()
    except UnicodeError as exc:
        raise DataError("Invalid category registry", "invalid_registry") from exc
    if len(names) != 345 or len(set(names)) != 345 or any(not name for name in names):
        raise DataError("Expected 345 unique categories", "invalid_registry")
    labels = [
        {"class_id": class_id, "source_name": name}
        for class_id, name in enumerate(names)
    ]
    objects, url = [], LISTING
    while url:
        try:
            page = json.loads(_get_small(url))
        except (ValueError, UnicodeError) as exc:
            raise DataError("Invalid inventory", "invalid_inventory") from exc
        objects.extend(page.get("items", []))
        token = page.get("nextPageToken")
        url = (
            LISTING + "&pageToken=" + urllib.parse.quote(token, safe="")
            if token
            else None
        )
    by_name = {
        source_object["name"]: source_object
        for source_object in objects
        if source_object.get("name", "").startswith("full/raw/")
        and source_object["name"].endswith(".ndjson")
    }
    if len(by_name) != 345 or len(objects) != 345:
        raise DataError("Inventory cardinality mismatch", "invalid_inventory")
    categories = []
    for label in labels:
        key = "full/raw/" + label["source_name"] + ".ndjson"
        if key not in by_name:
            raise DataError("Missing source category", "invalid_inventory")
        metadata = by_name[key]
        if (
            not metadata.get("generation")
            or not metadata.get("size")
            or not metadata.get("md5Hash")
        ):
            raise DataError("Missing source verification metadata", "invalid_inventory")
        categories.append({**metadata, **label})
    result = {
        "source_kind": "quickdraw",
        "categories": categories,
        "registry_sha256": hashlib.sha256(raw).hexdigest(),
    }
    from .common import atomic_bytes

    atomic_bytes(settings.base / "source-registry.txt", raw)
    result["inventory_sha256"] = object_hash(categories)
    atomic_json(settings.base / "labels.json", labels)
    atomic_json(settings.base / "inventory.json", result)
    return result


class _ReverseId(str):
    def __lt__(self, other):
        return str.__gt__(self, other)


def _consume_lines(lines, meta, settings, keep, *, full, stop_at_keep=False):
    if isinstance(keep, bool) or not isinstance(keep, int) or keep < 1:
        raise DataError("Invalid candidate count", "invalid_candidates")
    heap = []
    retained = {}
    counts = Counter()
    md5 = hashlib.md5()
    size = 0
    for line in lines:
        if stop_at_keep and not line.endswith(b"\n"):
            break
        size += len(line)
        md5.update(line)
        counts["source_lines"] += 1
        try:
            record, repairs = clean_record(json.loads(line), meta["source_name"])
        except (ValueError, TypeError, OverflowError, RecursionError, DataError) as exc:
            counts["rejected:" + getattr(exc, "code", "invalid_record")] += 1
            continue
        counts["structurally_valid"] += 1
        counts.update(repairs)
        drawing_id = record["key_id"]
        existing = retained.get(drawing_id)
        if existing is not None:
            content = object_hash(record)
            if content != existing["content_sha256"]:
                counts["conflicting_id"] += 1
                existing["id_conflict"] = True
                if content < existing["content_sha256"]:
                    existing.update(
                        content_sha256=content,
                        record=record,
                        trajectory_hash=trajectory_hash(record),
                    )
            else:
                counts["duplicate_id"] += 1
            continue
        score = priority("select-v1", drawing_id, settings.seed)
        item = (-score, _ReverseId(drawing_id))
        if len(heap) >= keep and (score, drawing_id) >= (-heap[0][0], str(heap[0][1])):
            continue
        if len(heap) >= keep:
            _, removed = heapq.heapreplace(heap, item)
            del retained[str(removed)]
        else:
            heapq.heappush(heap, item)
        content = object_hash(record)
        retained[drawing_id] = {
            "drawing_id": drawing_id,
            "class_id": meta["class_id"],
            "priority_hex": f"{score:064x}",
            "trajectory_hash": trajectory_hash(record),
            "content_sha256": content,
            "id_conflict": False,
            "record": record,
        }
        if stop_at_keep and len(retained) == keep:
            break
    digest = base64.b64encode(md5.digest()).decode("ascii")
    if full:
        if size != int(meta["size"]):
            raise DataError("Source length mismatch", "source_size_mismatch")
        if not meta.get("md5Hash") or digest != meta["md5Hash"]:
            raise DataError("Source checksum mismatch", "source_checksum_mismatch")
        if len(retained) < keep:
            raise DataError("Insufficient eligible records", "insufficient_candidates")
    rows = sorted(
        retained.values(), key=lambda row: (row["priority_hex"], row["drawing_id"])
    )
    return rows, {"source_bytes": size, "source_md5": digest, "counts": dict(counts)}


def sample_full_stream(
    lines: Iterable[bytes], meta: dict, settings: Settings, keep: int | None = None
) -> tuple[list[dict], dict]:
    """Sample a complete source after verifying its byte count and MD5."""
    return _consume_lines(
        lines,
        meta,
        settings,
        keep if keep is not None else settings.spec["candidates"],
        full=True,
    )


def sample_partial_stream(
    lines: Iterable[bytes], meta: dict, settings: Settings, keep: int | None = None
) -> tuple[list[dict], dict]:
    """Sample the first requested number of distinct cleaned source IDs."""
    keep = settings.spec["candidates"] if keep is None else keep
    rows, stats = _consume_lines(
        lines, meta, settings, keep, full=False, stop_at_keep=True
    )
    if len(rows) != keep:
        raise DataError("Insufficient eligible records", "insufficient_candidates")
    stats["source_md5"] = None
    return rows, stats


def save_candidates(
    settings: Settings,
    meta: dict,
    candidates: list[dict],
    stats: dict,
    source_kind: str = "quickdraw",
    complete: bool = True,
    keep: int | None = None,
) -> dict:
    keep = settings.spec["candidates"] if keep is None else keep
    path = candidate_path(settings, meta["class_id"])
    digest = write_jsonl(path, candidates)
    result = {
        **stats,
        "class_id": meta["class_id"],
        "source_name": meta["source_name"],
        "source_kind": source_kind,
        "source_generation": meta.get("generation"),
        "source_bytes": stats.get("source_bytes"),
        "source_md5": stats.get("source_md5"),
        "complete": complete,
        "full_source_verified": bool(complete and source_kind == "quickdraw"),
        "seed": settings.seed,
        "keep": keep,
        "candidate_count": len(candidates),
        "candidate_sha256": digest,
        "candidate_file": path.relative_to(settings.base).as_posix(),
    }
    if source_kind == "quickdraw_partial":
        result.update(profile=settings.profile, sampling_method="prefix-v1")
    atomic_json(receipt_path(settings, meta["class_id"]), result)
    return result


def verify_receipt(settings: Settings, meta: dict) -> dict:
    """Verify candidate bytes and the available source identity evidence."""
    try:
        receipt = read_json(receipt_path(settings, meta["class_id"]))
        path = candidate_path(settings, meta["class_id"])
        keep = receipt["keep"]
        valid_seed = receipt.get("seed") == settings.seed
        if "seed" not in receipt:
            valid_seed = receipt.get("recipe_sha256") == object_hash(
                acquisition_recipe(settings, keep)
            )
        if (
            receipt.get("class_id") != meta["class_id"]
            or receipt.get("source_name", meta["source_name"]) != meta["source_name"]
            or not valid_seed
            or not isinstance(keep, int)
            or isinstance(keep, bool)
            or keep < 1
        ):
            raise ValueError("Receipt identity mismatch")

        digest = hashlib.sha256()
        count = 0
        with path.open("rb") as source:
            for line in source:
                digest.update(line)
                if not line.strip():
                    continue
                row = json.loads(line)
                if (
                    not isinstance(row, dict)
                    or not isinstance(row.get("drawing_id"), str)
                    or row.get("class_id") != meta["class_id"]
                    or not isinstance(row.get("record"), dict)
                    or not isinstance(row.get("trajectory_hash"), str)
                    or not isinstance(row.get("priority_hex"), str)
                ):
                    raise ValueError("Invalid candidate")
                count += 1
        if receipt.get("candidate_sha256") != digest.hexdigest():
            raise ValueError("Receipt identity mismatch")
        if count != receipt.get("candidate_count") or count > keep:
            raise ValueError("Candidate count mismatch")
        if receipt.get("source_kind") == "quickdraw" and receipt.get("complete"):
            if (
                not receipt.get("full_source_verified")
                or receipt.get("source_generation") != meta.get("generation")
                or receipt.get("source_bytes") != int(meta["size"])
                or not meta.get("md5Hash")
                or receipt.get("source_md5") != meta["md5Hash"]
                or count != keep
            ):
                raise ValueError("Source evidence mismatch")
        elif receipt.get("source_kind") == "quickdraw_partial":
            if (
                settings.download_method != "prefix"
                or receipt.get("profile") != settings.profile
                or receipt.get("sampling_method") != "prefix-v1"
                or receipt.get("complete") is not False
                or receipt.get("full_source_verified") is not False
                or receipt.get("source_generation") != meta.get("generation")
                or not isinstance(receipt.get("source_bytes"), int)
                or isinstance(receipt.get("source_bytes"), bool)
                or receipt["source_bytes"] < 1
                or receipt["source_bytes"] > int(meta["size"])
                or receipt.get("source_md5") is not None
                or count != keep
            ):
                raise ValueError("Partial source evidence mismatch")
        elif receipt.get("full_source_verified"):
            raise ValueError("Invalid full source evidence")
        return receipt
    except (OSError, ValueError, TypeError, KeyError, DataError) as exc:
        raise DataError("Invalid candidate receipt", "invalid_receipt") from exc


def _cached(settings, meta, keep, kind, complete, probe_config=None):
    try:
        receipt = verify_receipt(settings, meta)
        return (
            receipt.get("source_kind") == kind
            and receipt.get("complete") is complete
            and receipt.get("keep", 0) >= keep
            and receipt.get("probe_config") == probe_config
        )
    except DataError:
        return False


def probe(
    settings: Settings,
    max_categories: int = 3,
    range_mib: int = 1,
    limit_records: int = 60,
) -> dict:
    """Collect bounded prefix samples without marking any source complete."""
    if (
        settings.profile != "smoke"
        or not 1 <= max_categories <= 10
        or not 1 <= range_mib <= 9
        or not 1 <= limit_records <= 200
    ):
        raise DataError("Invalid probe limits", "invalid_probe")
    inventory_data = read_json(settings.base / "inventory.json")
    categories = inventory_data["categories"]
    names = [
        "circle",
        "line",
        "cat",
        "bicycle",
        "alarm clock",
        "coffee cup",
        "The Eiffel Tower",
        "animal migration",
        "airplane",
        "zigzag",
    ]
    by_name = {entry["source_name"]: entry for entry in categories}
    if len(categories) == 1 and max_categories == 1:
        chosen = categories  # isolated local fixture
    else:
        if any(name not in by_name for name in names):
            raise DataError(
                "Probe category missing from inventory", "invalid_inventory"
            )
        chosen = [by_name[name] for name in names[:max_categories]]
    results = []
    keep = settings.spec["candidates"]
    cap = range_mib * 1024 * 1024
    for meta in chosen:
        config = {
            "range_bytes": cap,
            "limit_records": limit_records,
            "max_categories": max_categories,
        }
        if _cached(settings, meta, keep, "quickdraw_probe", False, config):
            results.append(read_json(receipt_path(settings, meta["class_id"])))
            continue
        end = min(cap, int(meta["size"])) - 1
        request = urllib.request.Request(
            OBJECT
            + urllib.parse.quote(meta["source_name"], safe="")
            + ".ndjson?generation="
            + str(meta["generation"]),
            headers={"Range": f"bytes=0-{end}", "Accept-Encoding": "identity"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 206:
                    raise DataError("Range ignored", "range_ignored")
                expected = f"bytes 0-{end}/{meta['size']}"
                if response.headers.get("Content-Range") != expected:
                    raise DataError("Invalid content range", "invalid_content_range")
                if response.headers.get("x-goog-generation") != str(meta["generation"]):
                    raise DataError("Generation changed", "source_generation_mismatch")
                if response.headers.get("Content-Encoding", "identity") not in (
                    "",
                    "identity",
                ):
                    raise DataError("Unexpected encoding", "content_encoding")
                accepted = []
                usable = 0
                consumed = 0
                digest = hashlib.sha256()
                pending = b""
                while consumed < end + 1 and usable < limit_records:
                    block = response.read(min(4096, end + 1 - consumed))
                    if not block:
                        raise DataError(
                            "Partial range response", "source_size_mismatch"
                        )
                    consumed += len(block)
                    digest.update(block)
                    pending += block
                    lines = pending.split(b"\n")
                    pending = lines.pop()
                    for line in lines:
                        if usable >= limit_records:
                            break
                        line += b"\n"
                        accepted.append(line)
                        try:
                            clean_record(json.loads(line), meta["source_name"])
                            usable += 1
                        except (
                            ValueError,
                            TypeError,
                            OverflowError,
                            RecursionError,
                            DataError,
                        ):
                            pass
                if consumed == int(meta["size"]) and pending and usable < limit_records:
                    accepted.append(pending)
        except DataError:
            raise
        except (OSError, ValueError) as exc:
            raise DataError("Probe request failed", "request_failed") from exc
        candidates, stats = _consume_lines(accepted, meta, settings, keep, full=False)
        stats.pop("source_sha256", None)
        stats.pop("source_md5", None)
        stats.pop("source_crc32c", None)
        stats.update(
            {
                "probe_config": config,
                "requested_range": f"bytes=0-{end}",
                "consumed_range": f"bytes=0-{consumed - 1}",
                "probe_sha256": digest.hexdigest(),
                "probe_consumed_bytes": consumed,
            }
        )
        results.append(
            save_candidates(
                settings, meta, candidates, stats, "quickdraw_probe", False, keep
            )
        )
    return {"source_kind": "quickdraw_probe", "receipts": results}


@contextlib.contextmanager
def _open_source(meta):
    """Open a complete, generation-pinned source with identity encoding."""
    url = (
        OBJECT
        + urllib.parse.quote(meta["source_name"], safe="")
        + ".ndjson?generation="
        + str(meta["generation"])
    )
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 200:
            raise DataError("HTTP status", "http_status")
        if response.headers.get("x-goog-generation") != str(meta["generation"]):
            raise DataError("Generation changed", "source_generation_mismatch")
        if response.headers.get("Content-Encoding", "identity") not in ("", "identity"):
            raise DataError("Unexpected encoding", "content_encoding")
        yield response


def download(
    settings: Settings,
    class_ids: list[int] | None = None,
    candidates: int | None = None,
    concurrency: int = CONCURRENCY,
) -> dict:
    """Download selected generation-pinned classes, resuming verified receipts."""
    if not settings.is_trainable:
        raise DataError("Download requires a trainable profile", "invalid_profile")
    if not 1 <= concurrency <= 3:
        raise DataError("Invalid concurrency", "invalid_concurrency")
    keep = settings.spec["candidates"] if candidates is None else candidates
    if (
        isinstance(keep, bool)
        or not isinstance(keep, int)
        or keep < settings.spec["candidates"]
    ):
        raise DataError("Candidate count too small", "invalid_candidates")
    inventory_path = settings.base / "inventory.json"
    inventory_data = (
        read_json(inventory_path) if inventory_path.exists() else inventory(settings)
    )
    if inventory_data.get("source_kind") != "quickdraw":
        raise DataError("Real inventory required", "invalid_inventory")
    requested = set(class_ids) if class_ids is not None else None
    selected = [
        meta
        for meta in inventory_data["categories"]
        if requested is None or meta["class_id"] in requested
    ]
    if requested is not None and len(selected) != len(requested):
        raise DataError("Unknown class ID", "invalid_class")

    partial = settings.download_method == "prefix"
    kind = "quickdraw_partial" if partial else "quickdraw"

    def download_class(meta):
        try:
            receipt = verify_receipt(settings, meta)
            if (
                receipt.get("source_kind") == kind
                and receipt.get("complete") is (not partial)
                and receipt.get("keep", 0) >= keep
            ):
                return receipt, True
        except DataError:
            pass
        for attempt in range(3):
            try:
                with _open_source(meta) as response:
                    if partial:
                        rows, stats = sample_partial_stream(
                            response, meta, settings, keep
                        )
                    else:
                        rows, stats = sample_full_stream(response, meta, settings, keep)
                return save_candidates(
                    settings, meta, rows, stats, kind, not partial, keep
                ), False
            except (OSError, DataError):
                if attempt == 2:
                    raise
        raise DataError("Download failed", "request_failed")

    total = len(selected)
    progress("download", f"{total} classes from {kind}, concurrency {concurrency}")
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        # Report each class as it finishes so a long resume is visibly progressing.
        completed = zip(selected, pool.map(download_class, selected))
        for index, (meta, (receipt, cached)) in enumerate(completed, start=1):
            results.append(receipt)
            state = "cached" if cached else "sampled"
            progress(
                "download",
                f"{index}/{total} c{meta['class_id']:03d} {meta['source_name']} ({state})",
            )
    return {"source_kind": kind, "receipts": results}
