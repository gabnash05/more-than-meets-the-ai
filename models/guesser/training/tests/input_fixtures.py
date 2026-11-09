"""Shared synthetic prepared data; never reads or downloads production payloads."""

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def prepare_drawings(root: Path, count: int = 4) -> Path:
    """Create distinct train/validation originals with causal timestamp geometry."""
    prepared = root / "prepared"
    (prepared / "manifests").mkdir(parents=True)
    for split in ("train", "validation"):
        rows = []
        source = prepared / f"{split}.jsonl"
        with source.open("wb") as handle:
            for index in range(count):
                identity = f"{split}-{index}"
                record = {
                    "key_id": identity,
                    "drawing": [
                        [[0, 40, 90, 130], [0, 80, 20, 110], [0, 100, 200, 300]],
                        [[20, 100], [100, 40], [310, 400]],
                    ],
                }
                raw = (json.dumps(record) + "\n").encode()
                rows.append(
                    {
                        "record_file": source.name,
                        "byte_offset": handle.tell(),
                        "byte_length": len(raw),
                        "drawing_id": identity,
                        "group_id": identity,
                        "class_id": index % 4,
                        "split": split,
                    }
                )
                handle.write(raw)
        pq.write_table(
            pa.Table.from_pylist(rows), prepared / "manifests" / f"{split}.parquet"
        )
    return prepared
