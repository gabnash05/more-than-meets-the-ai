"""Synthetic regressions for rendered views; no prepared production data needed."""

from __future__ import annotations

import json
import multiprocessing
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, cast

import lightning as L
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import torch
from torch.utils.data import DataLoader
from training.dataset import GuesserDataModule, GuesserDataset
from training.module import GuesserViTModule
from training.render_cache import RenderCache
from training.train import parse_args


def prepared_fixture(root: Path) -> Path:
    """Write a tiny indexed train/validation tree using real record rendering."""
    prepared = root / "prepared"
    (prepared / "manifests").mkdir(parents=True)
    rows = []
    source = prepared / "records.jsonl"
    with source.open("wb") as handle:
        for index in range(4):
            record = {
                "key_id": str(index),
                "drawing": [
                    [[0, 40, 90, 130], [0, 80, 20, 110], [0, 100, 200, 300]],
                    [[20, 100], [100, 40], [310, 400]],
                ],
            }
            raw = (json.dumps(record) + "\n").encode()
            rows.append(
                {
                    "record_file": source.name,
                    "byte_offset": handle.tell(),
                    "byte_length": len(raw),
                    "drawing_id": str(index),
                    "class_id": index,
                }
            )
            handle.write(raw)
    for split in ("train", "validation"):
        pq.write_table(
            pa.Table.from_pylist(rows), prepared / "manifests" / f"{split}.parquet"
        )
    return prepared


def test_validation_cache_reuses_exact_render_before_augmentation(
    tmp_path, monkeypatch
):
    """A warm cache bypasses rendering and preserves seeded affine output exactly."""
    prepared = prepared_fixture(tmp_path)
    plain = GuesserDataset(str(prepared), split="validation", augment=True)
    cached = GuesserDataset(
        str(prepared), split="validation", augment=True, cache_dir=tmp_path / "cache"
    )
    torch.manual_seed(71)
    expected = plain[0]
    torch.manual_seed(71)
    assert torch.equal(expected["image"], cached[0]["image"])

    def fail_render(*args, **kwargs):
        raise AssertionError("warm cache rendered again")

    monkeypatch.setattr("training.dataset._complete_view", fail_render)
    warm = GuesserDataset(
        str(prepared), split="validation", augment=True, cache_dir=tmp_path / "cache"
    )
    torch.manual_seed(71)
    actual = warm[0]
    assert torch.equal(expected["image"], actual["image"])
    assert torch.equal(expected["class_id"], actual["class_id"])


@pytest.mark.parametrize("complete_only", [False, True])
def test_persistent_workers_observe_epoch_updates(tmp_path, complete_only):
    """Parent epoch changes must reach existing workers under both start methods."""
    prepared = prepared_fixture(tmp_path)
    for context in multiprocessing.get_all_start_methods():
        dataset = GuesserDataset(str(prepared), complete_only=complete_only)
        loader = DataLoader(
            dataset,
            batch_size=4,
            num_workers=2,
            persistent_workers=True,
            multiprocessing_context=context,
        )
        try:
            first = next(iter(loader))["image"]
            assert loader._iterator is not None
            iterator = cast(Any, loader._iterator)
            pids = tuple(worker.pid for worker in iterator._workers)
            assert torch.equal(
                first, torch.stack([dataset[index]["image"] for index in range(4)])
            )
            dataset.set_epoch(1)
            second = next(iter(loader))["image"]
            expected = torch.stack([dataset[index]["image"] for index in range(4)])
            assert torch.equal(second, expected), context
            assert not torch.equal(first, second), context
            assert pids == tuple(worker.pid for worker in iterator._workers)
        finally:
            if loader._iterator is not None:
                cast(Any, loader._iterator)._shutdown_workers()


class EpochProbeModule(GuesserViTModule):
    """Exercise the production epoch hook without constructing or downloading ViT."""

    def __init__(self, prepared: str):
        L.LightningModule.__init__(self)
        self.weight = torch.nn.Parameter(torch.zeros(()))
        self.prepared = prepared
        self.seen_epochs = []
        self.worker_pids = []

    def training_step(self, batch, batch_idx):
        """Compare every worker view with an unaugmented direct epoch render."""
        direct = GuesserDataset(self.prepared, epoch=self.current_epoch)
        expected = torch.stack(
            [direct[int(index)]["image"] for index in batch["class_id"]]
        )
        assert torch.equal(batch["image"], expected), (
            f"stale first batch at epoch {self.current_epoch}"
        )
        self.seen_epochs.append(self.current_epoch)
        loader = self.trainer.train_dataloader
        assert loader is not None
        self.worker_pids.append(
            tuple(worker.pid for worker in loader._iterator._workers)
        )
        return self.weight.square()

    def configure_optimizers(self):
        """Provide the smallest optimizer needed by a real Trainer."""
        return torch.optim.AdamW(self.parameters(), lr=0.01)


