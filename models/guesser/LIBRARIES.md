# Guesser library choices

Use existing deep learning libraries for standard work. This supplements the reviewed Guesser plan and is the current implementation guidance for library selection and uv setup.

## Current implementation status

The completed data package already uses NumPy for array operations, Pillow for drawing/resizing, OpenCV for edge detection, PyArrow for Parquet, SQLite for identity/conflict indexing, and checksum libraries. Its record reader handles the project's seekable JSONL format; it is not a replacement for PyTorch's batching and worker system.

Training adapters live under [`training/`](training/README.md) (LightningModule/DataModule, A/B `train.py`, smoke and `compare_ab`). The model uv project at `models/guesser/` declares `torch`, `torchvision`, `timm`, `lightning`, `torchmetrics` and `safetensors` in `pyproject.toml` / `uv.lock`. Choose the CUDA/CPU index for the actual training host before `uv sync`. Evaluation metrics beyond training-time validation and the inference service remain Validation/Inference owner work. Trained weights are not committed.

## Required library map

| Work | Use | Project code that remains |
|---|---|---|
| Pretrained vision transformer and 345-class head | [timm create_model](https://huggingface.co/docs/timm/reference/models) | Select the checkpoint and pass `num_classes=345`. |
| Training and validation loop, device handling and mixed precision | [Lightning Trainer](https://lightning.ai/docs/pytorch/stable/core-api/trainer) | A small LightningModule defines the batch, loss and metrics; a DataModule supplies prepared data. |
| Best-model saves, early stopping, resume and logs | Lightning ModelCheckpoint, EarlyStopping, LearningRateMonitor and CSVLogger | Choose the validation score, patience, paths and equal A/B update budget. |
| Data batches, shuffling, worker processes and prefetch | [PyTorch Dataset/DataLoader](https://docs.pytorch.org/docs/stable/data.html) | Adapt IndexedDrawings and timestamp views; propagate epoch/seed deterministically to workers. |
| Loss, optimizer and scheduling | PyTorch CrossEntropyLoss, AdamW and built-in LR schedulers | Supply the agreed hyperparameters; do not implement gradient descent or scheduler formulas. |
| Ordinary image augmentation | [torchvision transforms v2](https://docs.pytorch.org/vision/stable/transforms.html) | Choose modest training-only rotation/translation/scale consistent with the data plan. |
| Top-1/top-3, F1, confusion and calibration error | [TorchMetrics classification metrics](https://lightning.ai/docs/torchmetrics/stable/classification/accuracy.html) | Run the approved per-stage protocol and keep explicit blank/pass counts. |
| Confidence calibration | TorchMetrics for [calibration error](https://lightning.ai/docs/torchmetrics/stable/classification/calibration_error.html), PyTorch loss/optimizer primitives or a suitable maintained calibration utility for fitting | Fit on validation only and record the temperature/pass policy. Measuring calibration error does not itself calibrate a model. |
| Model prediction | PyTorch eval/inference_mode and tensor softmax/topk | Apply the chosen shared preprocessor, label registry and game policy. |
| Weight I/O | Lightning checkpoints for training resume; timm/safetensors for inference weights | Bundle registry/preprocessor hashes and rebuild the same architecture. |
| HTTP service and request checks | [FastAPI/Pydantic](https://fastapi.tiangolo.com/tutorial/body/) and Uvicorn | Define the game's request/result/version contract and bounded resident-model worker. |
| Package management | [uv](https://docs.astral.sh/uv/guides/integration/pytorch/) | Declare dependencies, select the machine's supported PyTorch backend, and commit the lock. |

Do not combine multiple training engines for the same run. The selected combination is timm for the model plus Lightning for training. Hugging Face Trainer/Accelerate, fastai or another engine are not additional requirements alongside it.

## Backbone and preprocessing

The starting checkpoint remains [vit_tiny_patch16_224.augreg_in21k_ft_in1k](https://huggingface.co/timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k). It is an existing image classifier; the group adapts it to sketches instead of constructing a transformer.

```python
import timm

model = timm.create_model(
    "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
    pretrained=True,
    num_classes=345,
)
```

This is an implementation reference, not a claim that weights have been downloaded on this host. `pretrained=True` downloads weights when first used. Choose a cache location with sufficient space; no particular drive letter or operating system is required.

Use timm's pretrained metadata to check expected image size/normalization. Keep the project's shared current-prefix Foreground/Edges and fit/pad transform rather than blindly applying a model's generic center-crop transform. Existing prepared views are already float32 [3,224,224] and normalized; converting them with `torch.from_numpy` must not normalize them a second time. Standard training augmentation should use torchvision APIs, be seeded, and be absent from validation/live inference.

The only custom neural wrapper should be a small LightningModule around the existing timm model. The group should not implement transformer blocks, a complete training engine, mixed-precision scaling, gradient accumulation, checkpoint recovery, standard metrics or an HTTP framework.

## Work split

- Data owner: retain the existing CPU-only package and identity/split/preprocessing contract. Reuse its renderer and record reader in the model adapter.
- Model owner: use timm + Lightning + PyTorch DataLoader + torchvision; run the matched-budget A/B experiment with framework callbacks and logs.
- Validation/inference owner: use TorchMetrics and the fixed timestamp-stage protocol; keep test custody and build the FastAPI/Pydantic resident-model service using PyTorch inference APIs.

Project-specific code remains necessary for ordered timestamp cuts, exact sampling/conflict rules, early-recognition aggregation and game checkpoint/version policy. Implement those as small adapters around the libraries. A generic random split or automatic image crop must not replace an agreed rule and change the experiment.

## uv setup for the model project

Keep `data/` independent so data preparation never requires a large torch/GPU install. The model uv project lives at `models/guesser/` with an editable path dependency on `./data`, not a shared uv workspace. Model, data and evaluation each use their own `.venv`. Teammates should sync the appropriate project rather than re-running `uv init`:

```sh
uv sync --frozen
```

Run that command from `models/guesser/`. It is identical in Windows PowerShell, Windows Command Prompt (cmd) and Linux bash; no environment activation is required. First-time sync may download large PyTorch/CUDA packages. Model weights download separately on first model construction.

Optional cache settings are shell-specific. From `models/guesser/`, choose only the block for your shell; these relative paths keep caches in the ignored checkout-local `.local/` directory. Otherwise leave the defaults unchanged.

PowerShell:

```powershell
$env:UV_CACHE_DIR = "$PWD/.local/cache/uv"
$env:HF_HOME = "$PWD/.local/cache/huggingface"
$env:TORCH_HOME = "$PWD/.local/cache/torch"
```

Linux bash:

```bash
export UV_CACHE_DIR="$PWD/.local/cache/uv"
export HF_HOME="$PWD/.local/cache/huggingface"
export TORCH_HOME="$PWD/.local/cache/torch"
```

Windows Command Prompt:

```bat
set "UV_CACHE_DIR=%CD%/.local/cache/uv"
set "HF_HOME=%CD%/.local/cache/huggingface"
set "TORCH_HOME=%CD%/.local/cache/torch"
```

Set `UV_PYTHON_DOWNLOADS` to `never` using the same shell syntax only when Python is already installed and interpreter downloads are prohibited. Do not copy a `.venv` between operating systems: recreate it with uv and transfer prepared data/checkpoints separately.

The current source markers select the explicit CUDA 12.6 index for torch/torchvision on Windows and PyPI on Linux. Linux does not require a re-lock merely because it is Linux; both resolutions are in the lock. The builds may differ across platforms. Verify CUDA availability after syncing using the check in the [training guide](training/README.md#setup-windows-and-linux). Driver compatibility is a runtime prerequisite, not something a successful lock guarantees. If the selected backend is unsuitable, coordinate a torch/torchvision source change following the official [uv PyTorch guide](https://docs.astral.sh/uv/guides/integration/pytorch/), then re-lock and sync; do not overwrite the Windows source configuration as a Linux workaround.

Required model packages: `torch`, `torchvision`, `timm`, `lightning`, `torchmetrics`, `safetensors`. Service dependencies (`fastapi`, `pydantic`, `uvicorn`) remain for the inference owner. Commit `pyproject.toml` and `uv.lock`; teammates use `uv sync --frozen` when the lock matches their platform.

The evaluation scaffold in `evaluation/` keeps its separate Python 3.12 lock. Data remains Python 3.13. Those environments are not interchangeable.
