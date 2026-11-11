"""Train a new two-channel Referee with explicit data and provenance."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import lightning as L
import torch
from lightning.pytorch.callbacks import ModelCheckpoint
from lightning.pytorch.loggers import CSVLogger
from referee_data import preflight, preprocessing_config, preprocessing_hash

from .dataset import RefereeDataModule
from .module import RefereeViTModule


def dataset_fingerprint(prepared: Path) -> str:
    """Hash manifests and every referenced image, including unknown rows."""
    digest = hashlib.sha256()
    for split in ("train", "validation"):
        manifest = prepared / "manifests" / f"{split}.jsonl"
        data = manifest.read_bytes()
        digest.update(split.encode() + b"\0" + data)
        for line in data.splitlines():
            if not line.strip():
                continue
            relative = json.loads(line)["image_path"]
            image = (prepared / relative).resolve()
            if prepared.resolve() not in image.parents:
                raise ValueError(f"Image outside dataset: {image}")
            digest.update(relative.encode() + b"\0")
            with image.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
    return digest.hexdigest()


def source_fingerprints() -> dict[str, str]:
    root = Path(__file__).resolve().parents[1]
    paths = list((root / "training").glob("*.py")) + list(
        (root / "data" / "src").glob("*.py")
    )
    guesser = root.parent / "guesser" / "data" / "src"
    paths += [guesser / name for name in ("06-images.py", "settings.py", "common.py")]
    return {
        str(path.relative_to(root.parent.parent)).replace("\\", "/"): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in sorted(paths)
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument(
        "--checkpoint-root",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "checkpoints",
    )
    parser.add_argument("--max-epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--accumulate-grad-batches", type=int, default=4)
    parser.add_argument("--num-workers", type=int, default=2)
    parser.add_argument("--seed", type=int, default=198173)
    parser.add_argument("--precision", default="32-true")
    parser.add_argument(
        "--fast", action="store_true", help="Explicit non-production fixture smoke run"
    )
    parser.add_argument(
        "--ckpt-path",
        type=Path,
        help="Resume this v2 checkpoint after provenance validation",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    prepared = args.prepared_dir.expanduser().resolve()
    report = preflight(prepared, production=not args.fast)
    config = {
        "max_epochs": args.max_epochs,
        "batch_size": args.batch_size,
        "accumulate_grad_batches": args.accumulate_grad_batches,
        "seed": args.seed,
        "precision": args.precision,
        "fast": args.fast,
        "pretrained": not args.fast,
    }
    provenance = {
        "model_id": "referee-vit-v2",
        "dataset_fingerprint": dataset_fingerprint(prepared),
        "dataset_id": report["dataset_id"],
        "preprocessing_config": preprocessing_config(),
        "preprocessing_hash": preprocessing_hash(),
        "config": config,
        "source_fingerprints": source_fingerprints(),
    }
    resume = None
    if args.ckpt_path:
        resume = args.ckpt_path.resolve()
        checkpoint = torch.load(resume, map_location="cpu", weights_only=False)
        previous = checkpoint.get("hyper_parameters", {}).get("provenance")
        if not isinstance(previous, dict) or any(
            previous.get(k) != v for k, v in provenance.items()
        ):
            raise ValueError(
                "Resume rejected: model, dataset, preprocessing or run config differs"
            )
        provenance = previous
        run_dir = Path(previous["run_dir"])
        if not run_dir.is_dir():
            raise FileNotFoundError(f"Original run directory missing: {run_dir}")
    else:
        run_dir = (
            args.checkpoint_root
            / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:10])
        ).resolve()
        run_dir.mkdir(parents=True, exist_ok=False)
        provenance["run_dir"] = str(run_dir)
        versions = {}
        for package in (
            "torch",
            "torchvision",
            "lightning",
            "timm",
            "torchmetrics",
            "referee-data",
            "guesser-data",
        ):
            try:
                versions[package] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                versions[package] = None
        try:
            revision = subprocess.run(
                [
                    "git",
                    "-C",
                    str(Path(__file__).resolve().parents[3]),
                    "rev-parse",
                    "HEAD",
                ],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            revision = None
        provenance["source_revision"] = revision
        provenance["dependency_versions"] = versions
        (run_dir / "run.json").write_text(
            json.dumps(
                {"provenance": provenance, "preflight": report}, indent=2, default=str
            )
            + "\n",
            encoding="utf-8",
        )
    L.seed_everything(args.seed, workers=True)
    data = RefereeDataModule(str(prepared), args.batch_size, args.num_workers)
    data.setup("fit")
    if not resume:
        run_file = run_dir / "run.json"
        run_record = json.loads(run_file.read_text(encoding="utf-8"))
        run_record["excluded"] = {
            "train": data.train_dataset.excluded,
            "validation": data.val_dataset.excluded,
        }
        run_file.write_text(
            json.dumps(run_record, indent=2, default=str) + "\n", encoding="utf-8"
        )
    model = RefereeViTModule(
        num_classes=2,
        pretrained=not args.fast and resume is None,
        provenance=provenance,
    )
    checkpoint_callback = ModelCheckpoint(
        dirpath=run_dir / "weights",
        filename="best-{epoch:02d}",
        monitor="val_loss" if args.fast else "val_mean_ap",
        mode="min" if args.fast else "max",
        save_top_k=1,
        save_last=True,
        auto_insert_metric_name=False,
    )
    trainer = L.Trainer(
        max_epochs=1 if args.fast else args.max_epochs,
        accelerator="gpu" if torch.cuda.is_available() else "cpu",
        devices=1,
        precision=args.precision,
        accumulate_grad_batches=args.accumulate_grad_batches,
        callbacks=[checkpoint_callback],
        logger=CSVLogger(save_dir=str(run_dir), name="logs"),
        limit_train_batches=2 if args.fast else 1.0,
        limit_val_batches=2 if args.fast else 1.0,
        num_sanity_val_steps=0 if args.fast else 2,
    )
    trainer.fit(model, datamodule=data, ckpt_path=str(resume) if resume else None)
    print(
        f"Run: {run_dir}\nBest: {checkpoint_callback.best_model_path}\nLast: {checkpoint_callback.last_model_path}"
    )


if __name__ == "__main__":
    main()
