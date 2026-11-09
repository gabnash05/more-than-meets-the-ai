# Guesser data runbook

## 1. Set up the CPU-only environment

Run the [README setup](README.md#setup) from `models/guesser/data/`. Dependencies use uv, Python 3.13 and the committed lock. No model weights or PyTorch install is needed for data preparation. The separate `../evaluation/` notebook workspace keeps Python 3.12 and its own lock.

## 2. Download, clean and sample

Run these commands from `models/guesser/data/` in Windows PowerShell or Linux bash. Command Prompt users can run the same command text but must omit `#` comments. Keep the same profile through download, prepare and export.

```sh
uv run --frozen guesser-data download --profile medium
```

Replace `medium` with `small`, or omit `--profile` to keep `production`.

Without `--profile`, this selects the unchanged `production` size. All three training profiles preserve all 345 official category IDs:

| Profile | Reserve/category | Train/category | Validation/category | Test/category | Final total |
|---|---:|---:|---:|---:|---:|
| `production` (default) | 5,500 | 4,000 | 500 | 500 | 1,725,000 |
| `medium` | 2,200 | 1,600 | 200 | 200 | 690,000 |
| `small` | 550 | 400 | 50 | 50 | 172,500 |

For a smaller download and training run, select a profile on every command:

```sh
uv run --frozen guesser-data download --profile medium
uv run --frozen guesser-data prepare --profile medium
uv run --frozen guesser-data preview --profile medium   # optional
uv run --frozen guesser-data export --profile medium
```

Use `small` instead of `medium` for 500 final originals/category. Output stays separate under `.local/data/production/`, `.local/data/medium/` and `.local/data/small/`. The profile changes original-drawing counts, not the model's batch size.

Production reads selected raw sources from beginning to end. The dated bundled inventory totals about 181.43 GiB; streaming avoids storing full raw files, but those bytes still transfer. Medium and small stop after collecting their candidate reserve from each source's beginning, so they transfer less. Malformed records and repeated IDs do not add reserve slots. Prefix sampling is not uniform sampling of the complete source, and actual bytes depend on drawing length. No source download was run to implement these sizes.

Two categories stream concurrently by default. Cleaning preserves chronology, pauses, single-point strokes, nonzero start times and valid `recognized=false` records. It removes exact repeated points/empty strokes and rejects malformed/nonfinite/unsafe coordinates, invalid times, zero duration and drawings with no extent. IDs remain strings.

Selection uses `SHA256("select-v1|198173|<drawing_id>")` and string ID to rank the retained candidates. Production samples the full file into 5,500 slots; medium and small collect 2,200 and 550 distinct cleaned IDs before stopping. Retained conflicting IDs keep their slot and are flagged for quarantine; uninspected/discarded records have no conflict-tracking guarantee. Production receipts follow whole-file byte-count/MD5 verification. Smaller profiles record their generation, consumed byte count and candidate hash with `source_kind=quickdraw_partial`, `complete=false` and `full_source_verified=false`; those flags describe the source file, not whether the requested sample finished. Matching completed samples resume; interrupted categories restart at zero. Existing compatible production receipts remain usable.

```sh
uv run --frozen guesser-data download --profile medium --class "cat" --class "alarm clock" --concurrency 1
```

A class selection follows the profile: production reads each chosen file completely, while medium/small stop at their reserve. No global download cap, source SQLite index or automatic conflict re-download is used.

## 3. Prepare originals and splits

```sh
uv run --frozen guesser-data prepare --profile medium
```

One temporary SQLite index checks retained IDs/content/labels and exact full x/y/t trajectories across classes. Conflicts are quarantined, never relabeled. Same-label exact trajectories keep the best-ranked representative. Optional `excluded-ids.txt` entries remain excluded.

Eligible originals are ordered by the separate `split-v1` hash plus ID. The selected profile sets the exact train/validation/test counts: production 4,000/500/500, medium 1,600/200/200, small 400/50/50. All prefixes of an original stay in that split. Original records go directly to `prepared/records/{split}/cNNN.jsonl`, with Parquet manifests under `prepared/manifests/`. Offsets are UTF-8 byte offsets into uncompressed JSONL. The temporary index is removed; candidates are retained. No selected/staging-selected copies are created.

If a class is short, use the explicit refill command in the error, for example:

```sh
uv run --frozen guesser-data download --profile medium --class "alarm clock" --candidates 3200
uv run --frozen guesser-data prepare --profile medium
```

Preparation does not start network transfers. `dataset-summary.json` contains actual labels, counts, source information and record/manifest hashes. It does not bind the data to README or code-file hashes.

## 4. Optionally inspect examples

For model-input throughput, the separate [training guide](../training/README.md#exact-training-view-bundles-and-optional-cuda-augmentation)
documents an explicit epoch/arm view-bundle builder. Run it in the **model**
environment, not this CPU-only data environment. It reads train originals only,
retains the existing selection/cut/render/normalization rules and stores derived
lossless outputs; it does not replace JSONL/manifests, alter split membership or
touch held-out test. Preparation/export below remain unchanged.

```sh
uv run --frozen guesser-data preview --profile medium
```

Open `<data-root>/<profile>/preview/index.html` for the selected size. Sheets use training originals only. There are no approval CSVs, reviewers or sign-offs. To omit an individual drawing, put its ID in `<profile>/excluded-ids.txt`, prepare again, and refill only if needed. A legacy nonempty exclusion list is adopted once when no text list exists.

## 5. Check once and export

```sh
uv run --frozen guesser-data export --profile medium
```

Export performs one final audit of prepared counts, IDs/trajectories across splits, metadata, byte offsets and data hashes, then writes separate trainer and held-out-test ZIP64 packages plus checksums. There is no freeze command. `audit` is available for an optional standalone check; it is not another required step.

A new export rechecks actual data. If prepared data differs from its summary, prepare it again. A documentation edit does not require re-preparing data. Older prepared data without the new summary can be adopted by this audit. Historical exports are not automatically rebuilt.

Archives are named `trainer-<profile>.zip` and `held-out-test-<profile>.zip` under that profile's export directory.

The trainer archive contains train/validation records and manifests, labels, summary, installable data source and uv setup. It excludes held-out-test records, test manifests and QA images. Keep the held-out archive with the validation owner. Verify transfer checksums and extract before using byte offsets.

## 6. Load one drawing and create its image

```text
Prepared originals on disk
    -> 05-loader.py reads one original
    -> 06-images.py cuts at the chosen elapsed time
    -> renders only visible strokes
    -> foreground/edges preprocessing, fit/pad to 224x224, normalization
    -> one float32 [3,224,224] image plus a class label
    -> PyTorch DataLoader batches images in ../training/
```

```python
from guesser_data import IndexedDrawings

candidate = "foreground"  # Change to "edges" to use edge detection.
prepared = (
    ".local/data/medium/prepared"  # Or production/small; exported package: "prepared".
)
with IndexedDrawings(prepared, "train") as drawings:
    sample = drawings.training_image(0, epoch=0, candidate=candidate)
    if sample["status"] == "ok":
        image = sample["image"]
        target = sample["class_id"]

with IndexedDrawings(prepared, "validation") as drawings:
    for view in drawings.evaluation_images(0, candidate=candidate):
        print(view["fraction"], view["status"], view["unchanged"])
```

Use the same frozen profile and its train/validation/test packages throughout an experiment. Different profiles have different held-out originals, so their scores alone do not isolate the effect of dataset size. Medium and small are trainable, but no accuracy level is guaranteed.

For multiworker use, supply `manifest_cache_dir` to `IndexedDrawings`, for example `IndexedDrawings(prepared, "train", manifest_cache_dir="../.local/cache/manifests")`. Construction builds the complete split's IPC sidecar before workers start; each worker lazily memory-maps it once per PID. All columns and row order are preserved without full-split data copies or Python row dictionaries. This cache contains manifest metadata only, not rendered images or JSONL drawing payloads. It is separate from the training validation-render cache. Use a writable local directory with room for an uncompressed split (254.23 MiB for the measured production train sidecar) plus temporary build output. A SQLite transaction serializes cold conversions across processes, streaming 16,384-row batches and atomically renaming completed output. Decoding disables Arrow threads. The key binds absolute source path, size, mtime_ns, ctime_ns, inode/device, schema and cache format version.

Without a cache directory, read-only callers retain the process-local full-table fallback; its private decoded memory still scales with split size and worker count. `cached_row_groups` remains compatibility-only, not a memory limit. `max_handles` still bounds record files. Closing/changing PID releases table wrappers, mappings and JSONL handles; pickling omits all native resources while preserving the cache path. Reopened cached readers reject changed source generations, including same-length replacements, and require a new reader; fallback readers reload current data and reject changed lengths. Source freshness is checked before/after conversion and mmap opening, not on every warm lookup. Keep prepared data and sidecars immutable during a run. Failures raise rather than serving stale samples or empty results. Delete unused cache generations only after all readers close; no automatic pruning occurs. These freshness checks do not replace the package audit. Give each thread its own reader because seek/read handles are mutable. The [training package](../training/README.md) supplies the PyTorch adapter and DataLoader on Windows/Linux.

Training cuts are seeded by ID/epoch/purpose: 20% complete, otherwise 10%-90% elapsed time; blank views have bounded retries. Evaluation uses ten fixed stages, retaining blank/uncertain/unchanged outcomes. These are elapsed-time fractions, not point-count fractions. Geometry uses only the current prefix.

For live snapshots, use the same preprocessor directly:

```python
from PIL import Image
from guesser_data import preprocess

snapshot = Image.open("canvas.png")
foreground = preprocess(snapshot)  # default
edges = preprocess(snapshot, candidate="edges")
```

Keep one choice consistent for each model. The current foreground choice is provisional, not an accuracy result. Uniform background estimation can be uncertain; edge detection can lose faint evidence or double-outline thick strokes. Both methods return `ok`, `blank` or `uncertain`; usable images are already normalized. Only the image enters ViT; labels are targets, while word/ID/recognized/times are metadata.

### Manifest-only timing probe

Run from `models/guesser/data/` in the existing CPU environment, after preparation. This bash command measures cache construction/reuse, lazy mapping and two identical finite batches of 32 training-manifest lookups; it does not read drawing JSONL, render images, train, download, or open held-out-test data. A second execution reuses the sidecar. In PowerShell/cmd, save the Python body to a temporary script and run it with the same `uv run --frozen --no-sync python` prefix.

```sh
uv run --frozen --no-sync python -c '
import random
import time
import psutil
from guesser_data import IndexedDrawings

process = psutil.Process()
before = process.memory_info().rss
started = time.perf_counter()
with IndexedDrawings(".local/data/production/prepared", "train",
                     manifest_cache_dir="../.local/cache/manifests") as drawings:
    print("cache_setup_seconds", time.perf_counter() - started)
    indices = random.Random(198173).sample(range(len(drawings)), 32)
    started = time.perf_counter()
    drawings.manifest_row(indices[0])
    print("first_lookup_seconds", time.perf_counter() - started)
    for repeat in range(2):
        started = time.perf_counter()
        for index in indices:
            drawings.manifest_row(index)
        print("random32_seconds", repeat, time.perf_counter() - started)
    print("rss_delta_bytes", process.memory_info().rss - before)
    if hasattr(process.memory_full_info(), "pss"):
        print("pss_bytes", process.memory_full_info().pss)
'
```

The earlier process-local compact reader used 267,547,500 Arrow table bytes and increased process RSS by 670,248,960 bytes on production train: repeating that private decode per worker was unacceptable. A subsequent train-only IPC probe built 1,380,000 rows in 3.93 seconds; its file was 266,583,322 bytes (254.23 MiB), and the builder's peak RSS was 298,889,216 bytes (285.04 MiB). Three simultaneous fresh spawned readers mapped that same file and executed the same 1,024 globally shuffled indices (seed 198173). Each had approximately 347.4 MiB RSS, 138.3 MiB PSS, 43.3 MiB USS, and zero Arrow allocated data-buffer bytes. Aggregate worker PSS was 415.0 MiB; RSS must not be summed as private memory because it counts mapped pages repeatedly. Worker setup took 0.032–0.036 seconds, first random1024 passes 0.096–0.116 seconds, repeats 0.053–0.055 seconds. All 1,024 ID/class pairs matched the saved baseline exactly.

These observations include process/import overhead, vary with machine load and page-cache residency, and are not a cold-disk benchmark, full image pipeline, GPU training or ten-model-worker RAM measurement. Batch conversion bounds live decoded batches, not all Parquet decoder/allocator overhead; releasing a table need not immediately return allocator memory. Held-out-test data was not opened. Automated synthetic tests also cover zero-copy allocation bounds, independent nested/null rows, same-length replacement and source races, interrupted-build cleanup, concurrent cold initialization, close/pickle, and actual spawn/fork/forkserver lifecycle behavior. Linux fork tests can emit Python's existing multithreaded-fork deprecation warning; use spawn where practical.

## 7. Small examples and remaining measurements

`example` creates a one-class synthetic smoke example under `.local/data/example/smoke/`. `probe` explicitly requests small real-source ranges under `.local/data/probe/smoke/`; those are nonproduction samples, not whole-source checksum proofs. Neither command runs a production scan.

Full-source throughput, peak RAM/disk, dataset-wide quality, model accuracy and GPU capacity remain to be measured by the model/evaluation owners. A full real category is a useful first production measurement. The data tools do not guarantee that only disk space can become a bottleneck.
