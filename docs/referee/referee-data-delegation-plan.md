> Historical plan: the v1 zero-proxy policy below is superseded by `separate-writing-advisories-v2`. Encoded zeros are known source-derived negatives, not reviewed negatives; uncertain reviews remain masked. See the data runbook.

# Referee data preparation · Terra delegation plan

**Status** · Implementation brief. The ATYPICT inspection and shared-transform probe are complete. The data package and trainer export described here are proposed.

Build the CPU data package under `models/referee/data/`. Follow the Guesser's six numbered modules, uv setup, PowerShell launcher, optional preview, single export audit, separate ZIPs, and one public image reader. The work ends at a checked package of images, two content targets and their known-label masks. Model code, training, benchmarks, threshold selection, advisory timing, scoring and game integration are assigned outside this data package.

Start with an offline rehearsal and, when useful, a bounded real sample. The sample-only instruction governs all execution under this brief. A future `train` profile can be implemented against fixtures and run on real multiclass archives after separate authorization. See the [sample evidence](inspection/summary.json), [full Referee plan](README.md), and [Guesser data runbook](../../models/guesser/data/RUNBOOK.md).

## 1. Match the Guesser layout

~~~text
models/referee/data/
  .gitignore                  # .local/, .venv/ and generated files
  .python-version              # 3.13
  pyproject.toml
  uv.lock
  README.md                    # setup, four commands, reader and handoff
  RUNBOOK.md                   # receipts, corrections, audit and ZIP recovery
  referee-data.ps1
  src/
    __init__.py                # referee_data.IndexedCanvases
    __main__.py
    settings.py                # source pin, profiles, label order, seed
    common.py                  # shared paths, hashing, atomic writes, step loader
    cli.py
    01-download.py
    02-prepare.py
    03-preview.py
    04-export.py
    05-loader.py
    06-images.py
  tests/
  .local/data/<profile>/       # source/, prepared/, preview/, exports/
~~~

Use Python 3.13 and uv for the CPU tools. This matches the current `guesser-data` dependency and Guesser training workspace. The Guesser's Python 3.12 evaluation notebooks have a separate lock. Package the existing CPU preprocessor as a pinned path dependency and keep the model environment separate. Use standard-library ZIP/JSON/hash tools, NumPy, Pillow and the installed Guesser image API. Use JSONL for the small raster manifests. The public reader needs neither Torch nor a data service. [Guesser data setup](../../models/guesser/data/pyproject.toml) · [Guesser training workspace](../../models/guesser/pyproject.toml)

From `models/referee/data/`, the intended commands are:

~~~powershell
uv sync --frozen
.\referee-data.ps1 example                   # offline rehearsal in .local/data/example/sample/
.\referee-data.ps1 download --profile sample  # explicit bounded real-source transfer
.\referee-data.ps1 prepare --profile sample
.\referee-data.ps1 preview --profile sample   # optional contact sheets
.\referee-data.ps1 export --profile sample
~~~

Default to `sample`. Keep `--data-root` available for another drive and keep each profile isolated. Preparation, preview, export and loading work offline. Run the final data audit as part of `export`. Review corrections are input data and contact sheets are optional.

| Profile | Source and size | Result |
| --- | --- | --- |
| `sample` via `example` | Synthetic, offline. Include train, validation and source-evaluation fixtures. | Rehearse both ZIPs and the loader. Mark the package smoke-only. |
| `sample` via `download` | Up to ten multiclass training triplets, aiming for two per source folder. Cap archive response bodies at 24 MiB across the run. | Inspect real formats. Mark the source partial and the package smoke-only. Skip new held-out image payloads and report that the real sample has no held-out ZIP. |
| `train` | Future opt-in. Fetch only `multiclass/train.zip` and `multiclass/test.zip`, 264,614,478 compressed member bytes before range overhead. | Training/validation and held-out exports after coverage and isolation checks. Kept counts follow validation, grouping and review. |

The ten-triplet target and 24 MiB ceiling are initial engineering defaults. Select paths deterministically by seeded rank within provenance folders. Record actual bytes, missing pairs and coverage. The historical probe inspected 16 triplets across both variants and transferred 7.02 MiB. [Dataset audit](dataset-audit.md)

