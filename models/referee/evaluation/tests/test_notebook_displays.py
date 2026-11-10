"""Validate notebook structure without executing data or model work."""

import json
from pathlib import Path

NOTEBOOKS = Path(__file__).parents[1] / "notebooks"


def _source(name: str) -> str:
    notebook = json.loads((NOTEBOOKS / name).read_text(encoding="utf-8"))
    return "\n".join(
        "".join(cell["source"])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
    )


def test_environment_notebook_parses_and_calls_the_environment_check() -> None:
    assert "collect_environment()" in _source("00_environment_check.ipynb")


def test_notebooks_are_valid_json() -> None:
    for path in sorted(NOTEBOOKS.glob("*.ipynb")):
        assert json.loads(path.read_text(encoding="utf-8"))["nbformat"] == 4


def test_data_and_model_actions_are_opt_in() -> None:
    pipeline = _source("01_dataset_pipeline.ipynb")
    for flag in ("RUN_DOWNLOAD", "RUN_PREPARE", "RUN_PREVIEW", "RUN_EXPORT"):
        assert f"{flag} = False" in pipeline
    assert "RUN_TRAINING = False" in _source("03_training_and_checkpoint.ipynb")
    assert "RUN_EVALUATION = False" in _source("04_validation_evaluation.ipynb")
    assert "WRITE_FREEZE_RECORD = False" in _source("05_report_and_thresholds.ipynb")


def test_audit_and_summary_tables_are_explicitly_displayed() -> None:
    assert "display(pd.DataFrame(rows).set_index('split'))" in _source(
        "02_dataset_audit.ipynb"
    )
    assert "display(pd.DataFrame(rows).set_index('channel'))" in _source(
        "04_validation_evaluation.ipynb"
    )
