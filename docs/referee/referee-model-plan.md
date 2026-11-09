# Referee classifier and fine-tuning plan

Proposed 7 November 2026. This plan is based on archive inspection and sixteen sample records. It does not report a trained classifier, a measured model comparison or a completed policy-labelled dataset.

## 1. Choose the task the labels can support

Fine-tune a shared-backbone ViT-Tiny classifier with **two independent binary outputs**. One predicts visible text and the other predicts visible numbers. The target order is `[text, number]`. A canvas can contain either, both or neither.

```text
same current canvas -> shared Guesser preprocessing -> float32 [3,224,224]
                                                     -> Guesser category scores
                                                     -> Referee text and number scores
```

ATYPICT multiclass supplies separate text and number supervision after anchor reduction and review. Text includes single letters, initials and words. Number includes digits and multi-digit strings. Incidental lettering remains a positive *content* label. Players decide whether writing is incidental or a prohibited clue. Numbers receive their own advisory. Ordinary icons alone produce neither warning and advisory events carry zero score effects.

Keep the score channels independent throughout training, evaluation and serving. See the [outputs and advisory policy](referee-policy-boundary.md).

## 2. Why this classifier is the starting recommendation

| Candidate | Supervision and output | Benefit | Cost or limitation | Use |
|---|---|---|---|---|
| Two independent presence outputs | Audited text and number targets, one sigmoid per output | Shared image encoder with separate thresholds and messages | Small writing and digits need dedicated validation | **First experiment** |
| Four-label content classifier | Text/number/symbol/circle presence; four independent sigmoids | Retains all released content categories and mixed labels | More imbalance and audit work; no added rule understanding | Optional follow-up |
| Contextual policy classifier | Reviewed clue versus incidental examples | Could automate a different judgment | ATYPICT supplies content labels. Players make the rule decision in this plan. | Outside this scope |
| Object detector | Existing encoded anchors or recovered boxes | Localizes small writing and can support evidence review | More model/decoder/evaluation machinery; localization still does not prove a violation | Escalate if localization is needed |
| OCR/Florence-2 route | Recognition and/or text regions | May produce interpretable writing evidence | Handwriting/sketch adaptation and policy checks remain; a larger serving path | Existing alternative to compare later |

Classification reduces implementation complexity. It is not guaranteed to beat a detector on small, scattered letters. The annotations already came from a detector pipeline, so this change does not remove the need to audit supervision. It changes the prediction task and discards location information deliberately.

Do not train a five-class classifier from the five training folders. `real` is provenance, and mixed-content images break mutual exclusivity.

## 3. Backbone and libraries

Use the Guesser's recommended checkpoint family for an independent Referee model:

`timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k`

