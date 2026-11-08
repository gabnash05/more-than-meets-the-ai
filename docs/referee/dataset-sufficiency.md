# ATYPICT sufficiency for separate Referee advisories

ATYPICT multiclass has the label types needed to train separate text-presence and number-presence outputs. The current plan uses those scores as advisory evidence, with players judging incidental writing and prohibited clues. Dataset adequacy for the actual game will be established through training and validation.

## What fits the task

- The source registry distinguishes text, number, symbol and circle content.
- Reduce class confidence columns across anchors, then retain the text and number bits independently.
- Mixed-content canvases can supervise `[1,1]` when both categories are represented. Their frequency remains to be counted.
- Reviewed arrows, circles and ordinary drawings can provide hard negatives for both channels.
- Directory metadata contains 8,470 multiclass training image entries and 4,460 source evaluation entries. The label inventory and duplicate audit will establish unique usable counts.
- The existing Guesser foreground preprocessor accepted all sixteen sampled PNGs and produced the required float32 `[3,224,224]` format.

Use the multiclass release as the first training source. The text-only variant lacks number supervision and has verified overlap with multiclass evaluation.

## Evidence still needed

The format probe found visible writing with zero text anchors. Review nominal absence separately for text and numbers and preserve unresolved slots as unknown. Count the reviewed positives/negatives and report text and numeral support independently. Group duplicates and related versions before splitting, and disclose the missing source-session mapping.

Evaluate the shared image transform and both classifiers on the game's actual canvas. Include small or incomplete characters, colors, filled shapes, erasure, object labels, digits and drawing parts that resemble characters. The shared transform gives both models consistent pixels, while dataset and live-renderer differences still require evaluation.

ATYPICT's static raster examples support content-score validation. Game replays supply the timing needed to tune persistent observations, cooldown and per-channel thresholds. Keep a separate record of player judgments about incidental text so the validation report can show the practical advisory burden.

## Proposed sequence

1. Inventory and audit the source, including per-channel known-label masks and duplicate groups.
2. Prepare grouped training/validation manifests and a separately held source evaluation partition.
3. Train the frozen-feature baseline and fine-tuned two-output ViT-Tiny with the shared preprocessing recipe.
4. Choose per-channel score thresholds using validation data and the preference for fewer false advisories.
5. Tune warning persistence on labelled game replays, then evaluate the frozen system on separate game-canvas examples.
6. Add targeted examples where held-out errors show a coverage gap, reserving separate examples for evaluation.

The first sixteen records establish format and image-transform compatibility. Model accuracy, numeral coverage, warning precision and latency remain to be measured. The training baseline and its held-out errors will determine whether additional examples are needed.
