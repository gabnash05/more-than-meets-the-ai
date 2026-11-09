import numpy as np
from guesser_data.common import load_step
from PIL import Image

loader = load_step("05-loader")
images = load_step("06-images")
evaluation_views = loader.evaluation_views
training_view = loader.training_view
cut_prefix = images.cut_prefix
preprocess = images.preprocess
render_qd = images.render_qd


def test_time_cuts_and_image_steps():
    record = {
        "key_id": "42",
        "drawing": [
            [[0, 10, 20], [0, 10, 20], [10, 20, 30]],
            [[30, 40], [0, 10], [40, 50]],
        ],
    }
    prefix = cut_prefix(record, 0.5)
    assert prefix == [[[0, 10, 20], [0, 10, 20], [10, 20, 30]]]
    image = render_qd(prefix)
    assert image.size == (512, 512)
    for candidate in ("foreground", "edges"):
        result = preprocess(image, candidate)
        assert result["status"] == "ok"
        assert result["image"].shape == (3, 224, 224)
        assert result["image"].dtype == np.float32
        assert (
            preprocess(Image.new("RGB", (512, 512), "white"), candidate)["status"]
            == "blank"
        )
    first = training_view(record, 2)
    second = training_view(record, 2)
    assert (first["fraction"], first["width"]) == (second["fraction"], second["width"])
    assert np.array_equal(first["image"], second["image"])
    assert [view["fraction"] for view in evaluation_views(record)] == [
        i / 10 for i in range(1, 11)
    ]

    paused = {
        "key_id": "pause",
        "drawing": [[[1, 1, 2], [1, 1, 2], [100, 110, 120]], [[3], [3], [130]]],
    }
    dot = cut_prefix(paused, 0)
    assert dot == [[[1], [1], [100]]]
    assert cut_prefix(paused, 1 / 3) == [[[1, 1], [1, 1], [100, 110]]]
    assert np.asarray(render_qd(dot)).min() < 255
    changed = dict(
        record, drawing=[record["drawing"][0], [[3000, 4000], [0, 1000], [40, 50]]]
    )
    assert np.array_equal(
        np.asarray(render_qd(prefix)), np.asarray(render_qd(cut_prefix(changed, 0.5)))
    )
