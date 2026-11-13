from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageDraw

from .common import object_hash
from .settings import DEFAULT_PREPROCESSOR, PREPROCESS_DEFAULTS


def cut_prefix(record: dict, fraction: float) -> list:
    """Include points at or before the elapsed-time cutoff, keeping strokes separate."""
    if not 0 <= fraction <= 1:
        raise ValueError("fraction outside [0,1]")
    strokes = record["drawing"]
    start_time = strokes[0][2][0]
    end_time = strokes[-1][2][-1]
    cutoff = fraction * (end_time - start_time)
    prefix = []
    for x_values, y_values, times in strokes:
        point_count = sum((time_ms - start_time) <= cutoff for time_ms in times)
        if point_count:
            prefix.append(
                [x_values[:point_count], y_values[:point_count], times[:point_count]]
            )
    return prefix


def render_qd(
    prefix: list,
    width: float = PREPROCESS_DEFAULTS["evaluation_width"],
    config: dict | None = None,
) -> Image.Image:
    """Fit only the visible points to a 512-pixel canvas, with 2x antialiasing."""
    settings = candidate_config(DEFAULT_PREPROCESSOR, config)
    minimum = settings["training_width_min"]
    maximum = settings["training_width_max"]
    if not minimum <= width <= maximum:
        raise ValueError(f"width must be between {minimum} and {maximum} pixels")
    canvas_size = settings["render_canvas"]
    fit = settings["render_fit"]
    supersample = settings["render_supersample"]
    points = [
        (x, y) for x_values, y_values, _ in prefix for x, y in zip(x_values, y_values)
    ]
    canvas = Image.new(
        "RGB", (canvas_size * supersample, canvas_size * supersample), "white"
    )
    draw = ImageDraw.Draw(canvas)
    if points:
        x_min = min(x for x, y in points)
        x_max = max(x for x, y in points)
        y_min = min(y for x, y in points)
        y_max = max(y for x, y in points)
        span = max(x_max - x_min, y_max - y_min)
        scale = fit / span if span else 1
        center_x = x_min + (x_max - x_min) / 2
        center_y = y_min + (y_max - y_min) / 2
        radius = width * supersample / 2
        for x_values, y_values, _ in prefix:
            coordinates = [
                (
                    (canvas_size / 2 + (x - center_x) * scale) * supersample,
                    (canvas_size / 2 + (y - center_y) * scale) * supersample,
                )
                for x, y in zip(x_values, y_values)
            ]
            if len(coordinates) > 1:
                draw.line(
                    coordinates,
                    fill="black",
                    width=round(width * supersample),
                    joint="curve",
                )
            for x, y in coordinates:
                draw.ellipse(
                    (x - radius, y - radius, x + radius, y + radius), fill="black"
                )
    return canvas.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)


def candidate_config(
    candidate: str = DEFAULT_PREPROCESSOR, config: dict | None = None
) -> dict:
    if candidate not in ("foreground", "edges"):
        raise ValueError("candidate must be 'foreground' or 'edges'")
    config = config or {}
    fixed = (
        "render_canvas",
        "render_fit",
        "render_supersample",
        "evaluation_width",
        "training_width_min",
        "training_width_max",
    )
    if set(config) - set(PREPROCESS_DEFAULTS):
        raise ValueError("unknown candidate config option")
    if any(k in config and config[k] != PREPROCESS_DEFAULTS[k] for k in fixed):
        raise ValueError("render convention is fixed")
    return {
        "version": "shape-candidates-v1",
        "candidate": candidate,
        **PREPROCESS_DEFAULTS,
        **config,
    }


def candidate_hash(
    candidate: str = DEFAULT_PREPROCESSOR, config: dict | None = None
) -> str:
    return object_hash(candidate_config(candidate, config))


def preprocess(
    image: Image.Image,
    candidate: str = DEFAULT_PREPROCESSOR,
    config: dict | None = None,
) -> dict:
    """Extract visible shapes or boundaries and produce a normalized model image."""
    settings = candidate_config(candidate, config)
    # Capture the source size before thumbnailing: `thumbnail` mutates in place,
    # and the heatmap frame has to be expressed in the original canvas pixels.
    source_size = image.size
    working_image = image.convert("RGB")
    working_image.thumbnail(
        (settings["working_size"], settings["working_size"]), Image.Resampling.LANCZOS
    )
    pixels = np.asarray(working_image, dtype=np.uint8)
    diagnostics: dict[str, object] = {
        "candidate": candidate,
        "config_hash": object_hash(settings),
    }
    if candidate == "foreground":
        foreground = _background_mask(pixels, settings, diagnostics)
        if foreground is None:
            return {"status": "uncertain", "image": None, "diagnostics": diagnostics}
    else:
        foreground = _edge_mask(pixels, settings)

    coverage = float(foreground.mean())
    diagnostics["coverage"] = coverage
    if not foreground.any():
        return {"status": "blank", "image": None, "diagnostics": diagnostics}
    if coverage > settings["dense_limit"]:
        return {"status": "uncertain", "image": None, "diagnostics": diagnostics}
    box = _foreground_box(foreground)
    return {
        "status": "ok",
        "image": _fit_foreground(foreground, settings, box),
        "frame": _frame(box, settings, source_size, working_image.size),
        "diagnostics": diagnostics,
    }


