"""Reproduce the offline source/polarity and preprocessing visual audit."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from referee_data import preprocess, preprocessing_config, preprocessing_hash


def thumbnail_tensor(result: dict) -> Image.Image:
    if result["image"] is None:
        return Image.new("RGB", (224, 224), "#dddddd")
    config = preprocessing_config()["foreground"]
    pixels = np.clip((result["image"][0] * config["std"] + config["mean"]) * 255, 0, 255)
    return Image.fromarray(pixels.astype(np.uint8)).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    root = args.repository.resolve()
    output = args.output_dir or root / "models/referee/data/.local/repair-audit-20261111"
    output.mkdir(parents=True, exist_ok=True)
    sources = []
    prepared = root / "models/referee/data/.local/data/sample/prepared"
    for split in ("train", "validation"):
        path = prepared / "manifests" / f"{split}.jsonl"
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                row = json.loads(line)
                sources.append((row["sample_id"], prepared / row["image_path"]))
    metadata = json.loads((root / "docs/referee/inspection/summary.json").read_text(encoding="utf-8"))
    for row in metadata["samples"]:
        if row["variant"].endswith("/train"):
            sources.append((row["variant"] + ":" + row["path"], root / "docs/referee/samples" / row["preview"]))
    results = []
    for offset in range(0, len(sources), 8):
        batch = sources[offset:offset + 8]
        sheet = Image.new("RGB", (620, 8 * 250), "#eeeeee")
        draw = ImageDraw.Draw(sheet)
        for index, (sample_id, path) in enumerate(batch):
            with Image.open(path) as source:
                image = source.convert("RGB")
            result = preprocess(image)
            inverted = preprocess(ImageOps.invert(image))
            delta = None
            if result["image"] is not None and inverted["image"] is not None:
                delta = float(np.max(np.abs(result["image"] - inverted["image"])))
            results.append({"sample_id": sample_id, "path": str(path.relative_to(root)),
                "png_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "status": result["status"], "inverted_status": inverted["status"],
                "polarity_max_abs_difference": delta})
            image.thumbnail((224, 224))
            sheet.paste(image, (0, index * 250))
            sheet.paste(thumbnail_tensor(result), (300, index * 250))
            draw.text((0, index * 250 + 226), sample_id + " | " + result["status"], fill="black")
        sheet.save(output / f"source-canonical-{offset // 8 + 1}.png")
    stresses = []
    sheet = Image.new("RGB", (620, 12 * 250), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    names = ("blank", "gray-blank", "thin", "tiny-digits", "edge-writing", "red", "blue", "light-gray", "very-faint", "transparent", "large-text", "circle")
    for index, name in enumerate(names):
        image = Image.new("RGBA" if name == "transparent" else "RGB", (1024, 768),
            (0, 0, 0, 0) if name == "transparent" else "#eeeeee" if name == "gray-blank" else "white")
        brush = ImageDraw.Draw(image)
        size = 8 if name == "tiny-digits" else 80 if name == "large-text" else 20
        font = ImageFont.load_default(size=size)
        if name not in ("blank", "gray-blank", "circle"):
            color = {"red": "red", "blue": "blue", "light-gray": "#bbbbbb", "very-faint": "#eeeeee"}.get(name, "black")
            brush.text((0, 0) if name == "edge-writing" else (350, 300), "123 HELLO", font=font, fill=color)
        if name == "circle":
            brush.ellipse((250, 150, 750, 650), outline="black", width=6)
        result = preprocess(image)
        stresses.append({"case": name, "status": result["status"], "diagnostics": result["diagnostics"]})
        background = Image.new("RGBA", image.size, "white")
        background.alpha_composite(image.convert("RGBA"))
        background = background.convert("RGB")
        background.thumbnail((224, 224))
        sheet.paste(background, (0, index * 250))
        sheet.paste(thumbnail_tensor(result), (300, index * 250))
        draw.text((0, index * 250 + 226), name + " | " + result["status"], fill="black")
    sheet.save(output / "preprocess-stress.png")
    report = {"schema": "referee-visual-audit-v1", "preprocessing_config": preprocessing_config(),
        "preprocessing_hash": preprocessing_hash(), "sources": results, "stress_cases": stresses,
        "limits": "Training-source development audit only; synthetic probes are not accuracy. No held-out images read."}
    (output / "visual-audit.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sources": len(results), "polarity_differences": [r for r in results if r["polarity_max_abs_difference"] != 0],
        "stress_statuses": {r["case"]: r["status"] for r in stresses}, "output": str(output)}, indent=2))


if __name__ == "__main__":
    main()
