# Guesser evaluation workspace

This Python/Jupyter workspace supports Guesser data auditing, model-training orchestration, and the later evaluation/inference workflow. The training scripts live in the separate Python 3.13 model project; the notebook launches them through uv rather than importing them into this Python 3.12 kernel. The fixed-stage evaluator, serving API, trained checkpoints, and performance results are not implemented or included yet.

## What this workspace is for

- **Available now:** reproducible Python/Jupyter environment; `00_environment_check.ipynb`; `01_dataset_pipeline.ipynb`; `02_dataset_audit.ipynb` for manifest checks and an opt-in indexed-payload audit; `03_training.ipynb` for A/B training orchestration; and `04_model_evaluation.ipynb` for protocol guidance and readiness checks.
- **Planned use cases:** audit held-out drawing splits and rendered inputs; compare stage-wise recognition metrics for frozen checkpoints; inspect errors/calibration; measure snapshot-to-result latency; and connect a selected checkpoint to the inference API.
- **Not included by the repository:** local Quick, Draw! data, trained model checkpoints, the fixed ten-stage prediction runner, an inference service, or model results. Do not report smoke training or training-validation curves as the final evaluator.

## Supported environment

The [training input guide](../training/README.md#exact-training-view-bundles-and-optional-cuda-augmentation)
now provides separate model-environment estimate/build/benchmark commands for
immutable epoch views and opt-in CUDA affine execution. Do not render these
bundles in the notebook environment, rewrite notebook cells or replace completed
A/B artifacts to adopt them. Start a separately configured training process with
a new output root. Input throughput measurements are not ten-stage recognition
or held-out accuracy results.

- Python **3.12.16**, pinned in `.python-version` and constrained in `pyproject.toml`. This follows the Guesser plan's supported range and is a safer shared base for the planned ML stack.
- Target: 64-bit Windows and Linux. The committed `uv.lock` includes platform-specific wheel selections for both, and Windows resolution passed a uv dry run from Linux; a live Windows notebook run remains to be verified.
- Base Jupyter/scientific dependencies install by default. The optional `inference` extra adds the planned PyTorch 2.7.1 / torchvision 0.22.1 pair, timm, OpenCV, and FastAPI dependencies.
- GPU drivers are not in the lockfile. CUDA availability and performance depend on each machine; no Linux-only PyTorch index is configured.

## Prerequisites and setup

Install `uv` and Git. From the repository root, run the same commands in PowerShell or a Linux shell:

```sh
uv sync --project models/guesser/evaluation --locked
```

`uv` selects Python 3.12.16 from `.python-version` (downloading it if needed) and creates `models/guesser/evaluation/.venv`. No Pipenv, manual virtualenv activation, `.env`, or `PYTHONPATH` setting is needed; the workspace package is installed into the environment.

To add the model/API packages when that work begins:

```sh
uv sync --project models/guesser/evaluation --locked --extra inference
```

The inference extra downloads large PyTorch wheels. Confirm `torch.cuda.is_available()` on the target machine before relying on GPU inference; CPU environment checks still work if CUDA is unavailable.

## Configure notebook collaboration tools

Run these once **in every clone**, from the repository root, after `uv sync`:

```sh
uv run --project models/guesser/evaluation pre-commit install --config models/guesser/evaluation/.pre-commit-config.yaml
uv run --project models/guesser/evaluation nbdime config-git --enable
uv run --project models/guesser/evaluation nbstripout --install
```

What each step does:

- `pre-commit install` adds a local Git commit hook. The scoped `nbstripout` hook strips notebook outputs and execution metadata as a final check before commit.
- `nbdime config-git --enable` registers notebook-aware diff/merge drivers. The root `.gitattributes` contains the shared notebook driver rules.
- `nbstripout --install` adds a local Git clean filter. Notebook outputs are stripped from the staged version when you run `git add`, before the commit hook. This avoids committing bulky execution output and reduces output-only diffs.

The hook/filter and driver registrations live in `.git` configuration and are **not shared** with a clone. Each collaborator runs the commands above locally; the generated interpreter path is specific to that clone and OS, while `pyproject.toml`, `uv.lock`, and `.gitattributes` stay portable. The pre-commit hook is a second safety net. If it changes a notebook already staged, stage that notebook again before retrying the commit.

In a clone with the clean filter enabled, Git uses nbstripout's stripped text view for notebook diffs, while the configured nbdime merge driver handles notebook conflicts. Check the local setup with:

```sh
uv run --project models/guesser/evaluation nbstripout --status
git check-attr -a -- models/guesser/evaluation/notebooks/00_environment_check.ipynb
```

## Start JupyterLab

From the repository root, launch Jupyter with the repository as its contents root. This keeps notebook Markdown links to sibling project files (for example `models/guesser/training/README.md`) inside Jupyter's allowed file tree. Do not append the notebooks directory as a positional argument: Jupyter uses that directory as the server root instead. Open `models/guesser/evaluation/notebooks` from the Jupyter file browser.

```sh
uv run --project models/guesser/evaluation jupyter lab --ServerApp.root_dir=.
```

JupyterLab uses the project's Python kernel. Open `00_environment_check.ipynb` and run all cells to check Python, package imports, and a small image operation. It reports the current OS and interpreter so collaborators can confirm which environment they launched.

Useful launch options (append them before the notebook directory):

```sh
# Use another port if 8888 is busy
uv run --project models/guesser/evaluation jupyter lab --port=8890 models/guesser/evaluation/notebooks

# Do not open a browser automatically (for remote/headless use)
uv run --project models/guesser/evaluation jupyter lab --no-browser models/guesser/evaluation/notebooks

# Bind to all interfaces only when remote access is required
uv run --project models/guesser/evaluation jupyter lab --ip=0.0.0.0 models/guesser/evaluation/notebooks
```

Binding to `0.0.0.0` can expose the notebook server to other devices on the network. Use it only on a trusted network and keep Jupyter's token/password protection enabled.

If using a Jupyter server launched outside this environment, register the kernel once:

```sh
uv run --project models/guesser/evaluation python -m ipykernel install --user --name mtmai-guesser-evaluation --display-name "Python (MTMAI Guesser Evaluation)"
```

Then select **Python (MTMAI Guesser Evaluation)** in the notebook's kernel menu. If it is missing, repeat the registration command after syncing the environment.

## Dataset pipeline notebook

`01_dataset_pipeline.ipynb` calls the existing data CLI in its separate Python 3.13
environment. Setup reads CLI defaults and `settings.py` through a read-only
subprocess using `uv run --frozen --no-sync`; it displays profile counts, sampling
methods, seed, and preprocessing configuration without importing the data package
into the evaluation kernel. Prepare the data environment first when no data job
is active. Both dependency sync and pipeline execution are disabled by default.

The options cell exposes profile, data root, concurrency, candidate reserve,
category filters, optional preview, and export directory. `None` delegates CLI
defaults rather than copying them. Relative paths resolve from the repository
root. Production, medium, and small are training profiles; smoke is for
examples/probes, not the full pipeline. Filtering downloads does not remove the
requirement for all 345 classes during preparation. Seed and preprocessing values
are read-only here because the CLI does not expose overrides. Rerun setup after
changing data source settings, and never sync or start a second pipeline while a
data job is running.

`02_dataset_audit.ipynb` selects production, medium, or small through `PROFILE`
(`None` uses the data CLI default). It reads expected counts from the data package
and rejects a mismatched dataset summary. `DATA_ROOT` and the legacy
`MTMAI_GUESSER_DATA_ROOT` environment variable name a profile directory containing
`prepared/`, not the parent data directory used in notebook 01. Explicit paths
take precedence; relative overrides use the kernel working directory. A full
split-isolation audit requires all three manifests, so a trainer-only archive
cannot pass by itself. Keep held-out archives out of model selection and threshold
tuning. The data CLI export step already checks payload integrity for the selected
profile. Notebook 02 verifies manifests; neither notebook measures recognition
quality.

## Reproduce the current A/B training comparison

Use one profile from data preparation through training. The pipeline notebook
currently defaults to the data CLI's `production` profile; the training notebook
defaults to `small`. Set them to the same value before running cells. For the
small-profile model workflow, set `PROFILE` to `small` in notebooks 01 and 02,
and keep `DATA_PROFILE` set to `small` in notebook 03.

1. In `01_dataset_pipeline.ipynb`, if that profile is not already prepared, set
   `RUN_PIPELINE = True` and run the pipeline cells. Export creates the trainer
   and held-out-test packages and runs the data package's payload-integrity audit.
   If the data already exists, leave the pipeline disabled.
2. In `02_dataset_audit.ipynb`, select the same profile and run the manifest
   audit. Use its optional payload-audit cell only to repeat the export check on
   an existing dataset. If rendering or preprocessing changed, generate and
   inspect the preview in notebook 01 before exporting again.
3. In `03_training.ipynb`, select the same `DATA_PROFILE`, set
   `TRAINING_MODE = 'full'` and `RUN_SELECTION = 'both'`, then set
   `RUN_TRAINING = True`. After A and B complete, set `RUN_COMPARISON = True`
   and run the comparison cell. The outputs are `checkpoint-selection.json`,
   `metrics.csv`, `comparison.md`, `comparison-summary.json`, and plots under
   the chosen checkpoint root's `ab_comparison/` directory.
4. `04_model_evaluation.ipynb` checks whether the validation manifest and both
   checkpoint handoffs exist. It does not produce recognition scores. The
   fixed ten-stage prediction/scoring runner is not implemented, so the current
   reproducible A/B report is a training/validation comparison only.

Keep the held-out-test package out of selection and threshold tuning. Do not
compare scores from different profiles as if they were a controlled dataset-size
experiment; each profile has its own split membership.

## Training orchestration notebook

`03_training.ipynb` is a cross-environment launcher for the existing A/B model
scripts, not a second training implementation. It calls `training.train` and
`training.compare_ab` through the Python 3.13 model project's uv environment;
do not import those modules into the Python 3.12 notebook kernel. The notebook
uses the already-prepared `small` profile by default, never downloads/prepares
data, and reads only train/validation splits. Training is disabled by default;
fast and full runs have separate ignored checkpoint roots. Remove inherited
`PYTHONPATH`/`PYTHONHOME` from subprocesses so the model interpreter cannot
accidentally import packages from the notebook host environment.

The launcher inherits `training.train`'s input-pipeline defaults: shared
memory-mapped train/validation manifests and a bounded, lossless validation-view
cache. Training widths and partial cuts still change with the shared worker epoch;
training renders are not frozen or cached across epochs. Cache files live under
the model project's ignored `.local/cache/`, not in exported datasets. See the
[training cache/worker guide](../training/README.md#deterministic-views-cache-and-workers)
for storage requirements, invalidation, relocation and benchmark-disable flags.
Existing kernels must launch a new trainer process to load changed training code;
autoreloading the notebook does not update an already-running child.

## Model-evaluation notebook

`04_model_evaluation.ipynb` gives the next action for the current repository
state: if checkpoints are missing, return to notebook 03 and finish both runs;
if present, run notebook 03's comparison cell. It checks prerequisites only;
there is no ten-stage prediction/scoring command yet. The model plan describes
that intended evaluation, but it cannot be reproduced until the runner exists.

## Notebook workflow and merge conflicts

Keep reusable Python code in `src/guesser_evaluation/`; use notebooks for imports/function calls, analysis, plots, and experiment records. The environment-check notebook demonstrates authoring with `%%writefile`: use its `module_source_path('module.py')` helper to target another module under the package root, then invalidate import caches and import/call it in a later cell. New subpackages also need `__init__.py`. Treat each `%%writefile` cell as the source of truth for its generated `.py` module: make all code changes to that module in the notebook cell, then run it to regenerate the file. Direct edits to a generated `.py` are temporary and will be overwritten the next time its writer cell runs. Give every additional module its own writer cell; the environment-check pair has a synchronization test. Commit the notebook and each resulting `.py` file as separate single-file commits so tests and terminal runs work without executing the notebook. `%autoreload 2` may help during interactive iteration. Do not keep reusable application logic only in ordinary notebook cells. Commit code/configuration and reviewed report summaries, not raw dataset files, checkpoints, or large run artifacts. The `.gitignore` covers local data, model, run, and output directories.

Before editing notebooks, create a small feature branch and avoid having two people edit the same notebook cells at once:

```sh
git switch -c feature/evaluation-notebook
```

When a notebook merge conflict remains after `git merge` or `git pull`, do **not** resolve the `.ipynb` JSON or conflict markers by hand. From the repository root, run:

```sh
uv run --project models/guesser/evaluation nbdime mergetool
```

Nbdime opens a three-way notebook merge view so you can compare the base, local, and incoming notebook cells. Review the merged notebook, save it, then stage the resolved file and continue the merge:

```sh
git status --short
git add models/guesser/evaluation/notebooks/<resolved-notebook>.ipynb
git commit
```

The nbdime merge driver handles notebook structure; `nbstripout` removes irrelevant output/metadata churn. These tools reduce noisy diffs and make cell-level conflict resolution practical, but they cannot eliminate conflicts when both branches change the same cell differently. If `nbdime mergetool` reports no files need merging, confirm the conflict is in a notebook and that the clone setup commands above completed.

## Add dependencies and run checks

Do not install packages with bare `pip`. Add a dependency to the appropriate group or optional extra in `pyproject.toml`, regenerate the lock, then sync:

```sh
uv lock --project models/guesser/evaluation
uv sync --project models/guesser/evaluation --locked
```

Run the current environment checks from the repository root:

```sh
uv run --project models/guesser/evaluation python -m pytest
uv run --project models/guesser/evaluation ruff check models/guesser/evaluation/src models/guesser/evaluation/tests
```

Commit the updated `uv.lock` with dependency changes so Windows and Linux collaborators resolve the same versions.

## Required libraries

Use TorchMetrics for top-1/top-3, F1, confusion and calibration error. Reuse PyTorch/Lightning evaluation APIs and the data package's fixed timestamp views. Custom orchestration keeps the ten stages, blank/pass outcomes, original-grouped reporting and held-out-test policy explicit. Do not implement standard metric formulas again.

See the [library guide](../LIBRARIES.md) and [implementation rules](../AGENTS.md). These choices do not mean the model packages or service are installed yet.

Future serving code belongs in `../inference/`; shared weights belong in `../checkpoints/`. The evaluator and inference service are not implemented yet.
