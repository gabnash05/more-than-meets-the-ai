"""LightningModule wrapping the agreed timm ViT-Tiny backbone."""

from __future__ import annotations

import math

import lightning as L
import timm
import torch
import torch.nn.functional as F
from torchmetrics.classification import Accuracy


class GuesserViTModule(L.LightningModule):
    def __init__(
        self,
        num_classes: int = 345,
        head_lr: float = 1e-3,
        backbone_lr: float = 1e-4,
        weight_decay: float = 0.01,
        warmup_fraction: float = 0.05,
    ) -> None:
        super().__init__()
        self.save_hyperparameters()

        self.model = timm.create_model(
            "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
            pretrained=True,
            num_classes=num_classes,
        )

        self.val_accuracy = Accuracy(task="multiclass", num_classes=num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.model(x)

    def on_train_epoch_start(self) -> None:
        datamodule = self.trainer.datamodule if self.trainer is not None else None
        train_dataset = getattr(datamodule, "train_dataset", None)
        if train_dataset is not None and hasattr(train_dataset, "set_epoch"):
            train_dataset.set_epoch(self.current_epoch)

    def training_step(self, batch: dict[str, torch.Tensor], batch_idx: int) -> torch.Tensor:
        images, targets = batch["image"], batch["class_id"]
        logits = self(images)
        loss = F.cross_entropy(logits, targets)
        self.log("train_loss", loss, prog_bar=True)
        return loss

    def validation_step(self, batch: dict[str, torch.Tensor], batch_idx: int) -> torch.Tensor:
        images, targets = batch["image"], batch["class_id"]
        logits = self(images)
        loss = F.cross_entropy(logits, targets)
        preds = torch.argmax(logits, dim=1)
        self.val_accuracy.update(preds, targets)
        self.log("val_loss", loss, prog_bar=True, on_step=False, on_epoch=True)
        self.log("val_acc", self.val_accuracy, prog_bar=True, on_step=False, on_epoch=True)
        return loss

    def configure_optimizers(self):
        head_params: list[torch.nn.Parameter] = []
        backbone_params: list[torch.nn.Parameter] = []

        for name, param in self.named_parameters():
            if "head" in name or "fc" in name or "classifier" in name:
                head_params.append(param)
            else:
                backbone_params.append(param)

        if not head_params:
            raise RuntimeError(
                "No classifier head parameters matched; check timm head naming"
            )

        optimizer = torch.optim.AdamW(
            [
                {"params": backbone_params, "lr": self.hparams.backbone_lr},
                {"params": head_params, "lr": self.hparams.head_lr},
            ],
            weight_decay=self.hparams.weight_decay,
        )

        total_steps = int(getattr(self.trainer, "estimated_stepping_batches", 0) or 0)
        if total_steps <= 0:
            return optimizer

        warmup_steps = max(1, int(self.hparams.warmup_fraction * total_steps))

        def lr_lambda(step: int) -> float:
            if step < warmup_steps:
                return float(step + 1) / float(warmup_steps)
            progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
            return 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))

        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)
        return {
            "optimizer": optimizer,
            "lr_scheduler": {
                "scheduler": scheduler,
                "interval": "step",
            },
        }
