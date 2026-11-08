# ATYPICT dataset audit

Inspected 7 November 2026. Observations below distinguish archive-directory facts, checks on selected members, the authors' description and proposed uses.

## 1. Source and acquisition

The [DrawMon project page](https://drawm0n.github.io/) links to the [official Zenodo release](https://zenodo.org/records/7330402), DOI `10.5281/zenodo.7330402`. Its file is `DrawMon-ACMMM22_Dataset.zip`, **397,584,204 bytes** (397.6 decimal MB / 379.17 MiB). The record advertises MD5 `c199d21b6121819c81cfcda68cd440bd`.

The [record API](https://zenodo.org/api/records/7330402) returns the filename, exact length, checksum, file URL and dataset license `cc-by-4.0`. Preserve that response with a future download. The upstream code's MIT license is distinct from the dataset's CC BY 4.0 license.

This inspection used HTTP `Range` requests against the file content URL returned by that API. The server returned `206 Partial Content` with matching `Content-Range`. ZIP end records and central directories reveal member names and offsets. The outer archive stores its nested ZIPs without compressing them again, allowing direct seeks into their own directories and selected compressed members.

The inspector rejected an unhonoured range before reading its body, checked member sizes/CRC32 and calculated SHA-256 for extracted sample files. It did **not** verify the whole-file MD5 because that requires the complete ZIP. A 24 MiB per-run response-body cap was configured; actual total dataset range bodies across all inspection runs were 7,360,940 bytes. This is a bounded probe, not a full download.

## 2. What is actually inside

```text
DrawMon-ACMMM22_Dataset.zip
└── DrawMon-ACMMM22_Dataset/
    ├── README.md
    ├── multiclass/
    │   ├── train.zip  -> train/{circle,number,real,symbol,text}/
    │   └── test.zip   -> val/
    └── only_text/
        ├── train.zip -> train/
        └── test.zip  -> val/
```

Every sample has `sample_<n>.png`, `sample_<n>.npy` and `label_<n>.npy`. Pair by **variant + archive + internal directory + numeric suffix**. The same number in another folder is not a global session ID. The release README calls `real` the non-augmented sessions; it does not mean a clean or text-free class. Its multiclass introduction also contains an apparent copy-and-paste reference to “only text”; the actual arrays and official class mapping establish four foreground categories.

| Archive | Actual internal root | PNG / image / label triplets | Compressed nested ZIP | Uncompressed members |
|---|---|---:|---:|---:|
| `multiclass/train.zip` | `train/` | 8,470 | 171,861,581 B | 30.024 GiB |
| `multiclass/test.zip` | `val/` | 4,460 | 92,752,897 B | 15.811 GiB |
| `only_text/train.zip` | `train/` | 9,270 | 122,674,174 B | 13.058 GiB |
| `only_text/test.zip` | `val/` | 792 | 10,293,370 B | 1.116 GiB |

These are member counts and uncompressed lengths from complete directory metadata, not counts of unique people, sessions, objects or positive images. The two evaluation ZIPs are named `test.zip` but both unpack to `val/`. Keep the archive identity and the internal name in provenance; do not silently treat one name as proof of a particular official test protocol.

Multiclass training contains 2,890 text-folder images, 2,513 circle, 1,212 symbol, 1,209 number and 646 real. These folder counts are **not** per-class positive counts. All 12,930 multiclass PNGs occupy about **62.45 MiB** uncompressed. Most of the much larger extracted footprint consists of redundant float32 images and dense detector targets. For a classifier, retain PNGs and compact manifests after conversion instead of materializing tens of GiB of detector arrays.

No SVG, stroke/timestamp records, transcripts, prompt registry, session identifiers or provenance mapping appeared in the four archive inventories. The [paper](https://arxiv.org/html/2211.05429v1) describes collecting timestamped SVG game sessions, but those research-time representations are not the released files inspected here. Do not copy the Guesser's elapsed-time-prefix workflow onto this raster release.

## 3. Image format observed in sixteen records

| File | Observed contents | Classifier use |
|---|---|---|
| `sample_<n>.png` | Pillow `L`, 512 x 512, values 0..255 | Preferred compact image input |
| `sample_<n>.npy` | float32 `[512,512,1]`, values 0..255 | Redundant pixels; useful for format verification |
| Canvas appearance | White/light strokes on black; sampled border median 0 | Convert consistently to the selected training polarity |

All sixteen inspected PNGs exactly matched the corresponding NumPy pixels. This sample check does not prove every file has the same shape, finite values or polarity; the eventual converter must check each retained record.

## 4. Labels are encoded detector targets

The [official encoder](https://github.com/pictionary-cvit/drawmon/blob/d637b78af2f85d4331521c634c6431b2e569546e/tbpp_utils.py) concatenates regression offsets and class confidence targets. The [official visualization code](https://github.com/pictionary-cvit/drawmon/blob/d637b78af2f85d4331521c634c6431b2e569546e/tools/get_gt_preds_imgAndNpy.py) gives the order `bg, text, number, symbol, circle`.

| Variant | Observed shape / dtype | Columns |
|---|---|---|
| multiclass | float32 `[76454,9]` | `dx,dy,dw,dh,bg,text,number,symbol,circle` |
| only_text | float32 `[19110,6]` | `dx,dy,dw,dh,bg,text` |

Each row corresponds to an anchor/prior, not one drawn object. Multiple positive rows may describe one piece of writing. Regression offsets can be negative and are **not pixel coordinates**. A row such as `[0,0,0,0,1,0,0,0,0]` is an unmatched/background anchor, not evidence of an empty canvas.

For the inspected schema, classification conversion needs no decoder, anchor geometry, detector weights or old TensorFlow environment:

```python
import numpy as np

targets = np.load(label_path, allow_pickle=False)
# After validating variant, finite values and one-hot confidence columns:
confidence = targets[:, 4:]
content_presence = confidence[:, 1:].max(axis=0).astype(np.uint8)
# multiclass order: [text, number, symbol, circle]
text_proxy = int(content_presence[0])
referee_proxies = content_presence[:2]  # multiclass order: [text, number]
```

This operation produces an **encoded-label presence proxy**. A positive means at least one anchor was assigned the text class. A zero means no text anchor was encoded; it does not certify that no writing is visible. In the encoder, anchor matches depend on IoU, and this probe cannot attribute each missed label to matching, annotation, erasure or an earlier export step.

If a four-output model is later used, these are independent binary targets. An image can contain both text and circles. A mutually exclusive five-way softmax over the folder names is incorrect.

## 5. Concrete sample findings

The [sample browser](referee-flow.html#samples) and [contact sheet](samples/contact-sheet.png) show actual released images, without generated examples or model predictions.

| Inspected path, relative to its inner ZIP | Encoded foreground presence | What it demonstrates |
|---|---|---|
| multiclass train: `train/circle/sample_895.png` | text + circle | A circle folder can contain text. |
| multiclass train: `train/real/sample_141.png` | text + symbol + circle | “Real” is provenance, not a negative label. |
| multiclass train: `train/real/sample_7.png` | symbol | Natural-session examples can lack encoded text. |
| multiclass train: `train/number/sample_766.png` | none | The directory category need not have a positive encoded anchor. |
| only_text train: `train/sample_5906.png` | none | The image visibly contains the handwritten word “flute”, despite zero text anchors. Its byte-identical counterpart `sample_4378.png` also has zero text anchors. |

The writing observation is a manual inspection finding, not a full reannotation study. It is enough to reject the rule “all background anchors = trustworthy clean negative.” Quarantine or correct this example in a future classification dataset, and inspect other nominal negatives rather than training the model to ignore writing.

## 6. Duplicates and split limits

Directory screening grouped PNGs by `(uncompressed size, CRC32)`. It found 6,495 duplicate-candidate groups across the combined releases. Of these, 4,635 include multiple `only_text/train` files, two include multiple `multiclass/train` files, and 115 span a train/evaluation boundary **across variants**. These counts can overlap and are not a count of SHA-verified duplicate groups.

The pair below was fetched and independently confirmed byte-identical:

```text
multiclass/test.zip : val/sample_879.png
only_text/train.zip : train/sample_2859.png
SHA-256: 8bd84dfa8848adca9bfc421806aeab969c39787d9ce5881dcd2eb1e27dfcc2f6
```

Therefore, combining the two releases' existing training and evaluation partitions can leak an exact image into both. Do not merge them by default. The metadata screen found **zero same-variant train/evaluation CRC-size candidate groups**, but this is not proof against near duplicates, related snapshots or shared source-session augmentation. No source-session map was present, so session-independent evaluation cannot currently be established from filenames.

## 7. Practical consequence

Use multiclass as the first source. Reduce its anchors to independent text and number presence proxies, review nominal negatives for each channel and group duplicates. Symbol and circle categories help identify hard negatives. The text-only release lacks number supervision and has verified overlap across release variants.

The separate content labels support the latest two-advisory plan. Player decisions about incidental writing and prohibited clues remain distinct from the data labels. The [dataset sufficiency assessment](dataset-sufficiency.md) covers the evidence needed to establish that the source transfers to the game.

The existing Guesser `foreground` preprocessor processed all sixteen PNGs to float32 `[3,224,224]`. The resulting preview images and tensor hashes are in the inspection package. This exercise checks shared image compatibility and leaves accuracy to the planned model evaluation.