class EpochProbeDataModule(GuesserDataModule):
    """Keep the production loader but disable affine noise for exact comparisons."""

    def setup(self, stage=None):
        super().setup(stage)
        assert self.train_dataset is not None
        self.train_dataset.augment = None


def test_lightning_first_batches_and_resume_use_current_epoch(tmp_path):
    """Real Trainer prefetch must respect epoch transitions and nonzero resume."""
    prepared = str(prepared_fixture(tmp_path))
    options = {
        "accelerator": "cpu",
        "devices": 1,
        "logger": False,
        "enable_checkpointing": False,
        "enable_progress_bar": False,
        "enable_model_summary": False,
        "limit_train_batches": 1,
        "limit_val_batches": 0,
        "num_sanity_val_steps": 0,
    }
    model = EpochProbeModule(prepared)
    trainer = L.Trainer(max_epochs=2, **options)
    trainer.fit(
        model, datamodule=EpochProbeDataModule(prepared, batch_size=2, num_workers=2)
    )
    assert model.seen_epochs == [0, 1]
    assert model.worker_pids[0] == model.worker_pids[1]
    checkpoint = tmp_path / "resume.ckpt"
    trainer.save_checkpoint(checkpoint)
    resumed = EpochProbeModule(prepared)
    L.Trainer(max_epochs=3, **options).fit(
        resumed,
        datamodule=EpochProbeDataModule(prepared, batch_size=2, num_workers=2),
        ckpt_path=checkpoint,
    )
    assert resumed.seen_epochs == [2]


def test_cache_budget_shrink_evicts_existing_entries(tmp_path):
    """Reopening with a smaller budget must immediately enforce that budget."""
    cache = RenderCache(tmp_path, max_bytes=100000)
    sample = {"image": np.ones((3, 8, 8), dtype=np.float32), "status": "ok"}
    for index in range(8):
        cache.put(str(index), sample)
    small = RenderCache(tmp_path, max_bytes=1)
    assert all(small.get(str(index)) is None for index in range(8))


def test_over_budget_validation_pass_keeps_reusable_subset(tmp_path):
    """A sequential pass larger than the cache must not evict all future hits."""
    sample = {"image": np.ones((3, 8, 8), dtype=np.float32), "status": "ok"}
    cache = RenderCache(tmp_path, max_bytes=100000)
    cache.put("0", sample)
    with sqlite3.connect(cache.path) as connection:
        entry_bytes = connection.execute("SELECT size FROM views").fetchone()[0]
    cache = RenderCache(tmp_path, max_bytes=3 * entry_bytes)
    # Fill with four equally sized records, then replay the same validation order.
    # The second pass should retain three hits even though not every view fits.
    hits = []
    for _ in range(2):
        count = 0
        for index in range(4):
            key = str(index)
            if cache.get(key) is None:
                cache.put(key, sample)
            else:
                count += 1
        hits.append(count)
    assert hits[1] == 3


@pytest.mark.skipif(
    not Path("/proc/self/fd").is_dir(), reason="requires Linux fd inspection"
)
def test_cache_connections_do_not_accumulate(tmp_path):
    """Repeated lookups cannot leave SQLite descriptors open until GC."""
    import gc

    cache = RenderCache(tmp_path, max_bytes=100000)
    gc.collect()
    before = len(list(Path("/proc/self/fd").iterdir()))
    gc.disable()
    try:
        for index in range(100):
            cache.get(str(index))
        assert len(list(Path("/proc/self/fd").iterdir())) <= before + 2
    finally:
        gc.enable()
        gc.collect()


def test_cache_flags_and_datamodule_wiring(tmp_path, monkeypatch):
    """CLI can enable, relocate and disable validation-only caching."""
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train",
            "--render-cache-dir",
            str(tmp_path / "cache"),
            "--render-cache-max-bytes",
            "4096",
        ],
    )
    args = parse_args()
    prepared = prepared_fixture(tmp_path)
    module = GuesserDataModule(
        str(prepared),
        cache_dir=args.render_cache_dir,
        cache_max_bytes=args.render_cache_max_bytes,
    )
    module.setup("fit")
    assert module.train_dataset is not None
    assert module.val_dataset is not None
    assert module.train_dataset.cache is None
    assert module.val_dataset.cache is not None
    assert module.val_dataset.cache.max_bytes == 4096
    monkeypatch.setattr(sys, "argv", ["train", "--no-render-cache"])
    assert parse_args().no_render_cache


