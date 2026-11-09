# Frontend CI

The workflow is `.github/workflows/frontend-ci.yml`. It runs on pull requests,
pushes to `main`, and manual dispatch. It uses Node.js 24.22.2 and npm's lockfile.
It does not deploy anything or repair collaborator-owned application code.

## Individual multiplayer milestone

The existing workflow checks the local-demo frontend production export. The real API/PostgreSQL suite and remote multiplayer browser suite are additional local validation gates described in [backend validation](BACKEND-VALIDATION.md); this milestone does not claim a hosted pass for them. No hosted run, deployment, workflow coverage reduction, cache change or timeout change is part of the current implementation.

## Parallel execution and failure reporting

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

Validate workflow syntax/expressions with `actionlint` and review `git diff
--check`. Changes to this workflow alone do not fix known lint or browser-test
failures. Local application checks and hosted workflow verification are distinct.

After publication, compare a cold run and a subsequent warm run. Confirm the
npm restore reports a hit, the Next.js cache restores, saved entries appear on
the repository's Actions cache page, both jobs overlap, and all original checks
still report their outcomes. Cache misses and GitHub queueing mean an exact
runtime cannot be promised. Browser assertion timeouts remain part of the
critical path until the application/test owner resolves those failures.
