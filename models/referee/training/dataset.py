"""Strict adapters for prepared Referee manifests."""

from __future__ import annotations

import json
from pathlib import Path

import lightning as L
import torch
from PIL import Image
from referee_data import preprocess, preprocessing_config
from torch.utils.data import DataLoader, Dataset


class RefereeDataset(Dataset):
    """Load supervised rows; unknown labels never become negatives."""

    def __init__(
        self, prepared_dir: str, split: str = "train", augment: bool = False
    ) -> None:
        if split not in ("train", "validation", "test"):
            raise ValueError(f"Unsupported split: {split}")
        self.prepared_dir = Path(prepared_dir).resolve()
        self.samples = []
        self.excluded = {"unknown": [], "blank": [], "uncertain": []}
        manifest = self.prepared_dir / "manifests" / f"{split}.jsonl"
        with manifest.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                row = json.loads(line)
                mask = row["known_mask"]
                values = [row["text_present"], row["number_present"]]
                if (
                    not isinstance(mask, list)
                    or len(mask) != 2
                    or any(type(x) is not bool for x in mask)
                    or any(
                        (
                            (type(v) is not int or v not in (0, 1))
                            if known
                            else v is not None
                        )
                        for v, known in zip(values, mask)
                    )
                ):
                    raise ValueError(f"Invalid labels at {manifest}:{line_number}")
                path = (self.prepared_dir / row["image_path"]).resolve()
                if self.prepared_dir not in path.parents or not path.is_file():
                    raise FileNotFoundError(f"Invalid image path: {path}")
                # Decode every image, including unknown rows, so corrupt inputs fail closed.
                with Image.open(path) as image:
                    image.verify()
                sample_id = row.get("sample_id", f"{split}:{line_number}")
                if any(mask):
                    with Image.open(path) as image:
                        view = preprocess(image)
                    if view["status"] == "ok" and view["image"] is not None:
                        self.samples.append((path, values, mask))
                    elif view["status"] in ("blank", "uncertain"):
                        self.excluded[view["status"]].append(sample_id)
                    else:
                        raise ValueError(
                            f"Invalid preprocessing status for {path}: {view['status']}"
                        )
                else:
                    self.excluded["unknown"].append(sample_id)
        if not self.samples:
            raise ValueError(f"No supervised samples in {manifest}")
        self.augment = augment

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        path, values, mask = self.samples[index]
        with Image.open(path) as image:
            view = preprocess(image)
        if view["status"] != "ok" or view["image"] is None:
            raise ValueError(f"Image cannot be preprocessed ({view['status']}): {path}")
        image = torch.as_tensor(view["image"], dtype=torch.float32)
        if self.augment:
            from torchvision.transforms import v2

            settings = preprocessing_config()["foreground"]
            white = (1.0 - settings["mean"]) / settings["std"]
            image = v2.RandomAffine(
                degrees=10, translate=(0.05, 0.05), scale=(0.9, 1.1), fill=white
            )(image)
        return {
            "image": image,
            "target": torch.tensor(
                [v if k else 0 for v, k in zip(values, mask)], dtype=torch.float32
            ),
            "known_mask": torch.tensor(mask, dtype=torch.bool),
        }


class RefereeDataModule(L.LightningDataModule):
    def __init__(
        self, prepared_dir: str, batch_size: int = 32, num_workers: int = 2
    ) -> None:
        super().__init__()
        self.prepared_dir, self.batch_size, self.num_workers = (
            prepared_dir,
            batch_size,
            num_workers,
        )
        self.train_dataset = self.val_dataset = None

    def setup(self, stage: str | None = None) -> None:
        if stage in (None, "fit"):
            self.train_dataset = RefereeDataset(
                self.prepared_dir, "train", augment=True
            )
            self.val_dataset = RefereeDataset(self.prepared_dir, "validation")

    def _dataloader(self, dataset: RefereeDataset, *, shuffle: bool) -> DataLoader:
        return DataLoader(
            dataset,
            batch_size=self.batch_size,
            shuffle=shuffle,
            num_workers=self.num_workers,
            pin_memory=torch.cuda.is_available(),
            persistent_workers=self.num_workers > 0,
        )

    def train_dataloader(self) -> DataLoader:
        if self.train_dataset is None:
            self.setup("fit")
        return self._dataloader(self.train_dataset, shuffle=True)

    def val_dataloader(self) -> DataLoader:
        if self.val_dataset is None:
            self.setup("fit")
        return self._dataloader(self.val_dataset, shuffle=False)
