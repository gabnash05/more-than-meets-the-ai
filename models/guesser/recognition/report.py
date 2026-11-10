"""Assemble the ten-stage evaluation summary and human-readable report."""

from __future__ import annotations

from collections.abc import Sequence

REPORT_THRESHOLDS = (0.0, 0.25, 0.5, 0.75, 0.9)


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2%}"


def _num(value: float | None, digits: int = 4) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _delta(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.2%}"


def build_summary(
    run_info: dict,
    subset_info: dict,
    calibration: dict,
    model_metrics: dict[str, dict],
    comparison: dict | None,
) -> dict:
    """Keep the compact fields the notebook and report need."""
    models: dict[str, dict] = {}
    for model_id, metrics in model_metrics.items():
        stage = metrics["stage"]
        models[model_id] = {
            "identity": metrics["identity"],
            "stageTop1": [row["top1Accuracy"] for row in stage["stages"]],
            "stageTop3": [row["top3Accuracy"] for row in stage["stages"]],
            "stageMacroTop1": [row["macroTop1Accuracy"] for row in stage["stages"]],
            "stageBlank": [row["blankViews"] for row in stage["stages"]],
            "stageUncertain": [row["uncertainViews"] for row in stage["stages"]],
            "meanEarlyTop1": stage["meanEarlyTop1"],
            "meanEarlyTop1Macro": stage["meanEarlyTop1Macro"],
            "completeTop1": stage["completeTop1"],
            "completeTop3": stage["completeTop3"],
            "blankRate": stage["blankRate"],
            "uncertainRate": stage["uncertainRate"],
            "unchangedRate": stage["unchangedRate"],
            "policy": metrics["policy"],
            "bootstrap": metrics["bootstrap"],
            "trajectory": metrics["trajectory"],
            "topConfusions": metrics["topConfusions"],
        }
    return {
        "schema": "guesser-ten-stage-summary-v1",
        "split": run_info["split"],
        "originals": subset_info["originals"],
        "views": subset_info["views"],
        "run": run_info,
        "subset": subset_info,
        "calibration": calibration,
        "models": models,
        "comparison": comparison,
        "test": "not-run",
        "hints": "not-run",
    }


