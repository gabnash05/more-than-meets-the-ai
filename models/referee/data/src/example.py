"""Create a deterministic, isolated synthetic example of the source format."""

import io
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .common import atomic_output, write_jsonl
from .settings import RECORD_ID, TEST_ARCHIVE, TRAIN_ARCHIVE


def _npy(array: np.ndarray) -> bytes:
    payload = io.BytesIO()
    np.save(payload, array, allow_pickle=False)
    return payload.getvalue()


def _png(image: Image.Image, compression: int = 3) -> bytes:
    payload = io.BytesIO()
    image.save(payload, format="PNG", compress_level=compression)
    return payload.getvalue()


def _canvas(
    index: int, text: int = 0, number: int = 0, *, blank: bool = False
) -> Image.Image:
    image = Image.new("L", (512, 512), 0)
    if blank:
        return image
    draw = ImageDraw.Draw(image)
    left = 38 + index % 107
    top = 40 + index * 13 % 120
    draw.rectangle((left, top, left + 210, top + 155), outline=255, width=7)
    draw.line([(left, top), (left + 98, top + 105), (left + 208, top)], 255, 6)
    draw.ellipse((280, 280, 302 + index % 73, 348), outline=255, width=5)
    if text:
        draw.text((140, 260), "CAT", fill=255, font_size=32)
    if number:
        draw.text((140, 305), "12", fill=255, font_size=32)
    return image


def _labels(text: int, number: int, folder: str) -> bytes:
    targets = np.zeros((76_454, 9), dtype=np.float32)
    targets[:, 4] = 1.0
    for row, (enabled, column) in enumerate(
        ((text, 5), (number, 6), (folder == "symbol", 7), (folder == "circle", 8))
    ):
        if enabled:
            targets[row, 4] = 0.0
            targets[row, column] = 1.0
    return _npy(targets)


def _put(archive: zipfile.ZipFile, member: str, data: bytes) -> None:
    entry = zipfile.ZipInfo(member, date_time=(2022, 11, 18, 0, 0, 0))
    archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED)


def _sample(
    archive: zipfile.ZipFile,
    parent: str,
    index: int,
    image: Image.Image,
    text: int,
    number: int,
    *,
    compression: int = 3,
    invalid: bool = False,
) -> None:
    stem = f"{parent}/sample_{index}"
    _put(archive, f"{stem}.png", _png(image, compression))
    _put(
        archive,
        f"{stem}.npy",
        _npy(np.asarray(image, dtype=np.float32)[..., None]),
    )
    folder = parent.rsplit("/", maxsplit=1)[-1]
    encoded = b"invalid npy" if invalid else _labels(text, number, folder)
    _put(archive, f"{parent}/label_{index}.npy", encoded)


def _identity(partition: str, folder: str, index: int) -> str:
    return f"zenodo{RECORD_ID}:multiclass:{partition}:{folder}:{index}"


def build_example_files(root: Path) -> dict[str, Path]:
    """Write two synthetic nested archives and known fixture corrections."""
    archive_root = root / "fixture-archives"
    archives = {
        TRAIN_ARCHIVE: archive_root / "train.zip",
        TEST_ARCHIVE: archive_root / "test.zip",
    }
    corrections: list[dict[str, str]] = []

    def review(partition: str, folder: str, index: int, text: int, number: int) -> None:
        corrections.append(
            {
                "sample_id": _identity(partition, folder, index),
                "text_present": "yes" if text else "no",
                "number_present": "yes" if number else "no",
                "reviewer": "synthetic-fixture",
                "reason": "Known synthetic drawing content.",
            }
        )

    with (
        atomic_output(archives[TRAIN_ARCHIVE]) as stream,
        zipfile.ZipFile(stream, "w") as archive,
    ):
        for index, folder, text, number in (
            (101, "text", 1, 0),
            (102, "text", 1, 0),
            (103, "text", 1, 0),
            (104, "text", 1, 0),
            (111, "number", 0, 1),
            (112, "number", 0, 1),
            (113, "number", 0, 1),
            (114, "number", 0, 1),
            (121, "real", 1, 1),
            (122, "real", 1, 1),
            (123, "real", 1, 1),
            (124, "real", 1, 1),
            (125, "real", 1, 1),
            (126, "real", 1, 1),
            (131, "symbol", 0, 0),
            (132, "symbol", 0, 0),
            (133, "symbol", 0, 0),
            (134, "symbol", 0, 0),
            (141, "circle", 0, 0),
            (142, "circle", 0, 0),
            (143, "circle", 0, 0),
            (144, "circle", 0, 0),
        ):
            _sample(
                archive,
                f"train/{folder}",
                index,
                _canvas(index, text, number),
                text,
                number,
            )
            review("train", folder, index, text, number)
        _sample(archive, "train/circle", 895, _canvas(895, 1), 1, 0)
        _sample(archive, "train/real", 701, _canvas(701), 0, 0)
        _sample(archive, "train/real", 702, _canvas(702, blank=True), 0, 0)
        review("train", "real", 702, 0, 0)
        _sample(archive, "train/real", 703, _canvas(703), 0, 0, invalid=True)
        duplicate = _canvas(704, 1)
        _sample(archive, "train/text", 704, duplicate, 1, 0)
        _sample(archive, "train/text", 705, duplicate, 1, 0, compression=9)
        conflicting = _canvas(706, 1)
        _sample(archive, "train/real", 706, conflicting, 1, 0)
        _sample(archive, "train/real", 707, conflicting, 0, 0)
        review("train", "real", 707, 0, 0)
        _sample(archive, "train/real", 708, _canvas(708), 0, 0)
        _sample(archive, "train/real", 709, _canvas(709), 0, 0)
    with (
        atomic_output(archives[TEST_ARCHIVE]) as stream,
        zipfile.ZipFile(stream, "w") as archive,
    ):
        for index, canvas_index, text, number in (
            (901, 708, 0, 0),
            (902, 902, 1, 0),
            (903, 903, 0, 1),
            (4036, 709, 0, 0),
        ):
            _sample(
                archive, "val", index, _canvas(canvas_index, text, number), text, number
            )
            review("test", "val", index, text, number)
    corrections_path = root / "corrections.jsonl"
    if not corrections_path.exists():
        write_jsonl(corrections_path, corrections)
    return archives
