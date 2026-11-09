"""Inference for the pinned Quick, Draw! smoke-test classifier."""

from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

REVISION = "b02fde8d8732aed32bc9d8176c3dc4efda0333fb"
HASHES = {
    "model.tflite": "aa58c3f7b710dee642db88ef7d30b7a4feea9c25bbed24e75c66fe4cd53fb701",
    "labels.txt": "2ed0dac4ba018854a3e3166f9862e5529bc5f58a80d157d57eee22ca731895d5",
    "model_metadata.json": "d600a87a4572896aeb9293c7712901539fbd9ed0beb8b81797c3459ebb69fb96",
}


def prepare(image: Image.Image) -> np.ndarray | None:
    # The publisher trains on normalized Google bitmaps with light ink on black.
    inverted = ImageOps.invert(ImageOps.grayscale(image))
    bounds = inverted.getbbox()
    if bounds is None:
        return None
    cropped = inverted.crop(bounds)
    cropped.thumbnail((24, 24), Image.Resampling.LANCZOS)
    canvas = Image.new("L", (28, 28))
    canvas.paste(cropped, ((28 - cropped.width) // 2, (28 - cropped.height) // 2))
    return np.asarray(canvas, dtype=np.float32).reshape(1, 28, 28, 1) / 255.0


class QuickDraw:
    def __init__(self, path: Path, labels: list[str]):
        from ai_edge_litert.interpreter import Interpreter

        self.labels = labels
        self.interpreter = Interpreter(model_path=str(path), num_threads=1)
        self.interpreter.allocate_tensors()
        (self.input,) = self.interpreter.get_input_details()
        (self.output,) = self.interpreter.get_output_details()
        if tuple(self.input["shape"]) != (1, 28, 28, 1) or tuple(self.output["shape"]) != (1, 345):
            raise ValueError("tensor-shape-mismatch")
        for detail in (self.input, self.output):
            dtype = detail["dtype"]
            if dtype not in (np.float32, np.int8, np.uint8):
                raise ValueError("unsupported-tensor-dtype")
            scale, _ = detail["quantization"]
            if dtype != np.float32 and not (np.isfinite(scale) and scale > 0):
                raise ValueError("invalid-tensor-quantization")
        # Invoke once before reporting readiness so the first game request uses a warm interpreter.
        self.classify(np.zeros((1, 28, 28, 1), dtype=np.float32))

    def classify(self, pixels: np.ndarray) -> tuple[str, float]:
        dtype = self.input["dtype"]
        if dtype != np.float32:
            scale, zero = self.input["quantization"]
            limits = np.iinfo(dtype)
            pixels = np.clip(np.rint(pixels / scale + zero), limits.min, limits.max).astype(dtype)
        self.interpreter.set_tensor(self.input["index"], pixels)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(self.output["index"])
        if not np.isfinite(scores).all():
            raise ValueError("nonfinite-output")
        if self.output["dtype"] != np.float32:
            scale, zero = self.output["quantization"]
            scores = (scores.astype(np.float32) - zero) * scale
        index = int(np.argmax(scores))
        confidence = float(scores.flat[index])
        if not 0 <= confidence <= 1:
            raise ValueError("invalid-confidence")
        return self.labels[index], confidence

    def predict(self, image: Image.Image) -> dict:
        pixels = prepare(image)
        if pixels is None:
            return {"status": "pass", "reason": "no-evidence"}
        answer, confidence = self.classify(pixels)
        return {"status": "answer", "answer": answer, "confidence": confidence}
