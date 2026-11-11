# Referee data

This CPU-only Python 3.13 and uv package prepares ATYPICT rasters and two independent presence labels. It follows the Guesser's numbered data layout and uses its foreground implementation through a Referee-specific, hash-bound wrapper (EXIF orientation, white alpha compositing, working size 1024 and distance 0.04). Guesser behavior is unchanged. [Reviewed data walkthrough](../../../docs/referee/referee-data-flow.html)

## Setup and offline example

Install Python 3.13 and uv. From `models/referee/data/`, run the example.

~~~powershell
.\referee-data.ps1 example
~~~

The launcher syncs the locked CPU dependencies automatically and defaults to a local cache and temporary directory. The first sync may download Python dependencies.

The example uses synthetic drawings and writes both sample ZIPs and `checksums.json` to `.local/data/example/sample/exports/`. Use it to check setup, splits and the reader. The exported summary marks the synthetic sample as smoke-only.

## Normal workflow

~~~powershell
.\referee-data.ps1 download --profile sample
.\referee-data.ps1 prepare --profile sample
.\referee-data.ps1 preview --profile sample   # optional training contact sheets
.\referee-data.ps1 export --profile sample
~~~

`sample` is the default. It selects at most ten multiclass source-training triplets and caps archive responses at 24 MiB per invocation. It produces a smoke trainer ZIP with train and validation. The real `train` profile requires an explicit selection and authorization for the two multiclass archives. Use the same `--data-root` and profile on each command. Every command accepts `--help` and `--json`. [Runbook](RUNBOOK.md)

| Stage | File | Output |
| --- | --- | --- |
| 01 | [Download](src/01-download.py) | Verified source cache, triplet index and receipt |
| 02 | [Prepare](src/02-prepare.py) | PNGs, labels and grouped split manifests |
| 03 | [Preview](src/03-preview.py) | Optional training contact sheets |
| 04 | [Export](src/04-export.py) | Audited ZIPs and SHA-256 checksums |
| 05 | [Loader](src/05-loader.py) | One prepared canvas and its targets |
| 06 | [Images](src/06-images.py) | Guesser foreground input and status |

## Model handoff

The trainer receives `trainer-<profile>.zip` and its checksum entry. The separate test ZIP goes to the validation owner. Use the [trainer quick start](RUNBOOK.md#model-trainer-quick-start) to verify, extract and run the bundled reader. Read a row from the extracted folder.

~~~python
from referee_data import IndexedCanvases

sample = IndexedCanvases("prepared", "train")[0]
image = sample["image"]       # float32 [3, 224, 224] when status == "ok"
target = sample["target"]     # float32 [2], in [text, number] order
known = sample["known_mask"]  # bool [2], same order
~~~

Choose `"validation"` for the other trainer split. Use usable images and apply the mask separately to each target. Blank and uncertain canvases have no tensor. The loader already applies the Guesser normalization. [One-page trainer handoff](../../../docs/referee/referee-data-handoff.md)

## Corrected trainer gate

Run `referee-data preflight --profile train --json` before real training. The default production gate requires a complete recorded multiclass source and usable known positive/negative support for text and number in train and validation. `--sample` reports diagnostics without claiming production readiness. The public `preflight(prepared_dir, production=True)` also accepts an extracted trainer ZIP, verifies its inventory and reports unauthenticated provenance explicitly.

Contact sheets now show source and canonical pixels, resolved labels, masks and origins. See [the trainer handoff](../../../docs/referee/TRAINER-HANDOFF.md) and [the sample review audit](../../../docs/referee/REPAIR-AUDIT.md). Uncertain reviews stay masked. An absent encoded flag is a source-derived negative, not a reviewed negative; folder names are not labels. See the runbook for retained reviews.
