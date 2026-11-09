# Guesser model and data plan

Initial decisions agreed on 4 November 2026; data workflow simplified on 5 November 2026 (Asia/Manila). Delivery horizon: next week; the seven workdays below are a relative work plan, not an agreed calendar deadline.

**Scope:** Guesser only. All 345 Quick, Draw! categories. Direct depictions first. No new human drawing collection. A transformer is required. This document specifies work to implement and validate; it does not report a trained model or measured recognition performance.

## 1. The agreed result

Build a locally hosted image classifier that repeatedly recognizes the currently visible drawing and produces a ranked distribution over the 345 category IDs. Use a pretrained **ViT-Tiny**, adapted with complete and incomplete Quick, Draw! examples.

Per-point timestamps determine which points exist in each training/evaluation view. The first model receives an image, not coordinates, timestamps, the target word, or future strokes.

| Decision | Agreed plan |
| --- | --- |
| Training and recognition data | Quick, Draw! only |
| Vocabulary | All 345 official categories; the game prompt registry must use this vocabulary |
| Recognition task | One intended category for the whole evolving canvas |
| Backbone | timm ViT-Tiny, ImageNet pretrained, then fine-tuned on Quick, Draw! |
| Color | Shape recognition; color is usable for preprocessing but is not an intended semantic cue |
| Fill/background | Keep the UI tools; explicitly test and select background-aware preprocessing |
| Data volume | Default 5,000; medium 2,000; small 500 distinct usable originals/class; all 345 labels |
| Split | Default 4,000/500/500; medium 1,600/200/200; small 400/50/50 per class, before making prefixes |
| New player dataset | Excluded at the user's request |
| Updates | Approximately one recognition update per second when the visible state changes |
| Counted guesses | Scheduled game opportunities, separate from recognition updates |
| Passing | Allowed for blank or uncertain input; no replacement opportunity |
| Demo | One inference laptop, one match, up to three teams |
| Demo timing | Configurable example: 60 seconds; six opportunities at 10, 20, 30, 40, 50, 58 seconds |
| Game hints | Retain the existing design: the same official word length and revealed letters as humans |
| Evaluation | Complete-only training versus partial-training adaptation; no prescribed accuracy percentage |
| Latency target | Provisional p95 snapshot-to-result <= 1 second at three teams; measure it |
| Additional class constraints | None reported beyond the transformer requirement |

The one-second cadence, six demo opportunities, training hyperparameters and latency target are working configurations. They are not measured capacity or universally correct thresholds. Keep them versioned and adjustable.

This Guesser scope supersedes the earlier Qwen candidate for this plan. It does not rewrite the game repository or change the separate Referee work. Indirect visual references and private codes may remain legal game strategies, but recognizing them is outside this first model's claimed capability.

## 2. Three people, three concrete responsibilities

The user owns **Data**. The other two group members own **Model** and **Validation & Inference**. Use member names in your project tracker when assigned.

| Role | Owns | Required handoff | Does not independently change |
| --- | --- | --- | --- |
| Data — you | Source inventory and attribution; category registry; full-file sampling; structural cleaning; duplicate handling; original-drawing splits; timestamp cuts; Quick, Draw! renderer; indexed records/manifests; quality report; shared preprocessing fixtures | Versioned data package, train/validation manifests, test package for the validation owner, preprocessing specification and examples | Class ID order, held-out test membership, or preprocessing without a version change and coordination |
| Model | Load and adapt the pretrained transformer; data loader; complete-only baseline; partial-training experiment; equal training budget; checkpoints; training logs; model packaging | Weights, model configuration, label mapping hash, preprocessing version, training recipe, checkpoint-selection record | Data splits or final test-based tuning |
| Validation & Inference | Independently audit splits and inputs; validation reports and calibration; hold final test for the frozen candidate; background/fill and renderer checks; FastAPI inference worker; checkpoint integration; latency/load tests | Evaluation report, inference contract/service, latency traces, final test report and demo run instructions | Training labels, the split, or scoring/game rules inside the inference service |

