import importlib
import json

import numpy as np
import pytest
from PIL import Image, ImageDraw
from referee_data import (
    DataError,
    preflight,
    preprocess,
    preprocessing_config,
    preprocessing_hash,
)
from referee_data.common import object_hash
from referee_data.example import build_example_files
from referee_data.settings import Settings


def test_transparent_canvas_matches_white_composite_and_reports_blank():
    rgba = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    ImageDraw.Draw(rgba).line((20, 20, 60, 60), fill=(0, 0, 0, 255), width=4)
    white = Image.new("RGBA", rgba.size, "white")
    white.alpha_composite(rgba)
    actual = preprocess(rgba)
    expected = preprocess(white.convert("RGB"))
    assert actual["status"] == "ok"
    np.testing.assert_array_equal(actual["image"], expected["image"])
    assert preprocess(Image.new("RGBA", (80, 80)))["status"] == "blank"
    assert preprocessing_hash() == object_hash(preprocessing_config())


def test_preflight_sample_and_tamper(tmp_path):
    settings = Settings(tmp_path)
    archives = build_example_files(settings.base)
    importlib.import_module("referee_data.01-download").stage_fixture(
        settings, archives
    )
    importlib.import_module("referee_data.02-prepare").prepare(settings)
    report = preflight(settings.prepared, production=False)
    json.dumps(report)
    assert report["profile"] == "sample" and not report["trainer_ready"]
    assert report["statuses"]["train"]["blank"] > 0
    with pytest.raises(DataError, match="not production-ready"):
        preflight(settings.prepared)
    image = next((settings.prepared / "images").glob("*.png"))
    image.write_bytes(b"broken")
    with pytest.raises(DataError):
        preflight(settings.prepared, production=False)


def test_portable_trainer_preflight_without_raw_source(tmp_path):
    import zipfile

    settings = Settings(tmp_path / "data")
    archives = build_example_files(settings.base)
    importlib.import_module("referee_data.01-download").stage_fixture(
        settings, archives
    )
    importlib.import_module("referee_data.02-prepare").prepare(settings)
    result = importlib.import_module("referee_data.04-export").export_dataset(settings)
    extracted = tmp_path / "portable"
    with zipfile.ZipFile(settings.exports / result["trainer"]["file"]) as archive:
        archive.extractall(extracted)
    report = preflight(extracted / "prepared", production=False)
    assert not report["trainer_ready"] and not report["provenance_authenticated"]
    with pytest.raises(DataError, match="not production-ready"):
        preflight(extracted / "prepared")
    summary_path = extracted / "dataset-summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["source"]["missing_pairs"] == 0
    # The synthetic fixture has both classes in both splits; simulate the recorded
    # production source to isolate the missing-pairs gate, not source authenticity.
    summary["profile"] = "train"
    summary["source"].update(source_kind="atypict_range_multiclass", complete=True)
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    assert preflight(extracted / "prepared")["trainer_ready"]
    for missing in (1, None):
        summary["source"]["missing_pairs"] = missing
        summary_path.write_text(json.dumps(summary), encoding="utf-8")
        assert not preflight(extracted / "prepared", production=False)["trainer_ready"]
        with pytest.raises(DataError, match="not production-ready"):
            preflight(extracted / "prepared")
    image = next((extracted / "prepared" / "images").glob("*.png"))
    image.write_bytes(image.read_bytes() + b"tamper")
    with pytest.raises(DataError, match="hash mismatch"):
        preflight(extracted / "prepared", production=False)


def test_referee_overrides_preserve_faint_small_marks_and_polarity():
    config = preprocessing_config()["foreground"]
    assert config["working_size"] == 1024 and config["distance"] == 0.04
    for offset in range(10):
        source = Image.new("L", (1024, 1024), 255)
        draw = ImageDraw.Draw(source)
        draw.line((400 + offset, 500, 410 + offset, 510), fill=238, width=2)
        inverted = Image.eval(source, lambda pixel: 255 - pixel)
        left, right = preprocess(source), preprocess(inverted)
        assert left["status"] == right["status"] == "ok"
        np.testing.assert_array_equal(left["image"], right["image"])
        assert left["diagnostics"]["config_hash"] == preprocessing_hash()