## 2. Agree on the contracts before assigning workers

### Acquisition → preparation

Use Zenodo record `7330402`, DOI `10.5281/zenodo.7330402`, file `DrawMon-ACMMM22_Dataset.zip`, exactly `397584204` bytes. The advertised outer-file MD5 is `c199d21b6121819c81cfcda68cd440bd`. Resolve the content URL from pinned record metadata and preserve that metadata. A range receipt can verify the transferred members and their CRCs and hashes. The whole-file MD5 remains unverified for these range routes. [Official ATYPICT release](https://zenodo.org/records/7330402)

`source/pairs.jsonl` lists complete triplets with `sample_id`, `variant`, `source_archive`, `source_partition`, `provenance_folder`, and the three archive-relative member paths `png_member`, `sample_npy_member` and `label_npy_member`. `source/source-receipt.json` records the pin, route, inventory/selected counts, consumed bytes, completed members and verification status. Stage 01 exposes `read_member(source_root, source_archive, member_path)` to read one bounded member from the verified cache. Stage 02 uses that boundary for both bounded samples and complete local nested archives.

Build IDs from source record, variant, nested archive, inner directory and numeric suffix. The name `test.zip` maps to an internal `val/` path and the project's held-out `test` split. Source train folders are provenance. The `only_text` release has a different shape, lacks number supervision and overlaps multiclass data, including a confirmed cross-release duplicate. Keep it as audit evidence. [Archive inventory](inspection/zip-inventory.json) · [Duplicate receipt](inspection/verified-findings.json)

### Preparation → export

The `prepared/` tree has `images/` and `manifests/{train,validation,test}.jsonl` for the available splits. Image paths are POSIX-style relative to `prepared/`. Use the following fields in each record:

| Field | Meaning |
| --- | --- |
| `sample_id`, `source_archive`, `source_path`, `provenance_folder` | Stable identity and origin |
| `image_path`, `pixel_sha256`, `group_id`, `split` | Local PNG, decoded-pixel digest and split membership |
| `encoded_presence` | Diagnostic bits in `[text, number, symbol, circle]` order |
| `text_present`, `number_present` | `0`, `1` or `null` when the label is unknown |
| `known_mask`, `label_origin` | Two booleans and two origin tags (reviewed, encoded_positive, unreviewed_proxy or review_uncertain), in `[text, number]` order |
| `policy_version` | `separate-writing-advisories-v1` |

The profile root keeps `corrections.jsonl`, `labels.json` and `dataset-summary.json`. Use a corrections record keyed by `sample_id` with optional `text_present` and `number_present` review values `yes`, `no` or `uncertain`, reviewer, reason, and an optional exclusion reason. An omitted slot keeps its prior provenance. A review can confirm presence or absence or mask an uncertain slot. Otherwise a retained encoded positive is a proxy positive and an unreviewed zero is unknown. Reject conflicting correction entries explicitly.

For `train/circle/sample_895.png`, the observed detector bits are `[1,0,0,1]`. With no corrections, its proposed manifest gives text `1`, number `null` and mask `[true,false]`. A reviewed number-only example can give `[0,1]`. Text and digits can both be present. Writing on an object counts as content. Arrows, circles and icons can supply reviewed negatives when they contain neither type of writing. The record has no cheating or rule-violation target. [Sample evidence](inspection/summary.json) · [Policy boundary](referee-policy-boundary.md)

### Export → model owner

`referee_data.IndexedCanvases("prepared", "train")[index]` loads one sample on demand. The same entry point accepts `"validation"`; the validation owner's package accepts `"test"`. Provide `len()` and indexed access with clear errors for absent splits and bad indices. The result contains `image`, `target`, `known_mask`, `status` and `metadata`. Use an already normalized NumPy float32 image of shape `[3,224,224]` when status is `ok`. Use `image=None` for `blank` and `uncertain`. Targets are float32 `[2]` and the mask is bool `[2]`. Substitute finite zero for an unknown target in the loader and keep its mask false. Only the image is a model input.

Call `guesser_data.preprocess(png, candidate="foreground")` through Stage 06. The existing function fits foreground within 192 pixels, pads to 224, repeats the grayscale view across three channels and normalizes with mean/std 0.5. Preserve its status and diagnostics. Record its configuration hash and a fingerprint of the bundled source version. Check that the loader and direct Guesser call produce identical tensors for the same fixture and lock. Apply no extra normalization, temporal cuts, flips or label-changing crops. [Guesser image API](../../models/guesser/data/src/06-images.py) · [16-image probe](inspection/summary.json)

## 3. Delegate in three parallel lanes

Use a coordinator and up to three `gpt-6.1-terra` workers with `fork_turns: "none"`. Give each worker this plan and its named brief. Set the contracts above before dispatch. The coordinator owns `settings.py`, `common.py`, `cli.py`, package files, launcher, shared fixtures, docs and integrated checks. Workers use disjoint file ownership and coordinate contract changes through the coordinator. Dispatch stays with the coordinator. Each returns files changed, commands run, results, limits and a handoff note. Keep the existing group-project changes intact.

### Terra A · Acquire and verify

> Own `src/01-download.py` and `tests/test_acquisition.py`. Read the acquisition contract and `docs/referee/dataset-audit.md`. Build the ATYPICT cache and pair index using the pinned multiclass inventory. Use offline ZIP/HTTP fixtures first. Give Terra B a usable `read_member` interface and a complete fixture source tree. Use the real `sample` route only within the stated cap. Return actual counts and a receipt.

- Read only the required ZIP directories and member ranges. Require `206` and an exact `Content-Range`, including archive length, before reading the body. Enforce the remaining byte budget on requests and streaming reads, including retries. Reject an ignored range, changed source, truncation or CRC failure.
- Check nested member type, sizes, archive-root names and safe paths. Preserve ZIP/file identity and member hashes. Publish receipts after verification, reuse only matching completed members, and use partial files for interrupted work. Resume without mixing pins or profiles. Do not unpack the outer ZIP.
- Future `train` support can read both verified nested archives without materializing dense arrays on disk. Exercise it on fixture archives. Fail on range failure with a clear reason and keep network reads explicit.
- Cover same suffix under two parents, malformed response and byte cap, corrupt/incomplete cache, restart, path traversal and sample mode avoiding test image payloads.

### Terra B · Convert, review and split

> Own `src/02-prepare.py`, `src/03-preview.py` and `tests/test_preparation.py`. Read the two input contracts, `docs/referee/dataset-audit.md` and `docs/referee/data-workflow-plan.md`. Work against the shared fixture while Terra A builds the reader. Produce deterministic manifests, training-only review sheets and auditable exclusion/group counts for Terra C.

- Decode each PNG and check 512×512 grayscale, usable pixels and expected polarity. Record blank or suspect inputs. Compare `sample_n.npy` to PNG pixels for a representative set. Stream one label member at a time with `np.load(..., allow_pickle=False)`. Check multiclass float32 `[76454,9]`, finite values and the expected one-hot class columns. Columns 0–3 are offsets, column 4 is background and 5–8 are text, number, symbol and circle. A foreground bit is 1 if any anchor has that class. Report structural failures and retain only PNGs with compact records.
- Count positives, negatives and unknowns per head by provenance and split. Review encoded positives as well as nominal negatives for missed writing, especially small characters, mixed content, object writing and all-background labels. Review candidates from the source-training pool, including grouped validation rows, to establish known support in both trainer splits. Optional contact sheets show the training split only. Preserve mask and origin per slot. A correction may change one head while leaving the other unknown.
- Group exact decoded pixels before splitting. Use CRC/size only to shortlist. Use low-resolution image similarity to shortlist near duplicates or progressive variants for verification. Keep verified variants together, retain a stable representative for compatible exact duplicates, and quarantine conflicting groups until resolved by a reviewed correction. Persist reasons, counts and the grouping method. Use original session IDs if a trustworthy map becomes available. This release supplies no such map.
- Keep source `test.zip` as held-out `test`. Remove source-training rows from groups that cross into held-out. Tag the previously opened multiclass eval images `4036`, `2326` and `879` and exclude their entire known groups from train, validation and untouched-test claims. Record all exclusions. Allocate about 80/20 train/validation within source training by group with seed `198173`. Balance both heads and provenance where feasible, break ties stably and report actual support and unresolved session leakage.
- Check deterministic reruns, mask and correction precedence, mixed positives, corrupt or unexpected arrays, identical pixels with different PNG encoding, label conflicts, cross-source groups and disclosed probe exclusions. Preview is optional. Corrections trigger preparation again before export.

### Terra C · Audit, export and load

> Own `src/04-export.py`, `src/05-loader.py`, `src/06-images.py`, `tests/test_export.py` and `tests/test_views.py`. Read the export contract and the Guesser's `04-export.py`, `05-loader.py` and `06-images.py`. Build and test the consumer first against small prepared fixtures. Accept Terra B's output through the fixed manifest contract. Deliver two role-specific ZIP layouts and a portable one-row read to the coordinator.

- One final audit checks identity, allowed paths, decoded-pixel/file hashes, split/group disjointness, mask/origin consistency and archive membership. Track `ok`, `blank` and `uncertain`, and report usable label support after applying the exact loader transform. For a trainer-ready `train` bundle require at least one usable known positive and negative per head in both train and validation. Report shortages and actual support. This minimum is a plumbing check; model adequacy requires much stronger evidence. Leave rows with both masks false out of supervised batches.
- Write `trainer-<profile>.zip` for train and validation and `held-out-test-<profile>.zip` for the separate test custodian, with a portable `checksums.json` keyed by role (`trainer` and `held-out-test`), each with a relative `file` and `sha256`. Include only each role's PNGs/manifests and summary; keep held-out images, per-record metadata, corrections and QA sheets out of the trainer ZIP. Link packages by dataset ID, source pin, schema, seed and preprocessing fingerprint. Include counts, exclusions, known/masked supports, source verification, content hashes, split limits and attribution. Keep detailed QA and full audit logs with Data.
- Include the referee CPU reader and pinned Guesser source in both ZIPs as an allowlisted bundle. Preserve `models/referee/data/` and `models/guesser/data/` inside the ZIP so uv resolves `../../guesser/data` as it does in the checkout. Include the Referee lock, package files, source and start instructions. Keep the Guesser source unchanged. Use only prepared PNGs and compact manifests. Write staged archives and publish matching checksums once validated.
- Exercise a clean extraction, `uv sync --frozen` and one train/validation read from the trainer ZIP. Check status/shape/mask types, direct Guesser parity, portability after relocation and failure on missing or tampered data. Keep framework batching with the model owner. Verify the test ZIP can be read separately and the trainer ZIP has no test or preview payload.

## 4. Coordinator integration and handoff

1. Lock the source/manifest contracts, select one shared fixture and dispatch the three briefs. Keep the workers on their lanes while they build in parallel.
2. Wire `example` and the four normal commands. Run the CPU workflow from the launcher on synthetic data with reviewed negatives, an unknown, a both-positive sample, a blank, a corrupt member and cross-split duplicates. Re-run from the same inputs and compare manifest hashes. Exercise an interrupted acquisition and a correction rerun.
3. Run focused pytest, Ruff and Pyright for the data package and the packaged-reader smoke check. If the bounded real sample is run, record transfer bytes and exact checks, and label its outputs smoke-only. Report test support and the unresolved session-map limit. Hold full multiclass execution for separate authorization.
4. Give the model owner the trainer ZIP, its checksum entry and [one-page handoff](referee-data-handoff.md). Keep the paired held-out ZIP with the Validation & Inference owner. That owner keeps per-record held-out review separate, reports reviewed support apart from proxy support, and owns game replay collection. The released ATYPICT rasters supply no times, secret targets or replay history.

Done means the staged data tooling produces deterministic, checksum-verified fixture exports and a clean extracted archive can load one image and both targets through the shared preprocessor. A trainer-ready real-data handoff additionally requires the authorized multiclass run and measured reviewed support. Report these milestones separately.
