"""Audit prepared data and publish isolated role-specific bundles."""

import hashlib
import json
import os
import zipfile
from pathlib import Path

from PIL import Image

from .common import (
    DataError,
    atomic_json,
    file_hash,
    iter_jsonl,
    load_step,
    object_hash,
    preparation_input_hashes,
    read_json,
    resolve_relative,
)
from .settings import (
    LABEL_ORDER,
    PACKAGE_ROOT,
    POLICY_VERSION,
    SCHEMA_VERSION,
    SPLITS,
    Settings,
)


def _fail(message: str) -> None:
    raise DataError(message, "audit_failed")


def _package_files(root: Path, referee: bool) -> list[Path]:
    names = ("README.md", "RUNBOOK.md", "pyproject.toml", ".python-version")
    if referee:
        names += ("uv.lock",)
    files = [root / name for name in names]
    if referee:
        files.append(root / "referee-data.ps1")
    files.extend(sorted((root / "src").glob("*.py")))
    if not referee:
        files.extend(sorted((root / "src" / "resources").glob("*.txt")))
        files.extend(sorted((root / "src" / "resources").glob("*.json")))
    missing = [str(path) for path in files if not path.is_file()]
    if missing:
        _fail(f"Required package files missing: {missing}")
    return files


def audit(settings: Settings) -> dict:
    summary = read_json(settings.base / "dataset-summary.json")
    labels = read_json(settings.base / "labels.json")
    expected_labels = {
        "label_order": list(LABEL_ORDER),
        "policy_version": POLICY_VERSION,
        "schema_version": SCHEMA_VERSION,
    }
    if (
        labels != expected_labels
        or summary.get("profile") != settings.profile
        or summary.get("seed") != settings.seed
        or summary.get("label_order") != list(LABEL_ORDER)
        or summary.get("policy_version") != POLICY_VERSION
        or summary.get("schema_version") != SCHEMA_VERSION
    ):
        _fail("Summary or labels do not match the configured dataset")
    splits = summary.get("available_splits")
    if (
        not isinstance(splits, list)
        or splits != [s for s in SPLITS if s in splits]
        or not {"train", "validation"}.issubset(splits)
    ):
        _fail("Invalid available splits")
    receipt = read_json(settings.source / "source-receipt.json")
    if summary.get("source") != receipt:
        _fail("Source receipt changed since preparation")
    if summary.get("input_hashes") != preparation_input_hashes(settings.base):
        _fail("Source or review inputs changed. Run prepare again.")
    pairs = {
        row["sample_id"]: row for row in iter_jsonl(settings.source / "pairs.jsonl")
    }
    recorded_hashes = summary.get("hashes", {})
    rows_by_split = {}
    expected_paths = set()
    seen_ids, seen_groups, seen_pixels = {}, {}, {}
    support = {}
    statuses = {}
    preprocess = load_step("06-images").preprocess
    for split in splits:
        manifest_rel = f"manifests/{split}.jsonl"
        manifest = resolve_relative(settings.prepared, manifest_rel)
        expected_paths.add(manifest_rel)
        rows = list(iter_jsonl(manifest))
        rows_by_split[split] = rows
        counts = {
            "rows": len(rows),
            "text": {"positive": 0, "negative": 0, "unknown": 0},
            "number": {"positive": 0, "negative": 0, "unknown": 0},
        }
        usable = {
            head: {"positive": 0, "negative": 0, "unknown": 0} for head in LABEL_ORDER
        }
        statuses[split] = {"ok": 0, "blank": 0, "uncertain": 0}
        for row in rows:
            required = (
                "sample_id",
                "source_archive",
                "source_path",
                "provenance_folder",
                "image_path",
                "pixel_sha256",
                "group_id",
                "split",
                "encoded_presence",
                "text_present",
                "number_present",
                "known_mask",
                "label_origin",
                "policy_version",
            )
            if (
                not isinstance(row, dict)
                or any(k not in row for k in required)
                or row["split"] != split
                or row["policy_version"] != POLICY_VERSION
            ):
                _fail(f"Invalid manifest row in {split}")
            for key, seen in (
                ("sample_id", seen_ids),
                ("group_id", seen_groups),
                ("pixel_sha256", seen_pixels),
            ):
                value = row[key]
                if (
                    not isinstance(value, str)
                    or not value
                    or (
                        value in seen
                        and (
                            key in ("sample_id", "pixel_sha256") or seen[value] != split
                        )
                    )
                ):
                    _fail(f"Duplicate or cross-split {key}: {value}")
                seen[value] = split
            source_pair = pairs.get(row["sample_id"])
            expected_partition = "test" if split == "test" else "train"
            if source_pair is None or (
                source_pair["source_partition"] != expected_partition
                or source_pair["source_archive"] != row["source_archive"]
                or source_pair["png_member"] != row["source_path"]
                or source_pair["provenance_folder"] != row["provenance_folder"]
            ):
                _fail(f"Source pair mismatch for {row['sample_id']}")
            rel = row["image_path"]
            if (
                not isinstance(rel, str)
                or not rel.startswith("images/")
                or not rel.endswith(".png")
            ):
                _fail("Invalid image path")
            path = resolve_relative(settings.prepared, rel)
            expected_paths.add(rel)
            try:
                with Image.open(path) as image:
                    if (
                        image.format != "PNG"
                        or image.mode != "L"
                        or image.size != (512, 512)
                    ):
                        _fail(f"Invalid PNG dimensions or mode: {rel}")
                    if (
                        hashlib.sha256(image.tobytes()).hexdigest()
                        != row["pixel_sha256"]
                    ):
                        _fail(f"Pixel hash mismatch: {rel}")
                    try:
                        status = preprocess(image)["status"]
                    except (OSError, ValueError) as exc:
                        raise DataError(
                            f"Cannot read image: {path}", "invalid_image"
                        ) from exc
            except OSError as exc:
                raise DataError(f"Cannot decode {rel}", "audit_failed") from exc
            values = [row["text_present"], row["number_present"]]
            mask, origins, encoded = (
                row["known_mask"],
                row["label_origin"],
                row["encoded_presence"],
            )
            if (
                not isinstance(mask, list)
                or len(mask) != 2
                or any(type(v) is not bool for v in mask)
                or not isinstance(origins, list)
                or len(origins) != 2
                or not isinstance(encoded, list)
                or len(encoded) != 4
                or any(type(v) is not int or v not in (0, 1) for v in encoded)
            ):
                _fail("Invalid mask, origins or encoded bits")
            for i, head in enumerate(LABEL_ORDER):
                value, origin = values[i], origins[i]
                if value is not None and (
                    type(value) is not int or value not in (0, 1)
                ):
                    _fail("Invalid target")
                if mask[i] != (value is not None) or origin not in (
                    "reviewed",
                    "encoded_positive",
                    "unreviewed_proxy",
                    "review_uncertain",
                ):
                    _fail("Inconsistent mask or origin")
                if (
                    (origin == "encoded_positive" and (value != 1 or encoded[i] != 1))
                    or (
                        origin in ("unreviewed_proxy", "review_uncertain")
                        and value is not None
                    )
                    or (origin == "reviewed" and value is None)
                ):
                    _fail("Inconsistent target origin")
                category = (
                    "unknown" if value is None else "positive" if value else "negative"
                )
                counts[head][category] += 1
                if status == "ok":
                    usable[head][category] += 1
            if status not in statuses[split]:
                _fail("Unexpected preprocessing status")
            statuses[split][status] += 1
        if summary.get("counts", {}).get(split) != counts:
            _fail(f"Count mismatch for {split}")
        support[split] = usable
    if set(recorded_hashes) != expected_paths:
        _fail("Prepared hash inventory does not match manifests")
    for rel in sorted(expected_paths):
        if file_hash(resolve_relative(settings.prepared, rel)) != recorded_hashes[rel]:
            _fail(f"File hash mismatch: {rel}")
    from guesser_data.common import load_step as guesser_step

    config_hash = guesser_step("06-images").candidate_hash("foreground")
    guesser = PACKAGE_ROOT.parents[1] / "guesser" / "data"
    package_files = _package_files(guesser, False)
    fingerprint = object_hash(
        {
            p.relative_to(guesser).as_posix(): file_hash(p)
            for p in package_files
            if p.suffix != ".md"
        }
    )
    identity = {
        "profile": settings.profile,
        "seed": settings.seed,
        "schema_version": SCHEMA_VERSION,
        "policy_version": POLICY_VERSION,
        "source_record_id": receipt.get("record_id"),
        "hashes": recorded_hashes,
        "preprocessing_config_hash": config_hash,
        "preprocessing_source_fingerprint": fingerprint,
    }
    ready = (
        settings.profile == "train"
        and receipt.get("source_kind") == "atypict_range_multiclass"
        and receipt.get("complete") is True
        and all(
            support[s][h][v] > 0
            for s in ("train", "validation")
            for h in LABEL_ORDER
            for v in ("positive", "negative")
        )
    )
    return {
        "dataset_id": object_hash(identity),
        "rows": rows_by_split,
        "support": support,
        "statuses": statuses,
        "config_hash": config_hash,
        "fingerprint": fingerprint,
        "trainer_ready": ready,
        "source": receipt,
        "summary": summary,
    }