def _stage_table(model_ids: Sequence[str], models: dict[str, dict]) -> list[str]:
    if len(model_ids) == 1:
        model_id = model_ids[0]
        lines = [
            "| Stage | Fraction | Top-1 | Top-3 | Blank | Uncertain |",
            "| ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
        for stage_index, accuracy in enumerate(models[model_id]["stageTop1"]):
            lines.append(
                f"| {stage_index + 1} | {(stage_index + 1) / 10:.0%} | "
                f"{_pct(accuracy)} | "
                f"{_pct(models[model_id]['stageTop3'][stage_index])} | "
                f"{models[model_id]['stageBlank'][stage_index]} | "
                f"{models[model_id]['stageUncertain'][stage_index]} |"
            )
        return lines

    first, second = model_ids[0], model_ids[1]
    lines = [
        (f"| Stage | Fraction | {first} top-1 | {second} top-1 | {second} − {first} |"),
        "| ---: | ---: | ---: | ---: | ---: |",
    ]
    for stage_index in range(len(models[first]["stageTop1"])):
        left = models[first]["stageTop1"][stage_index]
        right = models[second]["stageTop1"][stage_index]
        delta = right - left if left is not None and right is not None else None
        lines.append(
            f"| {stage_index + 1} | {(stage_index + 1) / 10:.0%} | "
            f"{_pct(left)} | {_pct(right)} | {_delta(delta)} |"
        )
    return lines


def _summary_table(model_ids: Sequence[str], models: dict[str, dict]) -> list[str]:
    lines = [
        (
            "| Model | Mean early top-1 (macro) | Mean early top-1 (overall) | "
            "Complete top-1 | Complete top-3 | Blank | Uncertain |"
        ),
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for model_id in model_ids:
        model = models[model_id]
        lines.append(
            f"| `{model_id}` | {_pct(model['meanEarlyTop1Macro'])} | "
            f"{_pct(model['meanEarlyTop1'])} | "
            f"{_pct(model['completeTop1'])} | {_pct(model['completeTop3'])} | "
            f"{_pct(model['blankRate'])} | {_pct(model['uncertainRate'])} |"
        )
    return lines


def _policy_table(model_id: str, model: dict) -> list[str]:
    lines = [
        f"#### `{model_id}` policy",
        "",
        "| Threshold | Coverage | Accuracy among emitted | Overall correctness |",
        "| ---: | ---: | ---: | ---: |",
    ]
    rows = model["policy"]
    if len(rows) > len(REPORT_THRESHOLDS):
        rows = [
            row
            for row in rows
            if round(float(row["threshold"]), 2) in REPORT_THRESHOLDS
        ]
    for row in rows:
        lines.append(
            f"| {row['threshold']:.2f} | {_pct(row['coverage'])} | "
            f"{_pct(row['accuracyEmitted'])} | "
            f"{_pct(row['overallCorrectness'])} |"
        )
    return lines


def _trajectory_table(model_ids: Sequence[str], models: dict[str, dict]) -> list[str]:
    lines = [
        (
            "| Model | First correct (10/20/…/100%) | Never | Next stage correct | "
            "Stays correct |"
        ),
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for model_id in model_ids:
        trajectory = models[model_id]["trajectory"]
        first = trajectory["firstCorrect"]
        histogram = "/".join(str(first[str(stage)]) for stage in range(1, 11))
        lines.append(
            f"| `{model_id}` | {histogram} | {first['never']} | "
            f"{_pct(trajectory['nextStageAfterFirst']['accuracy'])} | "
            f"{_pct(trajectory['staysCorrectAfterFirst']['accuracy'])} |"
        )
    return lines


def _confusion_table(model_id: str, model: dict) -> list[str]:
    lines = [
        f"#### `{model_id}` top confusions",
        "",
        "| True | Predicted | Count |",
        "| --- | --- | ---: |",
    ]
    for row in model["topConfusions"][:10]:
        lines.append(
            f"| {row['trueLabel']} | {row['predictedLabel']} | {row['count']} |"
        )
    return lines


def build_report(summary: dict) -> str:
    """Render a report from the compact summary."""
    models = summary["models"]
    model_ids = list(models)
    run = summary["run"]
    subset = summary["subset"]
    calibration = summary["calibration"]
    is_test = summary["split"] == "test"
    per_class = (
        "all originals"
        if subset["limitPerClass"] is None
        else f"{subset['limitPerClass']} per class"
    )
    if is_test:
        status = (
            "> Held-out test recognition on sketch input using the model, "
            "temperature and threshold frozen from validation. Hint-assisted "
            "ranking was not evaluated, and these are not game scores. Blank, "
            "uncertain and unchanged views count as unsuccessful in the "
            "end-to-end stage curve."
        )
        manifest_label = "Test manifest SHA-256"
    else:
        status = (
            "> Validation-only recognition on sketch input. The held-out test "
            "split was not read, hint-assisted ranking was not evaluated, and "
            "these are not game scores. Blank, uncertain and unchanged views "
            "count as unsuccessful in the end-to-end stage curve."
        )
        manifest_label = "Validation manifest SHA-256"
    lines = [
        "# Guesser ten-stage evaluation",
        "",
        f"- Split: **{summary['split']}**",
        (
            f"- Originals: **{subset['originals']:,}** "
            f"({per_class}, seed {subset['seed']})"
        ),
        f"- Views: **{subset['views']:,}** (ten fixed prefixes per original)",
        f"- Prepared data: `{run['preparedDir']}`",
        f"- {manifest_label}: `{run['manifestSha256']}`",
        f"- Device: `{run['device']}`",
        f"- Started: {run['startedUtc']}",
        f"- Finished: {run['finishedUtc']}",
        "",
        status,
        "",
        "## Inputs",
        "",
        "| Model | Revision | Weights SHA-256 | Preprocessing |",
        "| --- | --- | --- | --- |",
    ]
    for model_id in model_ids:
        identity = models[model_id]["identity"]
        lines.append(
            f"| `{model_id}` | `{identity['artifactRevision'][:16]}…` | "
            f"`{identity['weightsSha256'][:16]}…` | "
            f"{identity['preprocessing']} |"
        )
    if calibration["mode"] == "temperature":
        lines.extend(
            [
                "",
                f"Temperature calibration: fitted on {calibration['sampleSize']:,} "
                f"validation views with seed {calibration['seed']}. "
                f"Temperatures: "
                + ", ".join(
                    f"`{model_id}` {value:.3f}"
                    for model_id, value in calibration["temperatures"].items()
                )
                + ".",
            ]
        )
    elif calibration["mode"] == "frozen":
        thresholds = calibration.get("thresholds", {})
        lines.extend(
            [
                "",
                "Calibration: **frozen** from the validation record with seed "
                f"{calibration['seed']}. Temperatures: "
                + ", ".join(
                    f"`{model_id}` {value:.3f}"
                    for model_id, value in calibration["temperatures"].items()
                )
                + ". Thresholds: "
                + ", ".join(
                    f"`{model_id}` {value:.2f}"
                    for model_id, value in thresholds.items()
                )
                + ". The held-out split was not used to fit or select either.",
            ]
        )
    else:
        lines.extend(
            [
                "",
                (
                    "Calibration: **not applied** because full logits were not saved. "
                    "Policy rows use raw softmax probabilities."
                ),
            ]
        )

    lines.extend(["", "## Stage accuracy", ""])
    lines.extend(_stage_table(model_ids, models))
    lines.extend(["", "## Summary", ""])
    lines.extend(_summary_table(model_ids, models))

    lines.extend(["", "## Policy trade-off", ""])
    for model_id in model_ids:
        lines.extend(_policy_table(model_id, models[model_id]))
        lines.append("")

    lines.extend(["## Recognition trajectory", ""])
    lines.extend(_trajectory_table(model_ids, models))
    lines.extend(["", "## Confusions", ""])
    for model_id in model_ids:
        lines.extend(_confusion_table(model_id, models[model_id]))
        lines.append("")

    comparison = summary["comparison"]
    if comparison:
        lines.extend(
            [
                "## A/B comparison",
                "",
                (
                    f"Delta is `{comparison['second']}` minus "
                    f"`{comparison['first']}`. Positive early delta favors "
                    f"`{comparison['second']}`; negative complete delta is a loss."
                ),
                "",
                "| Metric | Delta | 95% bootstrap interval |",
                "| --- | ---: | ---: |",
                (
                    f"| Mean early top-1 (macro) | {_delta(comparison['earlyDelta'])} | "
                    f"[{_delta(comparison['earlyDeltaLow'])}, "
                    f"{_delta(comparison['earlyDeltaHigh'])}] |"
                ),
                (
                    f"| Complete top-1 | {_delta(comparison['completeDelta'])} | "
                    f"[{_delta(comparison['completeDeltaLow'])}, "
                    f"{_delta(comparison['completeDeltaHigh'])}] |"
                ),
                "",
                (
                    f"Provisional goal (+5 early points, no more than 2 complete "
                    f"points lost): **{'met' if comparison['goalMet'] else 'not met'}**."
                ),
                "",
            ]
        )

    if is_test:
        subset_limit = (
            "- This is the frozen held-out test run. Do not tune the model or "
            "threshold on these errors."
        )
        custody_limit = (
            "- These held-out results are a one-time check of the frozen "
            "protocol, not a new validation set for iteration."
        )
    else:
        subset_limit = (
            "- The subset is a fixed balanced validation sample, not the full "
            "validation set unless `limitPerClass` is `null`."
        )
        custody_limit = (
            "- Held-out test results must come from a separate frozen run. Do "
            "not tune the model or threshold on test errors."
        )
    lines.extend(
        [
            "## Limits",
            "",
            subset_limit,
            (
                "- The model is a closed 345-class classifier. Low confidence is not "
                "a guaranteed unknown-concept detector."
            ),
            (
                "- The recognition curve is separate from the passing policy. A high "
                "pass rate can hide a weak guesser; read coverage, accuracy among "
                "emitted guesses and overall correctness together."
            ),
            custody_limit,
            "",
        ]
    )
    return "\n".join(lines)
