"""Compare Guesser Run A vs Run B from Lightning CSV logs and selection JSON."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path


DEFAULT_CHECKPOINT_ROOT = Path(__file__).resolve().parents[1] / "checkpoints"
RUN_DIRS = {
    "A": "A_complete_only",
    "B": "B_partial",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare small-dataset Guesser A/B validation curves and best scores."
    )
    parser.add_argument(
        "--checkpoint-root",
        type=Path,
        default=DEFAULT_CHECKPOINT_ROOT,
        help="Root containing A_complete_only/ and B_partial/.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Where to write comparison artifacts (default: <checkpoint-root>/ab_comparison).",
    )
    return parser.parse_args()


def _metrics_csv_paths(run_dir: Path) -> list[Path]:
    candidates = sorted(
        run_dir.glob("logs/**/metrics.csv"),
        key=lambda path: path.stat().st_mtime,
    )
    if not candidates:
        raise FileNotFoundError(
            f"No metrics.csv under {run_dir / 'logs'}. Finish training first."
        )
    return candidates


def _read_rows(metrics_csv: Path) -> list[dict[str, str]]:
    with metrics_csv.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        rows: list[dict[str, str]] = []
        for raw in reader:
            rows.append(
                {(key or "").strip(): (value or "").strip() for key, value in raw.items()}
            )
        return rows


def _float_or_none(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _row_get(row: dict[str, str], *names: str) -> str | None:
    lowered = {key.lower(): value for key, value in row.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value not in (None, ""):
            return value
    return None


def _epoch_series(rows: list[dict[str, str]], field: str) -> list[tuple[int, float]]:
    """Keep the last logged value per epoch for epoch-level metrics."""
    by_epoch: dict[int, float] = {}
    for row in rows:
        epoch_raw = _row_get(row, "epoch")
        value = _float_or_none(_row_get(row, field))
        if epoch_raw is None or value is None:
            continue
        by_epoch[int(float(epoch_raw))] = value
    return sorted(by_epoch.items())


def _merged_rows(run_dir: Path) -> tuple[list[dict[str, str]], list[str]]:
    """Merge all Lightning log versions in time order (later files overwrite epochs)."""
    paths = _metrics_csv_paths(run_dir)
    merged: list[dict[str, str]] = []
    for path in paths:
        merged.extend(_read_rows(path))
    return merged, [str(path) for path in paths]


def _best_val(rows: list[dict[str, str]]) -> dict[str, float | int | None]:
    best_acc = None
    best_epoch = None
    best_loss = None
    for epoch, acc in _epoch_series(rows, "val_acc"):
        if best_acc is None or acc > best_acc:
            best_acc = acc
            best_epoch = epoch
    loss_by_epoch = dict(_epoch_series(rows, "val_loss"))
    if best_epoch is not None:
        best_loss = loss_by_epoch.get(best_epoch)
    return {
        "best_val_acc": best_acc,
        "best_val_acc_epoch": best_epoch,
        "best_val_loss_at_best_acc": best_loss,
    }


def _load_selection(run_dir: Path) -> dict | None:
    path = run_dir / "checkpoint-selection.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _svg_chart(
    series_list: list[tuple[str, list[tuple[int, float]], str]],
    *,
    title: str,
    y_label: str,
    width: int = 880,
    height: int = 420,
) -> str:
    """Draw one or more epoch curves with readable axes and markers."""
    combined = [point for _, series, _ in series_list for point in series]
    if not combined:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
            f'<text x="24" y="40">No data for {title}</text></svg>\n'
        )

    left, right, top, bottom = 72, 160, 56, 64
    plot_w = width - left - right
    plot_h = height - top - bottom

    xs = [point[0] for point in combined]
    ys = [point[1] for point in combined]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    # Always include a little padding so lines don't sit on the frame.
    if math.isclose(x_min, x_max):
        x_min -= 0.5
        x_max += 0.5
    else:
        x_pad = max(0.25, 0.05 * (x_max - x_min))
        x_min -= x_pad
        x_max += x_pad
    if math.isclose(y_min, y_max):
        y_min -= 1e-3
        y_max += 1e-3
    else:
        y_pad = 0.08 * (y_max - y_min)
        y_min -= y_pad
        y_max += y_pad

    def map_x(epoch: float) -> float:
        return left + (epoch - x_min) / (x_max - x_min) * plot_w

    def map_y(value: float) -> float:
        return top + plot_h - (value - y_min) / (y_max - y_min) * plot_h

    epoch_ticks = sorted({int(point[0]) for point in combined})
    y_ticks = 5
    y_tick_values = [
        y_min + (y_max - y_min) * i / (y_ticks - 1) for i in range(y_ticks)
    ]

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{left}" y="28" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="600">{title}</text>',
        f'<text x="20" y="{top + plot_h / 2}" font-family="Segoe UI, Arial, sans-serif" font-size="12" text-anchor="middle" transform="rotate(-90 20,{top + plot_h / 2})">{y_label}</text>',
        f'<line x1="{left}" y1="{top + plot_h}" x2="{left + plot_w}" y2="{top + plot_h}" stroke="#333" stroke-width="1.5"/>',
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top + plot_h}" stroke="#333" stroke-width="1.5"/>',
        f'<text x="{left + plot_w / 2}" y="{height - 16}" font-family="Segoe UI, Arial, sans-serif" font-size="12" text-anchor="middle">epoch</text>',
    ]

    for epoch in epoch_ticks:
        x = map_x(epoch)
        parts.append(
            f'<line x1="{x:.1f}" y1="{top + plot_h}" x2="{x:.1f}" y2="{top + plot_h + 6}" stroke="#333"/>'
        )
        parts.append(
            f'<text x="{x:.1f}" y="{top + plot_h + 22}" font-family="Segoe UI, Arial, sans-serif" font-size="11" text-anchor="middle">{epoch}</text>'
        )

    for value in y_tick_values:
        y = map_y(value)
        parts.append(
            f'<line x1="{left - 6}" y1="{y:.1f}" x2="{left}" y2="{y:.1f}" stroke="#333"/>'
        )
        parts.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_w}" y2="{y:.1f}" stroke="#eee"/>'
        )
        parts.append(
            f'<text x="{left - 10}" y="{y + 4:.1f}" font-family="Segoe UI, Arial, sans-serif" font-size="11" text-anchor="end">{value:.3g}</text>'
        )

    legend_y = top
    for index, (label, series, color) in enumerate(series_list):
        if not series:
            continue
        points = " ".join(f"{map_x(epoch):.1f},{map_y(value):.1f}" for epoch, value in series)
        parts.append(
            f'<polyline fill="none" stroke="{color}" stroke-width="2.5" points="{points}"/>'
        )
        for epoch, value in series:
            parts.append(
                f'<circle cx="{map_x(epoch):.1f}" cy="{map_y(value):.1f}" r="3.5" fill="{color}"/>'
            )
        ly = legend_y + index * 20
        parts.append(
            f'<rect x="{left + plot_w + 16}" y="{ly - 10}" width="12" height="12" fill="{color}"/>'
        )
        parts.append(
            f'<text x="{left + plot_w + 34}" y="{ly}" font-family="Segoe UI, Arial, sans-serif" font-size="12">{label}</text>'
        )

    parts.append("</svg>\n")
    return "\n".join(parts)


def _markdown_report(summary: dict) -> str:
    a = summary["A"]
    b = summary["B"]
    winner = summary["winner_by_best_val_acc"]
    lines = [
        "# Guesser small-dataset A/B comparison",
        "",
        f"- Prepared from checkpoint root: `{summary['checkpoint_root']}`",
        f"- Winner by best validation accuracy: **{winner}**",
        "- Curves merge all Lightning `logs/version_*/metrics.csv` files so resumed runs keep early epochs.",
        "",
        "| Run | Best val_acc | Epoch | Val loss @ best | Log files merged |",
        "| --- | ---: | ---: | ---: | --- |",
        (
            f"| A complete-only | {a['best_val_acc']} | {a['best_val_acc_epoch']} | "
            f"{a['best_val_loss_at_best_acc']} | {len(a['metrics_csvs'])} |"
        ),
        (
            f"| B partial | {b['best_val_acc']} | {b['best_val_acc_epoch']} | "
            f"{b['best_val_loss_at_best_acc']} | {len(b['metrics_csvs'])} |"
        ),
        "",
        "Plots: `val_acc.svg`, `val_loss.svg` (and per-run SVGs).",
        "",
        "Note: this compares Lightning validation on **complete** validation views during training. "
        "Full ten-stage / held-out evaluation remains the Validation owner's protocol.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    args = parse_args()
    root = args.checkpoint_root
    output_dir = args.output_dir or (root / "ab_comparison")
    output_dir.mkdir(parents=True, exist_ok=True)

    run_payload: dict[str, dict] = {}
    for label, folder in RUN_DIRS.items():
        run_dir = root / folder
        rows, metrics_csvs = _merged_rows(run_dir)
        stats = _best_val(rows)
        selection = _load_selection(run_dir)
        val_acc = _epoch_series(rows, "val_acc")
        val_loss = _epoch_series(rows, "val_loss")
        run_payload[label] = {
            **stats,
            "metrics_csvs": metrics_csvs,
            "selection": selection,
            "val_acc_curve": val_acc,
            "val_loss_curve": val_loss,
        }
        color = "#1f77b4" if label == "A" else "#ff7f0e"
        name = "A complete-only" if label == "A" else "B partial"
        (output_dir / f"{label}_val_acc.svg").write_text(
            _svg_chart(
                [(name, val_acc, color)],
                title=f"{name} validation accuracy",
                y_label="val_acc",
            ),
            encoding="utf-8",
        )
        (output_dir / f"{label}_val_loss.svg").write_text(
            _svg_chart(
                [(name, val_loss, color)],
                title=f"{name} validation loss",
                y_label="val_loss",
            ),
            encoding="utf-8",
        )

    a_best = run_payload["A"]["best_val_acc"]
    b_best = run_payload["B"]["best_val_acc"]
    if a_best is None and b_best is None:
        winner = "none"
    elif a_best is None:
        winner = "B"
    elif b_best is None:
        winner = "A"
    elif b_best > a_best:
        winner = "B"
    elif a_best > b_best:
        winner = "A"
    else:
        winner = "tie"

    summary = {
        "checkpoint_root": str(root.resolve()),
        "winner_by_best_val_acc": winner,
        "A": {
            "best_val_acc": run_payload["A"]["best_val_acc"],
            "best_val_acc_epoch": run_payload["A"]["best_val_acc_epoch"],
            "best_val_loss_at_best_acc": run_payload["A"]["best_val_loss_at_best_acc"],
            "metrics_csvs": run_payload["A"]["metrics_csvs"],
            "selection": run_payload["A"]["selection"],
            "val_epochs": [epoch for epoch, _ in run_payload["A"]["val_acc_curve"]],
        },
        "B": {
            "best_val_acc": run_payload["B"]["best_val_acc"],
            "best_val_acc_epoch": run_payload["B"]["best_val_acc_epoch"],
            "best_val_loss_at_best_acc": run_payload["B"]["best_val_loss_at_best_acc"],
            "metrics_csvs": run_payload["B"]["metrics_csvs"],
            "selection": run_payload["B"]["selection"],
            "val_epochs": [epoch for epoch, _ in run_payload["B"]["val_acc_curve"]],
        },
    }

    (output_dir / "val_acc.svg").write_text(
        _svg_chart(
            [
                ("A complete-only", run_payload["A"]["val_acc_curve"], "#1f77b4"),
                ("B partial", run_payload["B"]["val_acc_curve"], "#ff7f0e"),
            ],
            title="Validation accuracy: A vs B",
            y_label="val_acc",
        ),
        encoding="utf-8",
    )
    (output_dir / "val_loss.svg").write_text(
        _svg_chart(
            [
                ("A complete-only", run_payload["A"]["val_loss_curve"], "#1f77b4"),
                ("B partial", run_payload["B"]["val_loss_curve"], "#ff7f0e"),
            ],
            title="Validation loss: A vs B",
            y_label="val_loss",
        ),
        encoding="utf-8",
    )

    summary_path = output_dir / "comparison-summary.json"
    report_path = output_dir / "comparison.md"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    report_path.write_text(_markdown_report(summary), encoding="utf-8")

    print(f"Wrote {summary_path}")
    print(f"Wrote {report_path}")
    print(f"Wrote plots under {output_dir}")
    print(f"A val epochs: {summary['A']['val_epochs']}")
    print(f"B val epochs: {summary['B']['val_epochs']}")
    print(f"Best val_acc — A: {a_best} | B: {b_best} | winner: {winner}")


if __name__ == "__main__":
    main()
