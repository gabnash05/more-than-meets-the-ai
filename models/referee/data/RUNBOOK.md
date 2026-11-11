# Referee data runbook

## Model trainer quick start

Install Python 3.13 and uv. Open PowerShell in a folder containing your trainer ZIP and its matching `checksums.json`. These commands verify the ZIP, extract it and load one training row using the bundled CPU reader.

~~~powershell
$trainer = (Get-Content -LiteralPath .\checksums.json -Raw | ConvertFrom-Json).trainer
if ((Get-FileHash -LiteralPath $trainer.file -Algorithm SHA256).Hash -ne $trainer.sha256) {
    throw 'Trainer ZIP checksum mismatch.'
}
$folder = [IO.Path]::GetFileNameWithoutExtension($trainer.file)
if (Test-Path -LiteralPath $folder) {
    throw "Use a fresh extraction folder. $folder already exists."
}
Expand-Archive -LiteralPath $trainer.file -DestinationPath $folder -ErrorAction Stop
Set-Location -LiteralPath $folder

@'
from referee_data import IndexedCanvases

row = IndexedCanvases("prepared", "train")[0]
image = row["image"]
print(row["status"], None if image is None else image.shape)
print("Targets [text, number]", row["target"], "Known", row["known_mask"])
'@ | uv run --project models/referee/data --frozen --no-dev python -
~~~

An `ok` row prints image shape `(3, 224, 224)`. Change `"train"` to `"validation"` to read the other trainer split. Use sample ZIPs to check the loader. For model fitting, use a package whose `dataset-summary.json` reports `trainer_ready: true`. The validation owner receives the separate held-out ZIP.

## 1. Choose a run

From `models/referee/data/`, run the synthetic example to make a trainer ZIP and a separate held-out ZIP.

~~~powershell
.\referee-data.ps1 example
~~~

The launcher syncs the locked CPU dependencies automatically. The first sync may download Python dependencies. The example itself uses synthetic drawings and writes the packages and checksums to `.local/data/example/sample/exports/`.

| Profile | Source | Export |
| --- | --- | --- |
| Offline `example` | Synthetic train and test archives with reviewed fixture labels | Sample trainer and held-out fixture ZIPs |
| Real `sample` | Up to two complete triplets per multiclass training folder, 24 MiB maximum in archive responses per invocation | Smoke trainer ZIP |
| Real `train` | Two nested multiclass archives from the pinned Zenodo release | Trainer and separately held-out test after auditing |

The real `train` run needs separate authorization. Prepared data, source caches, previews and exports use `.local/data/<profile>/` by default. Use `--data-root` to store them elsewhere, and pass the same options to each command.

## 2. Acquire and inspect the receipt

Only `download` reads the source. It checks the pinned record metadata and requires exact partial-content responses. It verifies the transferred ZIP data before use. The outer archive checksum is recorded as advertised, with verification reported separately. After an interruption, run the same command with the same profile and root to reuse verified cache entries.

If the download fails during the Zenodo record request, check HTTPS access to `https://zenodo.org/api/records/7330402` from the same machine. If Python reports a missing `SSLKEYLOGFILE` path, clear that optional setting for the current PowerShell session with `Remove-Item Env:SSLKEYLOGFILE` and retry.

Review `source/source-receipt.json` for archive bytes consumed, source kind, verification and selected counts. The real sample skips held-out images. Repeated download invocations have their own byte cap. The offline rehearsal receipt reports zero transferred archive bytes.

## 3. Prepare and optionally review

`prepare` checks canvas and detector-label formats and emits compact PNGs with JSONL manifests. It groups identical pixels and explicitly verified related examples before splitting. Train and validation come from the source training archive with a seeded allocation of about 80/20 by group. Eligible source test examples stay separate. The release has no original-session map.

For independent text and number corrections, add one JSON object per line in `corrections.jsonl` at the profile root. Valid review values are `yes`, `no` and `uncertain`. Omit a slot to retain its previous provenance. An unreviewed zero anchor proxy becomes unknown. This example confirms text and leaves number presence uncertain.

~~~json
{"sample_id":"zenodo7330402:multiclass:train:circle:895","text_present":"yes","number_present":"uncertain","reviewer":"reviewer-id","reason":"Text is legible. Number presence is unclear."}
~~~

To group a verified set of related canvases, add an object with their `sample_ids` array to `duplicate-groups.jsonl`. The tool groups these relationships transitively with exact pixel duplicates. Use `preview` to render training contact sheets at `preview/index.html`. Re-run `prepare` after edits to corrections or groups.

## 4. Audit and export

`export` checks source inputs, PNG and manifest hashes, split isolation, label consistency and usable support after the shared transform. It writes the trainer ZIP and checksum receipt to `exports/`. A source test split produces a separate held-out ZIP. Each package contains only its own prepared splits and the locked reader.

Use the summary to tell a wiring sample from a trainer-ready run. Real trainer readiness requires a complete multiclass run and usable known positives and negatives for both labels in both trainer splits. Check the actual counts when planning an experiment. The source version and image recipe fingerprints travel with each package.

## 5. Read the package

Use the [trainer quick start](#model-trainer-quick-start) for the trainer ZIP. Use the validation owner's independent test package for final evaluation.

ATYPICT is distributed under CC BY 4.0. This workflow retains canvas PNGs, derives separate presence targets, and records the source and split choices in the package. [Source release](https://zenodo.org/records/7330402)

## Corrected preprocessing and production preflight

From the repository root:

```powershell
uv run --project models/referee/data --frozen --no-dev referee-data preflight --profile train --json
```

For sample inspection add `--sample` and select the intended profile explicitly. This does not make sample data production-ready. For an extracted trainer package use `from referee_data import preflight; preflight("<package>/prepared")` in the model environment. A package must retain its labels, summary, hashes and bundled reader sources. All source/canonical previews use the Referee-specific preprocessing wrapper; do not apply a second normalization.

The current small reviewed sample intentionally fails production readiness. See [REPAIR-AUDIT.md](../../../docs/referee/REPAIR-AUDIT.md) for review files, ambiguous examples and actual validation results. Only apply review decisions to the matching source sample IDs and hashes; preserve existing human corrections.
