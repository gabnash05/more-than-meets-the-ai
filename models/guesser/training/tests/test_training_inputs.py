"""Independent input-contract and trainer-wiring tests for Guesser optimizations."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import torch
from training import dataset as inputs
from training.tests.input_fixtures import prepare_drawings


def assert_sample_equal(expected: dict, actual: dict) -> None:
    """Require exact metadata, dtype, layout and pixel bytes, not approximate pixels."""
    left, right = dict(expected), dict(actual)
    image, restored = left.pop("image"), right.pop("image")
    assert left == right
    if image is None:
        assert restored is None
    else:
        assert restored.dtype == image.dtype == np.float32
        assert restored.shape == image.shape
        assert restored.tobytes() == image.tobytes()


@pytest.mark.parametrize("complete_only", [False, True])
@pytest.mark.parametrize("epoch", [0, 1, 2])
def test_training_record_helper_matches_independent_reference(
    tmp_path, complete_only, epoch
):
    """Compare the new seam with the unchanged separate A/B rendering entry points."""
    prepared = prepare_drawings(tmp_path)
    dataset = inputs.GuesserDataset(str(prepared), complete_only=complete_only)
    for index in range(len(dataset)):
        item = dataset.drawings[index]
        if complete_only:
            expected = {
                **inputs._complete_view(item["record"], epoch, dataset.candidate),
                "drawing_id": item["drawing_id"],
                "class_id": item["class_id"],
            }
        else:
            expected = dataset.drawings.training_image(index, epoch, dataset.candidate)
        actual = inputs.render_training_record(
            item, epoch=epoch, complete_only=complete_only, candidate=dataset.candidate
        )
        assert_sample_equal(expected, actual)


def write_view_bundle(prepared: Path, bundle: Path, epochs=(0, 1, 2)) -> Path:
    """Publish a tiny test bundle from reference views, independently of the builder."""
    import hashlib
    import sqlite3

    from training.epoch_cache import SCHEMA, source_fingerprint
    from training.render_cache import encode_sample

    bundle.mkdir()
    count = len(inputs.GuesserDataset(str(prepared)))
    descriptor = {
        "format": 1,
        "complete": True,
        "fingerprint": source_fingerprint(prepared),
        "candidate": "foreground",
        "arms": ["a", "b"],
        "epochs": list(epochs),
        "sample_count": count,
        "entry_count": count * 2 * len(epochs),
    }
    with sqlite3.connect(bundle / "views.sqlite3") as connection:
        connection.executescript(SCHEMA)
        for arm in descriptor["arms"]:
            dataset = inputs.GuesserDataset(str(prepared), complete_only=arm == "a")
            for epoch in epochs:
                dataset.set_epoch(epoch)
                for index in range(count):
                    metadata, payload = encode_sample(dataset._read_sample(index))
                    digest = hashlib.sha256(metadata.encode() + payload).hexdigest()
                    connection.execute(
                        "INSERT INTO views VALUES (?,?,?,?,?,?)",
                        (arm, epoch, index, metadata, payload, digest),
                    )
        connection.execute(
            "INSERT INTO metadata VALUES ('descriptor',?)", (json.dumps(descriptor),)
        )
    return bundle


@pytest.mark.parametrize("complete_only", [False, True])
def test_cached_dataset_matches_reference_and_affine_rng(tmp_path, complete_only):
    """Cache hits preserve epoch views and consume the same augmentation RNG."""
    prepared = prepare_drawings(tmp_path)
    bundle = write_view_bundle(prepared, tmp_path / "bundle")
    reference = inputs.GuesserDataset(
        str(prepared), complete_only=complete_only, augment=True
    )
    cached = inputs.GuesserDataset(
        str(prepared),
        complete_only=complete_only,
        augment=True,
        training_view_cache=bundle,
    )
    for epoch in (0, 1, 2):
        reference.set_epoch(epoch)
        cached.set_epoch(epoch)
        for index in range(len(reference)):
            assert_sample_equal(
                reference._read_sample(index), cached._read_sample(index)
            )
            torch.manual_seed(71 + index)
            expected = reference[index]
            expected_rng = torch.get_rng_state()
            torch.manual_seed(71 + index)
            actual = cached[index]
            assert torch.equal(actual["image"], expected["image"])
            assert torch.equal(actual["class_id"], expected["class_id"])
            assert torch.equal(torch.get_rng_state(), expected_rng)


def test_datamodule_routes_bundle_only_to_training(tmp_path, monkeypatch):
    """The opt-in data module must not read records/render on a warm train hit."""
    prepared = prepare_drawings(tmp_path)
    bundle = write_view_bundle(prepared, tmp_path / "bundle")
    data = inputs.GuesserDataModule(str(prepared), training_view_cache=bundle)
    data.setup("fit")
    assert data.train_dataset is not None and data.val_dataset is not None
    assert data.train_dataset.training_cache is not None
    assert data.val_dataset.training_cache is None

    def fail(*args, **kwargs):
        raise AssertionError("A warm train hit accessed source records or rendering")

    monkeypatch.setattr(inputs.IndexedDrawings, "__getitem__", fail)
    monkeypatch.setattr(inputs, "_complete_view", fail)
    monkeypatch.setattr(inputs._loader, "training_view", fail)
    assert data.train_dataset[0]["image"].shape == (3, 224, 224)
    with pytest.raises(ValueError, match="validation"):
        inputs.GuesserDataset(
            str(prepared), split="validation", training_view_cache=bundle
        )


@pytest.mark.parametrize("cached", [False, True])
@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_deferred_cuda_matches_cpu_batches_without_rng_drift(tmp_path, cached):
    """CUDA execution must preserve per-image randomness, labels and validation."""
    from types import SimpleNamespace

    from lightning.fabric.utilities.apply_func import move_data_to_device
    from training.gpu_input import collate_deferred_affine

    prepared = prepare_drawings(tmp_path)
    bundle = write_view_bundle(prepared, tmp_path / "bundle") if cached else None
    data = inputs.GuesserDataModule(
        str(prepared), augment_device="cuda", training_view_cache=bundle
    )
    data.setup("fit")
    reference = inputs.GuesserDataset(str(prepared), augment=True)
    torch.manual_seed(913)
    expected = torch.stack([reference[index]["image"] for index in (0, 1)])
    expected_rng = torch.get_rng_state()
    torch.manual_seed(913)
    deferred = collate_deferred_affine([data.train_dataset[index] for index in (0, 1)])
    assert deferred["image"].shape[1] == (1 if cached else 3)
    assert deferred["_affine_params"][0] != deferred["_affine_params"][1]
    data.trainer = SimpleNamespace(training=True)
    actual = data.on_after_batch_transfer(move_data_to_device(deferred, "cuda"), 0)
    assert set(actual) == {"image", "class_id"}
    assert actual["image"].cpu().numpy().tobytes() == expected.numpy().tobytes()
    assert torch.equal(torch.get_rng_state(), expected_rng)
    validation = data.val_dataset[0]
    assert set(validation) == {"image", "class_id"}
    data.trainer.training = False
    assert data.on_after_batch_transfer(validation, 0) is validation


@pytest.mark.parametrize("change_source", [False, True])
def test_cache_guards_run_before_prefetch(tmp_path, monkeypatch, change_source):
    """Missing coverage and changed sources must fail before workers are dispatched."""
    prepared = prepare_drawings(tmp_path)
    bundle = write_view_bundle(
        prepared, tmp_path / "bundle", epochs=(1,) if not change_source else (0,)
    )
    data = inputs.GuesserDataModule(str(prepared), training_view_cache=bundle)
    data.setup("fit")
    loader = data.train_dataloader()
    if change_source:
        with (prepared / "train.jsonl").open("ab") as source:
            source.write(b"\n")

    def fail(*args, **kwargs):
        raise AssertionError("Prefetch began before validating the bundle")

    monkeypatch.setattr(torch.utils.data.DataLoader, "__iter__", fail)
    with pytest.raises(ValueError, match="coverage|source|recipe"):
        iter(loader)


def test_training_parser_exposes_opt_in_input_paths():
    """Existing CLI defaults remain unchanged while explicit input flags survive."""
    from training.train import parse_args

    baseline = parse_args([])
    assert baseline.training_view_cache is None and baseline.augment_device == "cpu"
    selected = parse_args(
        ["--training-view-cache", "views", "--augment-device", "cuda"]
    )
    assert selected.training_view_cache == Path("views")
    assert selected.augment_device == "cuda"


@pytest.mark.parametrize("augment_device", ["cpu", "cuda"])
@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_trainer_uses_cache_and_records_actual_placement(
    tmp_path, monkeypatch, augment_device
):
    """Exercise real callbacks/transfer/fit without fetching pretrained weights."""
    import lightning as L
    from training import train

    class TinyModel(L.LightningModule):
        def __init__(self, num_classes):
            super().__init__()
            self.layer = torch.nn.Linear(3, num_classes)

        def training_step(self, batch, batch_idx):
            return torch.nn.functional.cross_entropy(
                self.layer(batch["image"].mean((2, 3))), batch["class_id"]
            )

        def validation_step(self, batch, batch_idx):
            scores = self.layer(batch["image"].mean((2, 3)))
            self.log("val_acc", (scores.argmax(-1) == batch["class_id"]).float().mean())

        def configure_optimizers(self):
            return torch.optim.AdamW(self.parameters(), lr=0.001)

    prepared = prepare_drawings(tmp_path)
    bundle = write_view_bundle(prepared, tmp_path / "bundle", epochs=(0,))
    args = train.parse_args(
        [
            "--run",
            "b",
            "--fast",
            "--prepared-dir",
            str(prepared),
            "--checkpoint-root",
            str(tmp_path / "experiment"),
            "--no-manifest-cache",
            "--no-render-cache",
            "--training-view-cache",
            str(bundle),
            "--augment-device",
            augment_device,
            "--num-workers",
            "0",
            "--batch-size",
            "2",
        ]
    )
    monkeypatch.setattr(train, "GuesserViTModule", TinyModel)

    def fail(*args, **kwargs):
        raise AssertionError("Trainer ignored the prebuilt training cache")

    monkeypatch.setattr(inputs, "render_training_record", fail)
    record = train.train_one(args, complete_only=False)
    assert record["augment_device"] == augment_device
    assert record["actual_model_device"].startswith("cuda")
    assert record["training_view_cache"]["fingerprint"]
    assert Path(record["best_model_path"]).is_file()
    assert Path(record["last_model_path"]).is_file()
