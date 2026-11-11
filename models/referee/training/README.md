# Referee training

The v2 model predicts independent `text` and `number` logits. Known labels alone contribute to binary cross-entropy and validation AP. Unknown-only rows are excluded; missing or corrupt images fail. Blank and uncertain images are excluded, with IDs recorded in run.json. The training-only random affine is applied after canonical preprocessing and uses the normalized white background as its fill. AP is omitted when a validation channel lacks either class. The data package owns preprocessing and the production preflight audit.

From `models/referee/`, in an environment with the model and editable data packages installed:

```powershell
# Explicit nonproduction smoke on a prepared fixture; no pretrained download.
python -m training.train --prepared-dir <fixture-prepared> --fast --num-workers 0
# Production starts only after the full real-data audit succeeds.
python -m training.train --prepared-dir <production-prepared>
# Resume only an exact matching v2 run and dataset.
python -m training.train --prepared-dir <production-prepared> --ckpt-path <run>/weights/last.ckpt
# Export a production checkpoint; smoke checkpoints are rejected.
python -m training.export_v2 --checkpoint <run>/weights/best-00.ckpt --output-dir <bundles> --evaluation-report <validation>/summary.json
# Review synthetic canvases with a trusted checkpoint or a v2 bundle.
python -m recognition.diagnostics --checkpoint <checkpoint> --preprocessing foreground --output-dir <diagnostics>
python -m recognition.diagnostics --bundle <bundle> --output-dir <diagnostics>
```

Each new run receives a unique directory with `run.json`, best and last checkpoints. Checkpoints carry the data fingerprint, run configuration, preprocessing config and hash. Resume is explicit and rejects legacy or mismatched checkpoints. The v2 exporter checks model shape and provenance, verifies logits and sigmoid probabilities, and atomically publishes a new bundle. Legacy four-output checkpoints remain for inspection and the existing legacy export path. Do not treat a smoke run as a trained model or a performance result.
