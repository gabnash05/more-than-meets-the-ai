# Referee planning package

Research and sample inspection: **7 November 2026, Asia/Manila**. This package concerns the group project's Referee, separately from the Guesser and the current backend milestone.

The proposed input contract gives the Guesser and Referee the **same current-canvas image and versioned preprocessing**. The proposed Referee produces two independent presence scores, one for text and one for numbers. Each has its own threshold tuned on validation data and a persistence check across distinct observations. Text prompts ‘Possible written clue detected.’ Numbers have a separate advisory. Players judge incidental writing and disputes. Advisory events carry zero score effects.

## Read or explore

- [Referee data package](../../models/referee/data/README.md) includes the six CPU preparation stages and a verified offline example with separate trainer and held-out ZIPs.
- [Data-only Lavish walkthrough](referee-data-flow.html) follows the Guesser layout. Use the [Terra worker plan](referee-data-delegation-plan.md) to delegate the work and the [one-page handoff](referee-data-handoff.md) for the model owner.
- [Outputs and warning policy](referee-policy-boundary.md) explains the two presence labels, message types and player judgment.
- [Dataset sufficiency](dataset-sufficiency.md): why ATYPICT fits a baseline, what is still unknown and how to verify adequacy.
- [Visual walkthrough](referee-flow.html): actual sample browser, label conversion, dataset pitfalls, training choices and delivery sequence. Uses the project's Fredoka/Nunito typography and yellow/blue palette. The [standalone offline copy](referee-flow-offline.html) needs no live Lavish server.
- [Dataset audit](dataset-audit.md): official download route, archive contents, exact NumPy formats, sample findings and evidence limits.
- [Data workflow plan](data-workflow-plan.md): six proposed stages, classification manifests, cleaning, duplicate handling and splits.
- [Model plan](referee-model-plan.md): task choice, backbone, preprocessing, fine-tuning recipe and practical alternatives.
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

This revision records the latest review direction in the Referee plans. It supersedes the interim merged writing target. The data package implements the reviewed preparation flow and has passed a synthetic workflow rehearsal. Model training, score calibration and game integration remain future work.

The sample is deliberately selected to inspect formats, not to estimate class prevalence. Three multiclass evaluation images were opened: two paired schema probes and one duplicate check. These are disclosed probe examples rather than untouched final-test examples; the text-only release also has two paired evaluation probes.
