# More Than Meets the AI presentation

Open **`More-Than-Meets-the-AI.html`** in Chrome or Edge. This single file includes fonts, images, charts and the game QR. It works offline and can be copied directly to another laptop. The public game still needs an internet connection. `index.html` is the editable source version and needs its companion files.

- Arrow keys, Space or Page Down/Up: navigate. Home/End: first/last slide.
- F: fullscreen. N: speaker notes with source context and timing.
- Click the timer to start/pause rehearsal. Reload to reset it.
- The Guesser results slide switches between original accuracy and loss charts.
- Browser Print supports landscape pages with controls and notes hidden.

The 14-slide narration budget is **3 minutes 10 seconds**, leaving about 1 minute 50 seconds for the demo within the five-minute slot. Practice transitions before presenting. Suggested speaking handoffs: Husnie slides 1–5, John-Ronan slides 6–8 and 12, Kim slides 9–11 and 13–14. Change these to suit your roles.

## Updating results

Edit `config.js` for callout values. Replace `assets/guesser-accuracy.png`, `assets/guesser-loss.png` and `assets/referee-metrics.png` with charts from the same corresponding report. Update visible scope labels and speaker notes whenever the split, model or evaluation protocol changes. Callout values and original charts must agree.

Run `python presentation/build_standalone.py` from the repository root after edits to refresh the single-file deck. If the game URL changes, first update `config.js` and run `python presentation/update_qr.py` (uses qrcode from `private/python` or the active Python environment, install with `python -m pip install qrcode[pil]` if needed), then rebuild.

The Guesser results currently show **training-time validation on complete drawings**. They are not held-out test results or ten-stage recognition results. Dataset profile is intentionally unnamed because the report heading says small while its checkpoint path says production. Referee scores are historical held-out evaluation **against encoded proxy labels at 0.5**. They are not corrected-v2 results, independently reviewed labels or real-game warning accuracy.

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
