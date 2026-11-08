"""On-demand reader for prepared Referee canvases."""

from pathlib import Path

import numpy as np
from PIL import Image

from .common import DataError, iter_jsonl, load_step, resolve_relative


class IndexedCanvases:
    """Load a manifest and transform one canvas at a time."""

    def __init__(self, prepared: str | Path, split: str) -> None:
        self.prepared = Path(prepared).resolve()
        if split not in ("train", "validation", "test"):
            raise DataError(f"Invalid split: {split}", "invalid_split")
        manifest = self.prepared / "manifests" / f"{split}.jsonl"
        if not manifest.is_file():
            raise DataError(f"Split manifest is absent: {manifest}", "missing_split")
        self.rows = list(iter_jsonl(manifest))

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict:
        if not isinstance(index, int) or index < 0 or index >= len(self.rows):
            raise IndexError(f"Canvas index out of range: {index}")
        row = self.rows[index]
        path = resolve_relative(self.prepared, row["image_path"])
        try:
            with Image.open(path) as image:
                view = load_step("06-images").preprocess(image)
        except (OSError, ValueError) as exc:
            raise DataError(f"Cannot read image: {path}", "invalid_image") from exc
        values = [row["text_present"], row["number_present"]]
        return {
            "image": view["image"],
            "target": np.asarray(
                [v if v is not None else 0 for v in values], dtype=np.float32
            ),
            "known_mask": np.asarray(row["known_mask"], dtype=np.bool_),
            "status": view["status"],
            "metadata": {**row, "diagnostics": view["diagnostics"]},
        }
