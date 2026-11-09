import importlib

import numpy as np
import pytest
from guesser_data import preprocess
from PIL import Image, ImageDraw
from referee_data.common import DataError, write_jsonl

IndexedCanvases = importlib.import_module("referee_data.05-loader").IndexedCanvases


def test_loader_matches_guesser_and_masks_unknown(tmp_path):
    prepared = tmp_path / "prepared"
    image_path = prepared / "images" / "one.png"
    image_path.parent.mkdir(parents=True)
    image = Image.new("L", (512, 512), "white")
    ImageDraw.Draw(image).line((60, 60, 400, 400), fill="black", width=10)
    image.save(image_path)
    write_jsonl(
        prepared / "manifests" / "train.jsonl",
        [
            {
                "image_path": "images/one.png",
                "text_present": 1,
                "number_present": None,
                "known_mask": [True, False],
            }
        ],
    )
    reader = IndexedCanvases(prepared, "train")
    row = reader[0]
    direct = preprocess(image, candidate="foreground")
    assert len(reader) == 1 and row["status"] == direct["status"] == "ok"
    np.testing.assert_array_equal(row["image"], direct["image"])
    assert row["image"].shape == (3, 224, 224) and row["image"].dtype == np.float32
    np.testing.assert_array_equal(row["target"], np.array([1, 0], np.float32))
    np.testing.assert_array_equal(row["known_mask"], np.array([True, False], np.bool_))
    with pytest.raises(IndexError):
        reader[-1]
    with pytest.raises(DataError, match="absent"):
        IndexedCanvases(prepared, "test")
    image_path.unlink()
    with pytest.raises(DataError, match="Cannot read"):
        reader[0]


def test_blank_has_no_image(tmp_path):
    path = tmp_path / "images" / "blank.png"
    path.parent.mkdir()
    Image.new("L", (512, 512), "white").save(path)
    write_jsonl(
        tmp_path / "manifests" / "test.jsonl",
        [
            {
                "image_path": "images/blank.png",
                "text_present": None,
                "number_present": 0,
                "known_mask": [False, True],
            }
        ],
    )
    row = IndexedCanvases(tmp_path, "test")[0]
    assert row["status"] == "blank" and row["image"] is None