def test_manifest_cache_is_wired_independently_of_render_cache(tmp_path, monkeypatch):
    """Workers can share manifest buffers even when render caching is disabled."""
    root = tmp_path / "manifest-cache"
    monkeypatch.setattr(
        sys, "argv", ["train", "--manifest-cache-dir", str(root), "--no-render-cache"]
    )
    args = parse_args()
    prepared = prepared_fixture(tmp_path)
    module = GuesserDataModule(
        str(prepared), manifest_cache_dir=args.manifest_cache_dir
    )
    module.setup("fit")
    assert module.train_dataset is not None
    assert module.val_dataset is not None
    assert module.train_dataset.drawings.manifest_cache_dir == root
    assert module.val_dataset.drawings.manifest_cache_dir == root
    assert module.val_dataset.cache is None
    # Preparation happens before worker startup; mapping never renders a sample.
    assert list(root.glob("*.arrow"))
    monkeypatch.setattr(sys, "argv", ["train", "--no-manifest-cache"])
    assert parse_args().no_manifest_cache


def test_live_manifest_changes_fail_instead_of_serving_stale_cache(tmp_path):
    """A dataset cannot keep serving cached indices after its manifest changes."""
    prepared = prepared_fixture(tmp_path)
    dataset = GuesserDataset(
        str(prepared), split="validation", cache_dir=tmp_path / "cache"
    )
    dataset[0]
    manifest = prepared / "manifests" / "validation.parquet"
    rows = pq.read_table(manifest).to_pylist()
    rows[0]["class_id"] = 99
    pq.write_table(pa.Table.from_pylist(rows), manifest)
    with pytest.raises(RuntimeError, match="manifest changed"):
        dataset[0]


@pytest.mark.parametrize("candidate", ["foreground", "edges"])
def test_cache_invalidation_and_metadata_equivalence(tmp_path, candidate):
    """Recipe, epoch, manifest and source edits cannot reuse another view."""
    prepared = prepared_fixture(tmp_path)
    root = tmp_path / "cache"
    dataset = GuesserDataset(
        str(prepared), split="validation", candidate=candidate, cache_dir=root
    )
    for epoch in (0, 3):
        dataset.set_epoch(epoch)
        expected = GuesserDataset(
            str(prepared), split="validation", candidate=candidate, epoch=epoch
        )._read_sample(0)
        dataset._read_sample(0)
        actual = dataset._read_sample(0)
        assert np.array_equal(actual.pop("image"), expected.pop("image"))
        assert actual == expected
    # Keep record length and ID stable, but alter geometry and refresh the cache.
    source = prepared / "records.jsonl"
    source.write_bytes(source.read_bytes().replace(b"130", b"180"))
    updated = GuesserDataset(
        str(prepared), split="validation", candidate=candidate, cache_dir=root
    )
    direct = GuesserDataset(str(prepared), split="validation", candidate=candidate)
    assert torch.equal(updated[0]["image"], direct[0]["image"])
    # A new manifest mapping must not retrieve the old class label.
    manifest = prepared / "manifests" / "validation.parquet"
    rows = pq.read_table(manifest).to_pylist()
    rows[0]["class_id"] = 99
    pq.write_table(pa.Table.from_pylist(rows), manifest)
    remapped = GuesserDataset(
        str(prepared), split="validation", candidate=candidate, cache_dir=root
    )
    assert remapped[0]["class_id"].item() == 99


def test_cached_skips_keep_fallback_and_all_skipped_error(tmp_path, monkeypatch):
    """Cached unusable samples retain fallback order and visible failure."""
    from training import dataset as implementation

    prepared = prepared_fixture(tmp_path)
    original = implementation._complete_view
    calls = []

    def skip_first(record, epoch, candidate):
        calls.append(record["key_id"])
        if record["key_id"] == "0":
            return {"status": "uncertain", "image": None, "skipped": True}
        return original(record, epoch, candidate)

    monkeypatch.setattr(implementation, "_complete_view", skip_first)
    cached = GuesserDataset(
        str(prepared), split="validation", cache_dir=tmp_path / "cache"
    )
    assert cached[0]["class_id"].item() == 1
    assert cached[0]["class_id"].item() == 1
    assert calls == ["0", "1"]
    monkeypatch.setattr(
        implementation,
        "_complete_view",
        lambda *args, **kwargs: {
            "status": "blank",
            "image": None,
            "skipped": True,
        },
    )
    blank = GuesserDataset(
        str(prepared), split="validation", cache_dir=tmp_path / "blank"
    )
    for _ in range(2):
        with pytest.raises(RuntimeError, match="No usable image"):
            blank[0]


