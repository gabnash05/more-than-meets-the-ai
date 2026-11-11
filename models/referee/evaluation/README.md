# Referee evaluation

Notebook-based Referee validation, checkpoint auditing and threshold reporting. This workspace uses Python 3.12 and light notebook dependencies; the actual checkpoint loading and metric runner live in the separate Python 3.13 model project under `models/referee/recognition/`.

## Corrected v2 workflow

Use [the trainer handoff](../../../docs/referee/TRAINER-HANDOFF.md) for the two-output repaired pipeline and [the game-owner checklist](../../../docs/referee/GAME-OWNER-CHECKLIST.md) for integration. The launcher notebooks default to opt-in v2 operations; select an actual corrected run checkpoint before executing them. The old four-output checkpoint is retained for historical inspection, not for resuming v2 training. The trainer does not set gameplay thresholds in notebook 05.

The data package now owns canonical preprocessing and strict preflight. `training.train` uses reviewed/masked text and number targets; `training.export_v2` exports the new model identity. No corrected production checkpoint or production-ready dataset has been created by these code changes. Sample review coverage and unresolved issues are recorded in [the repair audit](../../../docs/referee/REPAIR-AUDIT.md).

The sections below document the legacy checkpoint/evaluation tools; do not use their old export recipe for v2.

## Legacy status

The notebook flow and runner are implemented. The supplied checkpoint is a 4-output ViT-Tiny (`num_classes=4`, filename score `0.5564`); the game uses two channels (`text`, `number`), and the checkpoint carries no preprocessing provenance. The runner reports encoded-proxy and reviewed-label metrics separately and refuses to guess when preprocessing is ambiguous. Full local validation and held-out test runs are recorded under the ignored `checkpoints/referee-evaluation/train/` output root. The current test labels have no known negatives, so held-out results measure agreement with encoded ATYPICT proxies, not reviewed gameplay labels.

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
| `06_heldout_test_evaluation.ipynb` | Run test metrics only with the validation-bound freeze record |
| `07_serving_bundle.ipynb` | Export the checkpoint as a hashed Referee serving bundle |

## What the evaluation shows

Only notebooks `04` and `06` score the model. Notebook `04` shows validation metrics used to check the checkpoint and preprocessing. Notebook `06` shows the final held-out metrics and charts. Notebooks `00`–`03` check the environment, prepare/audit data and inspect the checkpoint; `05` freezes the validation choices; `07` packages the model for serving.

The AP charts show ranking against the dataset's encoded ATYPICT labels: higher AP means the model ranks encoded positives ahead of encoded negatives more often. The held-out chart also shows precision, recall and F1 at the validation-frozen `0.5` threshold. These are proxy-label results. This dataset has no reviewed negative labels, so reviewed-label accuracy and threshold tuning cannot be established from it. The held-out results also cannot confirm session-level split independence because source session IDs are unavailable.

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
  --checkpoint checkpoints/referee_run/weights/referee-epoch=04-val_mean_ap=0.5564.ckpt --json
```

Expected fields include `num_classes: 4`, `head_in_features: 192`, `epoch: 4`, `best_model_score: 0.5564`. Lightning checkpoints contain non-tensor objects; this loader is only for the trusted teammate file.

## Evaluation

Run full validation through notebook `04_validation_evaluation.ipynb`, or directly:

```sh
cd models/referee
uv run --frozen --no-sync python -m recognition.evaluate \
  --checkpoint checkpoints/referee_run/weights/referee-epoch=04-val_mean_ap=0.5564.ckpt \
  --prepared-dir data/.local/data/train/prepared \
  --split validation \
  --preprocessing rgb_resize \
  --output-dir checkpoints/referee-evaluation/train/validation-v1 \
  --batch-size 32
```

`--preprocessing auto` probes `foreground` and `rgb_resize` on at most 200 rows and compares the encoded text+number mean AP with the checkpoint score. If neither is close or both are ambiguous, it stops and asks for the training ownerâ€™s provenance. Use `--preprocessing foreground` or `--preprocessing rgb_resize` only when that choice is confirmed.

Outputs are under the ignored output root:

- `predictions.jsonl` â€” per-row scores, targets, origins and status
- `summary.json` â€” checkpoint/prepared hashes, coverage, per-channel AP and thresholds
- `report.md` â€” human-readable report and limits
- `preprocessing-probe.json` â€” candidate probe when `auto` was used

Validation is the threshold review split. The current prepared validation and test labels contain no known negatives, so known-label AP and F1/threshold sweeps are unscored. The freeze notebook therefore keeps the predeclared `0.5` reference threshold; it binds the checkpoint, preprocessing, prepared-data summary and validation report hash. Review the validation report, then write the freeze record in notebook `05_report_and_thresholds.ipynb`.

Notebook `06_heldout_test_evaluation.ipynb` checks that freeze record against the checkpoint and validation report before scoring the test split. The evaluator also locks `auto` preprocessing to the frozen validation choice and omits test-derived threshold sweeps. Example CLI:

```sh
cd models/referee
uv run --frozen --no-sync python -m recognition.evaluate \
  --checkpoint checkpoints/referee_run/weights/referee-epoch=04-val_mean_ap=0.5564.ckpt \
  --prepared-dir data/.local/data/train/prepared \
  --split test \
  --output-dir checkpoints/referee-evaluation/train/test-v1 \
  --preprocessing auto \
  --freeze-record checkpoints/referee-evaluation/train/validation-v1/freeze.json \
  --validation-report checkpoints/referee-evaluation/train/validation-v1/report.md
```

## Serving bundle

`07_serving_bundle.ipynb` calls `training.export_bundle` to produce:

```text
models/referee/checkpoints/referee-evaluation/bundles/referee-vit-a-v1/
  manifest.json
  weights.safetensors
  labels.txt
  labels.json
  checkpoint-selection.json
```

The manifest records role `referee`, adapter `vit-tiny-referee`, input `[1, 3, 224, 224]`, output `[1, 4]`, label order `[text, number, symbol, circle]`, channel order `[text, number]`, sigmoid scores, preprocessing and a hash-bound artifact revision. The exporter verifies every file hash and fixed-tensor parity before publishing atomically.

The bundle is deployed on `node1` as `referee-vit-a-v1` with `REFEREE_PROVIDER=http` and `AI_TEST_FIXTURES=0`; `/health/ready` reports it ready. Copy the bundle under `<AI_ARTIFACT_ROOT>/<modelId>/` for another host and set the same variables. It has not been validated against a reviewed held-out set, so its scores are advisory.

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
- The serving bundle is deployed, but no real validation metrics, replay corpus or persistence-policy timing exist; the deployment is advisory.
- Do not commit checkpoints, prepared data, predictions, summaries or reports.
