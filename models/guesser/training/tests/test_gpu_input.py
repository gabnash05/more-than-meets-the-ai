import pytest
import torch
from torchvision.transforms import v2
from training.gpu_input import (
    apply_cuda_affine,
    collate_deferred_affine,
    sample_affine_params,
)


def test_deferred_affine_preserves_rng_and_collation():
    image = torch.arange(64, dtype=torch.float32).reshape(1, 8, 8)
    transform = v2.RandomAffine(10, translate=(0.05, 0.05), scale=(0.9, 1.1))
    torch.manual_seed(42)
    state = torch.get_rng_state()
    transform(image)
    expected = torch.get_rng_state()
    torch.set_rng_state(state)
    params = sample_affine_params(transform, image)
    assert torch.equal(torch.get_rng_state(), expected)
    state = torch.get_rng_state()
    batch = collate_deferred_affine(
        [
            {"image": image, "class_id": 1, "_affine_params": params},
            {"image": image, "class_id": 2, "_affine_params": params},
        ]
    )
    assert torch.equal(torch.get_rng_state(), state)
    assert batch["_affine_params"] == [params, params]
    assert batch["image"].shape == (2, 1, 8, 8)


def test_cuda_affine_rejects_cpu_input():
    with pytest.raises(ValueError, match="CUDA"):
        apply_cuda_affine(torch.zeros(1, 3, 8, 8), [{}], v2.RandomAffine(10))


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_affine_admission_probes_real_backend_without_rng_changes():
    from training.gpu_input import cuda_affine_admission

    torch.manual_seed(481)
    state = torch.get_rng_state()
    cuda_state = torch.cuda.get_rng_state()
    admitted, reason = cuda_affine_admission()
    assert admitted, reason
    assert torch.equal(state, torch.get_rng_state())
    assert torch.equal(cuda_state, torch.cuda.get_rng_state())


@pytest.mark.parametrize("seed", range(32))
@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_affine_bytes_characterization(seed):
    image = (
        (
            (
                torch.arange(224 * 224, dtype=torch.float32).reshape(224, 224)
                % 256
                / 255
                - 0.5
            )
            / 0.5
        )
        .expand(3, -1, -1)
        .contiguous()
    )
    transform = v2.RandomAffine(10, translate=(0.05, 0.05), scale=(0.9, 1.1))
    torch.manual_seed(seed)
    state = torch.get_rng_state()
    expected = transform(image)
    expected_rng = torch.get_rng_state()
    torch.set_rng_state(state)
    params = sample_affine_params(transform, image)
    cuda_image = image.unsqueeze(0).cuda()
    cuda_rng = torch.cuda.get_rng_state()
    actual = apply_cuda_affine(cuda_image, [params], transform)[0].cpu()
    assert torch.equal(torch.get_rng_state(), expected_rng)
    assert torch.equal(torch.cuda.get_rng_state(), cuda_rng)
    assert actual.numpy().tobytes() == expected.numpy().tobytes()


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_cuda_affine_boundary_parameters():
    from torchvision.transforms.v2 import functional as VF

    image = torch.arange(224 * 224, dtype=torch.float32).reshape(1, 224, 224)
    transform = v2.RandomAffine(10, translate=(0.05, 0.05), scale=(0.9, 1.1))
    parameters = [
        {"angle": angle, "translate": [11, -11], "scale": scale, "shear": [0.0, 0.0]}
        for angle in (0.0, 0.00001, 5.0, -9.999)
        for scale in (0.9, 0.9999999, 1.0, 1.0000001, 1.1)
    ]
    for params in parameters:
        expected = VF.affine(image, **params, fill=0)
        actual = apply_cuda_affine(image.unsqueeze(0).cuda(), [params], transform)[
            0
        ].cpu()
        assert torch.equal(actual, expected), params


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires actual CUDA")
def test_affine_restores_model_precision_after_kernel_error(monkeypatch):
    """A failed transform cannot change the model's high/TF32 compute policy."""
    from training import gpu_input

    torch.set_float32_matmul_precision("high")

    def fail(*args, **kwargs):
        raise ValueError("injected kernel error")

    monkeypatch.setattr(gpu_input.VF, "affine", fail)
    with pytest.raises(ValueError, match="injected"):
        apply_cuda_affine(
            torch.zeros(1, 3, 224, 224, device="cuda"), [{}], v2.RandomAffine(10)
        )
    assert torch.get_float32_matmul_precision() == "high"
