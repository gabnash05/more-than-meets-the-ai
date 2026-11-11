"""Contract tests for the report figure export.

The export exists because notebook outputs are stripped before commit, so these
tests check the two things that would silently rot: the writer cell drifting from
the module it generates, and the exporter producing a different set of files than
the notebook claims it does.
"""

from __future__ import annotations

import json
from pathlib import Path

from guesser_evaluation import report_figures


def _arm(index: int, policy_rows: int) -> dict:
    """Build one synthetic model block with the fields the exporter reads."""
    step = 0.1 * index
    stages = [
        {
            "stage": stage,
            "coverage": 0.1 * stage,
            "emitted": 100 * stage,
            "accuracyEmitted": 0.5,
            "overallCorrectness": 0.05 * stage,
        }
        for stage in range(1, 11)
    ]
    policy = [
        {
            "threshold": 0.05 * row,
            "coverage": 1.0 - 0.05 * row,
            "emitted": 1000 - 50 * row,
            "accuracyEmitted": 0.5 + 0.01 * row,
            "overallCorrectness": 0.4 - 0.01 * row,
            "stages": stages,
        }
        for row in range(policy_rows)
    ]
    return {
        "stageTop1": [0.05 * stage + step for stage in range(1, 11)],
        "stageTop3": [0.10 * stage + step for stage in range(1, 11)],
        "meanEarlyTop1": 0.3 + step,
        "meanEarlyTop1Macro": 0.3 + step,
        "completeTop1": 0.7 + step,
        "completeTop3": 0.9 + step,
        "blankRate": 0.0,
        "uncertainRate": 0.0,
        "unchangedRate": 0.01,
        "policy": policy,
        "trajectory": {
            "originals": 1000,
            "firstCorrect": {**{str(stage): 100 for stage in range(1, 11)}, "never": 0},
        },
    }


def _summary(split: str, policy_rows: int) -> dict:
    """Build a two-arm synthetic summary."""
    return {
        "split": split,
        "originals": 1000,
        "models": {"arm-a": _arm(0, policy_rows), "arm-b": _arm(1, policy_rows)},
    }


def test_export_all_writes_tables_and_curves(tmp_path: Path) -> None:
    """A swept split exports both CSV tables and every curve."""
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps(_summary("validation", policy_rows=4)), encoding="utf-8")

    written = report_figures.export_all(summary_path, tmp_path / "figures")
    names = {path.name for path in written}

    assert {"summary.csv", "policy-arm-a.csv", "policy-arm-b.csv"} <= names
    assert {"stage-top1.png", "stage-top1.svg", "stage-top3.png"} <= names
    assert {"delta-by-stage.png", "first-correct-stage.png"} <= names
    assert {"policy-tradeoff.png", "coverage-by-stage.png"} <= names
    for path in written:
        assert path.is_file() and path.stat().st_size > 0


def test_export_skips_the_policy_sweep_on_a_frozen_run(tmp_path: Path) -> None:
    """A frozen test run reports one threshold, so there is no trade-off to draw."""
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps(_summary("test", policy_rows=1)), encoding="utf-8")

    written = report_figures.export_all(summary_path, tmp_path / "figures")
    names = {path.name for path in written}

    assert "policy-tradeoff.png" not in names
    assert "coverage-by-stage.png" in names


def test_summary_csv_carries_the_reported_values(tmp_path: Path) -> None:
    """The CSV must publish the same numbers the summary reports, not a re-derivation."""
    summary = _summary("test", policy_rows=1)
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")

    report_figures.export_all(summary_path, tmp_path / "figures")
    rows = (tmp_path / "figures" / "summary.csv").read_text(encoding="utf-8").splitlines()

    assert rows[0].startswith("model,split,originals,")
    assert len(rows) == 3
    assert rows[1].startswith("arm-a,test,1000,")
    assert f"{summary['models']['arm-a']['completeTop1']}" in rows[1]


def test_writer_cell_matches_the_module() -> None:
    """The notebook writer cell and the importable module must stay identical.

    The notebook is the source of truth for this module, so an edit applied to
    only one of the two is a defect rather than a style question.
    """
    workspace = Path(__file__).parents[1]
    notebook = json.loads(
        (workspace / "notebooks" / "00_environment_check.ipynb").read_text(encoding="utf-8")
    )
    module = workspace / "src" / "guesser_evaluation" / "report_figures.py"
    expected = module.read_text(encoding="utf-8")

    bodies = [
        "".join(cell["source"][1:])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code" and cell["source"] and cell["source"][0].startswith("%%writefile ")
    ]

    assert any(body == expected for body in bodies), "no writer cell reproduces report_figures.py"
