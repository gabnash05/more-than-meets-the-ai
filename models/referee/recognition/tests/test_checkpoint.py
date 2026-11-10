from pathlib import Path

import pytest

from recognition.checkpoint import parse_checkpoint_name, strip_model_prefix

CHECKPOINT = (
    Path(__file__).parents[2]
    / "checkpoints"
    / "referee-epoch=04-val_mean_ap=0.5564.ckpt"
)


def test_parses_lightning_checkpoint_name() -> None:
    info = parse_checkpoint_name(Path("referee-epoch=04-val_mean_ap=0.5564.ckpt"))
    assert info.epoch == 4
    assert info.best_model_score == 0.5564


def test_strips_only_the_lightning_model_prefix() -> None:
    state = {"model.cls_token": 1, "model.head.weight": 2, "other": 3}
    assert strip_model_prefix(state) == {"cls_token": 1, "head.weight": 2, "other": 3}


@pytest.mark.skipif(not CHECKPOINT.is_file(), reason="supplied Referee checkpoint is absent")
def test_inspects_the_supplied_checkpoint() -> None:
    from recognition.checkpoint import inspect_checkpoint

    info = inspect_checkpoint(CHECKPOINT)
    assert info.num_classes == 4
    assert info.head_in_features == 192
    assert info.epoch == 4
    assert 0.5 < info.best_model_score < 0.6
