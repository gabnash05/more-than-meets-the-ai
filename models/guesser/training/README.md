# Guesser training

Lightning adapters for fine-tuning the agreed ViT-Tiny backbone on prepared Guesser data.

## Role split (current)

- **Small-dataset owner:** finish clean A/B on the **small** prepared set, compare validation curves, package the training codebase + recipe for handoff.
- **Teammate (faster laptop):** reuse this code later on **medium/production** prepared data via `--prepared-dir` (do not change splits or held-out test).

Scripts:

- `dataset.py`: `GuesserDataset` / `GuesserDataModule` over `IndexedDrawings`
  - Run **A** (`complete_only=True`): full originals
  - Run **B** (`complete_only=False`): `training_image` partial recipe
  - Validation during training uses complete originals (ten-stage / held-out eval stays with Validation)
- `module.py`: timm ViT-Tiny + dual-LR AdamW + warmup/cosine
- `train.py`: matched-budget A/B training, checkpoints, selection JSON
- `smoke_test.py`: one-batch GPU sanity for A and B
- `compare_ab.py`: lightweight A vs B CSV/metrics comparison + SVG plots

Use the sibling [data package](../data/README.md) for prepared data and shared preprocessing. Put weights under [`../checkpoints/`](../checkpoints/).

## Setup (Windows and Linux)

The training owner first ran the pipeline on Windows (team-reported). Linux is the port target; portable commands alone do not establish that a Linux GPU run has passed. Use Python 3.13, uv and an appropriate GPU driver. See the [library guide](../LIBRARIES.md#uv-setup-for-the-model-project) for backend selection and optional shell-specific cache settings.

From the repository root, sync the model environment and check the selected PyTorch build:

```sh
uv sync --project models/guesser --frozen
uv run --project models/guesser --no-sync python -c "import torch; print('torch:', torch.__version__); print('CUDA build:', torch.version.cuda); print('CUDA available:', torch.cuda.is_available())"
```

The GPU smoke test requires `CUDA available: True`; investigate the driver/build if it is false instead of assuming training is using the GPU. The main trainer can fall back to CPU, which is not a GPU validation.

Training defaults and the smoke script require `models/guesser/data/.local/data/small/prepared/`, including train and validation manifests. Production data does not satisfy that default path. If small data is not already prepared, run these commands from the repository root, with no other data job active:

```sh
uv sync --project models/guesser/data --frozen
uv run --project models/guesser/data --frozen guesser-data download --profile small
uv run --project models/guesser/data --frozen guesser-data prepare --profile small
```

Alternatively, extract a matching trainer archive and pass its `prepared/` directory with `--prepared-dir` to `training.train`. The smoke script has no path flag and still requires the small default tree. Keep held-out test sealed. Paths containing spaces must be quoted; forward slashes in Python/uv path arguments work on both systems. Never transfer virtual environments between machines.

## Smoke check

From `models/guesser/`:

```sh
uv run python -m training.smoke_test
```

`uv run` resolves the project environment on every platform, so there is no activation step. Commands and `#` comments work in Windows PowerShell and Linux bash. In Windows Command Prompt (cmd), run only the command lines and omit `#` comments.

Run every `python -m training.…` command below from `models/guesser/`. `uv --project` selects an environment but does not change the working directory; invoking these modules from the repository root will not locate the uninstalled `training` package.

## Train A and B (equal budget)

Defaults match the model plan: seed `198173`, effective batch 32 (`8 × accumulate 4`), up to 6 epochs, early stopping patience 2, FP32, validation-only checkpointing under `../checkpoints/`.

Dry run (one epoch, a few batches), isolated from real checkpoint output:

```sh
uv run python -m training.train --fast --checkpoint-root checkpoints/smoke
```

Full runs on small (two workers prefetch renders):

```sh
# A then B: same requested settings, different complete/partial inputs.
uv run python -m training.train --run both --num-workers 2
```

Or run each arm separately with matching settings:

```sh
# Complete-only baseline.
uv run python -m training.train --run a --num-workers 2
# Partial-view experiment; keep all other settings matched to A.
uv run python -m training.train --run b --num-workers 2
```

For a larger prepared tree, use a separate checkpoint root so small-run results are not mixed with production:

```sh
uv run python -m training.train --run both --num-workers 4 --prepared-dir data/.local/data/production/prepared --checkpoint-root checkpoints/production
```

Artifacts per run: `checkpoints/A_complete_only/` and `checkpoints/B_partial/` (weights, CSV logs, `checkpoint-selection.json`). Do not use held-out test for tuning.

When using a custom checkpoint root, pass that same `--checkpoint-root` to resume and comparison commands. In particular, compare production runs with `uv run python -m training.compare_ab --checkpoint-root checkpoints/production`. Worker counts are tuning choices on either OS: start at zero for debugging, then measure two or four workers before increasing them.

## Pause and resume

`last.ckpt` is refreshed every 1000 train steps; the best `val_acc` checkpoint is saved after each validation epoch (separate callbacks). Resume with the same flags plus `--resume`:

```sh
uv run python -m training.train --run a --num-workers 2 --resume
uv run python -m training.train --run b --num-workers 2 --resume
```

## Compare A vs B (after both runs finish)

```sh
uv run python -m training.compare_ab
```

Writes `checkpoints/ab_comparison/`:

- `comparison.md` / `comparison-summary.json` — best `val_acc`, epochs, paths
- `val_acc.svg` / `val_loss.svg` — overlaid A vs B curves
- per-run SVGs

This is a **small-dataset training-validation** comparison, not the final ten-stage held-out report.

## Handoff checklist for the training teammate

Send / commit (weights stay gitignored — transfer separately if needed):

1. `training/` package (`dataset.py`, `module.py`, `train.py`, `compare_ab.py`, `smoke_test.py`, README)
2. `pyproject.toml` + `uv.lock` (Windows cu126 and Linux PyPI source markers are preserved; sync on the destination and verify CUDA before running, rather than re-locking just for an OS change)
3. Small-run `checkpoint-selection.json` files (recipe + `labels_sha256`) and `ab_comparison/`
4. Note the exact command used for small A/B, and that production only needs `--prepared-dir` (+ maybe more workers)

## Required libraries

Use timm for the pretrained ViT-Tiny and its 345-class head; Lightning Trainer/Module/DataModule and callbacks for the training loop, device/precision handling, resume, checkpoint selection and logs; PyTorch Dataset/DataLoader for batches; torchvision v2 for ordinary augmentation; PyTorch loss/optimizer/schedulers and TorchMetrics for standard learning operations and scores. Keep custom code to data adaptation and the experiment protocol.

See the [library guide](../LIBRARIES.md) and [implementation rules](../AGENTS.md).
