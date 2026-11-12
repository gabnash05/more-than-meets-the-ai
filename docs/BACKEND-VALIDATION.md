# Backend validation and isolated setup

## Game UX and AI fairness — 11 November 2026

On Windows / Node.js 24.19.0, final API typecheck, lint, production build and the complete isolated PostgreSQL-backed suite passed: **80 passed, 0 failures, 3 skipped**. The skips are the two existing deferred Team tests and the real Redis round-trip, which requires `REDIS_URL`. The local Docker engine was unavailable, so no real Redis/worker or model inference claim is made; queue contract, fake-connection binding, deadline, readiness, cancellation and recovery tests passed.

The suite covers shared first-game countdown, cancellation after eligibility loss, rollback of a failed countdown leave and replacement admission in a two-seat lobby. Confidence cases include missing, below/exactly/above 0.5 and invalid values; low-confidence predictions are retained without answer pulses or scoring. Inference timing fixtures enforce the three-second minimum, one in-flight call, changed-drawing checks and the 24-call cap. Existing pause, stale-job, failure, human scoring and privacy checks remain enabled.

Committed AI history is absent while finalization fails and appears once after successful retry. Generic closing chat is permitted while target-bearing chat remains rejected until reveal. Actual compiled-process kill/restart retained committed history and scores while the unfinished drawing recovered as interrupted. Existing PostgreSQL cancellation, journal and idempotency checks passed against guarded `127.0.0.1:55437/mtmai_test`; no browser/API session shared that database during the suite.

Two metadata tests initially assumed immediate word selection; their fixture now explicitly bypasses countdown through the injected test option. Production keeps the three-second countdown. Review also corrected a second-save leave inconsistency and departed countdown occupants before the final passing run. Logs: `.cache/game-ux-ai-fairness/api-typecheck.log`, `api-lint.log`, `api-tests.log`. No commit, push, deployment or training was performed.

## Lossless drawing-sync follow-up — 10 November 2026

API typecheck, ESLint, production build and the complete isolated PostgreSQL-backed suite passed on Node.js 24.22.2: **57 passed, 2 deferred Team tests, 0 failures**. No API/browser session was running against the test database during the final backend suite. Existing SQL cancellation, journal/finalization idempotency, authentication/origin, privacy, scoring and actual compiled-process restart checks remain enabled.

The metadata projection now removes drawing operation arrays before deep cloning, while retaining a separate owned copy of every remaining nested field. A public-command regression first observed two full-history clones where only the rollback copy was required; it now observes one. Tests additionally mutate the store-owned snapshot and verify live identity, selected prompts and undo remain intact, and verify a failed metadata save restores the exact accepted drawing prefix before a safe retry. Drawing geometry remains in its separate journal; rollback and commit barriers were not removed.

The authority uses `DrawingPayload` and the shared 512-point append constant without changing accepted request validation, canonical ordering, accepted/durable watermarks or legacy verbose-payload compatibility. No SQL migration or model/provider change is required. The [frontend validation report](FRONTEND-VALIDATION.md) records the complete browser checks, bounded recovery and local measured comparison. No deployment, push, commit or production capacity claim is implied.

## Drawing/round-flow and timeout corrections — 9 November 2026

On Linux with Node.js 24.22.2, API typecheck, lint, production build and the complete backend suite passed: **55 passed, 2 explicitly deferred Team tests, 0 failures**. The task-owned PostgreSQL 18 container was bound only to `127.0.0.1:55437`, with the guarded `mtmai_test` database. The final backend run had no parallel API/browser session using that database.

New regressions prove immediate archive-drain finalization, 200 ms archival snapshot coalescing with the correct final durable watermark, and canonical held-stroke closure after the last solve or deadline. Deadline tests cover ordinary completion, a failed closing save with no leaked stroke end, and a failed finalization that retains closing state and retries exactly once. Existing scoring/privacy, memory limits, authentication/origins, PostgreSQL idempotency and actual compiled-process restart checks also passed.

A gated room-save test demonstrates head-of-line blocking of resync. A real PostgreSQL row-lock test failed before the adapter deadlines were added, then passed with server-side lock cancellation, unchanged stored state and a successful retry. Connection acquisition is bounded at 2 s, statements at 3 s and lock waits at 1 s. This is database-side cancellation, not a `Promise.race` that leaves a write running after rollback. It does not bound arbitrarily many queued commands or guarantee delivery over a broken network.