**Shared ownership:** Data and Validation & Inference agree on the renderer/preprocessor and golden image fixtures. Model uses that exact version. The validation owner can help inspect data-quality grids while the data owner prepares downloads.

**Why these boundaries:** the data role produces reusable original drawings and deterministic views, rather than millions of unrelated PNGs. The model role can begin on a small package while data preparation continues. The inference owner can build the API against a dummy 345-class predictor while training runs.

### The first shared contract

Agree these on Day 1:

- `labels.json`: ordered list of 345 class IDs and exact source names.
- `dataset_version` and sampling/cleaning version, with seed `198173`.
- `preprocess_version`, including color/background handling and stroke rendering.
- Input tensor: float32 `[B, 3, 224, 224]`; grayscale shape image repeated into RGB channels.
- Output: logits `[B, 345]`; labels resolved only through the matching registry.
- Validation prefix grid: 10%, 20%, ..., 100% of each recording's drawing duration.
- Same original drawing and every derived view stay in exactly one split.

## 3. Which data files to use

Use raw Quick, Draw! category NDJSON files. One line describes an original drawing with a string ID, category, metadata and separate `[x, y, time]` stroke arrays. Raw timestamps allow elapsed-time prefixes; the simplified bitmap/vector releases do not replace that timing input. AtyPict is outside this Guesser scope.

Keep the official 345-category order. The model target is its class ID; the word, recognized flag, country, ID and timestamps do not enter the vision model as features. Valid `recognized=false` drawings remain eligible.

Choose one balanced training profile: production (default, 5,000 eligible originals/class), medium (2,000/class), or small (500/class). All keep 345 categories. Production samples full category streams; medium/small read source prefixes only and stop after collecting their reserve. These sizes are not model batch sizes, and their recognition accuracy remains unmeasured.

## 4. Download and local environment

Use the standalone Python 3.13/uv project at `models/guesser/data/`. Its real defaults are in `src/settings.py`; descriptive JSON configs have been removed. The relocated notebook/evaluation project is `models/guesser/evaluation/`, with a separate Python 3.12 lock. This refactor does not unify those environments.

Run the [data README setup](../../models/guesser/data/README.md), then run these commands from `models/guesser/data/` on Windows or Linux. Preview is optional:

```sh
uv run --frozen guesser-data download
uv run --frozen guesser-data prepare
uv run --frozen guesser-data preview   # optional in PowerShell/bash; omit comment in cmd
uv run --frozen guesser-data export
```

Choose `--profile medium` or `--profile small` on each of the four commands above to download less and prepare a smaller training dataset. Omitting it preserves production. Real defaults remain in Python settings.

| Profile | Reserve/category | Train/category | Validation/category | Test/category | Final total |
|---|---:|---:|---:|---:|---:|
| `production` (default) | 5,500 | 4,000 | 500 | 500 | 1,725,000 |
| `medium` | 2,200 | 1,600 | 200 | 200 | 690,000 |
| `small` | 550 | 400 | 50 | 50 | 172,500 |

The model teammate performs the eventual download. Missing inventory is fetched automatically. Production pins generations and verifies full byte counts/MD5; its dated bundled inventory totals approximately 181.43 GiB. Medium/small pin generations, record consumed bytes and candidate hashes, and explicitly mark sources partial without claiming whole-file verification. They sample source beginnings, so they can be less representative than full-source sampling. Raw files are streamed, not retained in full. Two streams run by default; peak RAM/disk, actual partial-download sizes and throughput remain to be measured.

Production keeps 5,500 candidate IDs/class using the smallest `select-v1` SHA-256 priorities with seed 198173 and string-ID tie-breaks. Medium and small collect the first 2,200 and 550 distinct cleaned IDs/class, then rank those candidates with the same hash. Malformed/repeated-ID records do not add slots. Each profile has its own `.local/data/<profile>/` folder, summaries and archives. Matching completed classes resume; incomplete classes restart from the beginning. No download-budget ledger, per-source database, automatic conflict re-download or code/document freeze is required.

## 5. Cleaning and retained-candidate conflicts

