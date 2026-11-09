# Guesser data

A small Python 3.13/uv project for preparing Quick, Draw! originals and creating timed images. Model training and the prediction service belong to their separate model folders.

[Visual walkthrough](../../../docs/guesser/guesser-flow.html): an interactive visualization of this data component, stored alongside the Guesser planning docs.

## Setup

From `models/guesser/data/`:

```sh
uv sync --frozen
uv run --frozen guesser-data preflight
```

These commands are identical in PowerShell, cmd and bash. `uv run` selects the project's Python 3.13 environment, so nothing needs activating. On Windows, `.\guesser-data.ps1 <command>` is an optional shortcut for `uv run --frozen guesser-data <command>` that also points uv's cache and temp files under `.local/`.

Use uv to change dependencies and keep `pyproject.toml`/`uv.lock` together. Output defaults to `.local/data/production/`; `--data-root` can point at any drive, so choose one with enough free space.

## Read the files in this order

| Step | Actual implementation |
|---|---|
| 1 | [`01-download.py`](src/01-download.py): download, clean each drawing, keep a deterministic sample and save a completion receipt. |
| 2 | [`02-prepare.py`](src/02-prepare.py): deduplicate retained candidates, split originals, write JSONL/Parquet and a data summary. |
| 3, optional | [`03-preview.py`](src/03-preview.py): training-only contact sheets and a small synthetic example. |
| 4 | [`04-export.py`](src/04-export.py): one final data audit and separate trainer/test ZIPs. |
| 5 | [`05-loader.py`](src/05-loader.py): seek one original and choose its training or evaluation view. |
| 6 | [`06-images.py`](src/06-images.py): cut by time, render visible strokes, preprocess and normalize. |

All implementation files live directly in `src/`. The package settings keep the import name `guesser_data` without requiring another source folder.

The stage files use the requested literal `01-name.py` format. A small standard-library importer loads them; callers can use `from guesser_data import IndexedDrawings, preprocess`.

`settings.py` contains the actual editable defaults. `common.py` contains shared file/hash helpers; `cli.py` routes commands. There are no descriptive JSON configs, approval CSVs, sign-offs or freeze step.

```text
Prepare: 01 download/clean/sample -> 02 deduplicate/split -> 03 optional preview -> 04 check/export
Load:    05 read one drawing -> 06 cut -> render -> preprocess -> one image + class label
         -> PyTorch DataLoader batches images in ../training/
```

## Normal workflow

Annotated commands below work in PowerShell and bash. In Windows Command Prompt (cmd), omit `#` comments; the command text is unchanged.

```sh
uv run --frozen guesser-data download
uv run --frozen guesser-data prepare
uv run --frozen guesser-data preview   # optional: training-only contact sheets
uv run --frozen guesser-data export
```

### Choose a dataset size

All three training profiles keep all 345 categories. Counts below are original drawings, before timed images are generated.

| Profile | Reserve/category | Train/category | Validation/category | Test/category | Final total |
|---|---:|---:|---:|---:|---:|
| `production` (default) | 5,500 | 4,000 | 500 | 500 | 1,725,000 |
| `medium` | 2,200 | 1,600 | 200 | 200 | 690,000 |
| `small` | 550 | 400 | 50 | 50 | 172,500 |

Omitting `--profile` keeps `production`. To download less and train on a smaller dataset, use the same profile for each command:

```sh
uv run --frozen guesser-data download --profile medium
uv run --frozen guesser-data prepare --profile medium
uv run --frozen guesser-data preview --profile medium
uv run --frozen guesser-data export --profile medium
```

Replace `medium` with `small` for the smallest training dataset. Each size has its own `.local/data/<profile>/` folder and profile-named archives. Command results show the profile and target counts. `--candidates` can explicitly enlarge that profile's reserve.

Production reads each selected category file completely and keeps a hash-ranked sample. Medium and small read only the beginning of each category, cleaning until their reserve contains enough distinct IDs, then close the stream. They rank the collected candidates with the same seed. These prefix samples save transfer time but can be less representative of the complete source; drawing sizes vary, so exact downloaded GiB is not fixed. Both support fine-tuning experiments, but accuracy must be measured. They are training profiles; `smoke` remains only for examples/probes.

Production source checks use generation, byte count and whole-file MD5. Smaller profiles pin the generation and record consumed bytes plus candidate hashes; their receipts explicitly say the source is partial and not whole-file verified. Matching completed samples resume; incomplete categories restart. The in-memory sample tracks conflicts only for retained IDs. Preparation uses one temporary SQLite index for retained candidates; conflicts are quarantined rather than relabeled. It writes directly to prepared shards and removes its temporary index. Candidates stay available for re-preparation. Historical generated folders are not automatically deleted.

Optional drawing exclusions go in `<data-root>/<profile>/excluded-ids.txt`, one ID per line. Legacy explicit exclusions are adopted when no text file exists. No review approval is required.

If preparation reports a shortage, explicitly enlarge the affected reserve, then prepare again:

```sh
uv run --frozen guesser-data download --profile medium --class "cat" --candidates 3200
uv run --frozen guesser-data prepare --profile medium
```

See [the runbook](RUNBOOK.md) for transfer, loading and preprocessing examples.

## Small examples and supporting commands

```sh
uv run --frozen guesser-data example   # synthetic class; offline; separate directory
uv run --frozen guesser-data probe     # small real-source ranges; uses the network
```

