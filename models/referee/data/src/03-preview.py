"""Build a small, local-only visual review of prepared training canvases."""

from __future__ import annotations

import html
import textwrap
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .common import DataError, iter_jsonl, load_step, resolve_relative
from .settings import Settings

MAX_PREVIEW_SAMPLES = 64
SHEET_COLUMNS = 4
SHEET_ROWS = 4
CELL_WIDTH = 420
CELL_HEIGHT = 325


def _label(value: Any, known: Any) -> str:
    if known is False or value is None:
        return "unknown"
    if value == 1:
        return "present"
    if value == 0:
        return "absent"
    return "invalid"


def _caption(row: dict[str, Any]) -> str:
    return (
        f"text: {_label(row.get('text_present'), _mask(row, 0))} | "
        f"number: {_label(row.get('number_present'), _mask(row, 1))}"
    )


def _mask(row: dict[str, Any], index: int) -> Any:
    mask = row.get("known_mask")
    return mask[index] if isinstance(mask, list) and len(mask) > index else None


def _make_sheet(rows: list[dict[str, Any]], prepared: Path, output: Path) -> None:
    sheet = Image.new(
        "RGB", (SHEET_COLUMNS * CELL_WIDTH, SHEET_ROWS * CELL_HEIGHT), "#f4f6f8"
    )
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, row in enumerate(rows):
        x = (index % SHEET_COLUMNS) * CELL_WIDTH
        y = (index // SHEET_COLUMNS) * CELL_HEIGHT
        try:
            path = resolve_relative(prepared, str(row["image_path"]))
            with Image.open(path) as source:
                canvas = source.convert("RGB").resize((190, 190))
                view = load_step("06-images").preprocess(source)
            if view["status"] == "ok":
                config = load_step("06-images").preprocessing_config()["foreground"]
                pixels = np.clip(
                    (view["image"][0] * config["std"] + config["mean"]) * 255, 0, 255
                ).astype(np.uint8)
                canonical = Image.fromarray(pixels).convert("RGB").resize((190, 190))
            else:
                canonical = Image.new("RGB", (190, 190), "#eeeeee")
        except (KeyError, OSError, DataError, TypeError, ValueError) as exc:
            raise DataError(
                f"Cannot read training preview image for {row.get('sample_id', index)}: {exc}"
            ) from exc
        sheet.paste(canvas, (x + 10, y + 18))
        sheet.paste(canonical, (x + 220, y + 18))
        draw.text((x + 10, y + 2), "SOURCE", fill="#17212b", font=font)
        draw.text(
            (x + 220, y + 2), f"CANONICAL: {view['status']}", fill="#17212b", font=font
        )
        draw.text((x + 10, y + 212), _caption(row), fill="#17212b", font=font)
        draw.text(
            (x + 10, y + 228),
            f"mask: {row.get('known_mask')}  origin: {row.get('label_origin')}",
            fill="#425466",
            font=font,
        )
        sample_id = str(row.get("sample_id", f"row {index + 1}"))
        for line_index, line in enumerate(
            textwrap.wrap(sample_id, width=58, break_long_words=True)
        ):
            draw.text(
                (x + 10, y + 245 + line_index * 13), line, fill="#425466", font=font
            )
        folder = str(row.get("provenance_folder", ""))
        draw.text((x + 10, y + 300), folder[:55], fill="#425466", font=font)
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", optimize=True)


def preview(settings: Settings) -> dict[str, Any]:
    """Create contact sheets and an index using only the training manifest."""
    manifest = settings.prepared / "manifests" / "train.jsonl"
    if not manifest.is_file():
        raise DataError(f"Training manifest is missing: {manifest}", "missing_manifest")
    rows = []
    for row in iter_jsonl(manifest):
        if not isinstance(row, dict):
            raise DataError(f"Training manifest contains a non-object row: {manifest}")
        if len(rows) < MAX_PREVIEW_SAMPLES:
            rows.append(row)
    preview_root = settings.previews
    preview_root.mkdir(parents=True, exist_ok=True)

    sheet_names: list[str] = []
    chunk_size = SHEET_COLUMNS * SHEET_ROWS
    for offset in range(0, len(rows), chunk_size):
        name = f"train-{offset // chunk_size + 1:03d}.png"
        _make_sheet(
            rows[offset : offset + chunk_size], settings.prepared, preview_root / name
        )
        sheet_names.append(name)

    sections = []
    for number, name in enumerate(sheet_names, start=1):
        start = (number - 1) * chunk_size
        count = min(chunk_size, len(rows) - start)
        sections.append(
            f"<section><h2>Training samples {start + 1}-{start + count}</h2>"
            f'<img src="{html.escape(name)}" alt="Training contact sheet {number}"></section>'
        )
    document = (
        """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Training data preview</title><style>
body{font:16px system-ui,sans-serif;max-width:980px;margin:2rem auto;padding:0 1rem;color:#17212b}
img{max-width:100%;height:auto;border:1px solid #d8dee5}section{margin:2rem 0}
</style></head><body><h1>Training data preview</h1>
<p>Training split only. Source and canonical preprocessing are shown side by side with status, IDs, masks and label origins. Each canvas shows text and number labels; unknown means the label is masked.</p>
"""
        + "\n".join(sections)
        + "\n</body></html>\n"
    )
    index_path = preview_root / "index.html"
    index_path.write_text(document, encoding="utf-8")
    return {
        "index": str(index_path),
        "contact_sheets": [str(preview_root / name) for name in sheet_names],
        "sample_count": len(rows),
        "sample_limit": MAX_PREVIEW_SAMPLES,
        "split": "train",
    }
