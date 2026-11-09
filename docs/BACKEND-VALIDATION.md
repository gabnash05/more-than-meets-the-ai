# Backend validation and isolated setup

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
