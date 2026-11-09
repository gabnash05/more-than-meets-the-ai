"""PyTorch adapters for Referee JSONL manifests and image loading."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import lightning as L
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision.transforms import v2


class RefereeDataset(Dataset):
    """Dataset adapter for Referee JSONL manifests and image splits."""

    def __init__(
        self,
        prepared_dir: str,
        split: str = "train",
        augment: bool = False,
    ) -> None:
        if split not in ("train", "validation", "test"):
            raise ValueError(f"Unsupported training split: {split}")
        self.prepared_dir = Path(prepared_dir)
        self.split = split

        self.manifests_dir = self.prepared_dir / "manifests"
        self.images_dir = self.prepared_dir / "images"

        self.samples = self._load_jsonl()
        self._length = len(self.samples)

        self.augment = (
            v2.Compose(
                [
                    v2.RandomAffine(
                        degrees=10,
                        translate=(0.05, 0.05),
                        scale=(0.9, 1.1),
                    ),
                ]
            )
            if augment
            else None
        )
        
        self.transform = v2.Compose(
            [
                v2.Resize((224, 224)),
                v2.ToImage(),
                v2.ToDtype(torch.float32, scale=True),
            ]
        )

    def _load_jsonl(self) -> list[dict[str, Any]]:
        manifest_path = self.manifests_dir / f"{self.split}.jsonl"
        if not manifest_path.exists():
            return []
        samples = []
        with open(manifest_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    samples.append(json.loads(line))
        return samples

    def __len__(self) -> int:
        return max(1, self._length)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
            if not self.samples:
                image = torch.randn(3, 224, 224)
                if self.augment is not None:
                    image = self.augment(image)
                return {
                    "image": image,
                    "target": torch.zeros(4, dtype=torch.float32),
                }

            sample = self.samples[idx]
            
            # Clean up path by taking just the filename if 'images/' is prefixed in jsonl
            raw_img_path = sample.get("image_path") or sample.get("filename") or f"{idx}.png"
            img_filename = Path(raw_img_path).name
            img_path = self.images_dir / img_filename

            if img_path.exists():
                pil_img = Image.open(img_path).convert("RGB")
                image = self.transform(pil_img)
            else:
                image = torch.randn(3, 224, 224)

            if self.augment is not None:
                image = self.augment(image)

            # Extract multi-label encoded_presence array as a float tensor for BCE loss
            presence = sample.get("encoded_presence", [0, 0, 0, 0])
            target = torch.tensor(presence, dtype=torch.float32)

            return {
                "image": image,
                "target": target,
            }


class RefereeDataModule(L.LightningDataModule):
    """Train/validation DataModule for Referee model training."""

    def __init__(
        self,
        prepared_dir: str,
        batch_size: int = 32,
        num_workers: int = 2,
    ) -> None:
        super().__init__()
        self.prepared_dir = prepared_dir
        self.batch_size = batch_size
        self.num_workers = num_workers
        self.train_dataset: RefereeDataset | None = None
        self.val_dataset: RefereeDataset | None = None

    def setup(self, stage: str | None = None) -> None:
        if stage in (None, "fit"):
            self.train_dataset = RefereeDataset(
                self.prepared_dir,
                split="train",
                augment=True,
            )
            self.val_dataset = RefereeDataset(
                self.prepared_dir,
                split="validation",
                augment=False,
            )

    def _dataloader(self, dataset: RefereeDataset, *, shuffle: bool) -> DataLoader:
        options: dict = {
            "batch_size": self.batch_size,
            "shuffle": shuffle,
            "num_workers": self.num_workers,
            "pin_memory": torch.cuda.is_available(),
        }
        if self.num_workers > 0:
            options["persistent_workers"] = True
            options["prefetch_factor"] = 2
        return DataLoader(dataset, **options)

    def train_dataloader(self) -> DataLoader:
        if self.train_dataset is None:
            self.setup("fit")
        assert self.train_dataset is not None
        return self._dataloader(self.train_dataset, shuffle=True)

    def val_dataloader(self) -> DataLoader:
        if self.val_dataset is None:
            self.setup("fit")
        assert self.val_dataset is not None
        return self._dataloader(self.val_dataset, shuffle=False)