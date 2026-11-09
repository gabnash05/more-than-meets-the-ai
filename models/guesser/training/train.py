"""Matched-budget Guesser fine-tunes: Run A (complete-only) and Run B (partial)."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from datetime import UTC, datetime
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
    from .dataset import GuesserDataModule
    from .module import GuesserViTModule
except ImportError:
    from dataset import GuesserDataModule
    from module import GuesserViTModule

SEED = 198173
DEFAULT_PREPARED = (
    Path(__file__).resolve().parents[1]
    / "data"
    / ".local"
    / "data"
    / "small"
    / "prepared"
)
DEFAULT_CHECKPOINT_ROOT = Path(__file__).resolve().parents[1] / "checkpoints"
DEFAULT_RENDER_CACHE = (
    Path(__file__).resolve().parents[1] / ".local" / "cache" / "rendered-views"
)
DEFAULT_MANIFEST_CACHE = (
    Path(__file__).resolve().parents[1] / ".local" / "cache" / "manifests"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fine-tune Guesser ViT-Tiny with equal A/B update budgets."
    )
    parser.add_argument(
        "--run",
        choices=("a", "b", "both"),
        default="both",
        help="Train complete-only (a), partial (b), or both with the same budget.",
    )
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
    parser.add_argument("--max-epochs", type=int, default=6)
    parser.add_argument(
        "--training-view-cache",
        type=Path,
        default=None,
        help="Immutable prebuilt training views; never built automatically.",
    )
    parser.add_argument(
        "--augment-device",
        choices=("cpu", "cuda"),
        default="cpu",
        help="Per-image affine execution device; sampling stays in CPU workers.",
    )
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument(
        "--accumulate-grad-batches",
        type=int,
        default=4,
        help="Physical batch * this value should equal the agreed effective batch (32).",
    )
    parser.add_argument(
        "--num-workers",
        type=int,
        default=2,
        help="DataLoader workers for on-demand render/prefetch (0=debug; 2-4 typical on Windows).",
    )
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument(
        "--manifest-cache-dir",
        type=Path,
        default=DEFAULT_MANIFEST_CACHE,
        help="Shared memory-mapped manifest cache for train/validation workers.",
    )
    parser.add_argument(
        "--no-manifest-cache",
        action="store_true",
        help="Use process-local Arrow manifests instead of shared disk mappings.",
    )
    parser.add_argument(
        "--render-cache-dir",
        type=Path,
        default=DEFAULT_RENDER_CACHE,
        help="Shared validation render cache (training views remain epoch-dependent).",
    )
    parser.add_argument(
        "--no-render-cache",
        action="store_true",
        help="Disable validation render caching for an uncached benchmark.",
    )
    parser.add_argument(
        "--render-cache-max-bytes",
        type=int,
        default=2 * 1024**3,
        help="Maximum compressed cache payload bytes (SQLite overhead is additional).",
    )
    parser.add_argument("--num-classes", type=int, default=345)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument(
        "--precision",
        default="32-true",
        help="Lightning precision string; start with 32-true before trying 16-mixed.",
    )
    parser.add_argument(
        "--limit-train-batches",
        type=float,
        default=1.0,
        help="Fraction or count of train batches (use a small int for a dry run).",
    )
    parser.add_argument(
        "--limit-val-batches",
        type=float,
        default=1.0,
        help="Fraction or count of val batches (use a small int for a dry run).",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Short dry run: 1 epoch, 2 train batches, 1 val batch.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume each selected run from its weights/last.ckpt if present.",
    )
    parser.add_argument(
        "--ckpt-path",
        type=Path,
        default=None,
        help="Explicit Lightning checkpoint to resume (only valid with --run a or --run b).",
    )
    parser.add_argument(
        "--save-every-n-steps",
        type=int,
        default=1000,
        help="Also refresh last.ckpt every N train steps so mid-epoch stops are resumable.",
    )
    return parser.parse_args(argv)


def _run_name(complete_only: bool) -> str:
    return "A_complete_only" if complete_only else "B_partial"


def _labels_sidecar(prepared_dir: Path) -> dict[str, str | None]:
    """Locate labels.json next to prepared/ for handoff hashing."""
    candidates = [
        prepared_dir.parent / "labels.json",
        prepared_dir / "labels.json",
    ]
    for path in candidates:
        if path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            return {"labels_path": str(path.resolve()), "labels_sha256": digest}
    return {"labels_path": None, "labels_sha256": None}


def _resolve_ckpt_path(
    args: argparse.Namespace, run_dir: Path, complete_only: bool
) -> str | None:
    if args.ckpt_path is not None:
        if args.run == "both":
            raise ValueError("--ckpt-path requires --run a or --run b, not both")
        if not args.ckpt_path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {args.ckpt_path}")
        return str(args.ckpt_path)

    if not args.resume:
        return None

    last_ckpt = run_dir / "weights" / "last.ckpt"
    if last_ckpt.exists():
        print(f"Resuming {_run_name(complete_only)} from {last_ckpt}")
        return str(last_ckpt)

    print(f"No last.ckpt for {_run_name(complete_only)}; starting fresh.")
    return None


def train_one(args: argparse.Namespace, complete_only: bool) -> dict:
    """Fit one arm with framework callbacks and explicit input-device provenance."""
    if args.augment_device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA augmentation was requested but CUDA is unavailable")
    run_name = _run_name(complete_only)
    run_dir = args.checkpoint_root / run_name
    weights_dir = run_dir / "weights"
    weights_dir.mkdir(parents=True, exist_ok=True)

    L.seed_everything(args.seed, workers=True)
    torch.set_float32_matmul_precision("high")

    max_epochs = 1 if args.fast else args.max_epochs
    limit_train = 2 if args.fast else args.limit_train_batches
    limit_val = 1 if args.fast else args.limit_val_batches
    ckpt_path = _resolve_ckpt_path(args, run_dir, complete_only)

    datamodule = GuesserDataModule(
        prepared_dir=str(args.prepared_dir),
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        complete_only=complete_only,
        cache_dir=None if args.no_render_cache else args.render_cache_dir,
        cache_max_bytes=args.render_cache_max_bytes,
        manifest_cache_dir=None if args.no_manifest_cache else args.manifest_cache_dir,
        training_view_cache=args.training_view_cache,
        augment_device=args.augment_device,
    )
    # Check cache identity and requested arm before loading pretrained weights.
    # Epoch coverage remains iterator-time so resume-only bundles need no epoch 0.
    bundle_provenance = None
    if args.training_view_cache is not None:
        datamodule.setup("fit")
        assert datamodule.train_dataset is not None
        reader = datamodule.train_dataset.training_cache
        assert reader is not None and reader.descriptor is not None
        if ("a" if complete_only else "b") not in reader.descriptor["arms"]:
            raise ValueError("Training-view bundle lacks the requested arm")
        bundle_provenance = {
            "path": str(args.training_view_cache.resolve()),
            **reader.descriptor,
        }
    model = GuesserViTModule(num_classes=args.num_classes)

    # Keep best-val and periodic-last as separate callbacks. Combining
    # monitor=val_acc with every_n_train_steps can skip all saves on a fresh run.
    best_checkpoint = ModelCheckpoint(
        dirpath=weights_dir,
        filename=f"{run_name}-{{epoch:02d}}-{{val_acc:.4f}}",
        monitor="val_acc",
        mode="max",
        save_top_k=1,
        save_last=False,
        every_n_epochs=1,
    )
    last_checkpoint = ModelCheckpoint(
        dirpath=weights_dir,
        filename=f"{run_name}-last-{{step}}",
        save_top_k=0,
        save_last=True,
        every_n_train_steps=max(0, args.save_every_n_steps) or None,
        enable_version_counter=False,
    )
    early_stopping = EarlyStopping(
        monitor="val_acc",
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
        default_root_dir=str(run_dir),
        limit_train_batches=limit_train,
        limit_val_batches=limit_val,
        log_every_n_steps=10,
    )

    started = datetime.now(UTC).isoformat()
    trainer.fit(model, datamodule=datamodule, ckpt_path=ckpt_path)
    finished = datetime.now(UTC).isoformat()
    # Lightning tears model parameters back down to CPU after fit. Record the
    # execution strategy's actual device rather than that post-fit location.
    execution_device = trainer.strategy.root_device

    labels_meta = _labels_sidecar(args.prepared_dir)
    selection = {
        "run": run_name,
        "complete_only": complete_only,
        "started_utc": started,
        "finished_utc": finished,
        "seed": args.seed,
        "prepared_dir": str(args.prepared_dir.resolve()),
        "backbone": "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
        "preprocess_candidate": "foreground",
        "max_epochs": max_epochs,
        "batch_size": args.batch_size,
        "accumulate_grad_batches": args.accumulate_grad_batches,
        "effective_batch_size": args.batch_size * args.accumulate_grad_batches,
        "num_workers": args.num_workers,
        "manifest_cache_dir": (
            None if args.no_manifest_cache else str(args.manifest_cache_dir.resolve())
        ),
        "render_cache_dir": (
            None if args.no_render_cache else str(args.render_cache_dir.resolve())
        ),
        "render_cache_max_bytes": args.render_cache_max_bytes,
        "patience": args.patience,
        "precision": args.precision,
        "requested_model_device": "auto",
        "actual_model_device": str(execution_device),
        "augment_device": args.augment_device,
        "input_backend": "epoch-bundle"
        if args.training_view_cache is not None
        else "reference",
        "training_view_cache": bundle_provenance,
        "device_runtime": {
            "torch": str(torch.__version__),
            "torchvision": importlib.metadata.version("torchvision"),
            "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(execution_device)
            if execution_device.type == "cuda"
            else None,
        },
        "num_classes": args.num_classes,
        "monitor": "val_acc",
        "best_model_path": best_checkpoint.best_model_path,
        "best_model_score": (
            float(best_checkpoint.best_model_score)
            if best_checkpoint.best_model_score is not None
            else None
        ),
        "last_model_path": last_checkpoint.last_model_path,
        "resumed_from": ckpt_path,
        "fast_dev": bool(args.fast),
        **labels_meta,
    }
    selection_path = run_dir / "checkpoint-selection.json"
    selection_path.write_text(json.dumps(selection, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote selection record: {selection_path}")
    print(f"Best checkpoint: {best_checkpoint.best_model_path}")
    print(f"Last checkpoint: {last_checkpoint.last_model_path}")
    return selection


def main() -> None:
    args = parse_args()
    if args.augment_device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA augmentation was requested but CUDA is unavailable")
    if not args.prepared_dir.exists():
        raise FileNotFoundError(f"Prepared data not found: {args.prepared_dir}")

    args.checkpoint_root.mkdir(parents=True, exist_ok=True)
    runs = []
    if args.run in ("a", "both"):
        runs.append(True)
    if args.run in ("b", "both"):
        runs.append(False)

    results = [train_one(args, complete_only=flag) for flag in runs]
    summary_path = args.checkpoint_root / "train-summary.json"
    summary_path.write_text(
        json.dumps(
            {
                "created_utc": datetime.now(UTC).isoformat(),
                "runs": results,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote summary: {summary_path}")


if __name__ == "__main__":
    main()
