"""Validate, review, group and split the source canvases."""

import hashlib
import io
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError

from .common import (
    DataError,
    atomic_json,
    atomic_output,
    file_hash,
    iter_jsonl,
    load_step,
    preparation_input_hashes,
    read_json,
    resolve_relative,
    write_jsonl,
)
from .settings import (
    DISCLOSED_TEST_PATHS,
    LABEL_ORDER,
    POLICY_VERSION,
    RECORD_ID,
    SCHEMA_VERSION,
    Settings,
)


def _review(path: Path, ids: set[str]) -> dict[str, dict]:
    reviews = {}
    if not path.exists():
        return reviews
    for row in iter_jsonl(path):
        if not isinstance(row, dict) or row.get("sample_id") not in ids:
            raise DataError("Correction has an unknown sample_id", "invalid_correction")
        sample_id = row["sample_id"]
        if sample_id in reviews:
            raise DataError(
                f"Duplicate correction for {sample_id}", "invalid_correction"
            )
        for key in ("text_present", "number_present"):
            if key in row and row[key] not in ("yes", "no", "uncertain"):
                raise DataError(
                    f"Invalid correction {key} for {sample_id}", "invalid_correction"
                )
        if not row.get("reviewer") or not row.get("reason"):
            raise DataError(
                f"Correction needs reviewer and reason: {sample_id}",
                "invalid_correction",
            )
        reviews[sample_id] = row
    return reviews


def _decode(payload: bytes) -> tuple[bytes, str, bool]:
    with Image.open(io.BytesIO(payload)) as image:
        if image.format != "PNG" or image.mode != "L" or image.size != (512, 512):
            raise ValueError("expected 512x512 grayscale PNG")
        pixels = image.tobytes()
    return pixels, hashlib.sha256(pixels).hexdigest(), len(set(pixels)) == 1


def _bits(payload: bytes) -> list[int]:
    array = np.load(io.BytesIO(payload), allow_pickle=False)
    if (
        not isinstance(array, np.ndarray)
        or array.shape != (76454, 9)
        or array.dtype != np.float32
    ):
        raise ValueError("expected float32 label array [76454,9]")
    classes = array[:, 4:9]
    if (
        not np.isfinite(array).all()
        or not np.isin(classes, (0, 1)).all()
        or not np.all(classes.sum(axis=1) == 1)
    ):
        raise ValueError("invalid one-hot labels or non-finite values")
    return [int(np.any(classes[:, index])) for index in range(1, 5)]


