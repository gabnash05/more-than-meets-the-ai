# Referee game-owner checklist

This checklist covers the game-side work after a model trainer provides a verified, loadable two-output weights bundle. The trainer consumes a reviewed, prepared package and owns model-side preflight, smoke, training, validation evaluation, and export; the user/data owner retains source acquisition and label review. **The user/game owner retains ownership** of API integration, renderer/input contract, UI, deployment, threshold and persistence calibration, cancellation, crash behavior, and game acceptance. This checklist does not authorize implementation or deployment.

## Gate 0: accept a real model handoff

- [ ] Receive an actual loadable weight bundle, not only Drive charts, screenshots, a notebook, or a metric table.
- [ ] Verify bundle checksum, architecture, two-output signature/order `[text, number]`, source/checkpoint identity, dependency/runtime requirements, and model manifest.
- [ ] Verify the manifest's Referee preprocessing identity/hash and version. Referee uses the Guesser preprocessing implementation with Referee-specific overrides `working_size=1024` and `distance=0.04`; the Guesser config remains unchanged.
- [ ] Read the completed report: source and split provenance, reviewed known-positive/known-negative/unknown support per output, held-out separation, per-channel metrics, exclusions, and limitations.
- [ ] Confirm any reported threshold calibration used permitted validation data and was frozen before the final held-out evaluation. Charts alone do not establish this.
- [ ] Confirm the model owner has not presented synthetic probe scores as accuracy, and that historical source revision and Drive-chart correspondence are either verified or stated as unknown.

## Gate 1: renderer and API contract

- [ ] Capture only the current canonical canvas raster. Keep chat, hints, controls, prompt/secret target, and answer-bearing state out of the image.
- [ ] Ensure Guesser and Referee receive the same raw canonical canvas PNG for the same generation/revision. Each model prepares its own tensor; Referee uses its versioned Referee-specific overrides. Do not require identical prepared tensors or Guesser preprocessing config.
- [ ] Validate inference input shape/dtype/finiteness and output as two finite independent scores in `[text, number]` order. Treat invalid input/output as unavailable/uncertain, not as a clean negative.
- [ ] Keep text and number advisory channels independent. The number score remains separate and does not silently become a text warning or score effect.
- [ ] Preserve advisory-only semantics: zero score effect, no automatic punishment, and human judgment for whether visible writing is a prohibited clue. Incidental object writing can be a positive text-presence prediction.
- [ ] Review event payloads, privacy, stale revision handling, and error states against the existing API/game contract before enabling real weights.

## Gate 2: thresholds and persistence calibration

- [ ] Calibrate separate text and number thresholds using reviewed validation evidence and the intended preference for low false-advisory burden. Do not take a proposed `0.5` cutoff or synthetic VM score as calibrated.
- [ ] Separately choose persistence/cadence/expiry behavior on reviewed game-canvas replays. Measure false advisories on incidental writing, arrows, circles, icons, character-like forms, blank/gray canvases, and both polarities.
- [ ] Include positive text-only, number-only, mixed text/number, and small/peripheral writing examples. Report support and misses per channel.
- [ ] Freeze policy parameters before final acceptance evaluation. Record dataset/replay identities, thresholds, persistence rule, coverage, and results.
- [ ] Ensure blank, uncertain, unavailable, inference failure, and clean evidence remain distinct states. A failure must not be interpreted as a negative prediction.

## Gate 3: cancellation and failure behavior

- [ ] Verify requests are bound to the correct match, turn/generation, canvas revision, and model version; reject stale results after canvas changes, reset, pause, or turn end.
- [ ] Verify cancellation on superseding revisions and lifecycle transitions, with no late advisory after cancellation.
- [ ] Exercise model process unavailable, timeout, malformed output, OOM, crash/restart, and partial response. Fail safely to unavailable/uncertain; preserve human play and scoring.
- [ ] Confirm retries are bounded and do not duplicate advisories or apply results to a different turn. Record operational errors without exposing secret targets or private data.
- [ ] Verify clean teardown/recovery and document any remaining crash or cancellation limitations.

