"""Independently audit prepared Referee manifests and canvas images."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import cast

import numpy as np
from PIL import Image

SPLITS = ("train", "validation", "test")
LABEL_ORDER = ("text", "number")
ENCODED_ORDER = ("text", "number", "symbol", "circle")
POLICY_VERSION = "separate-writing-advisories-v2"
ORIGINS = {"reviewed", "encoded_positive", "encoded_negative", "review_uncertain"}


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read valid JSON from {path}") from exc


def _require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _validate_header(prepared: Path) -> tuple[dict, dict]:
    base = prepared.parent
    summary = _read_json(base / "dataset-summary.json")
    labels = _read_json(base / "labels.json")
    _require(isinstance(summary, dict), "dataset-summary.json must be an object")
    _require(isinstance(labels, dict), "labels.json must be an object")
    summary = cast(dict, summary)
    labels = cast(dict, labels)
    _require(summary.get("profile") in {"sample", "train"}, "Invalid dataset profile")
    _require(summary.get("label_order") == list(LABEL_ORDER), "Invalid summary label order")
    _require(labels.get("label_order") == list(LABEL_ORDER), "Invalid label order")
    _require(
        summary.get("policy_version") == POLICY_VERSION
        and labels.get("policy_version") == POLICY_VERSION,
        "Invalid policy version",
    )
    available = summary.get("available_splits")
    _require(
        isinstance(available, list) and available and set(available) <= set(SPLITS),
        "Invalid available splits",
    )
    return summary, labels


def _validate_row(row: dict, split: str) -> None:
    required = (
        "sample_id", "source_archive", "source_path", "provenance_folder",
        "image_path", "pixel_sha256", "group_id", "split",
        "encoded_presence", "text_present", "number_present", "known_mask",
        "label_origin", "policy_version",
    )
    _require(isinstance(row, dict), "Manifest row must be an object")
    _require(all(key in row for key in required), "Manifest row is missing fields")
    _require(row["split"] == split, f"Manifest row has the wrong split: {split}")
    _require(row["policy_version"] == POLICY_VERSION, "Manifest row has the wrong policy")
    _require(isinstance(row["sample_id"], str) and row["sample_id"], "Invalid sample ID")
    _require(isinstance(row["group_id"], str) and row["group_id"], "Invalid group ID")

    encoded = row["encoded_presence"]
    _require(
        isinstance(encoded, list)
        and len(encoded) == 4
        and all(type(value) is int and value in (0, 1) for value in encoded),
        "Invalid encoded_presence",
    )

    mask = row["known_mask"]
    origins = row["label_origin"]
    _require(
        isinstance(mask, list)
        and len(mask) == 2
        and all(type(value) is bool for value in mask),
        "Invalid known_mask",
    )
    _require(
        isinstance(origins, list)
        and len(origins) == 2
        and all(origin in ORIGINS for origin in origins),
        "Invalid label_origin",
    )

    values = (row["text_present"], row["number_present"])
    for index, (value, known, origin) in enumerate(zip(values, mask, origins)):
        _require(
            value is None or (type(value) is int and value in (0, 1)),
            f"Invalid target at channel {index}",
        )
        _require(known == (value is not None), "known_mask disagrees with target")
        if origin == "reviewed":
            _require(value is not None, "Reviewed target must be known")
        elif origin == "encoded_positive":
            _require(value == 1 and encoded[index] == 1, "Encoded positive is inconsistent")
        elif origin == "encoded_negative":
            _require(value == 0 and encoded[index] == 0, "Encoded negative is inconsistent")
        else:
            _require(value is None, "Unknown target must be null")

    image_path = row["image_path"]
    _require(isinstance(image_path, str) and image_path, "Invalid image path")
    pure = PurePosixPath(image_path)
    _require(
        not pure.is_absolute()
        and ".." not in pure.parts
        and pure.parts
        and pure.parts[0] == "images",
        "Invalid image path",
    )


def _audit_image(prepared: Path, row: dict, verify_images: bool) -> bool:
    path = (prepared / row["image_path"]).resolve()
    _require(prepared in path.parents, "Invalid image path")
    _require(path.is_file(), f"Missing image: {row['image_path']}")
    if not verify_images:
        return True

    with Image.open(path) as image:
        pixels = np.asarray(image.convert("L"), dtype=np.uint8)
    _require(pixels.shape == (512, 512), f"Unexpected image shape: {path.name}")
    digest = hashlib.sha256(pixels.tobytes()).hexdigest()
    _require(path.stem == row["pixel_sha256"], "Image filename hash mismatch")
    _require(digest == row["pixel_sha256"], "Image pixel hash mismatch")
    return True


def audit_prepared(prepared: str | Path, *, verify_images: bool = True) -> dict:
    """Validate manifests, label schema, image hashes and split isolation.

    The audit reads only the prepared tree. It does not load a model, tune
    thresholds or inspect the held-out test predictions.
    """
    prepared = Path(prepared).expanduser().resolve()
    _require(prepared.name == "prepared", "Pass the prepared/ directory")
    summary, _labels = _validate_header(prepared)
    available = summary["available_splits"]

    seen_sample: dict[str, str] = {}
    seen_group: dict[str, str] = {}
    seen_pixel: dict[str, str] = {}
    report_splits: dict[str, dict] = {}
    totals = {
        "rows": 0,
        "images_ok": 0,
        "missing_images": 0,
    }

    for split in available:
        manifest_path = prepared / "manifests" / f"{split}.jsonl"
        _require(manifest_path.is_file(), f"Missing {split} manifest")
        rows = [
            json.loads(line)
            for line in manifest_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        labels = {
            head: {"known": 0, "positive": 0, "negative": 0, "unknown": 0}
            for head in LABEL_ORDER
        }
        origins: Counter[str] = Counter()
        images_ok = 0

        for row in rows:
            _validate_row(row, split)
            sample_id = row["sample_id"]
            group_id = row["group_id"]
            pixel = row["pixel_sha256"]

            _require(sample_id not in seen_sample, f"Duplicate sample ID: {sample_id}")
            seen_sample[sample_id] = split
            if group_id in seen_group:
                _require(
                    seen_group[group_id] == split,
                    f"Group leaks across splits: {group_id}",
                )
            else:
                seen_group[group_id] = split
            if pixel in seen_pixel:
                _require(
                    seen_pixel[pixel] == split,
                    f"Pixel hash leaks across splits: {pixel}",
                )
            else:
                seen_pixel[pixel] = split

            if _audit_image(prepared, row, verify_images):
                images_ok += 1
            for index, head in enumerate(LABEL_ORDER):
                origin = row["label_origin"][index]
                value = (row["text_present"], row["number_present"])[index]
                origins[origin] += 1
                if value is None:
                    labels[head]["unknown"] += 1
                else:
                    labels[head]["known"] += 1
                    labels[head]["positive" if value == 1 else "negative"] += 1

        recorded = summary.get("counts", {}).get(split, {}).get("rows")
        if recorded is not None:
            _require(recorded == len(rows), f"Row count mismatch for {split}")

        report_splits[split] = {
            "rows": len(rows),
            "images_ok": images_ok,
            "missing_images": len(rows) - images_ok,
            "labels": labels,
            "origins": dict(sorted(origins.items())),
        }
        totals["rows"] += len(rows)
        totals["images_ok"] += images_ok
        totals["missing_images"] += len(rows) - images_ok

    return {
        "schema": "referee-dataset-audit-v1",
        "prepared": str(prepared),
        "profile": summary.get("profile"),
        "splits": report_splits,
        "totals": totals,
        "warnings": [
            "Encoded ATYPICT bits are proxies; they are not reviewed game labels.",
            "No original-session map exists; session independence is unverified.",
        ],
        "limits": [
            "Manifest and image audit only; no model metrics are computed.",
            "The held-out test split must not guide model or threshold choices.",
        ],
    }
