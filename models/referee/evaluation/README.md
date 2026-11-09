# Referee evaluation

The notebooks follow the Guesser evaluation workspace pattern, with Referee-specific data support and four-output metrics:

- `notebooks/00_environment_check.ipynb` reports the Python, PyTorch, torchvision, timm, and scikit-learn environment. It does not evaluate a model.
- `notebooks/01_dataset_audit.ipynb` reports split sizes and positive/negative counts for each `encoded_presence` bit.
- `notebooks/02_model_evaluation.ipynb` runs a four-output checkpoint on validation images, reports average precision, precision, recall, F1, and confusion counts for each encoded bit, and plots per-bit precision-recall curves.

The data pipeline notebook was not copied: Referee owns its download/prepare/export commands in `models/referee/data/` and its runbook. Dataset-level counts are not model performance.

## Open the notebooks

From the repository root, install the Guesser evaluation workspace's notebook and inference dependencies, then launch Jupyter on the Referee notebook directory:

```powershell
uv sync --project models/guesser/evaluation --locked --extra inference
uv run --project models/guesser/evaluation jupyter lab models/referee/evaluation/notebooks
```

The model evaluation defaults to `models/referee/data/.local/data/train/prepared/`, the validation split, and the newest epoch checkpoint matching `referee-epoch=*-val_mean_ap=*.ckpt`. Adjust those paths in the notebook for another local dataset or checkpoint. The held-out test split remains unused by default; evaluate it only after model and threshold selection are frozen.

## Current limits

The current workflow evaluates the four encoded targets used by training. Treat its metrics as agreement with `encoded_presence`, not reviewed text/number detector performance. The four encoded bits do not have separate human-reviewed semantic labels in the current registry.

- Average precision is reported only when both positive and negative encoded targets occur for that bit in the selected split. Precision, recall, F1, and confusion counts are computed against the encoded bits at a reference threshold of 0.5.

The notebook repeats the current trainer's resize-to-224 and `[0, 1]` input transform for checkpoint compatibility. The shared Guesser foreground preprocessing in the Referee validation plan is not yet used by the training adapter; this notebook does not claim to validate that planned input contract or game replay warning policy.
