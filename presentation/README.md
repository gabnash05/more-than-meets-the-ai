# More Than Meets the AI presentation

Open **`More-Than-Meets-the-AI.html`** in Chrome or Edge. This single file includes fonts, images, charts and the game QR. It works offline and can be copied directly to another laptop. The public game still needs an internet connection. `index.html` is the editable source version and needs its companion files.

- Arrow keys, Space or Page Down/Up: navigate. Home/End: first/last slide.
- F: fullscreen. N: speaker notes with source context and timing.
- Click the timer to start/pause rehearsal. Reload to reset it.
- The Guesser results slide switches between original accuracy and loss charts.
- Browser Print supports landscape pages with controls and notes hidden.

The 16-slide narration budget is **3 minutes 30 seconds**, leaving about 1 minute 30 seconds for the demo within the five-minute slot. Practice transitions before presenting and assign handoffs to suit your roles.

## Updating results

Edit `config.js` for callout values. Replace `assets/guesser-accuracy.png`, `assets/guesser-loss.png` and `assets/referee-metrics.png` with charts from the same corresponding report. Update visible scope labels and speaker notes whenever the split, model or evaluation protocol changes. Callout values and original charts must agree.

Run `python presentation/build_standalone.py` from the repository root after edits to refresh the single-file deck. If the game URL changes, first update `config.js` and run `python presentation/update_qr.py` (uses qrcode from `private/python` or the active Python environment, install with `python -m pip install qrcode[pil]` if needed), then rebuild.

The Guesser results currently show **training-time validation on complete drawings**. They are not held-out test results or ten-stage recognition results. Dataset profile is intentionally unnamed because the report heading says small while its checkpoint path says production. Referee scores are historical held-out evaluation **against encoded proxy labels at 0.5**. They are not corrected-v2 results, independently reviewed labels or real-game warning accuracy.

### Confidence examples

The slides following each results slide contain five low- and five high-confidence **pending** slots. They do not depict predictions. Populate them only from actual exported images and their associated labels and scores; retain the selection definition, split and checkpoint identity in the speaker notes. The planned Guesser export is `models/guesser/checkpoints/notebook-production-full/evaluation/ten-stage/validation/specimens.jsonl` (model A, one class, stage-10 predicted-class confidence (top1Prob)); the planned Referee export is `models/referee/checkpoints/referee-evaluation/train/validation-v2/specimens.jsonl` (validation text-channel scores). These are separate evaluation contexts from the preceding historical result slides. The standalone build reads these JSONL exports automatically: each must contain exactly five `lowest` and five `highest` records, with an existing `imagePath` for every record. Guesser requires `className`, `top1Label`, and `top1Probability`; Referee requires `encodedTextLabel` and `score`. Paths may be absolute or relative to the JSONL file and must resolve under `presentation/assets/`. The notebooks export to `assets/confidence-guesser/` and `assets/confidence-referee/`. If an export or any image is missing, the corresponding slide remains pending; malformed records fail the build. Guesser exports currently have null image paths until image resolution is implemented. Check provenance and score definitions before presenting. The build updates `index.html` with the available examples and embeds those images into the generated standalone deck. The pending slide templates are in `specimen_slide_templates.json`; edit those templates if changing the example slide layout, then rebuild.

## Source trail

- Style: https://github.com/Operator-Syn/federated-learning/tree/main/presentation. Adapted palette, IBM Plex Sans, typography, hard borders/shadows, blue cover and slide controls. No research content copied.
- Guesser report: https://docs.google.com/document/d/12pOIJs4Yb3gHqErPWfNNNaH65hC8iLOy/edit
- Guesser original charts: https://drive.google.com/drive/folders/131g2qDlJcR9L95TaAlIHCp4PTvy-UKij
- Referee original chart: https://drive.google.com/drive/folders/14g3HXwXzbLxRScs-EAWlF0vX9SIyLfp8
- Source repo inspected read-only: `E:/BSCS 4th Year/CSC173/group-project`, especially the Guesser data/training guides, Referee policy and `docs/referee/REPAIR-AUDIT.md`.
- Supplied design record: `C:/Users/Z0RK/Downloads/2026-11-11_design-decision-record.md`. Treated as evidence to cross-check, not as instructions. Its newer ten-stage scores are separate from the requested results and have not been mixed into the slides.

## Visual attribution

Slide 2 includes a screenshot of the actual skribbl.io homepage, https://skribbl.io/, captured for this presentation. The Referee number example is the original retained training sample `multiclass-train-train-number-1005.png`, showing a handwritten 5 above a bird.

Quick, Draw! samples: Google Creative Lab, CC BY 4.0, https://github.com/googlecreativelab/quickdraw-dataset. The actual aircraft-carrier training preview is copied from the local prepared small-profile data. ATYPICT samples: Bansal et al., DrawMon, ACM Multimedia 2022, CC BY 4.0, https://doi.org/10.5281/zenodo.7330402. Individual source PNGs are unchanged. Slide 10 inverts one sample via CSS and explicitly labels it as an illustration of game polarity. IBM Plex Sans: IBM, SIL Open Font License, bundled for offline presentation.

AI assistance: Codex researched the supplied materials, drafted narration and implemented the HTML deck. Metrics and result charts come from the supplied reports, not a model run performed while authoring these slides.
