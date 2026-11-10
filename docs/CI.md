# CI and GHCR container publishing

Pull requests run `.github/workflows/frontend-ci.yml` and
`.github/workflows/backend-ci.yml` with read-only repository permissions. The
backend workflow runs both API/PostgreSQL checks and the Python inference-service
tests. Pushes to `main` run `.github/workflows/container-images.yml`, which calls
both workflows before publishing. The same checks are reused, not copied or run
twice on each main push. All workflows also support manual dispatch; publication
is restricted to `refs/heads/main`. Application checks use Node.js 24.22.2 and
npm lockfiles; inference tests use the locked Python 3.13 environment.
Nothing deploys to the VPS, and no SSH or production database secret is needed.

## Individual multiplayer milestone

Frontend CI retains the complete local-demo production/browser suite. Backend CI
now configures the complete API suite, including real PostgreSQL and compiled
process-restart checks. The remote multiplayer browser suite remains an additional
local validation gate described in [backend validation](BACKEND-VALIDATION.md).
Configuration of these jobs is not evidence of a hosted pass: only an actual
GitHub Actions result establishes that. Existing frontend checks, caches, workers
and timeouts are preserved.

## Backend checks

The backend runner starts an ephemeral PostgreSQL 18 service on loopback port
55437 with database `mtmai_test`, matching the integration tests' hard guards.
Trust authentication is confined to that temporary CI database; never reuse it
for a public server. No production credentials or model artifacts enter CI.

After `npm ci`, the job generates Prisma and migrates only that test database.
Typecheck, lint, build and tests report their outcomes independently where their
prerequisites permit. Tests depend on successful migration and build; another
check's failure does not suppress them. Failures remain fatal. The runner's port
3103 is available for the actual API restart test. Providers remain unavailable.

## Container publication

Only after both frontend jobs and backend checks, including inference-service
tests, succeed, four independent Buildx jobs build for `linux/amd64` (node1's
verified architecture) and push:

- `ghcr.io/gabnash05/more-than-meets-the-ai-api:sha-<full-commit-sha>` — API `base` target, without inference/browser/model extras.
- `ghcr.io/gabnash05/more-than-meets-the-ai-api-inference:sha-<full-commit-sha>` — API `inference` target with the browser renderer required by live model inference.
- `ghcr.io/gabnash05/more-than-meets-the-ai-ai:sha-<full-commit-sha>` — CPU PyTorch ViT inference runtime; model bundles are mounted separately and are not baked into this image.
- `ghcr.io/gabnash05/more-than-meets-the-ai-web:sha-<full-commit-sha>` — Nginx plus the remote-mode static export, using same-origin API/socket URLs.

The owner/repository prefix is derived from GitHub's execution context, so forks
use their own namespace. Publication uses the automatic `GITHUB_TOKEN`, with
`packages: write` granted only to the publish job. Official Docker actions are
pinned to inspected release commit SHAs; each image has source/revision OCI
labels, a separate BuildKit cache scope and its tag/digest in the run summary.

Wait for the **whole** workflow to succeed before deploying matching tags. A
failed matrix member can leave only some images published; `fail-fast: false`
lets the remaining builds report their result rather than hiding partial failure.
There is deliberately no moving `latest`/`main` tag: a delayed run cannot make
an older release look newest. Re-running one commit may rebuild its tag; use the
reported digest if immutable content pinning is required. Publishing does not
restart games or apply database migrations.

New GHCR packages may initially be private even when the repository is public. A
repository/package administrator must either make all required packages public for
anonymous VPS pulls or authorize a user-managed, read-only registry credential.
Existing packages must grant this repository Actions access. No custom publish
PAT is required by the workflow. Registry access policies can still block a hosted
publication and must be checked on its first actual run.

