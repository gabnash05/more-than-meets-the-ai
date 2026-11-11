"""LightningModule wrapping the agreed timm ViT-Tiny backbone for Referee."""

from __future__ import annotations

import math

import lightning as L
import timm
import torch
import torch.nn.functional as F
from torchmetrics.classification import BinaryAveragePrecision


class RefereeViTModule(L.LightningModule):
    def __init__(
        self,
        num_classes: int = 2,
        head_lr: float = 1e-3,
        backbone_lr: float = 1e-4,
        weight_decay: float = 0.01,
        warmup_fraction: float = 0.05,
        pretrained: bool = True,
        provenance: dict | None = None,
    ) -> None:
        super().__init__()
        self.save_hyperparameters()

        self.model = timm.create_model(
            "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
            pretrained=pretrained,
            num_classes=num_classes,
        )

        self.val_ap_text = BinaryAveragePrecision()
        self.val_ap_number = BinaryAveragePrecision()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.model(x)

    def on_train_epoch_start(self) -> None:
        datamodule = self.trainer.datamodule if self.trainer is not None else None
        train_dataset = getattr(datamodule, "train_dataset", None)
        if train_dataset is not None and hasattr(train_dataset, "set_epoch"):
            train_dataset.set_epoch(self.current_epoch)

    @staticmethod
    def masked_loss(
        logits: torch.Tensor, targets: torch.Tensor, mask: torch.Tensor
    ) -> torch.Tensor | None:
        if (
            logits.ndim != 2
            or logits.shape[1] != 2
            or targets.shape != logits.shape
            or mask.shape != logits.shape
        ):
            raise ValueError(
                "Expected matching [batch, 2] logits, targets and known mask"
            )
        if not torch.isfinite(logits).all() or not torch.isfinite(targets).all():
            raise ValueError("Nonfinite logits or targets")
        if not torch.all((mask == 0) | (mask == 1)):
            raise ValueError("Known mask must be binary")
        if not torch.all((targets == 0) | (targets == 1)):
            raise ValueError("Targets must be binary")
        mask = mask.bool()
        if not mask.any():
            return None
        return (
            F.binary_cross_entropy_with_logits(
                logits[mask], targets[mask], reduction="sum"
            )
            / mask.sum()
        )

    def training_step(
        self, batch: dict[str, torch.Tensor], batch_idx: int
    ) -> torch.Tensor | None:
        loss = self.masked_loss(
            self(batch["image"]), batch["target"], batch["known_mask"]
        )
        if loss is not None:
            self.log("train_loss", loss, prog_bar=True)
        return loss

    def validation_step(self, batch: dict[str, torch.Tensor], batch_idx: int) -> None:
        logits = self(batch["image"])
        targets, mask = batch["target"], batch["known_mask"].bool()
        loss = self.masked_loss(logits, targets, mask)
        if loss is not None:
            self.log("val_loss", loss, on_step=False, on_epoch=True)
        probabilities = torch.sigmoid(logits)
        for index, metric in enumerate((self.val_ap_text, self.val_ap_number)):
            known = mask[:, index]
            if known.any():
                metric.update(probabilities[known, index], targets[known, index].long())
                self._val_positive[index] += int(targets[known, index].sum())
                self._val_negative[index] += int(
                    known.sum() - targets[known, index].sum()
                )

    def on_validation_epoch_start(self) -> None:
        self._val_positive = [0, 0]
        self._val_negative = [0, 0]

    def on_validation_epoch_end(self) -> None:
        values = []
        for index, (name, metric) in enumerate(
            (("text", self.val_ap_text), ("number", self.val_ap_number))
        ):
            if self._val_positive[index] and self._val_negative[index]:
                value = metric.compute()
                self.log(f"val_ap_{name}", value, prog_bar=True)
                values.append(value)
            metric.reset()
        if len(values) == 2:
            self.log("val_mean_ap", torch.stack(values).mean(), prog_bar=True)

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
