"""Bounded exact-input comparisons using the production Lightning training path."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import random
import statistics
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import lightning as L
import psutil
import torch
from torch.utils.data import DataLoader, Dataset, Subset
from torchvision.transforms import v2

if __package__:
    from .dataset import GuesserDataModule, GuesserDataset, _complete_view
    from .gpu_input import apply_cuda_affine, collate_deferred_affine
else:
    from dataset import GuesserDataModule, GuesserDataset, _complete_view
    from gpu_input import apply_cuda_affine, collate_deferred_affine


class BoundedBenchmarkDataset(GuesserDataset):
    """Retain training fallback selection, but fail loudly at a probe-only budget.

    The requested corpus is an index sample, not a filtered replacement dataset.
    Unusable records may select subsequent originals exactly as in training;
    this adapter bounds those reads without silently choosing another policy.
    """

    def __init__(self, *args: Any, record_attempt_limit: int, **kwargs: Any) -> None:
        if record_attempt_limit <= 0:
            raise ValueError("record_attempt_limit must be positive")
        self.record_attempt_limit = record_attempt_limit
        self.last_record_attempts = 0
        self._requested_index: int | None = None
        super().__init__(*args, **kwargs)

    def __getitem__(self, index: int) -> dict[str, Any]:
        """Reset a per-request counter and delegate the unchanged fallback loop."""
        self._requested_index = index
        self.last_record_attempts = 0
        try:
            return super().__getitem__(index)
        finally:
            self._requested_index = None

    def _read_sample(self, index: int) -> dict[str, Any]:
        """Count actual fallback attempts before a record/cache lookup is issued."""
        if self._requested_index is not None:
            if self.last_record_attempts >= self.record_attempt_limit:
                raise RuntimeError(
                    f"Benchmark record-attempt budget exceeded for index {self._requested_index}; "
                    "increase --max-record-attempts-per-sample explicitly"
                )
            self.last_record_attempts += 1
        return super()._read_sample(index)


class FixedEpochSubset(Subset):
    """Expose only the affine recipe, not set_epoch: this probe fixes one view epoch."""

    @property
    def augment(self):
        """Reuse the underlying recipe in the production post-transfer hook."""
        return getattr(self.dataset, "augment", None)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse and validate the bounded train-only benchmark request."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=("baseline", "cached-cpu", "cached-cuda"), default="baseline"
    )
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--arm", choices=("a", "b"), default="a")
    parser.add_argument("--epoch", type=int, default=0)
    parser.add_argument("--samples", type=int, default=2048)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--warmup-batches", type=int, default=16)
    parser.add_argument("--measure-batches", type=int, default=128)
    parser.add_argument("--require-cuda", action="store_true")
    parser.add_argument("--max-record-attempts-per-sample", type=int, default=64)
    parser.add_argument("--preparation-seconds", type=float, default=None)
    args = parser.parse_args(argv)
    if args.mode != "baseline" and args.bundle is None:
        parser.error("--bundle is required for cached modes")
    if args.mode == "baseline" and args.bundle is not None:
        parser.error("--bundle is only valid for cached modes")
    if args.epoch < 0 or args.num_workers < 0 or args.warmup_batches < 0:
        parser.error("epoch, workers and warmup batches must be nonnegative")
    if min(args.samples, args.batch_size, args.repeats, args.measure_batches) <= 0:
        parser.error(
            "samples, batch size, repeats and measure batches must be positive"
        )
    if args.samples < (args.warmup_batches + args.measure_batches) * args.batch_size:
        parser.error("samples must cover disjoint warmup and measurement batches")
    if args.max_record_attempts_per_sample <= 0:
        parser.error("max record attempts per sample must be positive")
    return args


def compare_inputs(
    reference: Dataset[Any],
    candidate: Dataset[Any],
    indices: list[int],
    seed: int = 198173,
    *,
    attempt_counts: list[int] | None = None,
) -> int:
    """Compare actual indexed labels and tensors under identical per-item RNG state.

    This check uses independent dataset calls, including their ordinary fallback
    selection. CUDA candidates materialize through the production adapter;
    persistent-worker sequence equivalence is covered separately by tests.
    """
    torch.manual_seed(seed)
    random.seed(seed)
    for index in indices:
        torch_state = torch.get_rng_state()
        python_state = random.getstate()
        left = reference[index]
        next_torch = torch.get_rng_state()
        next_python = random.getstate()
        torch.set_rng_state(torch_state)
        random.setstate(python_state)
        right = candidate[index]
        if attempt_counts is not None:
            assert isinstance(reference, BoundedBenchmarkDataset)
            assert isinstance(candidate, BoundedBenchmarkDataset)
            if reference.last_record_attempts != candidate.last_record_attempts:
                raise ValueError(
                    f"Fallback attempt mismatch at requested index {index}"
                )
            attempt_counts.append(candidate.last_record_attempts)
        if "_affine_params" in right:
            assert (
                isinstance(candidate, GuesserDataset) and candidate.augment is not None
            )
            # Materialize only this candidate through the admitted CUDA adapter;
            # compare against the independently CPU-augmented reference tensor.
            image = right["image"].unsqueeze(0).to("cuda")
            if image.shape[1] == 1:
                image = image.expand(-1, 3, -1, -1).contiguous()
            image = apply_cuda_affine(
                image,
                [right["_affine_params"]],
                cast(v2.RandomAffine, candidate.augment.transforms[0]),
            )[0]
            right = {"image": image.cpu(), "class_id": right["class_id"]}
        if (
            torch.get_rng_state().equal(next_torch) is False
            or random.getstate() != next_python
            or left.keys() != right.keys()
            or any(
                left[key].dtype != right[key].dtype
                or left[key].shape != right[key].shape
                or left[key].cpu().contiguous().numpy().tobytes()
                != right[key].cpu().contiguous().numpy().tobytes()
                for key in left
            )
        ):
            raise ValueError(f"Input mismatch at requested index {index}")
    return len(indices)


def measure_lightning(
    dataset: Dataset[Any],
    model_factory: Callable[[], L.LightningModule],
    indices: list[int],
    *,
    batch_size: int,
    warmup_batches: int,
    measure_batches: int,
    num_workers: int,
    device: str,
    accumulate_grad_batches: int = 4,
) -> dict[str, Any]:
    """Measure a bounded Lightning fit after disjoint warmup batches.

    Wall time includes loader wait, transfer, forward/backward and optimizer work.
    CUDA events measure transfer/augmentation/compute without per-batch sync.
    """
    required = (warmup_batches + measure_batches) * batch_size
    if len(indices) < required:
        raise ValueError("indices must cover warmup and measurement batches")

    class Timer(L.Callback):
        """Time from the end of warmup through the final measured optimizer batch."""

        def __init__(self):
            self.start = self.elapsed = self.last_end = None
            self.active = False
            self.wait_seconds = 0.0
            self.events = []
            self.current_events = []
            self.model_device = self.input_device = None
            self.measured_images = 0
            self.h2d_bytes = 0
            self.cpu_start = self.cpu_end = None

        def begin(self):
            if device == "cuda":
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
            self.start = self.last_end = time.perf_counter()
            self.cpu_start = os.times()
            self.active = True

        def mark(self):
            if device == "cuda" and self.active:
                event = torch.cuda.Event(enable_timing=True)
                event.record()
                self.current_events.append(event)

        def on_train_start(self, trainer, pl_module):
            self.model_device = str(pl_module.device)
            if not warmup_batches:
                self.begin()

        def on_train_batch_start(self, trainer, pl_module, batch, batch_idx):
            self.input_device = str(batch["image"].device)
            if self.active:
                self.measured_images += len(batch["class_id"])
                self.mark()  # Forward/backward/optimizer region starts here.

        def on_train_batch_end(self, trainer, pl_module, outputs, batch, batch_idx):
            if self.active:
                self.mark()
                self.events.append(self.current_events)
                self.current_events = []
                self.last_end = time.perf_counter()
            if batch_idx == warmup_batches - 1:
                self.begin()
            if batch_idx == warmup_batches + measure_batches - 1:
                if device == "cuda":
                    torch.cuda.synchronize()
                assert self.start is not None
                self.elapsed = time.perf_counter() - self.start
                self.cpu_end = os.times()
                self.active = False

    timer = Timer()

    class MeasuredData(GuesserDataModule):
        """Reuse production transfers/augmentation with a bounded fixed-epoch subset."""

        def __init__(self):
            super().__init__(
                str(getattr(dataset, "prepared_dir", ".")),
                augment_device=getattr(dataset, "augment_device", "cpu"),
            )
            self.fixed_views = FixedEpochSubset(dataset, indices[:required])
            # No set_epoch: the bounded probe measures a requested late epoch,
            # not epoch zero of its temporary one-epoch Lightning fit.
            self.train_dataset = cast(Any, self.fixed_views)
            self.loader = None

        def setup(self, stage=None):
            pass  # Dataset is explicitly prepared by the caller; never reopen another epoch.

        def train_dataloader(self):
            if isinstance(dataset, GuesserDataset):
                dataset.validate_training_cache()
            options: dict[str, Any] = (
                {"persistent_workers": True, "prefetch_factor": 2}
                if num_workers
                else {}
            )
            if self.augment_device == "cuda" and self.fixed_views.augment is not None:
                options["collate_fn"] = collate_deferred_affine
            self.loader = DataLoader(
                self.fixed_views,
                batch_size=batch_size,
                num_workers=num_workers,
                pin_memory=device == "cuda",
                **options,
            )
            return self.loader

        def val_dataloader(self) -> DataLoader:
            return DataLoader(Subset(dataset, []), batch_size=batch_size)

        def on_before_batch_transfer(self, batch, dataloader_idx):
            if timer.active:
                assert timer.last_end is not None
                timer.wait_seconds += time.perf_counter() - timer.last_end
                timer.h2d_bytes += sum(
                    value.numel() * value.element_size()
                    for value in batch.values()
                    if isinstance(value, torch.Tensor)
                )
                timer.mark()
            return batch

        def on_after_batch_transfer(self, batch, dataloader_idx):
            timer.mark()  # Transfer ended; deferred expansion/affine begins.
            result = super().on_after_batch_transfer(batch, dataloader_idx)
            timer.mark()
            return result

    data = MeasuredData()
    model = model_factory()
    trainer = L.Trainer(
        accelerator="gpu" if device == "cuda" else "cpu",
        devices=1,
        max_epochs=1,
        limit_train_batches=warmup_batches + measure_batches,
        limit_val_batches=0,
        num_sanity_val_steps=0,
        logger=False,
        enable_checkpointing=False,
        enable_progress_bar=False,
        enable_model_summary=False,
        callbacks=[timer],
        precision="32-true",
        accumulate_grad_batches=accumulate_grad_batches,
    )
    try:
        trainer.fit(model, datamodule=data)
    finally:
        iterator = getattr(data.loader, "_iterator", None)
        if iterator is not None:
            iterator._shutdown_workers()
    if timer.elapsed is None:
        raise RuntimeError("Lightning did not complete the requested measurement")
    count = timer.measured_images
    if count != measure_batches * batch_size:
        raise ValueError("Measured sample count differs from the requested budget")
    gpu_times = (
        {"transfer_ms": 0.0, "augmentation_ms": 0.0, "compute_ms": 0.0}
        if device == "cuda"
        else None
    )
    if gpu_times is not None:
        for events in timer.events:
            if len(events) != 5:
                raise RuntimeError("Incomplete CUDA event boundaries")
            for key, left, right in (
                ("transfer_ms", 0, 1),
                ("augmentation_ms", 1, 2),
                ("compute_ms", 3, 4),
            ):
                gpu_times[key] += events[left].elapsed_time(events[right])
    memory = psutil.Process().memory_full_info()
    assert timer.cpu_start is not None and timer.cpu_end is not None
    return {
        "measured_images": count,
        "images_per_second": count / timer.elapsed,
        "wall_seconds": timer.elapsed,
        "model_device": timer.model_device,
        "input_device": timer.input_device,
        "host_wait_seconds": timer.wait_seconds,
        "parent_cpu_user_seconds": timer.cpu_end.user - timer.cpu_start.user,
        "parent_cpu_system_seconds": timer.cpu_end.system - timer.cpu_start.system,
        "parent_memory_after_fit": {
            "rss_bytes": memory.rss,
            "private_bytes": getattr(memory, "uss", None),
            "pss_bytes": getattr(memory, "pss", None),
        },
        "requested_measured_samples": measure_batches * batch_size,
        "delivered_measured_samples": count,
        "h2d_tensor_bytes": timer.h2d_bytes if device == "cuda" else 0,
        "cuda_event_times": gpu_times,
        "peak_gpu_allocated_bytes": torch.cuda.max_memory_allocated()
        if device == "cuda"
        else None,
        "peak_gpu_reserved_bytes": torch.cuda.max_memory_reserved()
        if device == "cuda"
        else None,
    }


def run(
    args: argparse.Namespace,
    *,
    model_factory: Callable[[], L.LightningModule] | None = None,
) -> dict[str, Any]:
    """Reject unavailable CUDA before constructing models or accessing data."""
    if (
        args.require_cuda or args.mode == "cached-cuda"
    ) and not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this benchmark but is unavailable")
    if args.bundle is not None and not args.bundle.is_dir():
        raise FileNotFoundError(f"Training-view bundle not found: {args.bundle}")
    reference = BoundedBenchmarkDataset(
        str(args.prepared_dir),
        record_attempt_limit=args.max_record_attempts_per_sample,
        complete_only=args.arm == "a",
        epoch=args.epoch,
        augment=True,
    )
    candidate = BoundedBenchmarkDataset(
        str(args.prepared_dir),
        record_attempt_limit=args.max_record_attempts_per_sample,
        complete_only=args.arm == "a",
        epoch=args.epoch,
        augment=True,
        training_view_cache=args.bundle,
        augment_device="cuda" if args.mode == "cached-cuda" else "cpu",
    )
    if args.samples > len(reference):
        raise ValueError(
            "Requested samples exceed train originals; no implicit repetition"
        )
    indices = random.Random(198173).sample(range(len(reference)), args.samples)
    # Compare raw diagnostics/identity against the old rendering entry points,
    # independently of the new record helper and compressed-cache encoder.
    for index in indices:
        if args.arm == "a":
            item = reference.drawings[index]
            expected = {
                **_complete_view(item["record"], args.epoch, reference.candidate),
                "drawing_id": item["drawing_id"],
                "class_id": item["class_id"],
            }
        else:
            expected = reference.drawings.training_image(
                index, args.epoch, reference.candidate
            )
        actual = (
            candidate.training_cache.get(args.arm, args.epoch, index)
            if candidate.training_cache
            else candidate._read_sample(index)
        )
        left, right = expected.pop("image"), actual.pop("image")
        if (
            expected != actual
            or ((left is None) != (right is None))
            or (
                left is not None
                and (
                    left.dtype != right.dtype
                    or left.shape != right.shape
                    or left.tobytes() != right.tobytes()
                )
            )
        ):
            raise ValueError(f"Raw input mismatch at requested index {index}")
    attempt_counts: list[int] = []
    compared = compare_inputs(
        reference, candidate, indices, attempt_counts=attempt_counts
    )
    fixture_model = model_factory is not None
    if model_factory is None:
        if os.environ.get("HF_HUB_OFFLINE") != "1":
            raise RuntimeError(
                "Set HF_HUB_OFFLINE=1 before starting this benchmark; automatic downloads are forbidden"
            )
        if __package__:
            from .module import GuesserViTModule
        else:
            from module import GuesserViTModule
        model_factory = GuesserViTModule
    device = "cuda" if torch.cuda.is_available() else "cpu"
    repeats = []
    # Reset initialization, dropout, sampler and worker seeds identically in
    # every mode/repeat. Cache building and equivalence checks are not timed.
    for _ in range(args.repeats):
        gc.collect()
        L.seed_everything(198173, workers=True)
        torch.set_float32_matmul_precision("high")
        repeats.append(
            measure_lightning(
                candidate,
                model_factory,
                indices,
                batch_size=args.batch_size,
                warmup_batches=args.warmup_batches,
                measure_batches=args.measure_batches,
                num_workers=args.num_workers,
                device=device,
            )
        )
    descriptor = (
        candidate.training_cache.descriptor if candidate.training_cache else None
    )
    return {
        "mode": args.mode,
        "arm": args.arm,
        "epoch": args.epoch,
        "equivalent": True,
        "compared_samples": compared,
        "requested_indices": indices,
        "prepared_root": str(args.prepared_dir.resolve()),
        "corpus_policy": "requested indices with unchanged next-index fallback; per-sample record work capped",
        "max_record_attempts_per_sample": args.max_record_attempts_per_sample,
        "preflight_record_attempts": sum(attempt_counts),
        "batch_size": args.batch_size,
        "num_workers": args.num_workers,
        "precision": "32-true",
        "accumulate_grad_batches": 4,
        "warmup_batches": args.warmup_batches,
        "repeats": repeats,
        "median_images_per_second": statistics.median(
            row["images_per_second"] for row in repeats
        ),
        "cache_descriptor": descriptor,
        "cache_bytes": (args.bundle / "views.sqlite3").stat().st_size
        if args.bundle
        else 0,
        "preparation_seconds": args.preparation_seconds,
        "model_kind": "injected-test-fixture"
        if fixture_model
        else "pretrained-guesser-vit-tiny",
        "gpu": torch.cuda.get_device_name() if device == "cuda" else None,
        "torch": str(torch.__version__),
        "cuda_runtime": torch.version.cuda,
        "augmentation_code_sha256": hashlib.sha256(
            Path(__file__).with_name("gpu_input.py").read_bytes()
        ).hexdigest(),
        "worker_cpu_breakdown": None,
    }


def main() -> None:
    """Run a requested benchmark; failures are written to stderr by Python."""
    print(json.dumps(run(parse_args()), allow_nan=False))


if __name__ == "__main__":
    main()
