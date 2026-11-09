"""Offline construction of exact deterministic CPU training views."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from guesser_data import IndexedDrawings
from guesser_data.settings import DEFAULT_PREPROCESSOR
from torch.utils.data import DataLoader, Dataset

if __package__:
    from .dataset import render_training_record
    from .epoch_cache import FORMAT, SCHEMA, EpochViewReader, source_fingerprint
    from .render_cache import encode_sample
else:
    from dataset import render_training_record
    from epoch_cache import FORMAT, SCHEMA, EpochViewReader, source_fingerprint
    from render_cache import encode_sample


class BuildViews(Dataset):
    """Read each original once and encode all requested views before augmentation."""

    def __init__(
        self,
        prepared: Path,
        arms: list[str],
        epochs: list[int],
        manifest_cache_dir: Path | None = None,
    ) -> None:
        self.arms = tuple(arms)
        self.epochs = tuple(epochs)
        self.drawings = IndexedDrawings(
            prepared, "train", manifest_cache_dir=manifest_cache_dir
        )

    def __len__(self) -> int:
        return len(self.drawings)

    def __getitem__(self, index: int) -> list[tuple[Any, ...]]:
        item = self.drawings[index]
        rows = []
        for arm in self.arms:
            for epoch in self.epochs:
                sample = render_training_record(
                    item,
                    epoch=epoch,
                    complete_only=arm == "a",
                    candidate=DEFAULT_PREPROCESSOR,
                )
                metadata, image = encode_sample(sample)
                digest = hashlib.sha256(metadata.encode() + image).hexdigest()
                rows.append((arm, epoch, index, metadata, image, digest))
        return rows


def identity_collate(value: Any) -> Any:
    """Keep encoded rows intact when using an unbatched DataLoader."""
    return value


def _coverage(arms: list[str], epochs: list[int]) -> tuple[list[str], list[int]]:
    """Validate explicit coverage without silently repairing invalid inputs."""
    if not arms or any(type(arm) is not str or arm not in ("a", "b") for arm in arms):
        raise ValueError("arms must contain a and/or b")
    if not epochs or any(type(epoch) is not int or epoch < 0 for epoch in epochs):
        raise ValueError("epochs must contain nonnegative integers")
    if len(set(arms)) != len(arms) or len(set(epochs)) != len(epochs):
        raise ValueError("Duplicate arms/epochs are not permitted")
    return sorted(arms), sorted(epochs)


def _size(root: Path) -> int:
    """Count database and live rollback-journal bytes, not compressed payload alone."""
    return sum(path.stat().st_size for path in root.iterdir() if path.is_file())


def _sync_directory(path: Path) -> None:
    """Persist a completed directory publication on POSIX filesystems."""
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def build_bundle(
    prepared: Path,
    output: Path,
    *,
    arms: list[str],
    epochs: list[int],
    max_bytes: int,
    reserve_bytes: int,
    workers: int,
    manifest_cache_dir: Path | None = None,
) -> Path:
    """Publish a complete exact bundle or raise, cleaning only this build's staging.

    A SQLite page ceiling enforces the cap during writes. Private staging uses
    memory rollback (bounded transactions), never a second on-disk journal.
    Interrupted staging is disposable and never accepted as a published bundle.
    Existing bundles/locks are never replaced.
    Sources and dependencies must remain immutable throughout construction.
    """
    arms, epochs = _coverage(arms, epochs)
    if max_bytes < 131072 or reserve_bytes < 0 or workers < 0:
        raise ValueError(
            "Budget must be >=128 KiB; reserve/workers must be nonnegative"
        )
    prepared, output = Path(prepared).resolve(), Path(output).absolute()
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output.parent).free < reserve_bytes + max_bytes:
        raise OSError("Insufficient free space for the requested cap and reserve")
    lock = output.with_name(f".{output.name}.lock")
    lock.mkdir()  # An existing lock belongs to someone else; never remove it.
    staging: Path | None = None
    connection: sqlite3.Connection | None = None
    try:
        if output.exists():
            raise FileExistsError(output)
        fingerprint = source_fingerprint(prepared)
        views = BuildViews(prepared, arms, epochs, manifest_cache_dir)
        count = len(views)
        if not count:
            raise ValueError("Cannot build a bundle from an empty train manifest")
        staging = Path(
            tempfile.mkdtemp(prefix=f".{output.name}.building-", dir=output.parent)
        )
        connection = sqlite3.connect(staging / "views.sqlite3")
        # SQLite enforces the page ceiling DURING writes. Memory rollback keeps
        # journal growth off disk; only the verified, fsynced, closed DB publishes.
        connection.execute("PRAGMA page_size=4096")
        pages = max_bytes // 4096
        connection.execute(f"PRAGMA max_page_count={pages}")
        connection.execute("PRAGMA journal_mode=MEMORY")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA cache_size=-2048")
        connection.executescript(SCHEMA)
        options: dict[str, Any] = (
            {"multiprocessing_context": "spawn", "prefetch_factor": 1}
            if workers
            else {}
        )
        loader = DataLoader(
            views,
            batch_size=None,
            num_workers=workers,
            collate_fn=identity_collate,
            **options,
        )
        started = time.perf_counter()
        for index, rows in enumerate(loader):
            # Reserve all remaining allowed growth; concurrent disk consumers may
            # invalidate that reservation and must stop this builder visibly.
            used = _size(staging)
            if (
                used > max_bytes
                or shutil.disk_usage(output.parent).free
                < reserve_bytes + max_bytes - used
            ):
                raise OSError("Training-view quota or free-space reserve exceeded")
            connection.executemany("INSERT INTO views VALUES (?,?,?,?,?,?)", rows)
            if index % 128 == 127 or index == count - 1:
                connection.commit()
                print(
                    json.dumps(
                        {
                            "originals": index + 1,
                            "bytes": _size(staging),
                            "elapsed_seconds": time.perf_counter() - started,
                        }
                    ),
                    file=sys.stderr,
                )
        # Verify coverage from the actual database, not a counter in Python.
        groups = connection.execute(
            "SELECT arm,epoch,COUNT(*),MIN(sample_index),MAX(sample_index) FROM views GROUP BY arm,epoch"
        ).fetchall()
        if groups != [
            (arm, epoch, count, 0, count - 1) for arm in arms for epoch in epochs
        ]:
            raise ValueError("Incomplete training-view coverage")
        if source_fingerprint(prepared) != fingerprint:
            raise ValueError("Training source/recipe changed during build")
        descriptor = {
            "format": FORMAT,
            "complete": True,
            "fingerprint": fingerprint,
            "candidate": DEFAULT_PREPROCESSOR,
            "arms": arms,
            "epochs": epochs,
            "sample_count": count,
            "entry_count": count * len(arms) * len(epochs),
        }
        connection.execute(
            "INSERT INTO metadata VALUES ('descriptor',?)",
            (json.dumps(descriptor, allow_nan=False),),
        )
        connection.commit()
        connection.close()
        connection = None
        if (
            _size(staging) > max_bytes
            or shutil.disk_usage(output.parent).free < reserve_bytes
        ):
            raise OSError("Training-view quota or free-space reserve exceeded")
        reader = EpochViewReader(
            staging,
            fingerprint=fingerprint,
            candidate=DEFAULT_PREPROCESSOR,
            sample_count=count,
        )
        try:
            reader.get(arms[0], epochs[0], 0)
            reader.get(arms[-1], epochs[-1], count - 1)
        finally:
            reader.close()
        with (staging / "views.sqlite3").open("rb") as handle:
            os.fsync(handle.fileno())
        _sync_directory(staging)
        if output.exists():
            raise FileExistsError(output)
        staging.rename(output)
        staging = None
        _sync_directory(output.parent)
        return output
    except sqlite3.DatabaseError as error:
        raise OSError(
            f"Training-view database build failed (quota/corruption): {error}"
        ) from error
    finally:
        if connection is not None:
            connection.close()
        if staging is not None:
            shutil.rmtree(staging)
        lock.rmdir()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Require an explicit destination, coverage, disk reserve and build cap."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("estimate", "build"):
        command = commands.add_parser(name)
        command.add_argument("--prepared-dir", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
        command.add_argument("--arms", choices=("a", "b"), nargs="+", required=True)
        command.add_argument("--epochs", type=int, nargs="+", required=True)
        command.add_argument("--reserve-bytes", type=int, required=True)
        command.add_argument("--manifest-cache-dir", type=Path)
        if name == "build":
            command.add_argument("--max-bytes", type=int, required=True)
            command.add_argument("--workers", type=int, default=0)
        else:
            command.add_argument("--samples", type=int, default=512)
            command.add_argument("--seed", type=int, default=198173)
    args = parser.parse_args(argv)
    try:
        args.arms, args.epochs = _coverage(args.arms, args.epochs)
        if args.reserve_bytes < 0 or getattr(args, "workers", 0) < 0:
            raise ValueError("Reserve and workers must be nonnegative")
        if args.command == "estimate" and args.samples <= 0:
            raise ValueError("Estimate sample count must be positive")
        if args.command == "build" and args.max_bytes < 131072:
            raise ValueError("Build cap must be at least 128 KiB")
    except ValueError as error:
        parser.error(str(error))
    return args


def estimate_bundle(args: argparse.Namespace) -> dict[str, Any]:
    """Measure sampled encoded rows; project payloads without claiming a disk fit."""
    started = time.perf_counter()
    views = BuildViews(args.prepared_dir, args.arms, args.epochs)
    if not len(views):
        raise ValueError("Cannot estimate an empty train manifest")
    indices = random.Random(args.seed).sample(
        range(len(views)), min(args.samples, len(views))
    )
    payload_bytes = sum(
        len(row[3].encode()) + len(row[4]) + len(row[5])
        for index in indices
        for row in views[index]
    )
    projected = math.ceil(payload_bytes * len(views) / len(indices))
    # Output may be on another drive or not yet exist; inspect its nearest
    # existing ancestor without creating directories during an estimate.
    filesystem = args.output.absolute().parent
    while not filesystem.exists():
        filesystem = filesystem.parent
    return {
        "sampled_originals": len(indices),
        "total_originals": len(views),
        "arms": args.arms,
        "epochs": args.epochs,
        "sampled_encoded_bytes": payload_bytes,
        "estimated_encoded_bytes": projected,
        "safety_adjusted_bytes": math.ceil(projected * 1.25),
        "free_bytes": shutil.disk_usage(filesystem).free,
        "reserve_bytes": args.reserve_bytes,
        "elapsed_seconds": time.perf_counter() - started,
        "warning": "Payload estimate only: SQLite pages/indexes add overhead; measure real DB size before production",
    }


def main(argv: list[str] | None = None) -> None:
    """Print JSON results, keeping build progress on stderr and failures visible."""
    args = parse_args(argv)
    if args.command == "estimate":
        result = estimate_bundle(args)
    else:
        started = time.perf_counter()
        output = build_bundle(
            args.prepared_dir,
            args.output,
            arms=args.arms,
            epochs=args.epochs,
            max_bytes=args.max_bytes,
            reserve_bytes=args.reserve_bytes,
            workers=args.workers,
            manifest_cache_dir=args.manifest_cache_dir,
        )
        result = {
            "output": str(output),
            "bytes": _size(output),
            "elapsed_seconds": time.perf_counter() - started,
        }
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
