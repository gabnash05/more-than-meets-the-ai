"""Matched-budget Referee fine-tunes with clean checkpointing and logging."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import lightning as L
import torch
from lightning.pytorch.callbacks import (
    EarlyStopping,
    LearningRateMonitor,
    ModelCheckpoint,
)
from lightning.pytorch.loggers import CSVLogger

try:
    from .dataset import RefereeDataModule
    from .module import RefereeViTModule
except ImportError:
    from dataset import RefereeDataModule
    from module import RefereeViTModule

SEED = 198173
DEFAULT_PREPARED = (
    Path(__file__).resolve().parents[1]
    / "data"
    / ".local"
    / "data"
    / "sample"
    / "prepared"
)
DEFAULT_CHECKPOINT_ROOT = Path(__file__).resolve().parents[1] / "checkpoints"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fine-tune Referee ViT-Tiny.")
    parser.add_argument(
        "--prepared-dir",
        type=Path,
        default=DEFAULT_PREPARED,
        help="Path to prepared/ with train and validation manifests.",
    )
    parser.add_argument(
        "--checkpoint-root",
        type=Path,
        default=DEFAULT_CHECKPOINT_ROOT,
        help="Directory for Lightning checkpoints and CSV logs.",
    )
    parser.add_argument("--max-epochs", type=int, default=5)
    parser.add_argument("--num-classes", type=int, default=4) 
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--accumulate-grad-batches", type=int, default=4)
    parser.add_argument("--num-workers", type=int, default=2)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--precision", default="32-true")
    parser.add_argument("--limit-train-batches", type=float, default=1.0)
    parser.add_argument("--limit-val-batches", type=float, default=1.0)
    parser.add_argument("--fast", action="store_true", help="Short dry run.")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--save-every-n-steps", type=int, default=1000)
    parser.add_argument(
        "--ckpt-path",
        type=Path,
        default=None,
        help="Explicit Lightning checkpoint to resume from.",
    )
    return parser.parse_args()

def _resolve_ckpt_path(args: argparse.Namespace, weights_dir: Path) -> str | None:
    if args.ckpt_path is not None:
        if not args.ckpt_path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {args.ckpt_path}")
        return str(args.ckpt_path)

    if not args.resume:
        return None

    # Look for last checkpoint saved during training
    possible_lasts = list(weights_dir.glob("*-last*.ckpt")) + [weights_dir / "last.ckpt"]
    for last_ckpt in possible_lasts:
        if last_ckpt.exists():
            print(f"Resuming training from checkpoint: {last_ckpt}")
            return str(last_ckpt)

    print("No existing last checkpoint found; starting fresh.")
    return None

def main() -> None:
    args = parse_args()
    if not args.prepared_dir.exists():
        raise FileNotFoundError(f"Prepared data not found: {args.prepared_dir}")

    args.checkpoint_root.mkdir(parents=True, exist_ok=True)
    run_dir = args.checkpoint_root / "referee_run"
    weights_dir = args.checkpoint_root / "referee_run" / "weights"
    weights_dir.mkdir(parents=True, exist_ok=True)
    
    ckpt_path = _resolve_ckpt_path(args, weights_dir)

    last_checkpoint = ModelCheckpoint(
        dirpath=weights_dir,
        filename="referee-last-{step}",
        save_top_k=0,
        save_last=True,
        every_n_train_steps=max(0, args.save_every_n_steps) or None,
        enable_version_counter=False,
    )

    L.seed_everything(args.seed, workers=True)
    torch.set_float32_matmul_precision("high")

    max_epochs = 1 if args.fast else args.max_epochs
    limit_train = 2 if args.fast else args.limit_train_batches
    limit_val = 1 if args.fast else args.limit_val_batches

    datamodule = RefereeDataModule(
        prepared_dir=str(args.prepared_dir),
        batch_size=args.batch_size,
        num_workers=args.num_workers,
    )
    model = RefereeViTModule(num_classes=args.num_classes)

    best_checkpoint = ModelCheckpoint(
        dirpath=weights_dir,
        filename="referee-{epoch:02d}-{val_mean_ap:.4f}",
        monitor="val_mean_ap",
        mode="max",
        save_top_k=1,
        save_last=False,
    )
    last_checkpoint = ModelCheckpoint(
        dirpath=weights_dir,
        filename="referee-last-{step}",
        save_top_k=0,
        save_last=True,
        every_n_train_steps=args.save_every_n_steps,
    )
    early_stopping = EarlyStopping(
        monitor="val_mean_ap",
        mode="max",
        patience=args.patience,
        verbose=True,
    )
    lr_monitor = LearningRateMonitor(logging_interval="step")
    logger = CSVLogger(save_dir=str(run_dir), name="logs")

    trainer = L.Trainer(
        max_epochs=max_epochs,
        accelerator="gpu" if torch.cuda.is_available() else "cpu",
        devices=1,
        precision=args.precision,
        accumulate_grad_batches=args.accumulate_grad_batches,
        callbacks=[best_checkpoint, last_checkpoint, early_stopping, lr_monitor],
        logger=logger,
        limit_train_batches=limit_train,
        limit_val_batches=limit_val,
    )

    started = datetime.now(timezone.utc).isoformat()
    trainer.fit(model, datamodule=datamodule, ckpt_path=ckpt_path)
    finished = datetime.now(timezone.utc).isoformat()

    print(f"Best checkpoint: {best_checkpoint.best_model_path}")


if __name__ == "__main__":
    main()