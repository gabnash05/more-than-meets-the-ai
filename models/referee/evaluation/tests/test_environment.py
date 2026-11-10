"""Smoke checks for the Referee notebook environment."""

import sys

import referee_evaluation
from referee_evaluation.environment_check import collect_environment


def test_workspace_uses_python_312() -> None:
    assert sys.version_info[:2] == (3, 12)


def test_workspace_package_is_importable() -> None:
    assert referee_evaluation.__file__ is not None


def test_environment_check_runs_small_image_and_frame_operations() -> None:
    report = collect_environment()
    assert report["image_shape"] == (224, 224)
    assert report["dataframe_shape"] == (2, 1)
