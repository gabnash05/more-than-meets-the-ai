"""CPU adapter for a safely exported validation-selected ViT-Tiny checkpoint."""

import json
import os
from collections.abc import Callable
from importlib import import_module
from pathlib import Path

from PIL import Image

BACKBONE = "vit_tiny_patch16_224.augreg_in21k_ft_in1k"

# The backbone splits a 224px input into 16px patches, so attention resolves to
# a 14x14 token grid. Rollout keeps half of each block's residual stream, the
# usual weighting when the map is meant to show relative focus rather than a
# faithful path.
ATTENTION_GRID = 14
ROLLOUT_RESIDUAL = 0.5


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

    def classify(self, batch, with_attention: bool = False) -> tuple[str, float, list[dict], list[int] | None]:
        """Return the top-1 label, its probability, runner-ups, and an optional grid.

        Runner-ups are the next two classes, so a viewer can see what the model
        almost said. The caller decides who may see them: they narrow the answer
        down almost as well as the top-1 does.

        When ``with_attention`` is set, hooks capture each block's attention while
        the normal forward pass runs. The rollout is computed inside the same
        ``inference_mode`` block because inference tensors cannot be used outside
        it. Hooks are always removed, so a failed forward cannot leave them
        attached to the shared model.
        """
        torch = self.torch
        captured: list = []
        handles = []
        # A backbone without the expected projection can only lose the map, never
        # the answer, so fall back to a plain forward instead of raising.
        if with_attention and any(
            not hasattr(block.attn, "qkv")
            or not hasattr(block.attn, "num_heads")
            or not hasattr(block.attn, "head_dim")
            or not hasattr(block.attn, "scale")
            for block in self.model.blocks
        ):
            with_attention = False
        if with_attention:
            for block in self.model.blocks:
                handles.append(block.attn.qkv.register_forward_hook(self._capture(block, captured)))
        try:
            with torch.inference_mode():
                output = self.model(batch)
                if tuple(output.shape) != (1, len(self.labels)) or not torch.isfinite(output).all():
                    raise ValueError("invalid-model-output")
                probabilities = torch.softmax(output, dim=1)
                values, indices = probabilities.topk(3, dim=1)
                top_values = values[0].tolist()
                top_indices = indices[0].tolist()
                answer = self.labels[top_indices[0]]
                confidence = top_values[0]
                alternatives = [
                    {"answer": self.labels[top_indices[rank]], "confidence": top_values[rank]}
                    for rank in (1, 2)
                ]
                grid = self._attention_grid(captured) if with_attention else None
        finally:
            for handle in handles:
                handle.remove()
        return answer, confidence, alternatives, grid

    def _capture(self, block, sink: list):
        """Return a hook that appends one block's attention probabilities.

        Fused attention never calls the dropout module, so the map is rebuilt from
        the qkv projection: split it into query and key, scale their product, and
        softmax over the key axis. Reading a module's output cannot change what
        the model computes, and the extra matmul is a fraction of a block's work.
        """

        def hook(_module, _inputs, output) -> None:
            tokens = output.shape[1]
            heads = block.attn.num_heads
            shaped = output.reshape(output.shape[0], tokens, 3, heads, block.attn.head_dim).permute(2, 0, 3, 1, 4)
            scores = (shaped[0] @ shaped[1].transpose(-2, -1)) * block.attn.scale
            sink.append(scores.softmax(dim=-1))

        return hook

    def _attention_grid(self, captured: list) -> list[int]:
        """Fold per-block attention into one 14x14 map of relative focus.

        Rollout averages the heads, mixes in the residual stream with weight 0.5,
        multiplies the blocks together, then reads the CLS row, which is how much
        the classification token attended to each patch. Values are scaled so the
        strongest cell is 255 and returned row-major.
        """
        if len(captured) != len(self.model.blocks):
            return [0] * (ATTENTION_GRID * ATTENTION_GRID)
        torch = self.torch
        rolled = None
        for attention in captured:
            weights = attention.mean(dim=1)[0]
            identity = torch.eye(weights.shape[-1], dtype=weights.dtype)
            weights = ROLLOUT_RESIDUAL * weights + (1 - ROLLOUT_RESIDUAL) * identity
            rolled = weights if rolled is None else weights @ rolled
        if rolled is None:
            return [0] * (ATTENTION_GRID * ATTENTION_GRID)
        patches = rolled[0, 1:]
        patches = patches / patches.max().clamp(min=1e-12)
        scaled = (patches * 255).round().clamp(0, 255).to(torch.int32)
        return scaled.reshape(ATTENTION_GRID, ATTENTION_GRID).flatten().tolist()

    def predict(self, image: Image.Image) -> dict:
        sample = self.images.preprocess(image, self.candidate)
        if sample["status"] != "ok":
            return {"status": "pass", "reason": "no-evidence"}
        batch = self.torch.from_numpy(sample["image"]).unsqueeze(0)
        answer, confidence, alternatives, grid = self.classify(batch, with_attention=True)
        result = {"status": "answer", "answer": answer, "confidence": confidence, "alternatives": alternatives}
        geometry = sample.get("frame")
        if grid and geometry:
            result["heatmap"] = {"grid": grid, **geometry}
        return result
