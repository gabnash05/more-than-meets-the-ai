> Historical plan: the v1 zero-proxy policy below is superseded by `separate-writing-advisories-v2`. Encoded zeros are known source-derived negatives, not reviewed negatives; uncertain reviews remain masked. See the data runbook.

# Referee validation and inference plan

The latest review uses separate text and number evidence, shared Guesser input, validation-tuned thresholds and persistent observations. This document specifies implementation and evaluation work.

## 1. Evaluate each presence output

The fixed target order is `[text, number]`. A positive means that content is visible, including on a depicted object. Train and evaluate the known slots independently. Keep incidental-versus-prohibited player judgments as a separate annotation when measuring advisory burden.

Use reviewed labels for the main evaluation and separately report agreement with encoded ATYPICT proxies. Report text and number supports, prevalence, average precision, precision, recall, F1, confusion counts and false positive rates separately. A macro average can summarize the two outputs, with both individual results shown alongside it.

Measure content false positives on reviewed absence labels. Separately measure how often an advisory appears on permitted incidental writing in game validation. These have different causes and can guide different fixes. Include arrows, circles, icons, character-like drawing parts, words, digits, mixed content and object writing in the review slices.

Retain blank, uncertain, unavailable and excluded counts in coverage reporting. The shared blank/pass path supplies a legitimate blank observation while the model scores remain null. Recognition metrics and policy-level suppression metrics should identify that distinction.

## 2. Shared input and split discipline

Use the same canonical canvas raster, generation, revision and prepared tensor as the Guesser for any revision both models evaluate. The pinned Guesser `foreground` transform outputs float32 `[3,224,224]`, fits foreground within 192 pixels and normalizes using mean/std 0.5. Keep chat, hints, controls and secret targets outside the captured canvas image.

Training sources differ by task. Render Quick, Draw! prefixes for Guesser training and decode ATYPICT PNGs for Referee training, then apply the same image transform. A real-game shared-input fixture must produce identical prepared tensors for both model callers.

Use the grouped splits in the data plan. Source evaluation is the archive named `test.zip`, whose internal directory is `val/`. Disclose opened multiclass evaluation images 4036, 2326 and 879 and exclude their related groups from claims of an untouched test. Original-session independence remains unverified without a source map.

## 3. Tune thresholds on validation

Keep two opening thresholds, `text_enter` and `number_enter`. Choose each from validation precision/recall curves with the user's preference for fewer false advisories. Record missed detections at the chosen operating point. The default 0.5 score cutoff is a reporting reference, and the deployed operating point requires validation.

If calibration is fitted, fit each channel on held-out calibration data or out-of-fold validation predictions. Freeze calibration parameters and thresholds before final evaluation. When the reviewed support is small, report support and uncertainty alongside each curve.

Static ATYPICT validation can guide content thresholds. Tune warning persistence, cooldown and hysteresis using separately labelled game replays, because the released raster data lacks usable observation timing. Measure advisory precision, false advisories per clean turn, repeat advisories and time to first qualifying warning on those replays.

## 4. Historical persistence proposal (superseded)

The game now opens a text advisory on one fresh score of at least 0.3. The two-observation proposal below is retained as an evaluation alternative, not the active game rule. Compare false advisories and time to warning on reviewed game replays before treating either setting as calibrated.

Use independent state for text and numbers. A provisional starting policy checks the current canvas at about once per second. Open a channel's advisory after **two consecutive fresh observations** exceed its opening threshold, separated by **at least one second**, with a **maximum three-second gap**. These count/timing values are working assumptions for replay validation.

1. Validate the active canvas, generation, revision and preprocessing version. Discard stale and out-of-order results.
2. Validate a fresh observation ID and monotonic capture/confirmation time. Count each observation once. A fresh confirmation of the same current canvas can count as duration evidence. Stable revisions can reuse cached scores keyed by canvas, generation, revision, preprocessing version and model version.
3. Update each channel's streak independently. A below-opening-threshold observation resets its pending streak. A long gap or unavailable/uncertain observation breaks continuity.
4. When a streak qualifies, open that channel's incident and emit one advisory. Keep an active incident from repeating on every observation.
5. Use a lower exit threshold to end an active incident and a validation-chosen cooldown before another advisory. Clear, restart, generation change and turn close retire incident state immediately.

Observations of the same or similar image are correlated. The persistence rule measures how long evidence remains visible. Brief writing can disappear before the duration requirement is met, while a stable mistaken detection can persist. Replay validation should measure warning precision, misses and delay when selecting the count and timing settings.

| Evidence channel | Advisory wording | Policy behavior |
|---|---|---|
| Text | Possible written clue detected. | High-precision threshold and persistent evidence, with human judgment of incidental versus prohibited writing |
| Number | Possible numbers detected on the canvas. | Independent threshold and persistence, with a separate numeric advisory policy |
| Arrows, circles and other icons alone | None | Hard-negative evaluation slice |

Advisory events carry zero score effects. Players resolve disputes.

## 5. Service result and scheduling

Illustrative result fields below define an example contract.

```json
{
  "match_id": "example-match",
  "drawing_turn_id": "example-turn",
  "generation": 2,
  "snapshot_revision": 41,
  "observation_id": "example-observation",
  "observed_at": "example-monotonic-time",
  "prepared_image_hash": "example-hash",
  "status": "ok",
  "task": "text_number_presence",
  "label_order": ["text", "number"],
  "text_score": 0.87,
  "number_score": 0.18,
  "model_version": "example-model",
  "preprocess_version": "shape-candidates-v1/foreground",
  "preprocess_config_hash": "example-config",
  "policy_version": "separate-writing-advisories-v1"
}
```

The backend turns model evidence into incidents after checking persistence and policy. Use nullable scores for blank, uncertain or unavailable results. The classifier supplies the two presence scores. Players supply the rule judgment.

Use FastAPI/Pydantic and a resident model with `eval()` and `inference_mode()`. Bound concurrency and preserve Guesser checkpoint scheduling. Preprocess a required canvas revision once and reuse the tensor. Actual queue placement and shared CPU packaging must fit the existing transport and model environments during implementation.

Measure p50/p95 preprocessing and inference time, capture-to-backend delay and combined-device contention. Include snapshot generation/revision and processing timestamps in traces. The snapshot cadence and latency targets remain working configurations pending measurement.

## 6. Model handoff and checks

Package the two-output architecture, ordered target registry, shared preprocessing candidate/config hash, weights, training recipe, per-channel calibration and thresholds, and the persistence/cooldown settings. Verify output shape `[B,2]` when loading the artifact.

The integration checks cover text appearing and disappearing, digit-only drawings, both channels together, identical or out-of-order observations, long gaps, erasure, undo, clear, generation changes, valid incidental object text and concurrent Guesser work. Preserve the human game when the Referee is unavailable and report monitoring availability explicitly.
