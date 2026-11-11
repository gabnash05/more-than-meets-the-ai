> Historical plan: the v1 zero-proxy policy below is superseded by `separate-writing-advisories-v2`. Encoded zeros are known source-derived negatives, not reviewed negatives; uncertain reviews remain masked. See the data runbook.

# Referee data workflow plan

This is a proposed implementation, matching the Guesser's numbered workflow style. The scripts and training package described here have **not** been implemented. The retained sixteen-record probe is an inspection set, not a training dataset or an accuracy evaluation.

Use the [Terra data delegation plan](referee-data-delegation-plan.md) for worker ownership, implementation profiles, split filenames and the portable trainer and held-out ZIP contracts.

## 1. Six stages

| Stage | Proposed script | Input | Result |
|---|---|---|---|
| 01 Acquire | `01-download.py` | Pinned Zenodo record; explicit variant/profile | Complete requested archive or bounded sample, with source receipt |
| 02 Prepare | `02-prepare.py` | PNG/label pairs | Compact per-image presence proxies, provenance and quality findings |
| 03 Preview | `03-preview.py` | Images and manifest | Contact sheets and a simple corrections/exclusions file |
| 04 Export | `04-export.py` | Corrected records and duplicate groups | Train/validation/evaluation manifests, label registry and summary |
| 05 Load | `05-loader.py` | One manifest record | PNG plus two targets, known-label mask and metadata |
| 06 Transform | `06-images.py` | Source raster and pinned shared configuration | The Guesser's `foreground` preprocessing and a float32 `[3,224,224]` tensor |

Use maintained NumPy/Pillow operations and the standard PyTorch Dataset/DataLoader APIs when implementing batches. These numbered scripts should connect standard libraries to project requirements; they do not need another training framework or an approval/sign-off system.

## 2. Acquisition profiles and local storage

Proposed `sample` mode reads only bounded directory/member ranges and records that the source is partial. Proposed `train` mode acquires **multiclass/train.zip and multiclass/test.zip** from the pinned outer archive; downloading `only_text` should require choosing that variant explicitly. Training itself must never initiate dataset downloads.

Keep data under an ignored local directory such as `models/referee/data/.local/`, with a local `.gitignore` added when that package is created. The source data project should remain CPU-only and managed with uv. Select a separate Python 3.12 model environment and actual PyTorch backend for the training machine, following the existing Guesser environment separation. No model/GPU dependencies are needed merely to inspect files.

Two reasonable future acquisition routes are available:

1. Download the 397.6 MB outer ZIP once, verify its exact length and published MD5, then read nested archives without extracting everything. This is operationally simple, but it is a **future full download**, not what was performed here.
2. Select the two multiclass members by validated ranges, preserving exact offsets, sizes and member CRCs. This avoids the unused text-only archives. Verify the nested ZIP member hashes where possible and do not claim the outer ZIP MD5 was checked.

Either route should stream one label array at a time. Do not unpack all four variants indiscriminately: their aggregate uncompressed contents are approximately 60 GiB. For the chosen multiclass variant, keep its roughly 62.45 MiB of PNGs plus a compact manifest; dense labels can be temporary conversion inputs. Full storage and throughput have not been benchmarked.

## 3. Pairing and structural cleaning

- Construct identity from record/version, variant, nested archive, inner parent directory and numeric suffix. Never pair `real/sample_7` with another folder's `label_7`.
- Require the PNG, NumPy image and label triplet to exist in the source inventory. In the initial conversion, compare pixels for a representative set; check every retained PNG's decoding, dimensions and polarity. Do not require duplicate NumPy image storage in the training export.
- Load numeric files with `np.load(..., allow_pickle=False)`. Check the expected variant shape, float32 dtype, finite values and one-hot class columns. Reject unexpected schemas explicitly; do not guess the class-column offset from a new shape.
- Reduce the multiclass class columns to four presence bits. Retain `encoded_text_present` and `encoded_number_present` as separate proxies. Keep symbol and circle bits for auditing.
- Record blank, damaged, unusual-polarity, mixed-content and all-background-label cases. Blank images should remain an explicitly identified evaluation slice.
- Never use folder names, the regression offsets, numeric filenames or class labels as features supplied to the model.

