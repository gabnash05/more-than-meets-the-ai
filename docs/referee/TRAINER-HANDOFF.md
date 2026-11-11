# Referee trainer handoff

Status: **core runbook finalized against the current implementation**. Review evidence is linked in [the repair audit](REPAIR-AUDIT.md); replace example data/checkpoint paths with the local run paths. This document does not report a training run.

## Purpose and ownership

The trainer consumes a reviewed, prepared Referee package and owns model-side preflight, smoke, training, validation evaluation, and export. It does not acquire/expand source data, review labels, or manufacture missing positives/negatives. If package readiness fails, capture the preflight report and hand the data gap to the user/data owner. Routine trainer-environment and run-configuration fixes are self-help: resolve paths, sync the documented lock, correct arguments, adjust supported resource settings, and retry when the cause is understood. Application API, renderer, UI, deployment, warning calibration, cancellation/crash handling, and game policy remain with the user/game owner.

This runbook and the current [repair audit](REPAIR-AUDIT.md) define the repaired two-output contract and supersede earlier Referee model-planning documents. The [validation plan](validation-inference-plan.md) remains relevant for reporting boundaries. Commands below were checked against the current source implementation.

## Fixed model and input contract

- Two independent presence logits, fixed target order `[text, number]`. A canvas may contain neither, either, or both.
- Apply sigmoid independently for scores. Train with binary cross-entropy with logits over **known slots only**. Unknown slots' finite placeholders are not negatives. If a batch has no known slots, masked loss returns `None` and the training step skips the update; that batch is not an error. The dataset loader fails if a split has no supervised usable samples. Validation logs a channel AP only when that channel has positive and negative support; without both channel APs, `val_mean_ap` is absent and no valid checkpoint-selection score exists for that epoch. Production preflight must reject inadequate support before training. Never coerce an unknown into a negative.
- Use Referee's versioned background-aware preprocessing wrapper. It uses the Guesser preprocessing implementation with Referee-specific overrides `working_size=1024` and `distance=0.04`; the Guesser configuration remains unchanged. Expected prepared tensor: float32 `[3,224,224]`, with the Referee config/hash in provenance. Do not claim identical Guesser and Referee preprocessing configurations or add another trainer-specific transform. Reject incompatible Referee hashes rather than silently adapting.
- Keep the model advisory-only. Presence targets include incidental object writing; players make the prohibited-clue decision. Number scores remain a separate channel. No scores, punishment, or game-policy decisions belong in this trainer.
- The current v2 trainer uses ViT-Tiny and masked BCE-with-logits. Record the actual checkpoint, seed, package versions, optimizer/schedule, batch/accumulation, precision, stopping rule, and selected checkpoint in the run record; do not substitute settings from older plans.

## Readiness gate

Do not start a real run until all are true:

1. Use the current data/trainer CLI with the expected working directory and locked environment instructions documented below.
2. The selected package is identified by dataset ID, profile, checksums, label order, preprocessing fingerprint, and trainer-ready summary. It is not the tiny synthetic smoke package.
3. The summary demonstrates usable positive **and known negative** support for both outputs in training and validation. Unknown-label slots remain masked. Source acquisition and review corrections belong to the user/data owner; ambiguous cases stay unknown or are excluded. The current validation sample has no positives, so it cannot support evaluation or pass production readiness.
4. Train/validation sources and grouping are documented, duplicate/leakage checks are recorded, and opened probe examples are excluded from any claim of untouched evaluation.
5. The held-out evaluation package is kept separate and is not used for fitting, checkpoint selection, threshold tuning, or repeated error-driven model changes.
6. The environment resolves the locked dependencies and can load the approved pretrained initialization and one prepared row.

Current evidence does **not** pass this gate. [The repair audit](REPAIR-AUDIT.md) records review of 22 source images: 20 multiclass examples received corrections for training review, while two `only_text` examples remain audit-only. The validation sample has no positives, so it cannot support evaluation or pass production preflight. The user/data owner owns review corrections and further data acquisition. Keep uncertain labels unknown until reviewed.

A source expansion to 100 records failed because DNS resolution was unavailable. Referee canonical-preprocessing parity passed for the original 10 and had zero mismatches across the expanded 22. Of 12 synthetic stress cases, all 10 nonblank cases produced usable tensors; only the two blank canvases returned blank. Marks around 8 pixels remain limited by source raster resolution. No held-out images were opened during that work. These checks do not replace expanded reviewed support or held-out evaluation.

## Run sequence (commands confirmed in the current implementation)

Commands below are confirmed against the current `models/referee` implementation. Run data commands from the repository root with `uv` available; run model commands from `models/referee/` after syncing its locked environment. Replace angle-bracket paths with actual local paths.

