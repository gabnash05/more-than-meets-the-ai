"""Small, unadmitted CUDA preprocessing experiments."""

import numpy as np
import torch


def normalization_lut(mean: float, std: float) -> torch.Tensor:
    """Build the data preprocessor's float32 normalization table on CPU."""
    pixels = np.arange(256, dtype=np.uint8).astype(np.float32) / 255
    normalized = ((pixels - mean) / std).astype(np.float32)
    return torch.from_numpy(normalized)