def _foreground_box(foreground: np.ndarray) -> tuple[int, int, int, int]:
    """Return the ink bounding box as (x0, y0, x1, y1) in working pixels."""
    y_values, x_values = np.nonzero(foreground)
    return (
        int(x_values.min()),
        int(y_values.min()),
        int(x_values.max()) + 1,
        int(y_values.max()) + 1,
    )


def _frame(
    box: tuple[int, int, int, int],
    settings: dict,
    source_size: tuple[int, int],
    working_size: tuple[int, int],
) -> dict[str, dict[str, float]]:
    """Map the model's square input back onto the source canvas.

    The adapter crops to the ink, scales it to `fit`, and centre-pads into the
    square output, so a heatmap cell only means something once that transform is
    inverted. `frame` covers the whole square input, padding included; `content`
    covers just the drawing, so a viewer can clip the blank margin instead of
    painting it as attention.
    """
    source_width, source_height = source_size
    working_width, working_height = working_size
    x0, y0, x1, y1 = box
    scale_x = source_width / working_width
    scale_y = source_height / working_height
    width = x1 - x0
    height = y1 - y0
    scale = settings["fit"] / max(width, height)
    pad_x = (settings["output"] - round(width * scale)) / 2
    pad_y = (settings["output"] - round(height * scale)) / 2
    return {
        "frame": {
            "x": round((x0 - pad_x / scale) * scale_x, 3),
            "y": round((y0 - pad_y / scale) * scale_y, 3),
            "width": round((settings["output"] / scale) * scale_x, 3),
            "height": round((settings["output"] / scale) * scale_y, 3),
        },
        "content": {
            "x": round(x0 * scale_x, 3),
            "y": round(y0 * scale_y, 3),
            "width": round(width * scale_x, 3),
            "height": round(height * scale_y, 3),
        },
    }


def _background_mask(
    pixels: np.ndarray, settings: dict, diagnostics: dict[str, object]
) -> np.ndarray | None:
    height, width = pixels.shape[:2]
    border_width = min(settings["border"], max(1, min(height, width) // 2))
    border = np.zeros((height, width), bool)
    border[:border_width] = True
    border[-border_width:] = True
    border[:, :border_width] = True
    border[:, -border_width:] = True
    border_pixels = pixels[border]
    quantized = border_pixels.astype(np.int16) // settings["quantization"]
    bins, counts = np.unique(quantized, axis=0, return_counts=True)
    dominant_index = int(np.argmax(counts))
    support = float(counts[dominant_index] / len(quantized))
    diagnostics["border_support"] = support
    if support < settings["uniformity"]:
        return None
    dominant_bin = bins[dominant_index]
    background_pixels = border_pixels[np.all(quantized == dominant_bin, axis=1)]
    background = np.median(background_pixels, axis=0)
    diagnostics["background"] = background.tolist()
    return (
        np.linalg.norm((pixels.astype(np.float32) - background) / 255, axis=2)
        > settings["distance"]
    )


def _edge_mask(pixels: np.ndarray, settings: dict) -> np.ndarray:
    foreground = np.zeros(pixels.shape[:2], bool)
    for channel in range(3):
        foreground |= (
            cv2.Canny(
                pixels[:, :, channel], settings["canny_low"], settings["canny_high"]
            )
            > 0
        )
    frame_width = settings["frame"]
    if frame_width:
        foreground[:frame_width] = False
        foreground[-frame_width:] = False
        foreground[:, :frame_width] = False
        foreground[:, -frame_width:] = False
    return foreground


def _fit_foreground(
    foreground: np.ndarray,
    settings: dict,
    box: tuple[int, int, int, int] | None = None,
) -> np.ndarray:
    """Crop to the ink box, scale to fit, and centre-pad into the square input."""
    if box is None:
        box = _foreground_box(foreground)
    crop = Image.fromarray(np.where(foreground, 0, 255).astype(np.uint8)).crop(box)
    scale = settings["fit"] / max(crop.size)
    width, height = crop.size
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    crop = crop.resize(size, Image.Resampling.LANCZOS)
    padded = Image.new("L", (settings["output"], settings["output"]), 255)
    padded.paste(
        crop, ((settings["output"] - size[0]) // 2, (settings["output"] - size[1]) // 2)
    )
    pixels = np.asarray(padded, dtype=np.float32) / 255
    normalized = (pixels - settings["mean"]) / settings["std"]
    return np.repeat(normalized[None, :, :], 3, axis=0).astype(np.float32)
