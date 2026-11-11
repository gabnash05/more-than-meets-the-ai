from pathlib import Path

import pytest

from training.export_bundle import LABEL_ORDER, export

CHECKPOINT = (
    Path(__file__).parents[2]
    / "checkpoints"
    / "referee-epoch=04-val_mean_ap=0.5564.ckpt"
)


@pytest.mark.skipif(not CHECKPOINT.is_file(), reason="supplied Referee checkpoint is absent")
def test_exports_referee_bundle_with_fixed_tensor_parity(tmp_path: Path) -> None:
    result = export(
        CHECKPOINT,
        "referee-test-v1",
        "rgb_resize",
        tmp_path,
        overwrite=True,
    )
    assert result["status"] == "exported"
    assert result["parity"]["maxAbsDiff"] <= 1e-6
    bundle = tmp_path / "referee-test-v1"
    labels = (bundle / "labels.txt").read_text(encoding="utf-8").splitlines()
    assert labels == list(LABEL_ORDER)
    manifest = (bundle / "manifest.json").read_text(encoding="utf-8")
    assert '"role": "referee"' in manifest
    assert '"adapter": "vit-tiny-referee"' in manifest


def test_rejects_unknown_preprocessing(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="preprocessing"):
        export(CHECKPOINT, "referee-test-v1", "imagenet", tmp_path)
