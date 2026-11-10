from pathlib import Path

import pytest

from referee_evaluation.dataset_pipeline import PipelineOptions, parse_report


def test_builds_the_locked_cpu_cli_command() -> None:
    options = PipelineOptions(
        data_root=Path("/tmp/referee-data"),
        profile="sample",
        project=Path("/repo/models/referee/data"),
    )
    assert options.command("export") == [
        "uv", "run", "--project", "/repo/models/referee/data",
        "--frozen", "--no-dev", "referee-data", "export",
        "--data-root", "/tmp/referee-data", "--profile", "sample", "--json",
    ]


def test_rejects_unknown_profile_and_step() -> None:
    with pytest.raises(ValueError):
        PipelineOptions(Path("/tmp"), "production", Path("/repo")).command("export")
    with pytest.raises(ValueError):
        PipelineOptions(Path("/tmp"), "sample", Path("/repo")).command("train")


def test_parses_cli_json() -> None:
    payload = parse_report('{"command":"export","profile":"sample","result":{}}')
    assert payload["command"] == "export"
