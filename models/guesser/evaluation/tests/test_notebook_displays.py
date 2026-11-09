"""Verify notebook display cells without running audits or training."""

import ast
import json
from pathlib import Path


def test_class_balance_cell_explicitly_displays_its_figure() -> None:
    """Keep the plot display explicit inside the successful-audit branch."""
    notebook_path = Path(__file__).parents[1] / "notebooks" / "02_dataset_audit.ipynb"
    notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
    source = next(
        "".join(cell["source"])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
        and "plot_class_balance(audit_report)" in "".join(cell["source"])
    )
    # Inspect the branch without executing a notebook or starting a data job.
    # Bare expressions inside an if block are not Jupyter display requests.
    branch = next(node for node in ast.parse(source).body if isinstance(node, ast.If))
    expressions = [ast.unparse(node.value) for node in branch.body if isinstance(node, ast.Expr)]
    assert "display(class_balance_figure)" in expressions
