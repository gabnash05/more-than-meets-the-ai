"""CPU adapter for a safely exported validation-selected ViT-Tiny checkpoint."""

import json
import os
from collections.abc import Callable
from importlib import import_module
from pathlib import Path

from PIL import Image

BACKBONE = "vit_tiny_patch16_224.augreg_in21k_ft_in1k"


def _configure_cpu_threads(set_num_threads: Callable[[int], None]) -> None:
    """Use all process-visible CPUs for PyTorch intra-op work."""
    # Prefer the process-available count, then system count, and finally one.
    process_cpu_count = getattr(os, "process_cpu_count", None)
    process_available = process_cpu_count() if process_cpu_count else None
    thread_count = process_available or os.cpu_count() or 1
    # Set the pool before model loading and warm-up so inference shares it.
    set_num_threads(thread_count)


def validate_selection(selection: dict, manifest: dict, labels: list[str]) -> None:
    """Require the bundled selection record to match the serving manifest."""
    if (
        selection.get("backbone") != BACKBONE
        or selection.get("preprocess_candidate") != manifest.get("preprocessing")
        or selection.get("labels_sha256") != manifest.get("files", {}).get("labels.json")
        or selection.get("num_classes") != len(labels)
        or selection.get("fast_dev")
        or not selection.get("best_model_path")
        or selection.get("best_model_score") is None
    ):
        raise ValueError("checkpoint-selection-mismatch")


class ViTTiny:
    def __init__(self, root: Path, manifest: dict, labels: list[str]):
        import timm
        import torch
        from safetensors.torch import load_file

        self.torch = torch
        _configure_cpu_threads(torch.set_num_threads)
        self.labels = labels
        self.images = import_module("models.guesser.data.src.06-images")
        self.candidate = manifest["preprocessing"]
        selection = json.loads((root / "checkpoint-selection.json").read_text(encoding="utf-8"))
        validate_selection(selection, manifest, labels)
        if self.images.candidate_hash(self.candidate) != manifest.get("preprocessingConfigHash"):
            raise ValueError("preprocessing-config-mismatch")
        self.model = timm.create_model(BACKBONE, pretrained=False, num_classes=len(labels))
        self.model.load_state_dict(load_file(root / "weights.safetensors", device="cpu"), strict=True)
        self.model.eval()
        self.classify(torch.zeros((1, 3, 224, 224)))

    def classify(self, batch) -> tuple[str, float]:
        with self.torch.inference_mode():
            output = self.model(batch)
        if tuple(output.shape) != (1, len(self.labels)) or not self.torch.isfinite(output).all():
            raise ValueError("invalid-model-output")
        probabilities = self.torch.softmax(output, dim=1)
        confidence, index = probabilities.max(dim=1)
        return self.labels[index.item()], confidence.item()

    def predict(self, image: Image.Image) -> dict:
        sample = self.images.preprocess(image, self.candidate)
        if sample["status"] != "ok":
            return {"status": "pass", "reason": "no-evidence"}
        batch = self.torch.from_numpy(sample["image"]).unsqueeze(0)
        answer, confidence = self.classify(batch)
        return {"status": "answer", "answer": answer, "confidence": confidence}
