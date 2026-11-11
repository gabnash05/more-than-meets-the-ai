"""Reproducible 1024x768 referee canvas probes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch
from PIL import Image, ImageDraw, ImageFont, ImageOps
from referee_data import preprocess, preprocessing_config, preprocessing_hash
from torchvision.transforms import v2

from .checkpoint import load_model


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--checkpoint", type=Path)
    source.add_argument("--bundle", type=Path)
    parser.add_argument("--preprocessing", choices=("rgb_resize", "foreground"))
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "imageDimensions": [1024, 768],
        "font": "Pillow ImageFont.load_default, 100x20 raster resized to 600x120",
        "channels": ["text", "number"],
    }
    adapter = None
    if args.bundle:
        from inference.vit import RefereeViT

        manifest = json.loads(
            (args.bundle / "manifest.json").read_text(encoding="utf-8")
        )
        adapter = RefereeViT(
            args.bundle,
            manifest,
            (args.bundle / "labels.txt").read_text(encoding="utf-8").splitlines(),
        )
        candidate = (
            "foreground" if manifest["version"] == 2 else manifest["preprocessing"]
        )
        if args.preprocessing and args.preprocessing != candidate:
            raise ValueError("Requested preprocessing does not match bundle")
        is_v2 = manifest["version"] == 2
        model = adapter.model
        metadata.update(
            bundleManifestSha256=sha(args.bundle / "manifest.json"),
            bundleArtifactRevision=manifest["artifactRevision"],
            preprocessing=manifest["preprocessing"],
            preprocessingConfigHash=manifest["preprocessingConfigHash"],
        )
    else:
        payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
        provenance = payload.get("hyper_parameters", {}).get("provenance") or {}
        is_v2 = provenance.get("model_id") == "referee-vit-v2"
        if not is_v2 and args.preprocessing is None:
            raise ValueError(
                "Legacy checkpoints require explicit --preprocessing rgb_resize or foreground"
            )
        if is_v2 and (
            args.preprocessing not in (None, "foreground")
            or provenance.get("preprocessing_hash") != preprocessing_hash()
            or provenance.get("preprocessing_config") != preprocessing_config()
        ):
            raise ValueError("v2 checkpoint preprocessing mismatch")
        candidate = args.preprocessing or "foreground"
        model = load_model(args.checkpoint)
        metadata.update(
            checkpointSha256=sha(args.checkpoint),
            preprocessing=candidate,
            provenance=provenance,
        )
    if is_v2:
        metadata.update(
            preprocessingConfig=preprocessing_config(),
            preprocessingConfigHash=preprocessing_hash(),
        )
    font_image = Image.new("L", (100, 20), 255)
    ImageDraw.Draw(font_image).text(
        (0, 0), "HELLO", font=ImageFont.load_default(), fill=0
    )
    metadata["fontRasterSha256"] = hashlib.sha256(font_image.tobytes()).hexdigest()
    rgb = v2.Compose(
        [v2.Resize((224, 224)), v2.ToImage(), v2.ToDtype(torch.float32, scale=True)]
    )
    results = []
    for name in ("blank", "gray", "dot", "line", "circle", "hello", "digits"):
        image = Image.new("RGB", (1024, 768), "white")
        draw = ImageDraw.Draw(image)
        if name == "gray":
            image = Image.new("RGB", (1024, 768), "#eeeeee")
        elif name == "dot":
            draw.ellipse((510, 382, 514, 386), fill="black")
        elif name == "line":
            draw.line((100, 400, 900, 400), fill="black", width=6)
        elif name == "circle":
            draw.ellipse((250, 150, 750, 650), outline="black", width=6)
        elif name in ("hello", "digits"):
            raster = Image.new("L", (100, 20), 255)
            ImageDraw.Draw(raster).text(
                (0, 0),
                "HELLO" if name == "hello" else "12345",
                font=ImageFont.load_default(),
                fill=0,
            )
            image.paste(raster.resize((600, 120)).convert("RGB"), (200, 300))
        for inverted in (False, True):
            view = ImageOps.invert(image) if inverted else image.copy()
            filename = name + ("-inverted" if inverted else "") + ".png"
            view.save(args.output_dir / filename)
            if adapter:
                batch = adapter._image_batch(view)
                status = "no-evidence" if batch is None else "ok"
            elif candidate == "rgb_resize":
                batch, status = rgb(view).unsqueeze(0), "ok"
            else:
                if is_v2:
                    prepared = preprocess(view)
                else:
                    from guesser_data import preprocess as legacy_preprocess

                    prepared = legacy_preprocess(view, candidate="foreground")
                status = prepared["status"]
                batch = (
                    None
                    if prepared["image"] is None
                    else torch.as_tensor(prepared["image"]).float().unsqueeze(0)
                )
            scores = None
            if batch is not None:
                with torch.inference_mode():
                    scores = model(batch).sigmoid()[0].tolist()
                if len(scores) not in (2, 4):
                    raise ValueError("Unexpected model output shape")
            results.append(
                {
                    "file": filename,
                    "imageSha256": sha(args.output_dir / filename),
                    "status": status,
                    "scores": scores,
                    "scoreOrder": ["text", "number", "symbol", "circle"]
                    if scores is not None and len(scores) == 4
                    else ["text", "number"],
                }
            )
    (args.output_dir / "scores.json").write_text(
        json.dumps({"metadata": metadata, "results": results}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(args.output_dir / "scores.json")


if __name__ == "__main__":
    main()
