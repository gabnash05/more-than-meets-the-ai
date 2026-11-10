"""Referee evaluation dataset with explicit preprocessing candidates."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from referee_data.common import load_step
from torch.utils.data import Dataset
from torchvision.transforms import v2

ENCODED_ORDER = ("text", "number", "symbol", "circle")
LABEL_ORDER = ("text", "number")
PREPROCESSORS = ("foreground", "rgb_resize")


class RefereeEvaluationDataset(Dataset):
    """Read one prepared split and return tensors or an explicit blank status."""

    def __init__(self, prepared: str | Path, split: str, preprocessing: str) -> None:
        if split not in {"train", "validation", "test"}:
            raise ValueError(f"Unknown split: {split}")
        if preprocessing not in PREPROCESSORS:
            raise ValueError(f"Unknown preprocessing: {preprocessing}")
        self.prepared = Path(prepared).resolve()
        self.preprocessing = preprocessing
        manifest = self.prepared / "manifests" / f"{split}.jsonl"
        self.rows = [
            json.loads(line)
            for line in manifest.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.rgb = v2.Compose(
            [
                v2.Resize((224, 224)),
                v2.ToImage(),
                v2.ToDtype(torch.float32, scale=True),
            ]
        )

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict:
        row = self.rows[index]
        path = (self.prepared / row["image_path"]).resolve()
        if self.prepared not in path.parents:
            raise ValueError("Image path escapes the prepared directory")
        if not path.is_file():
            raise FileNotFoundError(path)

        with Image.open(path) as image:
            if self.preprocessing == "foreground":
                view = load_step("06-images").preprocess(image)
                status = view["status"]
                image_tensor = (
                    None
                    if view["image"] is None
                    else torch.from_numpy(view["image"]).float()
                )
            else:
                status = "ok"
                image_tensor = self.rgb(image.convert("RGB"))

        values = [row["text_present"], row["number_present"]]
        return {
            "sample_id": row["sample_id"],
            "image": image_tensor,
            "status": status,
            "encoded": torch.tensor(row["encoded_presence"], dtype=torch.float32),
            "labels": torch.tensor(
                [np.nan if value is None else float(value) for value in values],
                dtype=torch.float32,
            ),
            "known": torch.tensor(row["known_mask"], dtype=torch.bool),
            "origins": tuple(row["label_origin"]),
        }
