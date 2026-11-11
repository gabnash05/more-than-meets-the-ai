"""Export report figures and tables from a ten-stage evaluation summary.

Notebook outputs are stripped before they reach Git, so anything shown with
``display()`` or ``plt.show()`` disappears the moment the notebook is committed.
This module writes the evidence to disk instead: the tables as CSV and the
recognition curves as PNG and SVG, under the run's own output directory so they
live beside ``report.md`` and cannot drift from it.

Every plotted value is read from ``summary.json``. Nothing is recomputed, so a
figure cannot disagree with the report.

The policy sweep exists only on a validation run, which is the only split that
sweeps thresholds. On a held-out test run the policy has a single frozen row and
that figure is skipped rather than drawn as a one-point line.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import matplotlib

# This module only ever writes files, never shows a figure, so a non-interactive
# backend is always correct. Forcing it also keeps command-line runs working on a
# machine with no display or with an unusable one, where matplotlib would
# otherwise try Tk and fail while opening a window nobody asked for.
matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402

DESCRIPTION = "Export report figures and tables from a ten-stage summary."

STAGES = tuple(range(1, 11))
PERCENT_STAGES = tuple(stage * 10 for stage in STAGES)
PALETTE = ("#3B6EA5", "#C4622D", "#5B8C5A", "#8C6BB1")
DELTA_COLOUR = "#5B8C5A"

SUMMARY_FIELDS = (
    ("meanEarlyTop1Macro", "mean early top-1 (macro)"),
    ("meanEarlyTop1", "mean early top-1 (overall)"),
    ("completeTop1", "complete top-1"),
    ("completeTop3", "complete top-3"),
    ("blankRate", "blank rate"),
    ("uncertainRate", "uncertain rate"),
    ("unchangedRate", "unchanged rate"),
)


def _style() -> None:
    """Apply one report-safe style so every figure matches."""
    plt.rcParams.update(
        {
            "figure.dpi": 200,
            "savefig.dpi": 200,
            "font.size": 9,
            "axes.titlesize": 10,
            "axes.labelsize": 9,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "grid.alpha": 0.25,
            "grid.linewidth": 0.6,
            "legend.frameon": False,
            "svg.fonttype": "none",
        }
    )


def load_summary(summary_path: Path) -> dict:
    """Read a run's ``summary.json``."""
    return json.loads(Path(summary_path).read_text(encoding="utf-8"))


def _save(fig: Figure, output_dir: Path, name: str) -> list[Path]:
    """Write one figure as PNG and SVG, returning the paths written."""
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for suffix in ("png", "svg"):
        path = output_dir / f"{name}.{suffix}"
        fig.savefig(path, bbox_inches="tight")
        written.append(path)
    plt.close(fig)
    return written


def _arms(summary: dict) -> list[str]:
    """Return model IDs in summary order, which is the run's model order."""
    return list(summary["models"])


def _colour(index: int) -> str:
    """Cycle the palette so any number of arms stays distinguishable."""
    return PALETTE[index % len(PALETTE)]


