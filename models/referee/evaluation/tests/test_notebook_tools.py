"""Test portable source-path resolution for Referee notebooks."""

from pathlib import Path

import pytest

from referee_evaluation.notebook_tools import module_source_path


def test_resolves_from_repository_workspace_and_notebook_roots() -> None:
    workspace = Path(__file__).parents[1]
    expected = (workspace / "src" / "referee_evaluation" / "analysis.py").resolve()

    for start in (workspace.parents[2], workspace, workspace / "notebooks"):
        assert module_source_path("analysis.py", start=start) == expected


def test_rejects_paths_outside_the_package() -> None:
    with pytest.raises(ValueError):
        module_source_path("../outside.py")