### Environment setup

The model lock can resolve large PyTorch packages, especially on Windows. Put uv's cache and temporary files on the E: volume, which has space for the downloads, then sync the locked model project:

```powershell
$env:UV_CACHE_DIR = 'E:\uv-cache\referee'
$env:TEMP = 'E:\uv-temp\referee'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:UV_CACHE_DIR, $env:TEMP | Out-Null
uv sync --project models/referee --frozen
```

Run the model-module commands below from `models/referee/` (for example, after `Set-Location models/referee` from the repository root). Run the notebook commands from the repository root.

The model/data workspace resolves Python 3.13; training selects GPU when CUDA is available and CPU otherwise. The separate notebook-only environment requires Python 3.12. If a particular Python 3.12 patch release is unavailable, select an installed 3.12 interpreter:

```powershell
uv sync --project models/referee/evaluation --locked --python 3.12
uv run --project models/referee/evaluation --python 3.12 jupyter lab --ServerApp.root_dir=.
```

The package API also exposes `referee_data.preflight(prepared_dir, production=True)`, `referee_data.preprocessing_config()`, `referee_data.preprocessing_hash()`, and `referee_data.preprocess(image)` (PIL image input, canonical prepared image/status output).

1. **Prepare/inspect:** verify package checksums and summary; inspect split counts, per-output positive/known-negative/unknown counts, reviewed-label status, preprocessing fingerprint, grouping, and exclusions. Fail before extraction/loading if the package contract is incompatible.
   - Production audit (without `--sample`; expected to fail until train/validation support is sufficient):
     ```powershell
     uv run --project models/referee/data --frozen --no-dev referee-data preflight --data-root <data-root> --profile train --json
     ```
   - Nonproduction audit, which omits production support requirements:
     ```powershell
     uv run --project models/referee/data --frozen --no-dev referee-data preflight --data-root <data-root> --profile train --sample --json
     ```
   - With the data package installed in the active Python environment, an unpacked portable package can be audited directly:
     ```powershell
     python -c "from referee_data import preflight; print(preflight('<unpacked>/prepared'))"
     ```
2. **Preflight:** initialize the model and approved weights; load a training and validation batch; assert image shape/dtype/finiteness, target and mask shape/order, known-only loss behavior, and nonzero known supervision. Confirm checkpoint/output paths and free device memory.
   - The trainer calls `preflight(prepared_dir, production=not fast)` itself and records that report, the preprocessing config/hash, dataset ID/fingerprint, and run configuration. The explicit CLI above is useful for inspecting readiness before launching training.
3. **Smoke:** run the designated smoke fixture, confirm loss/backprop and checkpoint write/read, and keep its output as engineering evidence only. Run from `models/referee/` in the locked environment:
     ```powershell
     uv run --frozen python -m training.train --prepared-dir <sample-prepared-dir> --fast --num-workers 0
     ```
   - `--fast` selects nonproduction preflight and a one-epoch/two-batch smoke, with no pretrained weights download. It cannot bypass a failed production audit or produce an exportable checkpoint.
4. **Train:** only after the readiness gate passes, run the approved experiment on the trainer split with fixed configuration and reproducibility metadata. Preserve logs and checkpoints. No held-out data access during fitting or selection.
   - Minimal production invocation:
     ```powershell
     uv run --frozen python -m training.train --prepared-dir <train-prepared-dir>
     ```
   - Optional output-root override:
     ```powershell
     uv run --frozen python -m training.train --prepared-dir <train-prepared-dir> --checkpoint-root <checkpoint-root>
     ```
   - Other supported options are `--max-epochs`, `--batch-size`, `--accumulate-grad-batches`, `--num-workers`, `--seed`, `--precision`, and `--ckpt-path`. Use `--num-workers 0` to diagnose loader errors. Resume only when provenance/config checks pass. Do not launch until production preflight passes.
5. **Evaluate:** report validation results per output. The trainer's normal evaluation is validation only. Keep threshold calibration separate from the trainer; the game owner owns threshold and persistence policy.
   - Evaluate the v2 checkpoint on validation (the v2 evaluator enforces recorded Referee preprocessing):
     ```powershell
     uv run --frozen python -m recognition.evaluate --checkpoint <run-dir>/weights/<selected-checkpoint>.ckpt --prepared-dir <prepared-dir> --split validation --preprocessing foreground --output-dir <evaluation-output-dir>
     ```
   - Optional evaluator controls are `--limit <rows>` and `--bootstrap <count>`. Use the full validation split for the report later supplied to export; a limited run is only a smoke/diagnostic and must not be used as the bundle's validation evidence. The evaluator writes `predictions.jsonl`, `summary.json`, and `report.md`. Review text and number independently, and derive a confusion matrix/counts for each channel from known reviewed rows at an explicitly stated threshold. Inspect cases where number-labeled examples raise the text score and text-labeled examples raise the number score. The aggregate/AP report is not itself a cross-channel confusion analysis. Threshold calibration belongs to the game owner.
   - Do not access/evaluate the held-out split or freeze thresholds in routine trainer work. A held-out evaluation is allowed only with explicit user authorization and a user-supplied freeze record and validation report; the CLI also requires `--freeze-record` and `--validation-report` for `--split test`.
