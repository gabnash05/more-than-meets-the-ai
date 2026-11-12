# Referee planning package

Research and sample inspection: **7 November 2026, Asia/Manila**. This package concerns the group project's Referee, separately from the Guesser and the current backend milestone.

The Referee consumes the current canvas image and produces two independent presence scores, text and number. The current game policy shows an advisory on one text score of at least 0.3; number evidence stays internal. Players judge incidental writing and disputes. Advisory events carry zero score effects. Threshold calibration and false-advisory measurement remain future evaluation work.

## Current state

The repaired two-output contract is defined by [the trainer handoff](TRAINER-HANDOFF.md) and [the repair audit](REPAIR-AUDIT.md). Those two supersede the earlier model-planning documents for that contract: the fixed `[text, number]` target order, known-slots-only loss, preflight gates and export signature. Game-side acceptance, thresholds, cancellation and deployment gates are tracked in [the game-owner checklist](GAME-OWNER-CHECKLIST.md), which does not authorize implementation on its own.

The planning sections below remain the record of how the task, sampling and evaluation boundaries were chosen. Read them for rationale, not as the current implementation contract.

## Read or explore

- [Trainer handoff](TRAINER-HANDOFF.md): the current runbook for preflight, smoke, training, validation evaluation and export, plus who owns each failure.
- [Repair audit](REPAIR-AUDIT.md): 11 November review separating code verification, directly inspected data and historical model evidence, with the work still required before production training. Dated evidence, not a current pass.
- [Game-owner checklist](GAME-OWNER-CHECKLIST.md): the five gates and ownership split once a verified weights bundle exists.
- [Referee data package](../../models/referee/data/README.md) includes the six CPU preparation stages and a verified offline example with separate trainer and held-out ZIPs.
- [Data-only Lavish walkthrough](referee-data-flow.html) follows the Guesser layout. Use the [Terra worker plan](referee-data-delegation-plan.md) to delegate the work and the [one-page handoff](referee-data-handoff.md) for the model owner.
- [Outputs and warning policy](referee-policy-boundary.md) explains the two presence labels, message types and player judgment.
- [Dataset sufficiency](dataset-sufficiency.md): why ATYPICT fits a baseline, what is still unknown and how to verify adequacy.
- [Visual walkthrough](referee-flow.html): actual sample browser, label conversion, dataset pitfalls, training choices and delivery sequence. Uses the project's Fredoka/Nunito typography and yellow/blue palette. The [standalone offline copy](referee-flow-offline.html) needs no live Lavish server.
- [Dataset audit](dataset-audit.md): official download route, archive contents, exact NumPy formats, sample findings and evidence limits.
- [Data workflow plan](data-workflow-plan.md): six proposed stages, classification manifests, cleaning, duplicate handling and splits.
- [Model plan](referee-model-plan.md) (historical for the two-output contract): task choice, backbone, preprocessing, fine-tuning recipe and practical alternatives.
- [Validation and inference plan](validation-inference-plan.md): evaluation, threshold selection, advisory results and integration boundaries.
- [Sources and attribution](SOURCES.md): primary references and which claims each supports.
- [Inspection evidence](inspection/summary.json), [verified findings](inspection/verified-findings.json), and [sample contact sheet](samples/contact-sheet.png).

## What is verified

- The implemented data workflow prepared one live smoke sample of 10 multiclass training triplets using 2,868,684 archive response bytes (2.74 MiB). All 10 PNGs matched their NumPy pixels and loaded as finite tensors. The export contains 8 train and 2 validation rows and is marked smoke-only.

- The Zenodo record contains one **397,584,204-byte** ZIP with four nested archives.
- Directory metadata was inspected for all four archives. Sixteen complete image/NumPy/label triplets were selectively extracted, plus four small members for follow-up checks.
- Dataset range responses transferred **7,360,940 bytes (7.02 MiB; 1.85% of the archive)**, including directory overhead and one preliminary ZIP-tail request. This excludes small web/API/code responses and installed CLI tooling. The complete dataset was not downloaded.
- All sixteen inspected images are 512 x 512 grayscale; their NumPy images exactly match their PNG pixels. Their labels are detector-anchor targets, rather than ordinary class IDs or raw bounding-box lists.
- A visible-writing example has no positive text anchors. A cross-release training/evaluation duplicate was confirmed by byte equality and SHA-256.
- The existing Guesser `foreground` preprocessor accepted all sixteen sampled PNGs and produced finite float32 `[3,224,224]` tensors. The walkthrough includes those exact processed images and the inspection summary records their tensor hashes.

## What remains planned

No full data preparation, model-weight download, training, accuracy benchmark, runtime integration or deployment was performed. Proposed recipes, ownership, cadence and thresholds are working plans. The classifier is a recommended starting experiment, not a measured best-performing referee.

This revision records the review direction of this planning package and supersedes the interim merged writing target. For the current two-output contract, use the trainer handoff and repair audit above. The data package implements the reviewed preparation flow and has passed a synthetic workflow rehearsal. Model training, score calibration and game integration remain future work.

The sample is deliberately selected to inspect formats, not to estimate class prevalence. Three multiclass evaluation images were opened: two paired schema probes and one duplicate check. These are disclosed probe examples rather than untouched final-test examples; the text-only release also has two paired evaluation probes.
