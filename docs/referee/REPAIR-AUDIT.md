# Referee repair audit — 11 November 2026

This report separates code verification, directly inspected data, historical model evidence and work still required before production training. No game code, gameplay thresholds or deployments are changed by this repair.

## Direct dataset review

22 training-source PNGs were inspected in original form and source/canonical pairs: ten current local multiclass samples, ten additional retained multiclass samples and two retained only-text samples. Held-out images were not opened during this implementation. This is a bounded development audit, not a representative accuracy study. The two only-text examples remain audit-only and are not merged into multiclass training because of known cross-variant leakage risks.

Twenty multiclass review decisions are retained under `reviews/`, with reviewer identity, reason and original PNG SHA-256. Uncertain labels stay masked. One current sample, `text:1870`, has ambiguous curved marks and remains unknown for both channels; `number:926` has a visible 3 but uncertain text. Human review is still needed for these uncertain slots. Classifying writing presence does not establish cheating: incidental writing and symbols remain game-policy decisions.

Examples confirmed visually include text in a `number` directory, a small visible number in an example with no encoded number anchors, ordinary object/face drawings suitable as reviewed negatives, and `only_text:5906`, which visibly says flute despite its zero text anchors. Folder names and absent encoded anchors are not ground truth.

The attempted expansion to 20 examples per source folder used a 24 MiB archive-response cap and cached pinned metadata. It failed partway through range requests with DNS/getaddrinfo errors; no new sampled PNGs were acquired. The final exact transferred-byte total was unavailable after the interrupted requests. Previously retained samples were used instead; this report does not claim a 100-image review or whole-archive checksum verification.

## Preprocessing inspection

Run the reproducible audit from the repository root in an environment with referee-data installed:

```sh
python docs/referee/scripts/review_preprocessing.py
```

It writes JSON diagnostics and source/canonical sheets under `models/referee/data/.local/repair-audit-20261111/`. All 22 source samples returned usable tensors; every normal/inverted pair had maximum absolute tensor difference **0.0**. Twelve synthetic stress cases exercised blank and gray canvases, thin and tiny writing, edge writing, red/blue/faint strokes, alpha transparency, large writing and a circle.

Visual inspection caught damaged faint/tiny writing under the initial Guesser defaults. The Referee-only wrapper now uses working size 1024 and distance 0.04; the Guesser implementation is unchanged. Reinspection showed faint, colored, edge and transparent writing preserved. White and gray uniform canvases returned blank. Eight-pixel text remains visibly pixelated, so preservation of a nonblank tensor is not proof of legibility or recognition at that size. Real game brush widths and screenshots still need owner testing.

## Historical deployed baseline

`reviews/deployed-v1-baseline-20261111.json` preserves a read-only VM probe of the deployed bundle, its manifest, selection record, input pixel hashes and weights hash. It uses direct adapter inference, not the renderer or HTTP route. These synthetic probes are not model accuracy.

The deployed weights SHA-256 is `d89873a364e6eb08f86cc0205c255abcdf5ef20f14cb625ead4dc3852f36f8b5`. The selection records epoch 4, score 0.5564 and rgb_resize. A white blank scores approximately 49.67% text; HELLO black-on-white scores approximately 49.72%, versus 89.21% after inversion. Gray blank is approximately 50.65% text. Inverted digits score approximately 86.65% **text**, illustrating cross-channel confusion.

The available local and VM checkout trainer code used cross-entropy while validation/serving used BCE/sigmoid. This defect is confirmed in those sources. The exact historical training source revision, full original run dataset and training logs have not been recovered. Do not infer that the checkpoint filename or current source proves its historical training configuration.

The shared Drive material was inspected earlier in this chat. It contains evaluation charts, metrics and checkpoint-selection records; actual weights were not found in the inspected folders. Chart-to-deployed-weight correspondence remains unverified. Keep those charts separate from v2 results.

## Remaining production prerequisites

The reviewed sample is still a sample, not a complete source acquisition. Its small validation split lacks positive support. Production preflight must reject it even though reviewed negatives now exist. No corrected production checkpoint or ready full-data package has been produced.

Before giving the trainer a production-ready package, the data owner must acquire the complete pinned multiclass source, apply only corrections for sample IDs actually present, resolve or retain uncertain labels, review enough further examples for positive/negative validation support, regenerate preparation and export, then pass production preflight. A passing integrity/support gate is not an accuracy guarantee. Portable packages report unauthenticated provenance: SHA-256 verifies content consistency, not source authenticity.

The game owner separately owns service-loader v2 compatibility, rendering parity, warning thresholds/calibration, the 40%-display versus 50%-backend discrepancy, stale warnings and the logged inference-cancellation crash. See GAME-OWNER-CHECKLIST.md. No threshold is selected by this repair.

## Verification

Final integrated model/data suite: **59 passed, 2 skipped**. The two skips require the absent historical Lightning checkpoint; a separate non-skipped synthetic four-output adapter test verifies legacy v1 loading. Notebook/helper suite: **20 passed** under Python 3.12.2. Model/data checks used Windows Python 3.13.5, PyTorch 2.15.0+cpu, Lightning 2.6.6 and timm 1.0.31. This is CPU verification, not the locked Windows CUDA branch or Linux/Colab GPU verification.

Ruff passed from the documented project roots; data Pyright passed. `git diff --check` passed. A separately generated synthetic fixture completed the documented two-training/two-validation-batch smoke with no pretrained download; the evaluator and diagnostic CLI completed. Export explicitly rejected that actual smoke checkpoint. Synthetic export/load tests verified matching logits/probabilities, blank handling, included validation-report integrity and tamper rejection. These fixture checks are engineering evidence, not learned model quality.

The corrected reviewed sample was prepared/exported and its trainer ZIP extracted. Local and portable preflight agreed on dataset ID `2928756d3739ad78e9595464ac3b4d9cd85545bbbd3497813987403f067d422e`, and both rejected production readiness. Source acquisition now rejects missing annotation pairs and cannot mark an incomplete acquisition complete. Portable reports cannot authenticate a source merely from hashes; they state that limit explicitly.

The read-only VM baseline capture did not alter deployment. No game application code, Guesser code, production model training, commit or push was performed. Notebook cell IDs, prompts, metadata and unrelated saved outputs were retained; changed launcher cells must be rerun before their outputs can be considered current. Legacy four-output checkpoints remain inspectable, but are not valid resume inputs for the corrected two-output trainer.