`example` creates one synthetic class offline in a separate example directory; `probe` requests small real-source ranges in a separate probe directory. Examples/probes default to the smoke profile (16/2/2 originals/class), are marked nonproduction, and do not establish recognition accuracy or production throughput. Prefix probes do not verify a whole source checksum. There is no global download budget.

Other commands: `preflight`, `status`, `inventory`, and `audit`. Every command supports `--help`, `--data-root`, `--profile` and `--json`. Download also supports repeatable `--class`, `--candidates` and `--concurrency`. Old `scan`, `freeze`, `qa` and `validate` commands show replacement hints. Normal output is readable text; JSON is optional.

## Images and model handoff

```python
from guesser_data import IndexedDrawings
from guesser_data import preprocess

with IndexedDrawings(".local/data/medium/prepared", "train") as drawings:
    sample = drawings.training_image(0, epoch=0)  # foreground is the default
    # sample['image']: float32 [3,224,224] when status == 'ok'
    # sample['class_id']: separate training target
```

Choose `.local/data/production/prepared`, `.local/data/medium/prepared` or `.local/data/small/prepared` to match your experiment. After extracting an export, use its `prepared/` directory instead. A dataset size is independent of the model DataLoader batch size in [`../training/`](../training/README.md); use one frozen dataset and split package consistently within each experiment. Results from different profiles use different held-out originals and are not a controlled size comparison.

### Manifest random access and worker memory

For multiworker training, pass `IndexedDrawings(prepared, "train", manifest_cache_dir=cache_dir)`, with a writable local cache directory separate from prepared data and rendered-image caches. Construction builds/reuses an immutable, uncompressed `*.arrow` IPC sidecar. Workers lazily memory-map it once per PID: the OS shares file-backed column buffers instead of keeping a full decoded split privately in every worker. `manifest_row(index)` slices one row before converting it to a fresh, complete dictionary, including nullable/nested audit columns. Original order, negative-index bounds, all columns, split membership and the caller's global shuffle are unchanged. Neither drawing payloads nor prepared files are rewritten.

Cache identity includes the absolute prepared manifest path, size, nanosecond mtime/ctime, inode/device, format version and complete Arrow schema. Builds stream 16,384-row batches, disable Arrow decoding threads, and atomically publish only after rechecking source freshness. A standard-library SQLite transaction serializes competing cold builders; normal cache hits/readers do not hold this lock. Construction in the training parent finishes conversion before workers start. Read failures remain visible, never an empty result. Old generations are not automatically removed: close all readers before deleting unused cache files, and never modify a mapped sidecar in place.

The default `manifest_cache_dir=None` creates no cache or lock files, preserving read-only use. Its first lookup still decodes the full split into a process-local Arrow table; **do not use that fallback to budget multiworker training RAM**. `cached_row_groups` remains accepted/validated for compatibility but limits neither representation; `max_handles` still bounds open JSONL files. `close()`/PID changes release table wrappers, mappings and record handles; pickle retains configuration/cache path but omits native data and open files. Cached readers recheck the original source generation when reopening and reject any change, including same-length replacement; recreate the reader after a new preparation. Already mapped readers retain their snapshot, so keep prepared data immutable throughout a run. The uncached fallback reloads current data and rejects changed row counts. These checks do not replace the package audit. Use a separate reader per thread because JSONL seek/read handles are mutable.

A bounded production **train-manifest-only** probe (1,380,000 rows) built a 254.23 MiB IPC sidecar in 3.93 seconds with 285.04 MiB process peak RSS. Three simultaneous fresh spawned readers each had about 347.4 MiB RSS, but only 138.3 MiB PSS and 43.3 MiB USS: RSS counts the same mapped pages in each reader. Their aggregate PSS was 415.0 MiB, and Arrow reported zero allocated data-buffer bytes in each worker. Each repeated 1,024 shuffled lookups in 0.053–0.055 seconds, preserving the baseline IDs/class labels exactly. These are local finite probes, not full-training throughput or a ten-worker model RAM measurement. See [the runbook](RUNBOOK.md#manifest-only-timing-probe) for reproduction and limits.

### Views and preprocessing

Use `candidate="edges"` to toggle edge preprocessing. Keep the same choice across a model's training, validation, test and inference. Both modes fit/pad the current visible shape to 224x224 and normalize by mean/std 0.5; do not normalize twice. Timestamps create partial images; they are not direct ViT input features. Training views are 20% complete and otherwise use an elapsed-time cut in 10%-90%. Evaluation emits ten fixed 10%-100% stages, including blank, uncertain and unchanged outcomes. Crop bounds never use future points.

`dataset-summary.json` records source identity, seed, ordered labels, counts, preparation statistics and data hashes. It does not fingerprint source code or documentation. Export audits the data once, then separates training/validation from held-out test data. Changing prepared records requires preparation again; editing a README does not invalidate the dataset. Existing valid prepared data can receive the new summary during an audit without downloading again.

The data project uses Python 3.13. The relocated evaluation/notebook project uses Python 3.12 with its own uv lock; this change does not unify those environments. PyTorch batching and A/B training live in [`../training/`](../training/README.md).

## Development

Follow the repository's concise Python guidelines. Use Ruff for formatting/lint and Pyright for types. Data tests live in `tests/`; model evaluation belongs in `../evaluation/`. Historical reports in `reports/` describe earlier workflows, not proof that the current code ran at full source scale.

Quick, Draw! is attributed to Google Creative Lab under CC BY 4.0. [Official format and source](https://github.com/googlecreativelab/quickdraw-dataset). AtyPict is outside this Guesser pipeline.