def prepare(settings: Settings) -> dict:
    """Prepare compact images and deterministic grouped manifests."""
    receipt_path = settings.source / "source-receipt.json"
    receipt = read_json(receipt_path)
    input_hashes = preparation_input_hashes(settings.base)
    pairs = list(iter_jsonl(settings.source / "pairs.jsonl"))
    if (
        not isinstance(receipt, dict)
        or receipt.get("profile") != settings.profile
        or receipt.get("record_id") != RECORD_ID
        or receipt.get("in_progress")
        or receipt.get("pair_count") != len(pairs)
    ):
        raise DataError(
            "Source receipt is incomplete or mismatched. Run download again.",
            "invalid_source",
        )
    required = {
        "sample_id",
        "variant",
        "source_archive",
        "source_partition",
        "provenance_folder",
        "png_member",
        "sample_npy_member",
        "label_npy_member",
    }
    if any(
        not isinstance(row, dict)
        or not required.issubset(row)
        or any(not isinstance(row[k], str) or not row[k] for k in required)
        for row in pairs
    ):
        raise DataError("Invalid source pair index", "invalid_source")
    ids = {row["sample_id"] for row in pairs}
    if len(ids) != len(pairs):
        raise DataError("Duplicate sample ID in source pair index", "invalid_source")
    for row in pairs:
        if row["variant"] != "multiclass" or (
            row["source_partition"],
            row["source_archive"],
        ) not in (("train", "multiclass/train.zip"), ("test", "multiclass/test.zip")):
            raise DataError("Unexpected source partition or archive", "invalid_source")
        for key in ("png_member", "sample_npy_member", "label_npy_member"):
            resolve_relative(settings.source, row[key])
    reviews = _review(settings.base / "corrections.jsonl", ids)
    reader = load_step("01-download").open_member_reader(settings.source)
    with reader as read_member:
        records = {}
        excluded = Counter()
        diagnostics = Counter()
        for pair in sorted(pairs, key=lambda row: row["sample_id"]):
            sid = pair["sample_id"]
            review = reviews.get(sid, {})
            try:
                png = read_member(pair["source_archive"], pair["png_member"])
                pixels, pixel_hash, blank = _decode(png)
            except (ValueError, OSError, EOFError, UnidentifiedImageError) as exc:
                excluded["invalid_input"] += 1
                diagnostics[f"invalid:{type(exc).__name__}"] += 1
                continue
            diagnostics["blank"] += int(blank)
            diagnostics["suspect_inverted_polarity"] += int(
                sum(value > 127 for value in pixels) > len(pixels) // 2
            )
            record = {
                "pair": pair,
                "png": png,
                "pixel": pixel_hash,
                "bits": [],
                "targets": [None, None],
                "origins": [],
                "usable": False,
            }
            records[sid] = record
            if review.get("exclusion_reason"):
                excluded["review_exclusion"] += 1
                continue
            try:
                bits = _bits(
                    read_member(pair["source_archive"], pair["label_npy_member"])
                )
                # Check the image-array representation for a bounded representative subset.
                if int(hashlib.sha256(sid.encode()).hexdigest(), 16) % 100 == 0:
                    image_array = np.load(
                        io.BytesIO(
                            read_member(
                                pair["source_archive"], pair["sample_npy_member"]
                            )
                        ),
                        allow_pickle=False,
                    )
                    if image_array.shape not in (
                        (512, 512),
                        (512, 512, 1),
                    ) or not np.array_equal(
                        image_array.reshape(512, 512),
                        np.frombuffer(pixels, dtype=np.uint8).reshape(512, 512),
                    ):
                        diagnostics["sample_array_mismatch"] += 1
                    diagnostics["sample_arrays_checked"] += 1
            except (ValueError, OSError, EOFError, UnidentifiedImageError) as exc:
                excluded["invalid_input"] += 1
                diagnostics[f"invalid:{type(exc).__name__}"] += 1
                continue
            targets, origins = [], []
            for index, key in enumerate(("text_present", "number_present")):
                value = review.get(key)
                if value in ("yes", "no"):
                    targets.append(int(value == "yes"))
                    origins.append("reviewed")
                elif value == "uncertain":
                    targets.append(None)
                    origins.append("review_uncertain")
                else:
                    targets.append(1 if bits[index] else None)
                    origins.append(
                        "encoded_positive" if bits[index] else "unreviewed_proxy"
                    )
            record.update(bits=bits, targets=targets, origins=origins, usable=True)

        parent = {sid: sid for sid in records}

        def find(sid: str) -> str:
            while parent[sid] != sid:
                parent[sid] = parent[parent[sid]]
                sid = parent[sid]
            return sid

        def union(a: str, b: str) -> None:
            a, b = find(a), find(b)
            if a != b:
                parent[max(a, b)] = min(a, b)

        exact = defaultdict(list)
        for sid, record in records.items():
            exact[record["pixel"]].append(sid)
        for members in exact.values():
            for sid in members[1:]:
                union(members[0], sid)
        duplicate_path = settings.base / "duplicate-groups.jsonl"
        if duplicate_path.exists():
            for row in iter_jsonl(duplicate_path):
                members = row.get("sample_ids") if isinstance(row, dict) else None
                if (
                    not isinstance(members, list)
                    or len(members) < 2
                    or len(set(members)) != len(members)
                    or any(sid not in ids for sid in members)
                ):
                    raise DataError(
                        "Invalid verified duplicate group", "invalid_duplicate_group"
                    )
                retained = [sid for sid in members if sid in records]
                for sid in retained[1:]:
                    union(retained[0], sid)
        groups = defaultdict(list)
        for sid in records:
            groups[find(sid)].append(sid)
        selected = []
        for _, members in sorted(groups.items()):
            if any(
                records[sid]["pair"]["source_partition"] == "test"
                and records[sid]["pair"]["png_member"] in DISCLOSED_TEST_PATHS
                for sid in members
            ):
                excluded["disclosed_probe_group"] += len(members)
                continue
            # Conflicts apply to exact pixels, not related but different snapshots.
            pixel_hashes = {records[sid]["pixel"] for sid in members}
            conflict = any(
                any(
                    len(
                        {
                            records[sid]["targets"][head]
                            for sid in exact[pixel]
                            if records[sid]["targets"][head] is not None
                        }
                    )
                    > 1
                    for head in range(2)
                )
                for pixel in pixel_hashes
            )
            if conflict:
                excluded["conflicting_exact_group"] += len(members)
                continue
            has_test = any(
                records[sid]["pair"]["source_partition"] == "test" for sid in members
            )
            eligible = [
                sid
                for sid in members
                if records[sid]["usable"]
                and (not has_test or records[sid]["pair"]["source_partition"] == "test")
            ]
            excluded["cross_source_train"] += sum(
                records[sid]["usable"]
                and has_test
                and records[sid]["pair"]["source_partition"] == "train"
                for sid in members
            )
            by_pixel = defaultdict(list)
            for sid in eligible:
                by_pixel[records[sid]["pixel"]].append(sid)
            group_id = hashlib.sha256("\n".join(sorted(members)).encode()).hexdigest()
            for same in by_pixel.values():
                # Retain the representative’s own label and encoded provenance.
                representative = min(
                    same,
                    key=lambda sid: (
                        -sum(value is not None for value in records[sid]["targets"]),
                        sid,
                    ),
                )
                selected.append(
                    {
                        **records[representative],
                        "sample_id": representative,
                        "group_id": group_id,
                        "test": has_test,
                    }
                )
                excluded["compatible_exact_duplicates"] += len(same) - 1

        train_groups = defaultdict(list)
        for item in selected:
            if not item["test"]:
                train_groups[item["group_id"]].append(item)
        # Allocate groups within provenance/label strata for approximate support balance.
        strata = defaultdict(list)
        for gid, group in train_groups.items():
            key = (group[0]["pair"]["provenance_folder"], tuple(group[0]["targets"]))
            strata[key].append(gid)
        total = len(train_groups)
        quota = min(total - 1, max(1, round(total * 0.2))) if total >= 2 else 0
        allocations = {
            key: int(len(group_ids) * quota / total)
            for key, group_ids in strata.items()
        }
        remaining = quota - sum(allocations.values())
        ranked_strata = sorted(
            strata,
            key=lambda key: (
                -(len(strata[key]) * quota / total - allocations[key]),
                hashlib.sha256(f"{settings.seed}:{key}".encode()).hexdigest(),
            ),
        )
        for key in ranked_strata[:remaining]:
            allocations[key] += 1
        validation = set()
        for key, group_ids in strata.items():
            ranked = sorted(
                group_ids,
                key=lambda gid: hashlib.sha256(
                    f"{settings.seed}:{gid}".encode()
                ).hexdigest(),
            )
            validation.update(ranked[: allocations[key]])
        manifests = {"train": [], "validation": []}
        if any(row["source_partition"] == "test" for row in pairs):
            manifests["test"] = []
        for item in sorted(selected, key=lambda row: row["sample_id"]):
            pair = item["pair"]
            split = (
                "test"
                if item["test"]
                else ("validation" if item["group_id"] in validation else "train")
            )
            image_path = f"images/{item['pixel']}.png"
            target_path = resolve_relative(settings.prepared, image_path)
            with atomic_output(target_path) as output:
                output.write(item["png"])
            manifests[split].append(
                {
                    "sample_id": item["sample_id"],
                    "source_archive": pair["source_archive"],
                    "source_path": pair["png_member"],
                    "provenance_folder": pair["provenance_folder"],
                    "image_path": image_path,
                    "pixel_sha256": item["pixel"],
                    "group_id": item["group_id"],
                    "split": split,
                    "encoded_presence": item["bits"],
                    "text_present": item["targets"][0],
                    "number_present": item["targets"][1],
                    "known_mask": [value is not None for value in item["targets"]],
                    "label_origin": item["origins"],
                    "policy_version": POLICY_VERSION,
                }
            )
        hashes = {}
        counts = {}
        provenance = {}
        for split, rows in manifests.items():
            path = settings.prepared / "manifests" / f"{split}.jsonl"
            relative = path.relative_to(settings.prepared).as_posix()
            hashes[relative] = write_jsonl(path, rows)
            counts[split] = {"rows": len(rows)}
            provenance[split] = {}
            for head in LABEL_ORDER:
                values = Counter(row[f"{head}_present"] for row in rows)
                counts[split][head] = {
                    "positive": values[1],
                    "negative": values[0],
                    "unknown": values[None],
                }
            for folder in sorted({row["provenance_folder"] for row in rows}):
                folder_rows = [
                    row for row in rows if row["provenance_folder"] == folder
                ]
                provenance[split][folder] = {
                    head: {
                        "positive": sum(
                            row[f"{head}_present"] == 1 for row in folder_rows
                        ),
                        "negative": sum(
                            row[f"{head}_present"] == 0 for row in folder_rows
                        ),
                        "unknown": sum(
                            row[f"{head}_present"] is None for row in folder_rows
                        ),
                    }
                    for head in LABEL_ORDER
                }
            for row in rows:
                hashes[row["image_path"]] = file_hash(
                    settings.prepared / row["image_path"]
                )
        labels = {
            "label_order": list(LABEL_ORDER),
            "policy_version": POLICY_VERSION,
            "schema_version": SCHEMA_VERSION,
        }
        summary = {
            "schema_version": SCHEMA_VERSION,
            "profile": settings.profile,
            "seed": settings.seed,
            "label_order": list(LABEL_ORDER),
            "policy_version": POLICY_VERSION,
            "source": receipt,
            "available_splits": list(manifests),
            "counts": counts,
            "hashes": dict(sorted(hashes.items())),
            "input_hashes": input_hashes,
            "exclusions": dict(sorted(excluded.items())),
            "diagnostics": dict(sorted(diagnostics.items())),
            "provenance_counts": provenance,
            "grouping": {
                "method": "exact decoded pixels and explicitly verified transitive groups",
                "groups": len(groups),
                "session_map_available": False,
            },
            "limitations": [
                "No original session map; session independence is unverified.",
                "Near duplicates require manual verification and duplicate-groups.jsonl.",
            ],
        }
        if (
            preparation_input_hashes(settings.base) != input_hashes
            or read_json(receipt_path) != receipt
        ):
            raise DataError(
                "Source or review inputs changed. Run prepare again.", "inputs_changed"
            )
        atomic_json(settings.base / "labels.json", labels)
        atomic_json(settings.base / "dataset-summary.json", summary)
        return summary