def test_atomic_writes_concurrent_publication_and_bounded_disk(tmp_path):
    """Killed writes roll back; concurrent publication and admission stay bounded."""
    cache = RenderCache(tmp_path, max_bytes=16384)
    channel = np.random.default_rng(7).random((32, 32), dtype=np.float32)
    sample = {"status": "ok", "image": np.repeat(channel[None], 3, axis=0)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: cache.put("shared", sample), range(12)))
    code = (
        "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
        "c.execute('BEGIN IMMEDIATE'); "
        "c.execute(\"INSERT INTO views(key,metadata,image,size) VALUES ('partial','{}',X'00',1)\"); "
        "os._exit(13)"
    )
    assert (
        subprocess.run(
            [sys.executable, "-c", code, str(cache.path)], check=False
        ).returncode
        == 13
    )
    assert cache.get("partial") is None
    shared = cache.get("shared")
    assert shared is not None
    assert np.array_equal(shared["image"], sample["image"])
    for index in range(100):
        cache.put(str(index), sample)
    with sqlite3.connect(cache.path) as connection:
        used = connection.execute("SELECT bytes FROM usage").fetchone()[0]
        assert used == connection.execute("SELECT SUM(size) FROM views").fetchone()[0]
        assert used <= 16384
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert cache.get("0") is not None
    assert cache.get("99") is None
    assert sum(path.stat().st_size for path in tmp_path.iterdir()) < 4 * 16384 + 131072
    assert len(list(tmp_path.iterdir())) <= 2


def test_cache_errors_are_visible(tmp_path):
    """Invalid budgets and corrupt databases must not become silent cache misses."""
    with pytest.raises(ValueError, match="positive"):
        RenderCache(tmp_path, max_bytes=0)
    cache = RenderCache(tmp_path, max_bytes=100000)
    cache.path.write_bytes(b"not a SQLite database")
    with pytest.raises(sqlite3.DatabaseError):
        cache.get("anything")


def test_direct_training_script_keeps_cli_import_compatibility():
    """Both the existing direct-script CLI and module CLI must remain importable."""
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "train.py"),
            "--help",
        ],
        env={key: value for key, value in os.environ.items() if key != "PYTHONPATH"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--no-render-cache" in result.stdout


@pytest.mark.parametrize("context", multiprocessing.get_all_start_methods())
def test_validation_workers_share_transactional_cache(tmp_path, context):
    """Worker-populated cache rows survive reopening and return exact pixels."""
    prepared = str(prepared_fixture(tmp_path))
    dataset = GuesserDataset(prepared, split="validation", cache_dir=tmp_path / "cache")
    loader = DataLoader(
        dataset,
        batch_size=2,
        num_workers=2,
        persistent_workers=True,
        multiprocessing_context=context,
    )
    try:
        first = torch.cat([batch["image"] for batch in loader])
        second = torch.cat([batch["image"] for batch in loader])
        direct = GuesserDataset(prepared, split="validation")
        expected = torch.stack([direct[index]["image"] for index in range(4)])
        assert torch.equal(first, expected)
        assert torch.equal(second, expected)
        assert dataset.cache is not None
        with sqlite3.connect(dataset.cache.path) as connection:
            assert connection.execute("SELECT COUNT(*) FROM views").fetchone()[0] == 4
    finally:
        if loader._iterator is not None:
            cast(Any, loader._iterator)._shutdown_workers()


def test_candidate_and_recipe_revision_have_separate_cache_keys(tmp_path, monkeypatch):
    """Changing the candidate or preprocessing version must create a fresh entry."""
    from training import dataset as implementation

    prepared = str(prepared_fixture(tmp_path))
    root = tmp_path / "cache"
    foreground = GuesserDataset(prepared, split="validation", cache_dir=root)
    foreground[0]
    edges = GuesserDataset(
        prepared, split="validation", candidate="edges", cache_dir=root
    )
    expected = GuesserDataset(prepared, split="validation", candidate="edges")[0]
    assert torch.equal(edges[0]["image"], expected["image"])
    monkeypatch.setattr(
        implementation._images, "candidate_hash", lambda _: "new-recipe-version"
    )
    changed = GuesserDataset(prepared, split="validation", cache_dir=root)
    changed[0]
    assert changed.cache is not None
    with sqlite3.connect(changed.cache.path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM views").fetchone()[0] == 3