6. **Export:** package the selected weights with architecture/output order, preprocessing/config fingerprint, dependency/model provenance, checkpoint identity, and matching validation report. The current exporter requires `--evaluation-report`; it checks that the report is for validation, matches the selected checkpoint hash, and records Referee preprocessing.
   - Export only a non-smoke production v2 checkpoint:
     ```powershell
     uv run --frozen python -m training.export_v2 --checkpoint <run-dir>/weights/<selected-checkpoint>.ckpt --output-dir <bundle-parent> --evaluation-report <evaluation-output-dir>/summary.json
     ```
   - The exporter creates `<bundle-parent>/referee-vit-v2/` with safetensors weights, text/number labels, checkpoint-selection provenance, manifest, hashes, and fixed-input logit/probability parity verification. It rejects smoke checkpoints and preprocessing mismatches.
   - Synthetic input diagnostics for a checkpoint or bundle:
     ```powershell
     uv run --frozen python -m recognition.diagnostics --checkpoint <checkpoint> --preprocessing foreground --output-dir <diagnostics-dir>
     uv run --frozen python -m recognition.diagnostics --bundle <bundle-dir> --output-dir <diagnostics-dir>
     ```
     The command writes synthetic canvases and a `scores.json` with separate text and number scores. These are input diagnostics, not accuracy or a replacement for reviewed validation.

## Required report and export evidence

For every actual run, retain the exact commands/config and source/package checksums; environment and hardware; split and group counts; known positive, known negative, and unknown support for each output; preprocessing fingerprint; seed; initialization; epoch/update and checkpoint-selection details; interrupted/resumed status; and elapsed time/peak memory when available.

Report text and number separately: support, prevalence, average precision, precision, recall, F1, confusion counts, and false-positive rate at a stated reference operating point. State the threshold used for metrics; do not claim calibrated operating thresholds unless calibration was separately performed on authorized validation data. Report coverage and exclusions, distinguish encoded-label proxies from reviewed truth, and disclose the tiny smoke's engineering-only status. No metric should be described as game accuracy without reviewed game-renderer evaluation.

Export the **actual weight bundle** plus its manifest and reproducibility metadata. A chart, screenshot, notebook, or Drive folder is not a substitute for loadable weights. Conversely, weights without a matching manifest, preprocessing identity, and evaluation record are not a complete handoff. Confirm the expected artifact destination and naming with the game owner before copying or publishing.

## Recovery and diagnosis

First try the safe, documented remedies below and make ordinary environment/configuration corrections. Stop rather than guessing when a remedy would alter data or labels, change model/preprocessing semantics, bypass validation, force-load an incompatible checkpoint, expose held-out data to training/selection, or modify game/application code. Also stop if the same failure persists after the relevant documented remedy, the failure has no clear cause, or the package appears corrupt/inconsistent.

When stopping, preserve the failing command and working directory, full traceback/log tail, environment and hardware summary, config, dataset/profile ID and checksum, manifest/preprocessing fingerprint, checkpoint identity, and the smallest reproducible sample/step. If a checkpoint or bundle can still be loaded, run from `models/referee/`:

```powershell
uv run --frozen python -m recognition.diagnostics --checkpoint <checkpoint> --preprocessing foreground --output-dir <diagnostics-dir>
uv run --frozen python -m recognition.diagnostics --bundle <bundle-dir> --output-dir <diagnostics-dir>
```

This creates synthetic canvases and a `scores.json`; it is an input diagnostic, not a general failure-report generator. Include its output when relevant and record the remaining failure context manually. Do not include credentials, tokens, or private user data. Send the report to the responsible owner; do not keep retrying with speculative changes.