Cleaning occurs during `01-download.py`. Preserve stroke order, pauses, valid dots, nonzero starting times and valid unrecognized records. Remove empty strokes and exact repeated x/y/time triples. Reject malformed arrays, unsafe/nonfinite coordinates, invalid chronology, no full-drawing extent and zero duration. Normalize signed zero and keep IDs as strings.

Only retained candidates receive ID conflict tracking. Conflicting retained IDs keep their ranked slot until the inspected stream ends, preventing order-dependent replacement within that inspected input. Preparation uses one temporary SQLite index for retained identities, content/trajectory hashes and candidate offsets; it does not store another full JSON copy.

Quarantine retained ID/content/label conflicts and cross-label identical full trajectories; never relabel automatically. Same-label exact trajectory duplicates keep a deterministic best representative. This does not claim to discover conflicts involving discarded source records.

Optional manual exclusions are one ID per line in `excluded-ids.txt`. Per-class approval CSVs and sign-offs have been removed. If exclusions/duplicates leave a class short, explicitly download a larger reserve for that class and prepare again.

## 6. Split original drawings, then generate views

Select the chosen profile's eligible originals/class, sort by the separate `split-v1` hash and ID, then assign its exact training/validation/test counts from the table above. Production totals are 1,380,000 / 172,500 / 172,500 originals; medium totals are 552,000 / 69,000 / 69,000; small totals are 138,000 / 17,250 / 17,250. Every view of an original remains in its partition. Smaller profiles are marked trainable; the example/probe smoke profile remains nonproduction. Use the same frozen profile for both compared models; different profiles have different held-out originals and their scores alone do not form a controlled dataset-size comparison.

Write uncompressed seekable UTF-8 JSONL under `prepared/records/{split}/` and Parquet indexes under `prepared/manifests/`. Manifests retain identity, class, split, record path, byte offset/length, timing, recognized flag, quality counts and trajectory hash. No selected/staging-selected copies are required.

`dataset-summary.json` records source information, seed, ordered labels, counts, preparation statistics and record/manifest hashes. It does not fingerprint source files or documentation. Export performs one final audit; optional standalone auditing is not another required phase.

## 7. Turn timestamps into incomplete training examples

`05-loader.py` reads one indexed original; `06-images.py` cuts, renders and preprocesses it. The image enters the transformer and class ID is the separate training target. PyTorch Dataset/DataLoader batch integration is model-owner work, not implemented by the data package.

For partial-training adaptation, choose 20% complete views and otherwise a uniformly sampled elapsed-time cut in 10%-90%. Seed choices by drawing ID, epoch and purpose, independently of worker order. Blank training views have bounded retries; uncertain/skipped outcomes remain explicit. The complete-only baseline uses the full original.

Evaluation always emits ten fixed 10%-100% elapsed-time stages, retaining blanks, uncertainty and unchanged images in reporting. Cuts are inclusive, preserve separate strokes/pauses/dots and use first-to-last elapsed time. Cropping/scaling uses only visible prefix points; future bounds must not leak into early images.

## 8. Rendering, color, fill and background handling

Use the same shared image recipe for training and live visible-canvas snapshots. Raw Quick, Draw! points render as dark strokes on white, using a 512-square canvas, 448-pixel fit and 2x supersampling; evaluation width is 6 and training width is seeded in 3-12.

`foreground` is the provisional default (formerly foreground): estimate a dominant border background and retain foreground shapes, including filled silhouettes. `edges` remains available (formerly edges): union per-channel Canny boundaries. Foreground can return uncertain on mixed borders; edges can lose low-contrast evidence or double-outline thick strokes. Neither method automatically falls back to the other.

Fit the current visible shape within 192 pixels, center on 224, repeat as three channels and normalize by mean/std 0.5. The result is float32 `[3,224,224]`. Use one method consistently per model and do not normalize twice.

Color is used to separate visible shapes, not as learned category meaning. Background-fill, interior-fill, erasure and restoration checks illustrate preprocessing behavior; synthetic examples do not establish game recognition accuracy. The validation owner can compare the two methods before final experiments.

## 9. Model choice and training work

### Recommended starting checkpoint

`timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k`