def export_dataset(settings: Settings) -> dict:
    result = audit(settings)
    settings.exports.mkdir(parents=True, exist_ok=True)
    referee = PACKAGE_ROOT
    guesser = PACKAGE_ROOT.parents[1] / "guesser" / "data"
    referee_files = _package_files(referee, True)
    guesser_files = _package_files(guesser, False)
    checksums = {}
    for role, desired in (
        ("trainer", ("train", "validation")),
        ("held-out-test", ("test",)),
    ):
        splits = [s for s in desired if s in result["rows"]]
        if not splits:
            continue
        output = settings.exports / f"{role}-{settings.profile}.zip"
        temporary = output.with_suffix(".zip.part")
        source = result["source"]
        role_summary = {
            "dataset_id": result["dataset_id"],
            "role": role,
            "profile": settings.profile,
            "seed": settings.seed,
            "schema_version": SCHEMA_VERSION,
            "policy_version": POLICY_VERSION,
            "label_order": list(LABEL_ORDER),
            "source": {
                k: source.get(k)
                for k in (
                    "record_id",
                    "source_kind",
                    "complete",
                    "full_source_verified",
                    "response_bytes",
                )
            },
            "preprocessing_config_hash": result["config_hash"],
            "preprocessing_source_fingerprint": result["fingerprint"],
            "trainer_ready": result["trainer_ready"] if role == "trainer" else False,
            "smoke_only": not result["trainer_ready"],
            "splits": splits,
            "counts": {s: result["summary"]["counts"][s] for s in splits},
            "usable_support": {s: result["support"][s] for s in splits},
            "statuses": {s: result["statuses"][s] for s in splits},
            "hashes": {},
            "limitations": [
                "No trustworthy source session map; residual session leakage is possible.",
                "ATYPICT drawings do not contain game replay history.",
            ],
            "attribution": {
                "dataset": "ATYPICT (DrawMon)",
                "source": "https://doi.org/10.5281/zenodo.7330402",
                "license": "CC BY 4.0",
                "changes": "Selected PNGs, derived writing presence labels and grouped splits.",
            },
        }
        paths = set()
        for split in splits:
            paths.add(f"manifests/{split}.jsonl")
            paths.update(row["image_path"] for row in result["rows"][split])
        role_summary["hashes"] = {
            p: result["summary"]["hashes"][p] for p in sorted(paths)
        }
        try:
            with zipfile.ZipFile(
                temporary, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True
            ) as archive:
                archive.write(settings.base / "labels.json", "labels.json")
                archive.writestr(
                    "START-HERE.md",
                    "# Referee prepared data\n\n"
                    f"Available splits: {', '.join(splits)}. "
                    "See dataset-summary.json for coverage and smoke status.\n\n"
                    "Verify the ZIP SHA-256 against checksums.json before extracting. "
                    "From the extracted folder, run "
                    "uv sync --project models/referee/data --frozen.\n\n"
                    "    from referee_data import IndexedCanvases\n"
                    f'    sample = IndexedCanvases("prepared", "{splits[0]}")[0]\n\n'
                    "Use image when status is ok. The target and known_mask are ordered "
                    "[text, number]. The image is already normalized.\n",
                )
                archive.writestr(
                    "dataset-summary.json",
                    json.dumps(role_summary, indent=2, sort_keys=True) + "\n",
                )
                for rel in sorted(paths):
                    archive.write(
                        resolve_relative(settings.prepared, rel), f"prepared/{rel}"
                    )
                for root, files, prefix in (
                    (referee, referee_files, "models/referee/data"),
                    (guesser, guesser_files, "models/guesser/data"),
                ):
                    for path in files:
                        archive.write(
                            path, f"{prefix}/{path.relative_to(root).as_posix()}"
                        )
            with zipfile.ZipFile(temporary) as archive:
                if archive.testzip() is not None:
                    _fail("Archive verification failed")
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
        checksums[role] = {"file": output.name, "sha256": file_hash(output)}
    atomic_json(settings.exports / "checksums.json", checksums)
    return checksums
