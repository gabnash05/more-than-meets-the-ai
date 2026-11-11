# Referee

- [data/](data/README.md) prepares ATYPICT canvases and exports smoke packages.
- `training/`: model training and fine-tuning.
- `inference/`: model loading and predictions.
- [evaluation/](evaluation/README.md): notebook-based checkpoint auditing, validation metrics and threshold review.
- `checkpoints/`: local model weights, ignored by Git.

The data pipeline has been exercised on synthetic fixtures and a bounded ATYPICT sample. The training, inference and evaluation folders describe the planned model work.

See the [Referee planning package](../../docs/referee/README.md) for the ATYPICT sample audit, classifier fine-tuning plan, six-stage data workflow and interactive visual walkthrough. These are proposed next steps; no Referee weights, training results or inference service are included.

## Referee v2 repair and training handoff

The corrected pipeline predicts independent text/number presence with reviewed-label masks and shared canonical preprocessing. Start with [TRAINER-HANDOFF.md](../../docs/referee/TRAINER-HANDOFF.md); [REPAIR-AUDIT.md](../../docs/referee/REPAIR-AUDIT.md) records validation and data limitations. Existing four-output artifacts remain legacy inputs. Production training and game deployment are separate steps and have not been performed by the repair.
