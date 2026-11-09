# Primary sources and attribution

Accessed 7 November 2026, Asia/Manila. Source-code references are pinned to commit `d637b78af2f85d4331521c634c6431b2e569546e` on the official repository's `without_memcache` branch.

| Source | Supports |
|---|---|
| [DrawMon project page](https://drawm0n.github.io/) | Authors, task, atypical-content categories and official dataset/code routes |
| [Zenodo release](https://zenodo.org/records/7330402), [record API](https://zenodo.org/api/records/7330402) | Release DOI/version, file URL, length/checksum and API license metadata |
| [DrawMon paper, sections 3, 4.1 and 6](https://arxiv.org/html/2211.05429v1) | Research-time stroke collection/augmentation and source split description; does not establish this classifier's accuracy |
| [Official README](https://github.com/pictionary-cvit/drawmon/tree/d637b78af2f85d4331521c634c6431b2e569546e) | CanvasNet object-detection context and code license |
| [Official image loader](https://github.com/pictionary-cvit/drawmon/blob/d637b78af2f85d4331521c634c6431b2e569546e/data_pictText.py) | Pairing of image/label NumPy files and five training provenance folders |
| [Target encoder/decoder](https://github.com/pictionary-cvit/drawmon/blob/d637b78af2f85d4331521c634c6431b2e569546e/tbpp_utils.py) | Concatenated regression offsets and confidence columns; anchor assignment |
| [Original rendering/annotation adapter](https://github.com/pictionary-cvit/drawmon/blob/d637b78af2f85d4331521c634c6431b2e569546e/pictText_utils.py) | Text, number, symbol and circle annotation order and upstream SVG-based path |
| [Class visualization code](https://github.com/pictionary-cvit/drawmon/blob/d637b78af2f85d4331521c634c6431b2e569546e/tools/get_gt_preds_imgAndNpy.py) | Explicit `bg, text, number, symbol, circle` registry |
| [ViT-Tiny checkpoint model card](https://huggingface.co/timm/vit_tiny_patch16_224.augreg_in21k_ft_in1k) | Pretraining, model family, approximately 5.7M parameters and default 224-pixel input |
| [timm model API](https://huggingface.co/docs/timm/reference/models) | Maintained pretrained model construction and classifier replacement |
| [BCEWithLogitsLoss](https://docs.pytorch.org/docs/2.15/generated/torch.nn.BCEWithLogitsLoss.html) | Binary/multi-label loss with logits and positive weighting |
| [Lightning Trainer](https://lightning.ai/docs/pytorch/stable/core-api/trainer) | Existing training/device/precision/accumulation facilities |
| [TorchMetrics average precision](https://lightning.ai/docs/torchmetrics/stable/classification/average_precision) | Binary and multi-label ranking metrics |
| [uv with PyTorch](https://docs.astral.sh/uv/guides/integration/pytorch/) | Backend-aware dependency configuration |

## Local evidence

The [inspection summary](inspection/summary.json) derives from complete ZIP directory metadata and selected extracted files. The [follow-up verification](inspection/verified-findings.json) records the byte-equal cross-variant pair and the zero-text-label writing counterpart. The [released README](inspection/dataset-README.md) is retained verbatim with its original wording. [Zenodo metadata](inspection/zenodo-record.json) preserves the license and archive identity.

The sixteen source preview PNGs preserve the released pixels. The contact sheet resizes those images. The additional shared-input previews apply the existing Guesser foreground transform and display the denormalized first channel. No image generation, OCR model inference or trained classifier produced their labels. Presence badges in the walkthrough are reductions of the released encoded labels, **not predictions**. The “flute” observation is manual visual inspection.

## Attribution and changes

Dataset: Nikhil Bansal, Kartik Gupta, Kiruthika Kannan, Sivani Pentapati and Ravi Kiran Sarvadevabhatla. *DrawMon: A Distributed System for Detection of Atypical Sketch Content in Concurrent Pictionary Games*. ACM Multimedia 2022. Dataset DOI: [10.5281/zenodo.7330402](https://doi.org/10.5281/zenodo.7330402). Dataset license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as returned by the release API.

Modifications in this package: sample selection, contact-sheet resizing, HTML display/annotations, detector-label reduction summaries and analysis/planning prose. Original PNG pixels are preserved in the individual sample files. The upstream software is separately MIT licensed. No trained weights are redistributed here.

The latest user feedback in Lavish specifies independent text and number outputs, the shared Guesser canvas input, per-channel validation thresholds and persistent evidence. Players adjudicate incidental writing and prohibited clues. The [Guesser data API](../../models/guesser/data/README.md) documents `preprocess` and its versioned foreground/edges settings. The shared-input probe called this existing API on the saved ATYPICT images.