The pull-only VPS procedure is in [the deployment runbook](../deploy/README.md#pull-prebuilt-ghcr-images-on-node1); the optional ViT canary uses its separate [GHCR Guesser instructions](../deploy/README.md#ghcr-vit-guesser-canary-on-node1).

## Frontend parallel execution and failure reporting

Two independent jobs start together:

- **Frontend checks:** typecheck, lint, and unit tests. These short checks run
  sequentially within their job, but independently of the production build and
  browser tests. A failed check does not skip the remaining checks.
- **Production build and browser tests:** builds the static export, ensures the
  Google Chrome channel expected by Playwright is available, then runs all
  browser tests. Browser tests require a successful build and browser setup.

Each job writes its own outcome table to the run summary. Required failures
still fail the job and workflow; there is no `continue-on-error` or reduced test
coverage. Browser failures upload `test-results/` screenshots, traces, and error
contexts with seven-day retention. The existing two Playwright workers and test
assertion timeouts remain unchanged.

Both runners perform their own `npm ci`. This spends more runner time than a
single job, but avoids serializing the fast checks behind the browser path or
transferring `node_modules` between runners. Parallel jobs can still queue when
GitHub's concurrency allowance is exhausted.

## Cache behavior

- **npm downloads:** `setup-node` restores the lockfile-keyed npm download cache.
  An explicit cache save immediately after successful installation preserves it
  even when lint or browser tests later fail. The previous workflow relied on
  `setup-node`'s success-only post-job save, which was skipped on failing runs.
  Both jobs use the same cache key; concurrent first saves may race, with one
  winning. Neither job skips `npm ci` or caches `node_modules`.
- **Next.js build cache:** restores only `apps/web/.next/cache`, keyed by runner
  OS/architecture, Node major, lockfile, and frontend source/configuration/assets.
  A lockfile-matching prefix can restore the previous incremental cache after a
  source change. A successful build saves the cache before browser tests run.
  The production `out/` is always rebuilt, never restored as a test substitute.
- **Chrome:** smoke-launches Playwright's configured Chrome channel and reuses it
  when available; otherwise installs Chrome and OS dependencies through Playwright.
  It does not add a cache for system Chrome or skip browser coverage.

Install commands use `--prefer-offline --no-audit --no-fund`: reuse downloaded
packages where possible and avoid advisory/funding requests on the timed
installation path. No separate dependency-audit check existed in this workflow;
these jobs are not a security scan.

## Verification and timing

### Local verification — 9 November 2026

All three workflow files passed actionlint 1.7.12. Additional parsed checks verified
the main-only publishing condition, both required reusable workflows, package
permissions, guarded test database and pull-only/persistent Compose contract.
The new Compose file passed node1's Docker Compose v5.5.1 `config --quiet` through
stdin against its existing file layout; no VPS files or containers were changed.

Both Dockerfile targets built successfully as local `linux/amd64` images using
Podman (API `base`, web final stage). An isolated stack exercised the actual images,
containerized Prisma migrations, all service health checks and Nginx-to-API routing.
The real multiplayer browser suite then passed **7 tests**, with the unavailable
real-inference smoke test explicitly skipped. Test containers/network/volume were
cleaned up. Raw temporary evidence is under
`/home/yashindo/.hermes/cache/scratch/mtmai-ghcr/`.

The first Podman smoke attempt timed out at the host-facing API health request:
production Nginx uses Docker's `127.0.0.11` DNS resolver, which Podman does not
supply. The successful local run used a scratch-only resolver override from the
test network; the production image and `deploy/nginx.conf` were unchanged. This
adaptation is not a Docker deployment verification. No hosted workflow run, GHCR
push/pull, package visibility change or VPS rollout has been performed. Those
require a committed/pushed workflow and inspection of its actual GitHub run.

Validate workflow syntax/expressions with `actionlint` and review `git diff
--check`. Changes to this workflow alone do not fix known lint or browser-test
failures. Local application checks and hosted workflow verification are distinct.

After publication, compare a cold run and a subsequent warm run. Confirm the
npm restore reports a hit, the Next.js cache restores, saved entries appear on
the repository's Actions cache page, both jobs overlap, and all original checks
still report their outcomes. Cache misses and GitHub queueing mean an exact
runtime cannot be promised. Browser assertion timeouts remain part of the
critical path until the application/test owner resolves those failures.
