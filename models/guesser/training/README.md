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

## Exact training-view bundles and optional CUDA augmentation

Three caches solve different costs: the existing Arrow mmap cache shares manifest
metadata; the bounded validation cache reuses complete validation renders; the
new immutable **training-view bundle** stores lossless pre-augmentation views
separately for each original index, A/B arm and epoch. Source JSONL remains
canonical. No training command builds, downloads, evicts or repairs a bundle.

From `models/guesser/`, first estimate storage on the intended output filesystem:

```sh
uv run --no-sync python -m training.build_epoch_cache estimate --prepared-dir data/.local/data/production/prepared --output .local/cache/training-views/ab --arms a b --epochs 0 1 2 3 4 5 --samples 512 --reserve-bytes 10737418240
```

The estimate measures compressed payloads, not guaranteed SQLite capacity. The
uncompressed pixels alone are about 257.95 GiB per arm/epoch for production.
Approve a filesystem/budget before a full build; never substitute lossy pixels
or freeze one image across epochs to make it fit. The following is an explicit,
potentially expensive build, **not** an automatic next step:

```sh
uv run --no-sync python -m training.build_epoch_cache build --prepared-dir data/.local/data/production/prepared --output .local/cache/training-views/ab --arms a b --epochs 0 1 2 3 4 5 --max-bytes 107374182400 --reserve-bytes 10737418240 --workers 4
```

`--manifest-cache-dir .local/cache/manifests` optionally reuses the existing
shared Arrow index during a build. The disk cap covers logical SQLite bytes and
is enforced during writes using SQLite's page ceiling. Private staging uses
memory rollback journals and bounded transactions; interrupted staging is never
a valid bundle. Only a counted, identity-checked, closed, fsynced database is
published. Cooperating builders serialize through a sibling lock; existing
outputs/locks and other builders' staging are never removed. A killed builder
can leave its own staging/lock for explicit operator inspection, not automatic
pruning. Filesystem metadata and other jobs still require the free-space reserve.

Enable the bundle in a **new** experiment root with matching A/B settings:

```sh
uv run --no-sync python -m training.train --run both --prepared-dir data/.local/data/production/prepared --checkpoint-root checkpoints/exact-input-new-run --training-view-cache .local/cache/training-views/ab --augment-device cpu --batch-size 8 --accumulate-grad-batches 4 --precision 32-true
```

The default is still `--augment-device cpu`. Opt into `--augment-device cuda`
only after measuring its tradeoff; a busier GPU is not necessarily a faster run.
CUDA mode samples the original
per-image affine parameters in CPU workers, transfers pinned tensors through
Lightning, expands cached one-channel pixels on CUDA and executes each affine
independently. It never initializes CUDA inside workers or renormalizes pixels.
The runtime checks a fixed boundary/random unique-index corpus before admitting
a CUDA backend. This is a regression gate, not an exhaustive mathematical proof.
Affine grid construction temporarily uses IEEE float32 because the model's
`high`/TF32 matmul setting changes pixel selection; the model setting is restored
even on exceptions. This adapter is for the single training-process/stream path,
not concurrent unrelated inference threads. Validation remains unchanged.

Source manifest/file identity, absolute prepared path, rendering source code,
Python/platform and package versions are bound to the bundle. Ordinary edits or
replacement require a rebuild; fingerprints are not signatures against malicious
metadata forgery. Every entry has a verified digest. Missing/corrupt coverage
raises instead of silently rendering/falling back. Sources and published bundles
must stay immutable while readers run. Loader-time checks happen **before**
prefetch and use the restored epoch, allowing resume bundles containing only the
remaining epochs. Worker RNG state not saved by the original trainer is not
retroactively recoverable. Completed A/B checkpoints/notebooks are not modified.

### Measure before choosing a placement

Use `training.benchmark_epoch_cache --help`. Modes `baseline`, `cached-cpu` and
`cached-cuda` describe the **input/augmentation** path; `--require-cuda` forbids
CPU model fallback in all modes. Comparisons check raw metadata/pixel bytes with
the old reference entry points and seeded augmented tensors before timing.
Warmup and measurement use disjoint batches from one fixed shuffled train-only
sample, with the same weights, seed, workers, FP32 and accumulation. The late
view epoch is frozen even though the bounded Trainer itself runs one epoch.
Requested indices retain training's ordinary next-index fallback, not a
filtered/reindexed replacement corpus. `--max-record-attempts-per-sample`
(default 64) caps fallback work in both preflight and timed loading; exhaustion
raises instead of silently changing selection. JSON records the prepared root,
this policy and preflight attempt count. Use an explicitly copied train-only
prepared root and its matching bundle when source access itself must remain
inside a smaller corpus; `--samples` alone is not an I/O sandbox. The benchmark
guard does not restrict normal training fallback.

Linux example (set `HF_HUB_OFFLINE=1` using the equivalent shell syntax on Windows):

```sh
HF_HUB_OFFLINE=1 uv run --no-sync python -m training.benchmark_epoch_cache --mode cached-cuda --require-cuda --prepared-dir data/.local/data/production/prepared --bundle .local/cache/training-views/ab --arm b --epoch 2 --samples 2048 --batch-size 8 --num-workers 4 --repeats 3 --warmup-batches 16 --measure-batches 128
```

Repeat with `--mode cached-cpu`, then `--mode baseline` without `--bundle`, for
both arms and a later epoch. Pretrained weights must already be cached; offline
failure is not permission to download. JSON stdout reports each repeat, median
images/s, real model/input devices, host wait, CUDA transfer/augmentation/compute
events and allocated/reserved VRAM peaks. Driver utilization is not inferred
from VRAM, and unmeasured worker CPU breakdown is explicitly null. Supply measured
`--preparation-seconds` when available; warm speed alone does not prove a faster
first experiment. Test-fixture model injections are labelled, not production
model measurements. Full A/B retraining and production-sized builds remain
separate operator decisions.

The existing Pillow rasterizer, LANCZOS resizing, foreground/edge decisions and
causal bounds remain authoritative. `gpu_views.py` contains a small exact uint8
normalization-table experiment, not a full CUDA renderer. CUDA bilinear does not
match Pillow LANCZOS; no approximate resize/raster substitution is enabled.
Mixed precision, physical batch changes, extra workers and custom prefetch
streams are separate measured experiments, not implicit changes to this recipe.

## Required libraries

Use timm for the pretrained ViT-Tiny and its 345-class head; Lightning Trainer/Module/DataModule and callbacks for the training loop, device/precision handling, resume, checkpoint selection and logs; PyTorch Dataset/DataLoader for batches; torchvision v2 for ordinary augmentation; PyTorch loss/optimizer/schedulers and TorchMetrics for standard learning operations and scores. Keep custom code to data adaptation and the experiment protocol.

See the [library guide](../LIBRARIES.md) and [implementation rules](../AGENTS.md).