## Gate 4: UI and deployment

- [ ] Keep text warning copy advisory and neutral; show no accusation or automatic penalty. Confirm the number channel's approved visibility/message behavior.
- [ ] Check warnings clear/expire according to the calibrated policy and do not leak into a new turn or stale canvas state.
- [ ] Exercise accessibility, small screens, loading/unavailable states, and interaction alongside human guessing and scoring.
- [ ] Pin model artifact/version and preprocessing identity in deployment configuration; verify artifact checksum and rollback path. Keep deployment disabled until the owner accepts the prior gates.
- [ ] Measure target-environment latency, throughput, memory, and failure rate. Do not substitute synthetic VM probes for production measurements.
- [ ] Record the exact deployed bundle, policy configuration, environment, and acceptance evidence. Keep rollback available if the real model increases false advisories or destabilizes play.

## Evidence to carry forward

The prior synthetic VM observations were white blank **49.67% text**, gray **50.65% text**, `HELLO` on white **49.72% text**, inverted `HELLO` **89.21% text**, and inverted digits **86.65% text**. They show input sensitivity only; they are not accuracy or threshold calibration. Historical checkpoint lineage and correspondence with Drive charts remain unresolved. No actual weights bundle was found in the Drive folders inspected; require an exported weights bundle and matching manifest before integration.

See [the repair audit](REPAIR-AUDIT.md) for review evidence: 22 source images were inspected, with corrections for 20 multiclass examples and two `only_text` examples retained as audit-only. Referee preprocessing parity had zero mismatches across all 22. Of 12 synthetic stress cases, all 10 nonblank cases produced evidence; only the two blanks produced no evidence. Marks around 8 pixels remain limited by raster resolution. The validation sample has no positives, so it cannot support production evaluation. The user/data owner owns the review report, uncertain labels, and further source acquisition. A smoke run establishes pipeline mechanics, never model quality.

The historical checkpoint lineage is unresolved. Require a reproducible checkpoint identity and verified export before integration. The two-output model requires a user-owned change to the current service loader; the exported model alone will not load through the existing service contract.

## Trainer handoff status

The core data preflight, v2 training, evaluation, export, and synthetic diagnostic commands are documented in [the trainer handoff](TRAINER-HANDOFF.md) from the current implementation. Review evidence is in [the repair audit](REPAIR-AUDIT.md). Replace example paths with the actual run paths, then review the exported bundle and integration contract before connecting it to the game.

## Specific issues observed in this investigation

The 0.5-and-persistence policy below describes the older inspected build. The current policy uses one text score of at least 0.4; the original report and its exact build still need separate reproduction if that discrepancy matters.

- [ ] Reproduce the reported 40% warning and identify its exact UI/build/payload. The inspected deployed backend requires text evidence >=0.5 plus persistence, so a literal 40% warning remains unexplained by that path. Compare displayed score, model revision and stale warning state rather than assuming a threshold bug.
- [ ] Test draw -> erase -> clear -> new turn. Confirm both raw PNG emptiness and warning removal/expiry; distinguish an exactly white blank from gray pixels or residual marks.
- [ ] Reproduce and fix the uncaught `Error: aborted` from inference cancellation in `redis-queue.js` through `RoomEngine.cancelInference/pauseGroups`. The inspected API container had restart count 3; the logs do not prove every restart had this cause. Verify cancellation is handled without process exit and human play continues.
- [ ] Add v2 model-service bundle-loader support, including the two-output shape and the new manifest file/hash inventory. Model-level adapter tests are not service-readiness tests.

The v2 model adapter imports the CPU-only `referee_data` and `guesser_data` packages. Ensure the service image installs/copies the correct reader packages and their resources, not just the new weights. Test the exact bundle with `/health/ready` and a real inference request after updating the service loader. Existing v1 service readiness is not evidence of v2 runtime compatibility.