Earlier local runs exposed missing `TEST_DATABASE_URL` and assertions tied to the old per-batch snapshot/open-stroke behavior. The environment was explicitly supplied and those assertions now verify coalescing and preservation of the original prefix plus exactly one canonical end. The final complete command passed; no test was skipped to hide those failures. Worker-sandbox IPC/build restrictions were bypassed by running the integrated checks normally, not by disabling typechecking.

These are local validation results; they do not imply deployment, provider enablement, a capacity claim or confirmed attribution of the live screenshot's timeout. The exact original stalled command remains unknown. The frontend report records browser evidence and its limitations.

## Scope

These are local checks for the single-process Individual milestone. They do not establish hosted CI, deployment, inference performance or production capacity. Team coverage stays explicitly deferred. See the [implementation scope](BACKEND-IMPLEMENTATION-PLAN.md), [API setup](../apps/api/README.md) and [frontend evidence](FRONTEND-VALIDATION.md).

Use Node.js 24/npm, installed PostgreSQL, and installed Google Chrome for browser checks. The observed local runtime is Node.js 24.19.0/npm 11.17.0; frontend CI remains pinned to Node.js 24.22.2. Existing CI coverage, caches, workers and timeouts are preserved.

## Guarded PostgreSQL configuration

Integration tests require `TEST_DATABASE_URL` whose host is exactly `127.0.0.1`, port is `55437`, and database is `mtmai_test`. Tests reject another target. The API restart test launches its own compiled process on port 3103. Keep that port free and avoid running another API/browser session against the same test database during the backend suite: startup recovery deliberately changes active room state.

The local cluster for this task is under `.cache/backend-postgres`, independent of system PostgreSQL. Configuration is in ignored `.cache/backend-runtime.env` with `DATABASE_URL`, `TEST_DATABASE_URL` and `PORT` entries. Never print credentials or add them to source control. Check ignore rules with `git check-ignore .cache/backend-runtime.env .cache/backend-postgres`.

For a fresh setup, create a separate cluster in an unused directory using PostgreSQL's `initdb` with a password prompt, start that specific directory with `pg_ctl -D <isolated-directory> -o "-h 127.0.0.1 -p 55437" -l <isolated-log> start`, then use `createdb --host=127.0.0.1 --port=55437 --username=<your-role> --password mtmai_test`. Configure a separate app database if needed. Do not initialize over an existing cluster, stop a system service or issue database cleanup commands against another target. This task reused its existing isolated cluster.

From the repository root, load only the required local value and validate it before migrations/tests. This PowerShell example does not execute the configuration as code or echo its contents:

```powershell
$testLine = Get-Content -LiteralPath '.cache/backend-runtime.env' |
    Where-Object { $_ -match '^TEST_DATABASE_URL=' } |
    Select-Object -First 1
if (-not $testLine) { throw 'Missing TEST_DATABASE_URL' }
$testConnection = $testLine.Substring('TEST_DATABASE_URL='.Length).Trim().Trim('"').Trim("'")
$testUri = [Uri]$testConnection
if ($testUri.Host -cne '127.0.0.1' -or $testUri.Port -ne 55437 -or $testUri.AbsolutePath -cne '/mtmai_test') {
    throw 'Refusing a non-isolated database target'
}
$env:TEST_DATABASE_URL = $testConnection
$env:DATABASE_URL = $testConnection
```

When C: is low, use ignored E: task cache/temp directories by setting `npm_config_cache`, `TEMP` and `TMP` for the child processes. Do not alter the user's system environment.

## Backend commands

From `apps/api`, with the guarded variables set:

```sh
npm ci
npm run prisma:generate
npm run db:migrate
npm run typecheck
npm run lint
npm test
```

`npm test` runs the production TypeScript build first. The suite combines pure room/scoring tests, injected storage failures, real HTTP/Socket.IO authentication/origin checks, real PostgreSQL idempotency/conflict checks and an actual compiled-process kill/restart. Tests remove only rows they create. A passing source typecheck alone does not replace the production build or database checks.

