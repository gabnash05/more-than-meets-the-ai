# Referee evaluation

Notebook-based Referee validation, checkpoint auditing and threshold reporting. This workspace uses Python 3.12 and light notebook dependencies; the actual checkpoint loading and metric runner live in the separate Python 3.13 model project under `models/referee/recognition/`.

## Status

The notebook flow and runner are implemented. No prepared Referee data, measured model performance or serving bundle is included. The supplied checkpoint is a 4-output ViT-Tiny (`num_classes=4`, filename score `0.5564`); the game uses two channels (`text`, `number`), and the checkpoint carries no preprocessing provenance. The runner reports encoded-proxy and reviewed-label metrics separately and refuses to guess when preprocessing is ambiguous.

## Setup

From the repository root:

```sh
uv sync --project models/referee/evaluation --locked
uv sync --project models/referee --frozen
uv run --project models/referee/evaluation jupyter lab --ServerApp.root_dir=.
```

Open `models/referee/evaluation/notebooks/` from the Jupyter file browser. Optionally register the kernel:

```sh
uv run --project models/referee/evaluation python -m ipykernel install --user \
  --name mtmai-referee-evaluation \
  --display-name "Python (MTMAI Referee Evaluation)"
```

Run notebook `00_environment_check.ipynb` first.

## Notebook flow

| Notebook | Purpose |
| --- | --- |
| `00_environment_check.ipynb` | Python/package smoke check; no model or data |
| `01_dataset_pipeline.ipynb` | Launch `referee-data` in its CPU environment; explicit opt-in |
| `02_dataset_audit.ipynb` | Validate manifests, labels, masks, split isolation and PNG hashes |
| `03_training_and_checkpoint.ipynb` | Inspect the supplied checkpoint; optional training launcher |
| `04_validation_evaluation.ipynb` | Run per-channel validation AP, threshold sweep and coverage |
| `05_report_and_thresholds.ipynb` | Review thresholds, AP slices and optional freeze record |
| `06_serving_bundle.ipynb` | Export the checkpoint as a hashed Referee serving bundle |

## Data prerequisites

Prepared data is expected at:

```text
models/referee/data/.local/data/<profile>/prepared/
  manifests/train.jsonl
  manifests/validation.jsonl
  manifests/test.jsonl      # when the source export includes it
  images/*.png
models/referee/data/.local/data/<profile>/dataset-summary.json
models/referee/data/.local/data/<profile>/labels.json
```

Profiles are `sample` and `train`. `sample` is a wiring/smoke profile; the real `train` profile requires separate authorization for the source archives. The notebooks never download automatically.

To build a profile manually:

```sh
uv run --project models/referee/data --frozen --no-dev referee-data download --profile sample --json
uv run --project models/referee/data --frozen --no-dev referee-data prepare --profile sample --json
uv run --project models/referee/data --frozen --no-dev referee-data preview --profile sample --json
uv run --project models/referee/data --frozen --no-dev referee-data export --profile sample --json
```

## Checkpoint

The default checkpoint is:

```text
models/referee/checkpoints/referee-epoch=04-val_mean_ap=0.5564.ckpt
```

Inspect it without data:

```sh
cd models/referee
uv run --frozen --no-sync python -m recognition.checkpoint \
  --checkpoint checkpoints/referee-epoch=04-val_mean_ap=0.5564.ckpt --json
```

Expected fields include `num_classes: 4`, `head_in_features: 192`, `epoch: 4`, `best_model_score: 0.5564`. Lightning checkpoints contain non-tensor objects; this loader is only for the trusted teammate file.

## Evaluation

Run validation through notebook `04_validation_evaluation.ipynb`, or directly:

```sh
cd models/referee
uv run --frozen --no-sync python -m recognition.evaluate \
  --checkpoint checkpoints/referee-epoch=04-val_mean_ap=0.5564.ckpt \
  --prepared-dir data/.local/data/sample/prepared \
  --split validation \
  --preprocessing auto \
  --output-dir checkpoints/referee-evaluation/sample/validation-v1 \
  --batch-size 32 \
  --limit 200
```

`--preprocessing auto` probes `foreground` and `rgb_resize` on at most 200 rows and compares the encoded text+number mean AP with the checkpoint score. If neither is close or both are ambiguous, it stops and asks for the training owner’s provenance. Use `--preprocessing foreground` or `--preprocessing rgb_resize` only when that choice is confirmed.

Outputs are under the ignored output root:

- `predictions.jsonl` — per-row scores, targets, origins and status
- `summary.json` — checkpoint/prepared hashes, coverage, per-channel AP and thresholds
- `report.md` — human-readable report and limits
- `preprocessing-probe.json` — candidate probe when `auto` was used

Validation is the tuning split. A held-out `test` run requires `--freeze-record` and `--validation-report`; do not tune on test.

## Serving bundle

`06_serving_bundle.ipynb` calls `training.export_bundle` to produce:

```text
models/referee/checkpoints/referee-evaluation/bundles/referee-vit-a-v1/
  manifest.json
  weights.safetensors
  labels.txt
  labels.json
  checkpoint-selection.json
```

The manifest records role `referee`, adapter `vit-tiny-referee`, input `[1, 3, 224, 224]`, output `[1, 4]`, label order `[text, number, symbol, circle]`, channel order `[text, number]`, sigmoid scores, preprocessing and a hash-bound artifact revision. The exporter verifies every file hash and fixed-tensor parity before publishing atomically.

The bundle is integration-ready, but the production overlay still sets `REFEREE_PROVIDER=unavailable`. To enable it, copy the bundle under `<AI_ARTIFACT_ROOT>/<modelId>/` and set `REFEREE_MODEL_ID=referee-vit-a-v1`, `REFEREE_PROVIDER=http`, and `AI_TEST_FIXTURES=0`; do not enable a public Referee without validation review.

## Tests

```sh
cd models/referee/evaluation
uv run --frozen pytest -q
uv run --frozen ruff check src tests

cd ../..
uv run --project models/referee --frozen --no-sync python -m pytest -q recognition/tests training/tests
uv run --project models/referee --frozen --no-sync ruff check recognition training/export_bundle.py training/tests
```

The checkpoint integration test skips when the supplied file is absent.

## Limits

- Encoded ATYPICT bits are proxies, not reviewed game labels. Report both slices.
- The filename score `0.5564` is a training-validation metric, not reviewed-label accuracy, gameplay precision or a capacity result.
- No Referee serving bundle, replay corpus, persistence-policy timing or deployment is included.
- Do not commit checkpoints, prepared data, predictions, summaries or reports.