| Symptom | First checks and safe remedy |
|---|---|
| CUDA out-of-memory | Record device/peak allocation; lower physical batch size, retaining the intended effective batch with gradient accumulation if supported. If still failing, use a smaller documented model/input option only after owner approval and record the change. Do not silently change precision or architecture. |
| Loader hang/worker crash | Retry with `num_workers=0` using the documented option to reveal the original decode/worker exception. Preserve the failing sample ID and traceback. |
| Missing path or manifest mismatch | Check the resolved working directory, package profile, manifest-relative path rules, and checksum/package ID. Fix the invocation or request a corrected package; do not edit source labels to make the loader pass. |
| Corrupt/unreadable image or invalid tensor | Quarantine/report the sample with its ID and decode/shape/finiteness error; ask the data owner to review and rebuild the package. Never silently drop it or substitute a blank. |
| Missing or ambiguous labels / inadequate support | Stop model work and pass the preflight summary to the user/data owner, who owns further source acquisition and label review. Keep genuinely unknown slots masked. Absent encoded flags are source-derived negatives, not reviewed negatives; do not infer labels from folder names. |
| Dependency or checkpoint download/load failure | Check the active environment and project directory, then sync/install from the documented lock/setup instructions and retry. Capture package versions, exact checkpoint ID and full error if the documented setup does not resolve it. Do not substitute a checkpoint or change model semantics to make loading pass. |
| Resume/checkpoint mismatch | Compare architecture/output order, preprocessing fingerprint, dataset/profile, config, optimizer state, and checkpoint manifest. Resume only when compatible. Otherwise start a separately identified run from the approved initialization; do not force-load or relabel an incompatible checkpoint. |
| Export mismatch or load failure | Compare the manifest with the selected checkpoint, model signature, output order, and preprocessing fingerprint. Correct the export command/config and re-export from the selected checkpoint; run the documented load smoke. If identity still does not match, stop and report it. Charts or logs are not the exported model. |

After recovery, distinguish a resumed run from a fresh run, preserve the original failure evidence, and record every changed setting. No result from an interrupted or mismatched run is silently combined with another run. Do not treat routine resource/config adjustments as a bug; record them and continue when supported by the run instructions.

## Existing evidence and limits

Prior VM probe observations were: white blank canvas text score **49.67%**; gray canvas text score **50.65%**; `HELLO` on white background text score **49.72%**; inverted `HELLO` text score **89.21%**; inverted digit sample text score **86.65%**. These are synthetic/input-sensitivity probe scores, **not accuracy**, not a held-out evaluation, and not evidence of calibrated operating thresholds.

The historical checkpoint lineage and correspondence between those observations and charts in Drive have not been resolved. No actual weights bundle was found in the Drive folders inspected. Preserve that uncertainty in any report; do not attribute the observations to a reproducible checkpoint without matching its identity, source revision, input/preprocessing, and chart provenance. The current sample remains too small and validation has no positives; it is not training-ready. The trainer must not infer review outcomes; see [the repair audit](REPAIR-AUDIT.md).

Once real weights are exported, note that the current two-output model signature requires a corresponding change to the service loader, owned by the user/game owner. The trainer's export is not deployable through the current loader by itself; do not modify the loader as part of trainer work.

For the first real model evaluation, include baseline diagnostics beyond aggregate scores: per-output text/number confusion counts and rates, especially text-versus-number confusions and false positives/negatives, plus reviewed examples for each error type. Keep diagnostic labels tied to reviewed data. A single aggregate metric can hide a model that detects one channel while confusing the other.

## Remaining handoff details

- Replace placeholder paths with the concrete prepared data, checkpoint and export locations for the actual run. Do not invent or imply a weights destination in Drive.
- Held-out evaluation requires explicit user authorization and supplied freeze/validation records. No held-out images were opened during the recent bounded source inspection.

## Linux and Colab setup

The same modules and prepared-package paths work on Linux/Colab. Run the model commands from `models/referee/` in the checked-out repository; no Windows E: path is required. Use `uv sync --project models/referee --frozen` from the repository root, then run commands with `uv run --project models/referee --frozen python -m ...`. Set cache/temporary directories to an available mounted volume if necessary. The model/data runtime is Python 3.13; the separate notebook kernel is Python 3.12. Launch model commands in subprocesses rather than importing model dependencies into the notebook kernel. In Colab, prefix shell commands with `!`; install `uv` in the notebook runtime if absent. Verify `torch.cuda.is_available()` in the model environment before expecting GPU training. Linux/Colab execution has not been verified by this Windows CPU repair run.

## What to return

Return the selected training checkpoint, its `run.json` and CSV logs, the validation report directory, and the entire `referee-vit-v2` export folder. That folder contains `weights.safetensors`, `labels.txt`, `labels.json`, `checkpoint-selection.json`, `evaluation-summary.json`, and `manifest.json`. The manifest hashes every payload file; the included validation summary must match the selected checkpoint. Keep hashes and filenames together. No actual v2 production weights have been created by the code repair.

The owner must complete the real-data readiness gate before assigning the production run. The reviewed sample ZIP is for setup/smoke only. Start the trainer with a prepared package, not an unresolved labeling/download task.
