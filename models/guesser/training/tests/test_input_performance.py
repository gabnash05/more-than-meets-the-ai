"""Safety and orchestration checks for the input benchmark."""

import pytest
import torch
from training import benchmark_epoch_cache as benchmark


def test_gpu_benchmark_refuses_cpu_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(benchmark.torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="CUDA"):
        benchmark.run(
            benchmark.parse_args(["--prepared-dir", str(tmp_path), "--require-cuda"])
        )


def test_cached_mode_requires_existing_bundle(tmp_path):
    args = benchmark.parse_args(
        [
            "--prepared-dir",
            str(tmp_path),
            "--mode",
            "cached-cpu",
            "--bundle",
            str(tmp_path / "missing"),
        ]
    )
    with pytest.raises(FileNotFoundError, match="bundle"):
        benchmark.run(args)


def test_exact_comparison_checks_returned_tensors_and_indices():
    import torch
    from torch.utils.data import Dataset

    class Tiny(Dataset):
        def __init__(self, mismatch=False):
            self.mismatch = mismatch

        def __len__(self):
            return 4

        def __getitem__(self, index):
            return {
                "image": torch.tensor([index + int(self.mismatch)]),
                "class_id": torch.tensor(index),
            }

    assert benchmark.compare_inputs(Tiny(), Tiny(), [3, 0, 2]) == 3
    with pytest.raises(ValueError, match="index 3"):
        benchmark.compare_inputs(Tiny(), Tiny(True), [3, 0, 2])


def test_tiny_lightning_training_is_measured():
    import lightning as L
    import torch
    from torch.utils.data import Dataset

    class TinyData(Dataset):
        def __len__(self):
            return 8

        def __getitem__(self, index):
            return {
                "image": torch.tensor([float(index)]),
                "class_id": torch.tensor(index % 2),
            }

    class TinyModel(L.LightningModule):
        def __init__(self):
            super().__init__()
            self.layer = torch.nn.Linear(1, 2)

        def training_step(self, batch, batch_idx):
            return torch.nn.functional.cross_entropy(
                self.layer(batch["image"]), batch["class_id"]
            )

        def configure_optimizers(self):
            return torch.optim.SGD(self.parameters(), lr=0.01)

    result = benchmark.measure_lightning(
        TinyData(),
        TinyModel,
        list(range(8)),
        batch_size=2,
        warmup_batches=1,
        measure_batches=3,
        num_workers=0,
        device="cpu",
    )
    assert result["measured_images"] == 6
    assert result["images_per_second"] > 0
    assert result["model_device"] == "cpu"


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cached_cuda_run_compares_inputs_and_measures_real_lightning(tmp_path):
    """A bounded end-to-end run must return actual CUDA timing, not a stub."""
    import lightning as L
    import torch
    from training.build_epoch_cache import build_bundle
    from training.tests.input_fixtures import prepare_drawings

    class TinyModel(L.LightningModule):
        def __init__(self):
            super().__init__()
            self.layer = torch.nn.Linear(3, 4)

        def training_step(self, batch, batch_idx):
            return torch.nn.functional.cross_entropy(
                self.layer(batch["image"].mean((2, 3))), batch["class_id"]
            )

        def configure_optimizers(self):
            return torch.optim.AdamW(self.parameters(), lr=0.001)

    prepared = prepare_drawings(tmp_path)
    bundle = build_bundle(
        prepared,
        tmp_path / "bundle",
        arms=["b"],
        epochs=[1],
        max_bytes=10000000,
        reserve_bytes=0,
        workers=0,
    )
    args = benchmark.parse_args(
        [
            "--mode",
            "cached-cuda",
            "--prepared-dir",
            str(prepared),
            "--bundle",
            str(bundle),
            "--epoch",
            "1",
            "--arm",
            "b",
            "--samples",
            "4",
            "--batch-size",
            "1",
            "--repeats",
            "1",
            "--warmup-batches",
            "1",
            "--measure-batches",
            "3",
            "--require-cuda",
        ]
    )
    report = benchmark.run(args, model_factory=TinyModel)
    assert report["equivalent"] is True
    assert report["requested_indices"]
    assert report["repeats"][0]["model_device"].startswith("cuda")
    assert report["repeats"][0]["input_device"].startswith("cuda")
    assert report["repeats"][0]["measured_images"] == 3
    assert report["median_images_per_second"] > 0


def test_benchmark_caps_fallback_work_without_changing_training(tmp_path, monkeypatch):
    """A bounded probe fails rather than scanning an unbounded fallback suffix."""
    from training.dataset import GuesserDataset
    from training.tests.input_fixtures import prepare_drawings

    prepared = prepare_drawings(tmp_path)
    calls = []

    def blank(self, index):
        calls.append(index)
        return {"image": None, "status": "blank", "skipped": True}

    monkeypatch.setattr(GuesserDataset, "_read_sample", blank)
    probe = benchmark.BoundedBenchmarkDataset(str(prepared), record_attempt_limit=2)
    with pytest.raises(RuntimeError, match="record-attempt budget"):
        probe[0]
    assert calls == [0, 1]
    calls.clear()
    with pytest.raises(RuntimeError, match="No usable image"):
        GuesserDataset(str(prepared))[0]
    assert calls == [0, 1, 2, 3]