The diagnostic registry is `text, number, symbol, circle`. The model target keeps `[text, number]` in that fixed order. Each value can be positive independently. Persist a known-label mask in the same order.

## 4. Label audit and corrections

The probe's visible “flute” example with zero text anchors shows why nominal absence needs review. Count candidates first, then inspect nominally negative cases across source folders, background/ink conditions and character sizes. Review a sample of positives and check for both writing types independently. A number-only annotation can coexist with unannotated text.

Use `text_present` and `number_present`, each with `yes`, `no` or `uncertain` during review. Record source ID, reviewer and reason. Keep reviewed positives and negatives and use encoded positives as separately marked proxies where appropriate. Unreviewed zero proxies and unresolved conflicts receive an unknown target for the affected slot. A known number label can train the number channel while its text label is masked.

Object writing stays positive for the relevant content channel. Review ordinary arrows, circles and icons as potential `[0,0]` examples. The user's policy leaves incidental versus prohibited judgment to players, so keep any such game-evaluation annotation separate from the content targets. Use the multiclass release for both channels. The text-only release lacks number supervision and has verified overlap with multiclass evaluation.

## 5. Duplicate groups and split construction

Hash decoded grayscale pixels and compare exact bytes where appropriate. Use CRC32/size only as a cheap candidate screen. Group exact duplicates and review near duplicates or progressive snapshots together. If labels conflict for identical pixels, quarantine the group or apply a documented reviewed correction; do not let conflicting twins train opposite labels.

Keep multiclass source training and source evaluation separate. Build a validation holdout from training **after** duplicate/provenance grouping. Use seed `198173` and a provisional 80/20 train/validation allocation by group, approximately stratified by text and number support and provenance. Actual counts follow the audit; do not promise fixed sample counts in advance.

Hold the source `test.zip`/internal `val/` partition for final evaluation. The opened evaluation probe images, `val/sample_4036.png`, `val/sample_2326.png` and `val/sample_879.png` (duplicate verification), must be tagged as disclosed inspection examples. Exclude their duplicate/provenance groups from any claim of an untouched final test and report the exclusion. Do not tune thresholds on source evaluation outputs.

The preferred split unit is the original game session and all its augmentations. That mapping is absent from this release. If the authors' original IDs become available, use them before splitting. Otherwise, ship a provisional image/near-duplicate-group split with the limitation plainly stated. Exact deduplication cannot establish session independence. Author contact, if desired later, is a user action; no message was sent during this inspection.

## 6. Minimal export contract

Use JSONL initially; Parquet can be added if a real loading need appears. PNGs are already small, so float32-image caches are unnecessary.

```json
{
  "sample_id": "zenodo7330402:multiclass:train:circle:895",
  "source_archive": "multiclass/train.zip",
  "source_path": "train/circle/sample_895.png",
  "image_path": "images/multiclass/train/circle/sample_895.png",
  "pixel_sha256": "<computed during preparation>",
  "group_id": "<duplicate/provenance group>",
  "split": "<assigned after grouping>",
  "provenance_folder": "circle",
  "encoded_presence": [1, 0, 0, 1],
  "encoded_text_present": 1,
  "encoded_number_present": 0,
  "text_present": 1,
  "number_present": null,
  "known_mask": [1, 0],
  "label_origin": ["encoded_positive", "unreviewed_proxy"],
  "policy_version": "separate-writing-advisories-v1"
}
```

The example presence bits were actually observed; bracketed identity/hash/split values illustrate fields to be computed, not existing prepared artifacts. Resolve each target independently. Prefer a reviewed label, then a retained encoded positive. Mask unreviewed zero proxies and uncertain labels for that slot.

Export `labels.json`, `train.jsonl`, `validation.jsonl`, `evaluation.jsonl`, `corrections.jsonl` and `dataset-summary.json`. The summary records source pin, seed, class order, preprocessing version, paired counts, positive/negative/unknown counts, duplicate/conflict counts, exclusions, source evaluation probe IDs and split limitations. No production metrics are implied by the export.

## Shared image handoff

Decode each retained PNG and apply the existing Guesser `foreground` preprocessing with the pinned config hash. The data package's Python 3.13 environment can run this CPU step before handing a tensor to the model environment. Use the same transform for live inference. Record candidate, version and image status in the export. The sixteen sampled PNGs passed this shape and dtype check using the actual Guesser function.