Its [model card](https://huggingface.co/timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k) describes a 224x224 ViT with about 5.7M parameters, pretrained on ImageNet-21k and fine-tuned on ImageNet-1k. It is **not already a Quick, Draw! classifier**. Your group supplies the 345-category head and sketch adaptation.

The recommendation is based on the fixed-vocabulary task, transformer requirement, local GPU constraints and one-week horizon. It is not an experimentally established “best model” for your game.

~~~python
import timm
import torch

torch.manual_seed(198173)
model = timm.create_model(
    "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
    pretrained=True,
    num_classes=345,
)
model.eval()
with torch.inference_mode():
    assert model(torch.zeros(2, 3, 224, 224)).shape == (2, 345)
~~~

The [timm API](https://huggingface.co/docs/timm/quickstart) supports replacing the classifier with `num_classes`. Save the initial head state or identical initialization seed for the controlled training comparison.

### Alternatives considered

| Option | Why it is not the primary one-week plan |
| --- | --- |
| Object detection model | Requires localization targets the Guesser does not need; your supervision is an intended category for the whole canvas |
| [Sketchformer](https://github.com/leosampaio/sketchformer) | A relevant pretrained stroke transformer, but its documented setup is older TensorFlow and Quick, Draw! stroke preprocessing; pretrained-data overlap must be checked, and edit/fill state requires extra handling |
| [Community BEiT sketch classifier](https://huggingface.co/kmewhort/beit-sketch-classifier) | Already sketch-adapted, but documented Quick, Draw! pretraining makes unseen-test provenance important; a new random split from the same corpus cannot automatically be called unseen |
| [Qwen3-VL-2B](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct) | Fits broader language/visual reasoning questions, but is more complex than this fixed 345-label classifier requires; no local sketch latency advantage was measured |
| [DeiT-Tiny](https://huggingface.co/facebook/deit-tiny-patch16-224) | Sensible transformer fallback if the chosen timm checkpoint has loading problems; do not spend the week training many backbones |

Sketch-RNN is mainly a sketch-generation representation/model family, not a ready answer-word classifier to adopt without additional classification work. A separate stroke/timing transformer is future experimentation, not required simply because raw timestamps exist.

### Two controlled runs

- **A — complete-only baseline:** fine-tune the pretrained ViT on complete drawings only.
- **B — partial-trained adaptation:** same backbone, originals, initialization, optimizer budget and image preprocessing; use the 20% full / 80% timestamp-prefix view recipe.

Train independently from the same pretrained initialization. Do not give B extra training updates and attribute the entire improvement to partial examples. If you later do A -> B continued adaptation, add a continued-complete control with the same additional updates.

Starting configuration for both:

| Setting | Working value |
| --- | --- |
| Loss | Cross-entropy over 345 intended labels |
| Optimizer | AdamW |
| Head LR | 1e-3 |
| Backbone LR | 1e-4; reduce if unstable |
| Weight decay | 0.01 |
| Warmup | First 5% of the agreed update budget |
| Effective batch | 32; e.g. physical 8 x accumulation 4 |
| Epoch ceiling | 6, with best-validation checkpoint and patience 2 |
| Schedule | Warmup then cosine decay, identical across A/B |
| Precision | Begin with a successful FP32 run; use tested FP16 autocast/scaling if stable on the actual GPU |
| Loader | Start with 0 workers for debugging; then 2–4 workers after measuring RAM/CPU use on the actual Windows or Linux host |
| Seed | 198173, including samplers and augmentation |

Run a small overfit check and an all-345-class smoke set before the full experiment. Check loss decreases, label mapping is correct, gradients are finite and padded blank images do not become confident release candidates.

Time a representative training interval, including rendering/loading, before committing to six epochs. If the ceiling exceeds the available time, fix an equal step budget for A and B in advance, keep balanced sampling across **all 345** classes, and report the actual budget. Do not quietly remove difficult categories.

Data can prepare the small or medium trainable package first. The smoke example remains only a pipeline example; it is not the all-345-category training dataset. The baseline and adapted run can use separate laptops; final serving uses one frozen model, not a three-laptop distributed inference requirement.

## 10. Validation and final testing

### Keep tuning and testing distinct

Use validation for architecture/preprocessor pilots, epoch selection, temperature calibration and pass thresholds. Once these are frozen, run the chosen model and the fixed baseline on the final test. Do not retune after seeing test errors and still describe that same test as untouched.

For fast epoch selection, use a deterministic validation subset such as 50 originals/class (all validation originals for small). Use the selected profile's full validation set for final validation/calibration and its full held-out test set once: 500/class for production, 200/class for medium, 50/class for small. Generate views on demand or cache a bounded number of shards, rather than writing millions of small image files.

### Detailed model-validation procedure

The Validation & Inference owner leads this procedure with the model owner's frozen checkpoints. Validation is an offline recognition-quality task; the latency/load protocol below is a separate runtime task.

1. **Audit inputs before scoring.** Confirm train/validation/test ID and trajectory-hash disjointness, all 345 labels, and exactly the selected profile's validation originals per class (500 production, 200 medium, 50 small). Validate timestamp cuts and current-prefix-only crop bounds. A manifest/parser failure must be fixed and counted, not silently omitted from the denominator.
2. **Build identical held-out views.** Each original produces ten fixed time prefixes: 10% through 100%. Full production validation has 172,500 originals and 1,725,000 views per model pass; medium has 69,000 originals / 690,000 views, and small has 17,250 originals / 172,500 views. A fixed 50-per-class subset has 17,250 originals and 172,500 views for fast epoch checks. Preserve this same subset, view recipe and image hashes across A and B.
3. **Run evaluation mode.** Use `model.eval()` and `torch.inference_mode()`, with no optimizer step, stochastic training augmentation or training-time dropout. Run A and B against the same inputs, output registry and scoring code.
4. **Write one offline result row per view.** Include drawing ID, true class ID, time fraction/cutoff, input hash, checkpoint identity, preprocessor version, raw top-k logits/IDs, blank status and any passing-policy result. The true label is available only to the offline evaluator; it never enters the live inference request.
5. **Inspect learning after each epoch.** Record training loss, validation cross-entropy on nonblank evaluable images, and the early-recognition score. Keep blank stages visible in end-to-end recognition metrics. If training improves while validation quality declines, inspect overfitting and use the best validation checkpoint rather than the latest weights. Keep the same checkpoint-selection rule and patience for A and B.
6. **Evaluate full validation before final selection.** Report all ten stage accuracies, mean early accuracy, complete-image top-1/top-3, per-class support/confusions and uncertainty grouped by original drawing. Compare candidates with the equal-budget rule from Section 9.
7. **Calibrate passing on validation only.** Fit any scalar temperature using validation logits and intended labels with model weights fixed. Sweep candidate confidence thresholds, for example 0.00–0.95 in 0.05 increments, and record the resulting accuracy/coverage tradeoff. A finer sweep is allowed on validation, never on test. Keep blank/preprocessing-uncertain passes deterministic.
8. **Freeze and record the decision.** Save weights/hash, labels/hash, preprocessor, calibration, pass threshold, public-hint policy and selection rationale. If hint filtering is used, assess it separately; a hint-normalized score must not be presented as visual confidence.
9. **Run final testing on different originals.** Only after freezing, evaluate A and the chosen candidate on the selected profile's final-test originals (172,500 production, 69,000 medium, 17,250 small) and the fixed ten-stage grid. Report the fixed protocol even if the results are disappointing. Changing a candidate after studying test errors means the original untouched-test claim no longer applies.

#### Metric definitions and denominators

- **Stage top-1:** correct unthresholded top-ranked classifications at that stage divided by the number of original drawings. In the end-to-end recognition curve, a blank stage has no valid recognition and counts as unsuccessful. This curve is separate from the passing policy.
- **Mean early top-1:** the arithmetic mean of the nine stage accuracies from 10% through 90%, with macro class averaging. Because the planned class counts are equal, class-balanced and overall stage averaging coincide until any missing/invalid examples are accounted for.
- **Complete top-1/top-3:** use the final recorded view. Top-3 membership is a ranking diagnostic; it does not authorize extra counted game guesses.
- **Policy coverage:** number of emitted guesses divided by all evaluated opportunities, including passes.
- **Accuracy among emitted guesses:** correct emitted guesses divided by emitted guesses. If no guesses are emitted, report undefined/null, not 100%.
- **Overall policy correctness:** correct emitted guesses divided by all evaluated opportunities. Report this with coverage and conditional accuracy so a high pass rate cannot conceal an ineffective Guesser.
- **Validation loss:** a diagnostic for learning/calibration on valid nonblank model inputs. Report its denominator; do not replace the early-recognition objective with loss alone.
- **Uncertainty:** resample whole original drawings within class, keeping all their stages together. Report paired A/B differences on the same drawings, not uncertainty as if every prefix were an unrelated sample.

The illustrative +5-point early-accuracy goal and <=2-point complete-image-loss guard are comparison goals. They do not replace the full score report, constitute a promised accuracy, or justify test-based tuning.

#### Validation owner's concrete handoff

| Deliverable | Minimum contents |
| --- | --- |
| Stage-level metrics | A/B top-1 at every fraction, early mean, complete top-3, original/view counts and blank counts |
| Error analysis | All-class support/accuracy, major confusions and reproducible drawing/view IDs |
| Prediction records | Offline per-view rows or a documented reproducible equivalent |
| Policy evaluation | Calibration, pass thresholds, coverage, conditional accuracy and overall correctness |
| Candidate-freeze record | Model, registry, manifest and preprocessing hashes; chosen checkpoint and selection rule |
| Final-test report | Same fixed metrics on the untouched original-drawing test split, with grouped uncertainty |

Generate recognition-versus-progress plots from actual evaluation outputs. Before experiments run, report the result fields as not run/null; do not insert made-up scores into the planning visualization.

### Recognition measures

Report the following on **sketch-only** input first:

- Top-1 accuracy at every fraction 10%–100%.
- Mean early top-1 accuracy across 10%–90%, with macro class averaging.
- Complete-drawing top-1 and top-3 accuracy.
- Per-class support/accuracy and major confusion pairs; all 345 classes remain in the report.
- Blank-stage/pass rate and uncertain-pass rate.
- Accuracy among emitted guesses together with coverage, so passing cannot inflate an isolated accuracy number.
- Recognition trajectory: first correct stage and, separately, first stage followed by correct predictions at the next observed stage. Report failures/censoring rather than dropping unsolved drawings.

Top-3 accuracy is a diagnostic. Returning three labels in an internal response is not permission to count three game guesses.

A reasonable provisional adaptation goal is +5 percentage points in mean early top-1 over A, while losing no more than 2 points on complete-drawing accuracy. This is a project goal for comparison, not a required class rule or a known achievable result. If it is missed, report the result and select the better validated candidate; do not manufacture a positive finding.

Compute uncertainty by resampling whole drawings within class (e.g. a stratified bootstrap). Keep all ten views together in each resample. Do not treat 1.725M correlated prefix images as that many independent test drawings.

### Hints and game behavior

Report a second, explicitly **hint-assisted** evaluation if a reproducible hint schedule is simulated. Filter label candidates using only the same public word length/letter pattern humans receive. Keep the sketch-only result separate.

The vision network remains image-only. Log raw image scores separately from hint-filtered ranking. Softmax renormalization over a one-label hint set is not evidence of strong visual confidence. Choose and freeze the passing policy on validation, and report hint candidate-set sizes and pass coverage.

This is a closed-vocabulary classifier. Low-confidence passing is not a guaranteed detector of unsupported concepts or meaningless marks; those can still produce confident errors. Keep all playable prompts mapped to the frozen 345-label registry.

### Latency and capacity

On the intended inference laptop, with weights already loaded:

- Warm up before timing steady-state inference; report cold startup separately.
- Time canonical capture/render, preprocessing, queue wait, GPU inference, postprocessing and result receipt.
- Report p50/p95 and failures under one, two and three simultaneous team streams at the proposed cadence.
- Include scheduled jobs during the frequent-update traffic; verify they are not starved.
- Target p95 snapshot-to-result <= 1 second for three teams.
- Use one host clock for each measured interval or calibrated cross-host tracing. Do not subtract unrelated laptop clocks.
- Confirm that lowering precision, changing batching, exporting or quantizing does not silently change rankings beyond the documented tolerance. Export/quantization is optional for this deadline.

No new player data will be collected. Consequently the evaluation establishes Quick, Draw! held-out performance and synthetic robustness checks. It does not establish accuracy, fairness or human-beatable difficulty on actual player sketches.

## 11. Live inference and counted attempts

### Runtime flow

1. The existing Next.js canvas sends operations to the authoritative NestJS game backend.
2. NestJS freezes a current canonical canvas version and public hint version.
3. Respect the existing observation barrier: active human guessers must have rendered the permitted versions before their release to the AI.
4. A worker creates the visible snapshot; FastAPI applies the versioned shape preprocessor.
5. A resident ViT produces 345 logits.
6. Postprocessing applies public hint constraints and the frozen pass/guess policy.
7. Return version-tagged recognition information.
8. NestJS alone decides whether this is a scheduled attempt, validates it, checks the hidden target and updates game state.
9. Save input identity, model/policy versions and timing for replay/evaluation.

The model service must not receive the secret answer, human guess text, opposing canvases or a database connection that exposes those labels. Training labels belong outside live model-visible input. Official hints are permitted; the target is not.

### Frequent recognition is not a counted guess

- At most one frequent-update request per active team per second; skip unchanged snapshots.
- Bound pending work; replace/coalesce obsolete unstarted recognition jobs.
- Scheduled attempts have priority over background recognition updates.
- Use only the checkpoint's frozen canvas/hint versions for its counted decision.
- Reuse a cached result only for the exact permitted image/input versions, hash, model and preprocessing/policy revision. Do not use a newer snapshot or future hint, or smooth a checkpoint prediction with later observations.
- The initial model is stateless across images. Temporal smoothing is deferred.
- Hidden recognition updates must be tagged separately from official attempts in logs and replay.
- AI guess text stays hidden from players until the existing reveal/replay stage; progress indicators can update.

### Pass, failure and cancellation are different

At each scheduled opportunity, emit either one canonical word or a pass. A blank or low-confidence pass consumes that opportunity and creates no replacement checkpoint. It is a normal policy outcome, not an inference outage.

A real timeout/service error is a failed required attempt and follows the existing backend outage/bonus rules. A human solve, forfeit, timeout, voided round, generation change or prior AI solve cancels further relevant work. A late response cannot score retrospectively.

Keep round duration, opportunity times, deadlines and pass thresholds in configuration. The example six-opportunity schedule leaves the last two seconds for a response before the round deadline; the backend must still reject results that actually arrive too late.

### Proposed service contract

This is a contract to implement, not an existing endpoint.

~~~json
{
  "job_id": "unique-job",
  "match_id": "match",
  "round_id": "round",
  "round_generation": 1,
  "team_id": "team",
  "kind": "recognition_update",
  "checkpoint_id": null,
  "canvas_version": 123,
  "hint_version": 2,
  "snapshot_sha256": "hash",
  "image": "canonical image bytes or an agreed internal binary upload",
  "public_hint": {"pattern": "_ a _", "word_length": 3},
  "deadline": "backend-defined deadline",
  "preprocess_version": "shape-v1"
}
~~~

For a counted attempt, `kind` is `scheduled_attempt` and a checkpoint identity is required. Retain the server-instance identity required by the existing game design as well.

Return `job_id` and the same generation/team/input versions, `model_version`, `preprocess_version`, `policy_version`, candidate class IDs/scores, `decision=guess|pass`, the chosen canonical class ID when applicable, pass reason and stage timing. A top-k list is for diagnostics; only the chosen word is one game answer.

Load weights once on service startup; call `model.eval()` and use `torch.inference_mode()`. Start with a single bounded GPU worker. Microbatch up to three compatible jobs only if the load test confirms deadlines. FastAPI handles validation/admission; it must not block the game event loop or award points.

## 12. Parallel seven-day work plan

Day numbers mean work sessions from the agreed start. Fix the actual submission date in your group calendar.

| Day | Data — you | Model | Validation & Inference |
| --- | --- | --- | --- |
| 1 | Pin the 345-label registry, source inventory and cleaning/split recipe; full-class throughput probe; begin source scan | Verify CUDA and checkpoint; build 345-head model and loader against smoke records | Build input/output schemas and dummy API; prepare split-audit and render/fill fixtures |
| 2 | Continue scan; deliver indexed smoke subset across all 345 classes; preprocessing pilot inputs | Overfit/smoke checks; measure training throughput and agree equal A/B budget | Audit labels/splits; compare foreground/edges on validation pilot and synthetic fills; select the shared preprocessor with Data |
| 3 | Complete scan, duplicate/refill checks and QA; save split manifests/summary; hand off packages | Start complete-only baseline A and partial-trained B from same initialization | Build resident model worker, pass policy harness, checkpoint/version handling |
| 4 | Resolve preparation defects without touching test-based decisions; finalize data receipt | Continue runs; choose checkpoints using validation only | Generate stage-wise validation metrics; integrate public hint filtering; first three-team load run |
| 5 | Help inspect training/validation failures and package reproducible data recipe | Finish/freeze candidate; deliver complete model package | Calibrate/select passing policy on validation; rerun fill/renderer and end-to-end checks |
| 6 | Verify artifact hashes and data reproducibility | Support inference parity; no test-driven retraining | Run final held-out evaluation for frozen A/B, synthetic stress report and timed three-team demo |
| 7 | Final data documentation and attribution | Final training/ablation write-up | Demo rehearsal, failure handling, final results and limitations; buffer for integration fixes |

If source scanning takes longer, Model and Validation & Inference continue with the all-class smoke package and dummy/service fixtures. All-345 coverage, frozen split integrity and honest reporting remain required. Reduce equal training steps or optional export work before removing categories or using test data for tuning.

## 13. Data handoff and completion checks

Optional contact sheets show training originals without an approval requirement. `04-export.py` audits data once before writing separate trainer (train/validation) and held-out-test ZIP64 packages with checksums. It preserves installable data source and uv setup while excluding test records/manifests and test-derived QA from the trainer archive.

Editing documentation does not invalidate data. Changed prepared records require preparation again. Existing valid prepared records can receive a new summary without a download. Historical datasets and ZIPs are not rebuilt automatically.

Keep final test custody with the validation owner. Model handoff additionally needs weights, class mapping, chosen preprocessing/settings, training recipe and checkpoint selection record. A model-quality report remains separate from data-format checks.

## 14. Evidence, decisions and remaining work

The data tools are implemented, and earlier reports record limited synthetic/real-prefix validation. The slim refactor uses only five small offline checks plus static relocation checks. These do not prove full-source throughput, peak memory, dataset-wide quality, model accuracy or real-game latency.

The evaluation environment/notebook scaffold was moved from `research/guesser-evaluation/` into the agreed model layout. Its notebook has not been run as part of this move; no new model dependencies or weights were installed.

Production acquisition/counts/quality and the model/evaluation experiments remain their owners' work. Preserve the controlled complete-only versus partial-training comparison and untouched held-out test.

Primary sources: [Quick, Draw! formats and license](https://github.com/googlecreativelab/quickdraw-dataset), [ViT-Tiny checkpoint](https://huggingface.co/timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k), [timm classifier adaptation](https://huggingface.co/docs/timm/quickstart).

## 15. Read the numbered implementation

1. `01-download.py`: source inventory, streaming, cleaning, sampling and simple resume.
2. `02-prepare.py`: retained-candidate conflicts, deduplication, original splits and summary.
3. `03-preview.py`: optional training contact sheets and a small synthetic example.
4. `04-export.py`: one final data audit and separate trainer/test packages.
5. `05-loader.py`: read one original and coordinate its requested view.
6. `06-images.py`: time cut, visible-stroke rendering and foreground/edges preprocessing.

`settings.py` is the source of editable defaults. The [README](../../models/guesser/data/README.md) maps the files and the [runbook](../../models/guesser/data/RUNBOOK.md) gives exact commands. Reference implementations live in those source files rather than duplicate code pasted into this document.
