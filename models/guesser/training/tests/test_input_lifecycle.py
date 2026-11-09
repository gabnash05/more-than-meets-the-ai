"""Real Lightning first-batch, persistent-worker and resume equivalence tests."""

from typing import Any

import lightning as L
import pytest
import torch
from training.build_epoch_cache import build_bundle
from training.dataset import GuesserDataModule, GuesserDataset
from training.module import GuesserViTModule
from training.tests.input_fixtures import prepare_drawings


class InputProbe(GuesserViTModule):
    """Reuse the production epoch hook without constructing/download-loading ViT."""

    def __init__(self, prepared, compare_raw=True):
        L.LightningModule.__init__(self)
        self.weight = torch.nn.Parameter(torch.zeros(()))
        self.prepared = prepared
        self.compare_raw = compare_raw
        self.seen = []
        self.worker_pids = []

    def training_step(self, batch, batch_idx):
        """Compare raw epochs or retain exact augmented bytes for paired runs."""
        image = batch["image"].cpu()
        labels = batch["class_id"].cpu()
        if self.compare_raw:
            reference = GuesserDataset(self.prepared, epoch=self.current_epoch)
            expected = torch.stack([reference[int(index)]["image"] for index in labels])
            assert image.numpy().tobytes() == expected.numpy().tobytes()
        self.seen.append((self.current_epoch, image.numpy().tobytes(), labels.tolist()))
        loader: Any = self.trainer.train_dataloader
        self.worker_pids.append(
            tuple(worker.pid for worker in loader._iterator._workers)
        )
        return self.weight.square()

    def configure_optimizers(self):
        """Provide only the optimizer needed to exercise fit/checkpoint resume."""
        return torch.optim.AdamW(self.parameters(), lr=0.01)


class NoNoise(GuesserDataModule):
    """Disable only affine execution so stale-epoch pixels are independently visible."""

    def setup(self, stage=None):
        super().setup(stage)
        assert self.train_dataset is not None
        self.train_dataset.augment = None


def trainer_options(root, device) -> dict[str, Any]:
    """Keep all test output isolated and use one batch per real epoch."""
    return {
        "default_root_dir": str(root),
        "accelerator": device,
        "devices": 1,
        "logger": False,
        "enable_checkpointing": False,
        "enable_progress_bar": False,
        "enable_model_summary": False,
        "limit_train_batches": 1,
        "limit_val_batches": 0,
        "num_sanity_val_steps": 0,
    }


def test_cached_first_batches_persistent_workers_and_remaining_epoch_resume(tmp_path):
    """The first resumed iterator can use a bundle containing only epoch two."""
    prepared = prepare_drawings(tmp_path)
    options: dict[str, Any] = {
        "arms": ["b"],
        "max_bytes": 10000000,
        "reserve_bytes": 0,
        "workers": 0,
    }
    first = build_bundle(prepared, tmp_path / "first", epochs=[0, 1], **options)
    remaining = build_bundle(prepared, tmp_path / "remaining", epochs=[2], **options)
    model = InputProbe(str(prepared))
    trainer = L.Trainer(max_epochs=2, **trainer_options(tmp_path, "cpu"))
    trainer.fit(
        model,
        datamodule=NoNoise(
            str(prepared), batch_size=2, num_workers=2, training_view_cache=first
        ),
    )
    assert [entry[0] for entry in model.seen] == [0, 1]
    assert model.worker_pids[0] == model.worker_pids[1]
    checkpoint = tmp_path / "resume.ckpt"
    trainer.save_checkpoint(checkpoint)
    restored = InputProbe(str(prepared))
    L.Trainer(max_epochs=3, **trainer_options(tmp_path, "cpu")).fit(
        restored,
        datamodule=NoNoise(
            str(prepared), batch_size=2, num_workers=2, training_view_cache=remaining
        ),
        ckpt_path=checkpoint,
    )
    assert [entry[0] for entry in restored.seen] == [2]


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_worker_rng_matches_cpu_and_cuda_affine_over_epochs(tmp_path):
    """Equal worker seeds/order give identical model-visible bytes after transfer."""
    prepared = prepare_drawings(tmp_path)
    bundle = build_bundle(
        prepared,
        tmp_path / "views",
        arms=["b"],
        epochs=[0, 1],
        max_bytes=10000000,
        reserve_bytes=0,
        workers=0,
    )
    results = []
    torch.set_float32_matmul_precision("high")
    for placement in ("cpu", "cuda"):
        L.seed_everything(187, workers=True)
        model = InputProbe(str(prepared), compare_raw=False)
        L.Trainer(max_epochs=2, **trainer_options(tmp_path, "gpu")).fit(
            model,
            datamodule=GuesserDataModule(
                str(prepared),
                batch_size=2,
                num_workers=2,
                training_view_cache=bundle,
                augment_device=placement,
            ),
        )
        assert model.worker_pids[0] == model.worker_pids[1]
        results.append(model.seen)
    assert results[0] == results[1]