def export_tables(summary: dict, output_dir: Path) -> list[Path]:
    """Write the per-model summary and the per-arm policy sweep as CSV.

    A reader who wants to re-plot or re-check a number should not have to scrape
    a markdown table, so the same values are published in a machine-readable form.

    Args:
        summary: Parsed ``summary.json``.
        output_dir: Directory to write into; created if missing.

    Returns:
        The paths written.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    summary_path = output_dir / "summary.csv"
    with summary_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["model", "split", "originals", *[label for _, label in SUMMARY_FIELDS]])
        for model_id in _arms(summary):
            model = summary["models"][model_id]
            writer.writerow(
                [
                    model_id,
                    summary["split"],
                    summary["originals"],
                    *[model[key] for key, _ in SUMMARY_FIELDS],
                ]
            )
    written.append(summary_path)

    for model_id in _arms(summary):
        rows = summary["models"][model_id]["policy"]
        policy_path = output_dir / f"policy-{model_id}.csv"
        with policy_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                ["threshold", "coverage", "emitted", "accuracyEmitted", "overallCorrectness"]
            )
            for row in rows:
                writer.writerow(
                    [
                        row["threshold"],
                        row["coverage"],
                        row["emitted"],
                        row["accuracyEmitted"],
                        row["overallCorrectness"],
                    ]
                )
        written.append(policy_path)
    return written


def export_stage_curve(summary: dict, output_dir: Path, key: str, title: str, name: str) -> list[Path]:
    """Plot one accuracy measure against drawing progress for every arm.

    Args:
        summary: Parsed ``summary.json``.
        output_dir: Directory to write into.
        key: Summary field holding ten per-stage values.
        title: Figure title.
        name: File stem.
    """
    _style()
    fig, axis = plt.subplots(figsize=(6.0, 3.4))
    for index, model_id in enumerate(_arms(summary)):
        values = [value * 100 for value in summary["models"][model_id][key]]
        axis.plot(
            PERCENT_STAGES,
            values,
            marker="o",
            markersize=3.5,
            linewidth=1.6,
            color=_colour(index),
            label=model_id,
        )
    axis.set_xticks(PERCENT_STAGES)
    axis.set_xlabel("Drawing progress (% of recorded drawing time)")
    axis.set_ylabel("Accuracy (%)")
    axis.set_ylim(0, 100)
    axis.set_title(title)
    axis.legend(loc="upper left")
    return _save(fig, output_dir, name)


def export_delta_curve(summary: dict, output_dir: Path) -> list[Path]:
    """Plot the per-stage top-1 difference between the last and first arm.

    The shape matters more than the endpoints: an arm can lead early and trail on
    complete drawings, and a single summary delta would hide that crossover.
    """
    arms = _arms(summary)
    if len(arms) < 2:
        return []
    first, second = arms[0], arms[1]
    deltas = [
        (summary["models"][second]["stageTop1"][index] - summary["models"][first]["stageTop1"][index]) * 100
        for index in range(len(STAGES))
    ]
    _style()
    fig, axis = plt.subplots(figsize=(6.0, 3.2))
    axis.bar(PERCENT_STAGES, deltas, width=6.0, color=DELTA_COLOUR, alpha=0.85)
    axis.axhline(0, color="black", linewidth=0.9)
    axis.set_xticks(PERCENT_STAGES)
    axis.set_xlabel("Drawing progress (% of recorded drawing time)")
    axis.set_ylabel(f"{second} − {first}, top-1 (pp)")
    axis.set_title("Per-stage top-1 difference between arms")
    for x_value, delta in zip(PERCENT_STAGES, deltas):
        axis.annotate(
            f"{delta:+.1f}",
            (x_value, delta),
            textcoords="offset points",
            xytext=(0, 3 if delta >= 0 else -9),
            ha="center",
            fontsize=7,
        )
    return _save(fig, output_dir, "delta-by-stage")


def export_first_correct(summary: dict, output_dir: Path) -> list[Path]:
    """Plot the stage at which each drawing is first recognised correctly.

    ``never`` is kept as a category rather than dropped, because the drawings no
    arm ever gets right are the most informative part of the distribution.
    """
    arms = _arms(summary)
    originals = summary["models"][arms[0]]["trajectory"]["originals"]
    names = [f"{stage * 10}%" for stage in STAGES] + ["never"]
    keys = [str(stage) for stage in STAGES] + ["never"]
    width = 0.8 / len(arms)
    positions = list(range(len(names)))

    _style()
    fig, axis = plt.subplots(figsize=(6.4, 3.4))
    for index, model_id in enumerate(arms):
        counts = summary["models"][model_id]["trajectory"]["firstCorrect"]
        values = [counts[key] / originals * 100 for key in keys]
        offset = (index - (len(arms) - 1) / 2) * width
        axis.bar(
            [position + offset for position in positions],
            values,
            width=width,
            color=_colour(index),
            label=model_id,
        )
    axis.set_xticks(positions)
    axis.set_xticklabels(names)
    axis.set_xlabel("Stage of first correct recognition")
    axis.set_ylabel("Share of drawings (%)")
    axis.set_title("When each arm first gets a drawing right")
    axis.legend(loc="upper left")
    return _save(fig, output_dir, "first-correct-stage")


def export_policy_sweep(summary: dict, output_dir: Path) -> list[Path]:
    """Plot the threshold trade-off, one panel per arm.

    Skipped on a frozen test run, where the policy holds a single row: a sweep of
    one point is not a trade-off and drawing it would suggest a choice that the
    test split is not allowed to make.
    """
    arms = _arms(summary)
    if max(len(summary["models"][arm]["policy"]) for arm in arms) < 2:
        return []

    _style()
    fig, axes = plt.subplots(1, len(arms), figsize=(3.8 * len(arms), 3.2), sharey=True)
    if len(arms) == 1:
        axes = [axes]
    for axis, model_id in zip(axes, arms):
        rows = summary["models"][model_id]["policy"]
        thresholds = [row["threshold"] for row in rows]
        axis.plot(thresholds, [row["coverage"] * 100 for row in rows], "-",
                  linewidth=1.5, color=_colour(0), label="Coverage")
        axis.plot(thresholds, [(row["accuracyEmitted"] or 0) * 100 for row in rows], "--",
                  linewidth=1.5, label="Accuracy when emitted")
        axis.plot(thresholds, [row["overallCorrectness"] * 100 for row in rows], ":",
                  linewidth=1.5, label="Overall correctness")
        axis.set_title(model_id)
        axis.set_xlabel("Confidence threshold")
        axis.set_xlim(-0.02, 1.0)
        axis.set_ylim(0, 100)
    axes[0].set_ylabel("Percent")
    axes[0].legend(loc="center left", fontsize=7.5)
    fig.suptitle("Policy trade-off fitted on the validation split", y=1.02)
    return _save(fig, output_dir, "policy-tradeoff")


def export_coverage_by_stage(summary: dict, output_dir: Path) -> list[Path]:
    """Plot how often the model answers at the reported threshold, per stage.

    Coverage is the honest companion to the stage curve: an arm can be accurate
    when it speaks and still speak rarely, which is invisible in accuracy alone.
    """
    arms = _arms(summary)
    _style()
    fig, axis = plt.subplots(figsize=(6.0, 3.2))
    plotted = False
    for index, model_id in enumerate(arms):
        stages = summary["models"][model_id]["policy"][0]["stages"]
        values = [row["coverage"] * 100 for row in stages]
        axis.plot(PERCENT_STAGES, values, marker="o", markersize=3.5, linewidth=1.6,
                  color=_colour(index), label=model_id)
        plotted = True
    if not plotted:
        plt.close(fig)
        return []
    threshold = summary["models"][arms[0]]["policy"][0]["threshold"]
    axis.set_xticks(PERCENT_STAGES)
    axis.set_xlabel("Drawing progress (% of recorded drawing time)")
    axis.set_ylabel("Views answered (%)")
    axis.set_ylim(0, 100)
    axis.set_title(f"How often the model answers at threshold {threshold:.2f}")
    axis.legend(loc="upper left")
    return _save(fig, output_dir, "coverage-by-stage")


def export_all(summary_path: Path, output_dir: Path) -> list[Path]:
    """Write every table and figure this summary supports.

    Args:
        summary_path: Path to the run's ``summary.json``.
        output_dir: Directory for the exports, normally ``<output root>/figures``.

    Returns:
        Every path written, in a stable order.
    """
    summary = load_summary(summary_path)
    output_dir = Path(output_dir)
    split = summary["split"]
    written: list[Path] = []
    written += export_tables(summary, output_dir)
    written += export_stage_curve(
        summary, output_dir, "stageTop1",
        f"End-to-end top-1 by drawing progress ({split})", "stage-top1",
    )
    written += export_stage_curve(
        summary, output_dir, "stageTop3",
        f"End-to-end top-3 by drawing progress ({split})", "stage-top3",
    )
    written += export_delta_curve(summary, output_dir)
    written += export_first_correct(summary, output_dir)
    written += export_policy_sweep(summary, output_dir)
    written += export_coverage_by_stage(summary, output_dir)
    return written


def main(argv: list[str] | None = None) -> int:
    """Export from the command line so a run can be published without a notebook."""
    import argparse

    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument("summary", type=Path, help="Path to a run's summary.json")
    parser.add_argument("output", type=Path, help="Directory for the exports")
    args = parser.parse_args(argv)
    for path in export_all(args.summary, args.output):
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
