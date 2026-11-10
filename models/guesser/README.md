# Guesser

- [data/](data/README.md): implemented numbered data stages and shared timed-image creation; Python 3.13/uv. Profiles: `production`, `medium`, `small` (plus non-trainable `smoke` examples).
- [training/](training/README.md): implemented Lightning + timm ViT-Tiny fine-tuning for matched A/B runs (`complete_only` vs partial). Point `--prepared-dir` at small/medium/production `prepared/` data. Weights stay under ignored `checkpoints/`.
- `recognition/`: implemented fixed ten-stage recognition evaluator for exported serving bundles. It keeps blank/uncertain views in the end-to-end denominator, reports the passing-policy trade-off, and guards held-out test runs with a frozen record.
- [inference/](inference/README.md): future prediction service and model loading.
- [evaluation/](evaluation/README.md): relocated Python 3.12/uv notebook environment. Notebooks 05 and 06 export and score serving bundles; latency and inference-service benchmarks remain future work.
- `checkpoints/`: local weights, CSV logs, and A/B comparison artifacts; ignored by Git (transfer separately if needed).

Use the [library guide](LIBRARIES.md) and [implementation rules](AGENTS.md). Standard deep learning tasks should use maintained library APIs. No production-trained weights or inference service are shipped in Git.
