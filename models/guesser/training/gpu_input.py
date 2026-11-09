"""Deferred per-image affine execution with unchanged CPU worker RNG."""

from functools import lru_cache
from typing import Any, cast

import torch
from torch.utils.data import default_collate
from torchvision.transforms import v2
from torchvision.transforms.v2 import functional as VF


def sample_affine_params(
    transform: v2.RandomAffine, image: torch.Tensor
) -> dict[str, Any]:
    """Sample with the existing transform and CPU worker RNG."""
    if image.device.type != "cpu":
        raise ValueError("Sample augmentation parameters in the CPU data worker")
    return transform.make_params([image])


def collate_deferred_affine(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Keep per-image affine values as Python objects during transfer."""
    batch = default_collate(
        [
            {key: value for key, value in row.items() if key != "_affine_params"}
            for row in rows
        ]
    )
    batch["_affine_params"] = [row["_affine_params"] for row in rows]
    return batch


def apply_cuda_affine(
    images: torch.Tensor,
    params: list[dict[str, Any]],
    transform: v2.RandomAffine,
) -> torch.Tensor:
    """Apply independently sampled transforms; caller must verify exactness."""
    if images.device.type != "cuda" or images.dtype != torch.float32:
        raise ValueError("Exact baseline requires CUDA float32 images")
    if images.ndim != 4 or len(params) != images.shape[0]:
        raise ValueError("Each image requires its own affine parameters")
    # The Trainer uses "high" matmul precision for the model. TF32 on affine
    # grid construction changes nearest-neighbor indices at pixel boundaries.
    # Scope IEEE float32 to this transform, restoring the MODEL policy even on
    # error. All kernels are dispatched on the training process's model stream.
    previous = torch.get_float32_matmul_precision()
    try:
        torch.set_float32_matmul_precision("highest")
        return torch.stack(
            [
                VF.affine(
                    image,
                    **parameters,
                    interpolation=transform.interpolation,
                    fill=cast(Any, transform.fill),
                    center=transform.center,
                )
                for image, parameters in zip(images, params, strict=True)
            ]
        )
    finally:
        torch.set_float32_matmul_precision(previous)


def cuda_affine_admission() -> tuple[bool, str]:
    """Run a cached backend regression gate; this is not an exhaustive proof.

    The production recipe is fixed at 224 pixels, nearest interpolation, no
    shear and zero fill. Refuse a mismatching device rather than approximate.
    Throughput remains a separate benchmark, never inferred from this check.
    """
    if not torch.cuda.is_available():
        return False, "CUDA is unavailable"
    return _probe_affine(torch.cuda.current_device())


@lru_cache(maxsize=8)
def _probe_affine(device: int) -> tuple[bool, str]:
    """Compare unique source indices at recipe boundaries and fixed random draws."""
    # Unique positive pixels expose every wrong nearest-neighbor index and fill.
    image = torch.arange(1, 224 * 224 + 1, dtype=torch.float32).reshape(1, 224, 224)
    gpu = image.unsqueeze(0).to(torch.device("cuda", device))
    transform = v2.RandomAffine((-10.0, 10.0), translate=(0.05, 0.05), scale=(0.9, 1.1))
    params = [
        {
            "angle": angle,
            "translate": (offset, -offset),
            "scale": scale,
            "shear": (0.0, 0.0),
        }
        for angle in (-10.0, -5.0, 0.0, 5.0, 10.0)
        for scale in (0.9, 0.9999999, 1.0, 1.0000001, 1.1)
        for offset in (-11, 0, 11)
    ]
    # Characterization must not steal random numbers from the model or loader.
    with torch.random.fork_rng(devices=[]):
        torch.set_rng_state(
            torch.Generator(device="cpu").manual_seed(198173).get_state()
        )
        params.extend(transform.make_params([image]) for _ in range(128))
    for parameters in params:
        expected = VF.affine(image, **parameters, fill=[0.0])
        actual = apply_cuda_affine(gpu, [parameters], transform)[0].cpu()
        if actual.numpy().tobytes() != expected.numpy().tobytes():
            return False, f"CPU/CUDA nearest-affine mismatch: {parameters}"
    return (
        True,
        f"{len(params)} exact unique-index cases passed on CUDA device {device}",
    )
