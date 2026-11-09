import numpy as np
import pytest
import torch
from PIL import Image
from torchvision.transforms import InterpolationMode
from torchvision.transforms.v2 import functional as VF
from training.gpu_views import normalization_lut


def test_normalization_lut_matches_numpy_reference_all_bytes():
    pixels = np.arange(256, dtype=np.uint8).astype(np.float32) / 255
    expected = ((pixels - 0.5) / 0.5).astype(np.float32)
    assert normalization_lut(0.5, 0.5).numpy().tobytes() == expected.tobytes()


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_normalization_matches_reference_bytes():
    values = torch.arange(256, dtype=torch.uint8, device="cuda")
    actual = normalization_lut(0.5, 0.5).cuda()[values.long()].cpu().numpy()
    pixels = np.arange(256, dtype=np.uint8).astype(np.float32) / 255
    expected = ((pixels - 0.5) / 0.5).astype(np.float32)
    assert actual.tobytes() == expected.tobytes()


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_bilinear_resize_characterizes_lanczos_difference():
    pixels = np.zeros((9, 13), dtype=np.uint8)
    pixels[1:8, 3:7] = 255
    reference = np.asarray(
        Image.fromarray(pixels).resize((7, 5), Image.Resampling.LANCZOS)
    )
    actual = (
        VF.resize(
            torch.from_numpy(pixels).unsqueeze(0).cuda(),
            [5, 7],
            interpolation=InterpolationMode.BILINEAR,
            antialias=True,
        )
        .cpu()
        .squeeze(0)
        .numpy()
    )
    assert not np.array_equal(actual, reference)


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_lanczos_is_not_a_supported_tensor_replacement():
    """The installed maintained CUDA resize API cannot execute Pillow's filter."""
    with pytest.raises((ValueError, NotImplementedError)):
        VF.resize(
            torch.zeros(1, 9, 13, device="cuda"),
            [5, 7],
            interpolation=InterpolationMode.LANCZOS,
        )


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_lut_matches_unchanged_fit_foreground_oracle():
    """Compare the GPU table/padding bytes with the actual CPU reference function."""
    from guesser_data.common import load_step
    from guesser_data.settings import PREPROCESS_DEFAULTS

    settings = dict(PREPROCESS_DEFAULTS)
    expected = load_step("06-images")._fit_foreground(
        np.ones((1, 1), dtype=bool), settings
    )
    side, fit = settings["output"], settings["fit"]
    values = torch.full((side, side), 255, dtype=torch.uint8, device="cuda")
    offset = (side - fit) // 2
    values[offset : offset + fit, offset : offset + fit] = 0
    actual = normalization_lut(settings["mean"], settings["std"]).cuda()[values.long()]
    actual = actual.expand(3, -1, -1).contiguous().cpu().numpy()
    assert actual.tobytes() == expected.tobytes()
