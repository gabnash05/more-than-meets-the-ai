"""Plot Referee Lightning metrics from the CSV logger as standalone SVG files."""

from __future__ import annotations

import argparse
import csv
import html
import math
import re
from pathlib import Path


DEFAULT_RUN_DIR = Path(__file__).resolve().parents[1] / "checkpoints" / "referee_run"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plot epoch-level Referee metrics from Lightning CSV logs."
    )
    parser.add_argument(
        "--run-dir",
        type=Path,
        default=DEFAULT_RUN_DIR,
        help="Training run directory containing logs/version_*/metrics.csv.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Where to write plots (default: <run-dir>/metric_plots).",
    )
    return parser.parse_args()


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return [
            {(key or "").strip(): (value or "").strip() for key, value in row.items()}
            for row in csv.DictReader(handle)
        ]


def _metric_series(
    rows: list[dict[str, str]], metric: str
) -> list[tuple[int, float]]:
    """Return the last logged value for each epoch, ignoring step-only rows."""
    by_epoch: dict[int, float] = {}
    for row in rows:
        try:
            epoch = int(float(row["epoch"]))
            value = float(row[metric])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(value):
            by_epoch[epoch] = value
    return sorted(by_epoch.items())


def _svg_chart(metric: str, series: list[tuple[int, float]]) -> str:
    width, height = 880, 440
    left, right, top, bottom = 76, 32, 58, 64
    plot_width, plot_height = width - left - right, height - top - bottom
    xs, ys = [x for x, _ in series], [y for _, y in series]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    if x_min == x_max:
        x_min, x_max = x_min - 0.5, x_max + 0.5
    else:
        padding = (x_max - x_min) * 0.05
        x_min, x_max = x_min - padding, x_max + padding
    if math.isclose(y_min, y_max):
        padding = max(abs(y_min) * 0.05, 0.001)
    else:
        padding = (y_max - y_min) * 0.08
    y_min, y_max = y_min - padding, y_max + padding

    def map_x(epoch: float) -> float:
        return left + (epoch - x_min) / (x_max - x_min) * plot_width

    def map_y(value: float) -> float:
        return top + plot_height - (value - y_min) / (y_max - y_min) * plot_height

    title = html.escape(metric.replace("_", " ").title())
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#fff"/>',
        '<g font-family="Segoe UI, Arial, sans-serif" fill="#222">',
        f'<text x="{left}" y="30" font-size="18" font-weight="600">{title} by epoch</text>',
        f'<text x="20" y="{top + plot_height / 2:.1f}" font-size="12" text-anchor="middle" transform="rotate(-90 20 {top + plot_height / 2:.1f})">{html.escape(metric)}</text>',
        f'<text x="{left + plot_width / 2}" y="{height - 16}" font-size="12" text-anchor="middle">epoch</text>',
        f'<line x1="{left}" y1="{top + plot_height}" x2="{left + plot_width}" y2="{top + plot_height}" stroke="#333"/>',
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top + plot_height}" stroke="#333"/>',
    ]
    for index in range(5):
        value = y_min + (y_max - y_min) * index / 4
        y = map_y(value)
        parts.extend([
            f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_width}" y2="{y:.1f}" stroke="#e8e8e8"/>',
            f'<text x="{left - 10}" y="{y + 4:.1f}" font-size="11" text-anchor="end">{value:.4g}</text>',
        ])
    for epoch in xs:
        x = map_x(epoch)
        parts.append(f'<text x="{x:.1f}" y="{top + plot_height + 22}" font-size="11" text-anchor="middle">{epoch}</text>')
    points = " ".join(f"{map_x(epoch):.1f},{map_y(value):.1f}" for epoch, value in series)
    parts.append(f'<polyline fill="none" stroke="#1f77b4" stroke-width="2.5" points="{points}"/>')
    for epoch, value in series:
        parts.append(f'<circle cx="{map_x(epoch):.1f}" cy="{map_y(value):.1f}" r="4" fill="#1f77b4"/>')
    parts.extend(["</g>", "</svg>", ""])
    return "\n".join(parts)


def main() -> None:
    args = parse_args()
    log_dir = args.run_dir / "logs"
    paths = sorted(log_dir.glob("**/metrics.csv"), key=lambda path: path.stat().st_mtime)
    if not paths:
        raise FileNotFoundError(f"No metrics.csv files found under {log_dir}")

    # Later logger versions overwrite earlier values for the same epoch.
    merged_rows = [row for path in paths for row in _read_rows(path)]
    metrics = sorted(
        {key for row in merged_rows for key in row}
        - {"epoch", "step"}
    )
    output_dir = args.output_dir or args.run_dir / "metric_plots"
    output_dir.mkdir(parents=True, exist_ok=True)
    plotted: list[str] = []
    for metric in metrics:
        series = _metric_series(merged_rows, metric)
        if not series:
            continue
        filename = re.sub(r"[^a-zA-Z0-9_.-]+", "_", metric).strip("_.")
        (output_dir / f"{filename}.svg").write_text(
            _svg_chart(metric, series), encoding="utf-8"
        )
        plotted.append(metric)

    if not plotted:
        raise ValueError(f"No epoch-level numeric metrics found in {len(paths)} CSV file(s).")
    print(f"Merged {len(paths)} metrics CSV file(s).")
    print(f"Wrote {len(plotted)} metric plot(s) to {output_dir}")
    print("Metrics: " + ", ".join(plotted))


if __name__ == "__main__":
    main()