The [model card](https://huggingface.co/timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k) describes approximately 5.7M parameters, 224 x 224 input and ImageNet pretraining. It has not already learned ATYPICT or the game's rule policy. Sharing the family simplifies the group's tooling; it does not require sharing fine-tuned weights with the Guesser or passing Guesser outputs to the Referee.

Illustrative future setup, **not executed in this task**:

```python
import timm
import torch

model = timm.create_model(
    "vit_tiny_patch16_224.augreg_in21k_ft_in1k",
    pretrained=True,
    num_classes=2,
)
loss_fn = torch.nn.BCEWithLogitsLoss()
# x: float32 [B,3,224,224]; target: float32 [B,2] in [text, number] order
# This example batch has both labels reviewed and known.
logits = model(x)
loss = loss_fn(logits, target)
presence_scores = logits.sigmoid()
```

Use `timm` for model construction and checkpoint adaptation, Lightning for the training loop/checkpoints/logging, PyTorch Dataset/DataLoader for batches, torchvision for modest augmentations and TorchMetrics for per-channel classification metrics. Use uv to lock dependencies in the separate model environment after choosing the machine's supported PyTorch backend. No hand-written transformer layers, custom optimizer or second training engine is needed.

## 4. Referee preprocessing

Reuse the Guesser's existing `guesser_data.preprocess` API with `foreground` as the first shared candidate. It estimates the background from the border, extracts visible foreground, fits that content inside 192 pixels, pads to 224, repeats the grayscale image across three channels and normalizes with mean and standard deviation `0.5`. Successful output is float32 `[3,224,224]`. Pin the candidate and config hash for both models.

| Stage | Guesser | Referee |
|---|---|---|
| Training image source | Render the visible Quick, Draw! prefix to a raster | Decode an ATYPICT PNG. The shared foreground transform handles the observed black background. |
| Image preprocessing | The shared `foreground` recipe | The same recipe and tensor format |
| Training target | Quick, Draw! category ID | Independent text and number bits and a known-label mask |
| Live input | Current canonical canvas raster and revision | The same raster, revision and prepared tensor when both evaluate that revision |

At runtime, prepare each required canvas revision once and reuse that tensor for either model. Key cached results by canvas, generation, revision and preprocessing version. Keep Guesser scheduling separate from Referee persistence. Capture canvas pixels separately from chat, target text, hints and controls. Use a shared status for blank or uncertain preprocessing. A revision with invalid image evidence leaves both models' corresponding result unavailable or uncertain.

The existing CPU image package is pinned to Python 3.13. Use its locked environment to produce reference fixtures. If the trainer or serving environment uses another Python version, hand off the shared prepared tensor or package the existing CPU preprocessing core for both supported runtimes as part of implementation. Preserve the existing API and compare outputs on the same fixtures. Keep one implementation of normalization and background handling.

The saved sample probe ran this API on all sixteen PNGs and verified their tensor shape and dtype. The result covers the image format and transform compatibility. Validation must check small and peripheral letters and digits, fill, erasure and colors on the game's own canvas. If a preprocessing change is needed, compare shared candidates and update both models' versioned input contract together.

Use modest training-only translations with padding, line-width variations or small rotations when the label stays visible. Apply the shared recipe to each augmented image. Preserve visible writing and avoid flips or crops that change the intended label.

## 5. Fine-tuning sequence

Use seed `198173`, fixed audited manifests and the same source preprocessing for all comparisons. Log the actual image and group counts before a run. Use all eligible multiclass data after audit; the sixteen probe records are far too small to train or evaluate a useful model.

| Experiment | Trainable part | Working recipe | Question answered |
|---|---|---|---|
| A: frozen feature baseline | New two-logit head | Up to 5 epochs; AdamW head LR `1e-3` | Can pretrained visual features already separate the audited examples? |
| B: fine-tuned classifier | Same head, then all backbone layers | 3-epoch head warm-up; up to 15 further epochs, backbone LR `1e-5`, head LR `1e-4` | Does sketch adaptation improve writing discrimination? |
| C: shared input robustness check | Same two-head architecture | Evaluate both tasks with the same pinned preprocessing candidate on color, fill and small-character fixtures | Does the shared input retain the evidence each task needs? |

Start B from the same pretrained checkpoint and recorded head initialization used for A's comparison, rather than accidentally giving it a hidden extra training stage. A is an inexpensive engineering baseline, not an equal-budget causal experiment. Record optimizer updates and wall time; if making a controlled claim about fine-tuning, rerun A/B with equal training budgets and the same model-selection protocol.

Working defaults: batch size 32 if it fits, otherwise lower the physical batch and use Lightning gradient accumulation to retain an effective batch of 32; AdamW weight decay `0.01`; short LR warm-up followed by cosine decay; supported mixed precision; early stopping patience 4. Select checkpoints using the mean of text and number validation average precision. Report both values and their supports separately. Record the actual schedule and precision. Training time, VRAM and accuracy must be measured on the group's device.

Use binary cross-entropy with logits for both slots. The loader fills unknown target slots with a finite placeholder and carries a zero known-label mask for them. Compute loss over known slots, and skip a batch that has no known target slots. Start unweighted. If one channel has severe imbalance, compare a `pos_weight` computed separately from its audited training positives and negatives. Compare both channels' precision and calibration after weighting.

Retain the original symbol and circle bits for auditing and hard-negative slices. The deployed head needs the two user-facing evidence channels.

## 6. Getting from writing evidence to the actual rule

Text evidence and number evidence enter separate advisory policies. The text message is “Possible written clue detected.” The numeric message describes possible numbers. Evaluate persistence and false advisories on game replays before setting deployment thresholds. Players decide whether text is incidental or a prohibited clue, and resolve ambiguous marks.

Use [the sufficiency protocol](dataset-sufficiency.md) to audit the source, train the baseline and measure how each channel transfers to the shared game renderer. Include positive object writing, number-only examples, mixed text and numbers, and ordinary circles, arrows and icons. The ATYPICT detector targets supply content supervision. Human judgments of clues and incidental details serve as a separate validation annotation when measuring policy-level false alarms.

## 7. Work ownership and relative schedule

Mirror the Guesser's three responsibilities; these are roles, not new assignments to named members.

| Role | Work | Handoff |
|---|---|---|
| Data | Source receipt, schema converter, reviewed labels, grouping and manifests | Images, compact targets, corrections and audit summary |
| Model | Frozen baseline, fine-tuned ViT, reproducible logs and packaging | Weights, recipe, class/preprocess versions and validation selection |
| Validation & inference | Independent label/split checks, held-out evaluation, threshold policy and serving | Evaluation report, calibrated result contract and measured latency |

Relative order: Days 1-2 data conversion/negative audit; Day 3 frozen baseline; Days 4-5 fine-tuning and error review; Day 6 threshold/held-out evaluation; Day 7 advisory integration and latency checks. This is a tentative seven-workday sequence, not an agreed deadline or promise that annotation fits two days. If supervision or provenance remains poor, report a writing-evidence prototype with those limits and extend the audit before making stronger claims.
