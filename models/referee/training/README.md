# Referee training

Lightning adapters for fine-tuning the agreed ViT-Tiny backbone on prepared Referee data for multi-label binary classification (`encoded_presence` across 4 target flags).

## Role split (current)

- **This machine / small-dataset owner:** finish clean validation tuning on the **small** prepared set, validate multi-label AP curves, package the training codebase + recipe for handoff.
- **Teammate (faster laptop):** reuse this code later on **medium/production** prepared data via `--prepared-dir`.

Scripts:

- `dataset.py`: `RefereeDataset` / `RefereeDataModule` over JSONL manifests and image splits. Extracts multi-label binary arrays (`encoded_presence`).
- `module.py`: timm ViT-Tiny (`num_classes=4`) + `BCEWithLogitsLoss` + dual-LR AdamW + warmup/cosine scheduler + `BinaryAveragePrecision` metrics (`val_ap_text`, `val_ap_number`, `val_mean_ap`).
- `train.py`: Training loop with gradient accumulation, checkpointing under `checkpoints/referee_run/weights/`, and resume support.
- `plot_metrics.py`: Plots epoch-level metrics from the Lightning CSV logs as standalone SVG files.
- `smoke_test.py`: One-batch GPU sanity check for data loading and forward/backward passes.

Put weights under [`../checkpoints/`](../checkpoints/).

## Smoke check

From `models/referee/` with your virtual environment active:

```powershell
uv run python -m training.smoke_test
```

## Train the Referee model
Defaults match the model plan: seed 198173, physical batch 8 with gradient accumulation 4 (effective batch 32), up to 5 epochs, early stopping patience, FP32, and validation-only checkpointing.

```powershell
# Full run on the prepared set (with 2 workers prefetching images)
uv run python -m training.train --prepared-dir "C:\Users\Administrator\more-than-meets-the-ai\models\referee\data\.local\data\train\prepared" --num-workers 2

# Teammate later: point at a larger prepared tree (same flags otherwise)
uv run python -m training.train --prepared-dir "path/to/production/prepared" --num-workers 4
```

Artifacts per run: checkpoints/referee_run/weights/ (best weights saved via val_mean_ap).

## Plot training metrics

After training, generate one SVG per metric (for example, `val_loss.svg`, `val_ap_text.svg`, `val_ap_number.svg`, and `val_mean_ap.svg`):

```powershell
uv run python -m training.plot_metrics
```

By default, plots are written to `checkpoints/referee_run/metric_plots/`. Override the run or output directory with `--run-dir` and `--output-dir`.

## Pause and Resume
Resume training using the same flags plus --resume:

```powershell
uv run python -m training.train --prepared-dir "C:\Users\Administrator\more-than-meets-the-ai\models\referee\data\.local\data\train\prepared" --num-workers 2 --resume
```

## Handoff checklist for the training teammate
Send / commit (weights stay gitignored — transfer separately if needed):

1. training/ package (dataset.py, module.py, train.py, smoke_test.py, README)
2. pyproject.toml + uv.lock (CUDA index set for Windows cu126)
3. Best checkpoint file (referee-epoch=...-val_mean_ap=....ckpt) if transferring pre-trained weights.
4. Note the exact command used for training, and that production scaling only requires updating --prepared-dir and adjusting --num-workers.

## Required Libraries
Use timm for the pretrained ViT-Tiny backbone and its 4-class multi-label head; Lightning Trainer/Module/DataModule and callbacks for the training loop, device handling, resume capability, and metric logging; PyTorch Dataset/DataLoader for batched multi-label tensor loading; torchvision v2 for augmentations; PyTorch BCEWithLogitsLoss, AdamW, schedulers, and TorchMetrics BinaryAveragePrecision for independent multi-label scoring. Keep custom code limited to data adaptation and multi-label tensor mapping.