## Real browser verification

Start the compiled API explicitly on loopback port 3001 with the guarded test database and `WEB_ORIGINS=http://127.0.0.1:3100`. Keep the normal 15s/60s/8s/30s game timings unless a test explicitly uses injected time. Build the web export with:

```powershell
$env:NEXT_PUBLIC_ROOM_TRANSPORT = 'remote'
$env:NEXT_PUBLIC_ROOM_API_URL = 'http://127.0.0.1:3001'
$env:NEXT_PUBLIC_ROOM_SOCKET_URL = 'http://127.0.0.1:3001'
npm run build
```

Run `npm run preview` from `apps/web` in another process. Then run `npx playwright test --config playwright.multiplayer.config.ts`. The multiplayer config does not launch either service. Default local-demo browser tests require a separate local build; they cannot verify the remote authority. Do not rebuild the export while a browser suite is running.

An additional task-local Playwright probe kills only the task-owned API process after a durable watermark, restarts the compiled API, and verifies identity, prior human/AI results, saved pixels, same-position fresh-prompt retry and the separate read-only archive canvas. Its PID and database guards must pass before it can stop a process. Screenshots cover selection, recap, interrupted recovery and final standings at phone/tablet/desktop sizes with reduced motion enabled. The repeatable committed API restart test and saved-viewer browser regression remain in source; the full task-local probe and its sanitized evidence stay under ignored `.cache/individual-milestone`.

## Results/chat/prompt corrections — 7 November 2026

The correction source passed API typecheck, ESLint, its production build and the complete test command: **35 active tests passed, 2 Team tests explicitly deferred, 0 failures**. Logs are `.cache/results-corrections/api-typecheck.log`, `api-lint.log` and `api-test.log`.

The added prompt scenarios cover the 348-word catalogue, a complete 20-prompt match without selected-target repetition, manual/automatic selection, request replay, persisted history across interrupted recovery, legacy records without fabricated history, fresh-match reset and exhausted-pool permissions. The existing SQL, authentication/origin, archival/finalization failure and actual compiled-process restart checks also passed. Human scoring and SQL schema are unchanged.

The frontend report records 41 web unit tests, 48 local production browser tests and 7 real multiplayer tests. The additional actual API restart probe passed private selected-prompt JSON persistence, exclusion across retry, exact recovered/archive pixels and reset history for a new match. One earlier probe exceeded its API-readiness wait before the API became ready. Its repeat passed with captured startup output. Evidence is `.cache/results-corrections/browser-restart-retry.log` and `verification/summary.json`. The earlier milestone evidence below belongs to its previous source snapshot.

## Earlier Individual milestone evidence


Verified **7 November 2026 (Asia/Manila)** against the guarded isolated database, without touching system PostgreSQL:

| Check | Observed result |
| --- | --- |
| Prisma migration deployment | No pending migrations |
| API typecheck | Passed |
| API ESLint | Passed |
| Production build via `npm test` pretest | Passed |
| Complete backend test command | 30 passed, 2 explicitly deferred Team tests, 0 failures |

The final suite exercises independent human solves and normalized score boundaries; choice-timer recovery, elapsed-time hints and pause/grace races; stable rotation, authorized lobby return and socket replacement; bounded 128-batch backpressure and ordered contiguous archival recovery; journal/result conflicts and exactly-once finalization; authentication/origins; and a real compiled-process kill/restart with saved-prefix and prior-result recovery. Synthetic AI tests cover solved/eligible-zero/unavailable, bound and stale jobs, duplicate consumption, partial coverage and exclusion of an interrupted generation while retaining earlier committed totals.

Final backend logs are `.cache/individual-milestone/api-final-pause-typecheck.log`, `api-final-pause-lint.log` and `api-final-pause-test.log`. Migration evidence is `api-final-migrations.log`. These ignored local artifacts contain the actual run output; they are not hosted CI evidence. The frontend report records the separate successful 41-unit/36-local-browser/7-remote-browser runs and visual restart probe. The actual UI restart probe passed with exact saved and archived pixels, preserved earlier human/AI results, fresh same-position retry and another game from the lobby; it reported zero unexpected browser errors. Historical results there remain specific to their dated snapshots.
