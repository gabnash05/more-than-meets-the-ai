# Room API

NestJS and Socket.IO run one authoritative room process on Node.js 24. Compose defaults to process-local memory. Direct startup defaults to PostgreSQL, and `ROOM_STORE=memory` starts a local server without a database. Optional inference and production setup are covered in the [deployment runbook](../../deploy/README.md).

## Setup and running

Copy `.env.example` to `.env` and set `DATABASE_URL` to an existing PostgreSQL database. Set `WEB_ORIGINS` to the comma-separated browser origins allowed to connect. From `apps/api`, run:

```sh
npm ci
npm run prisma:generate
npm run db:migrate
npm run dev
```

Generate the Prisma client for either store. Apply migrations before starting against a fresh PostgreSQL database. For production, run `npm run build` followed by `npm start`. The API binds to loopback on port 3001 by default; `GET /api/health` reports readiness. The default allowed browser origins are `http://localhost:3000`, `http://localhost:3100`, and `http://127.0.0.1:3100`.

Server timing values are configured in milliseconds, not through room settings: `GAME_CHOOSE_MS=15000`, `GAME_DRAW_MS=60000`, `GAME_RECAP_MS=8000`, and `GAME_GRACE_MS=30000`. Values must be positive whole numbers no greater than 3,600,000; invalid values prevent startup. Room rounds count the total number of drawing prompts in the match.

Individual is the supported remote mode in this milestone. New Team settings/starts are rejected; existing Team code/types/records and deferred tests are retained for the later Team plan. Host starts require two connected humans. Each committed round has an eight-second recap before progression/final standings.

## Prompt catalogue and match history

New matches use an API-owned catalogue of 348 unique words: the existing category labels plus the original prompts. There is no runtime dependency on the model directory. The room's private JSON `selectedPrompts` records accepted manual/automatic choices, including interrupted targets. New choices exclude every recorded target; merely offered alternatives may recur. Refresh, restart and retry retain the history; a new match resets it.

The no-repeat guarantee applies to freshly started matches. Older JSON without this field keeps legacy behavior and results; earlier targets cannot be reconstructed from records that did not store them. Return to the lobby and start a new game to test strict non-repetition.

If fewer than three unused words remain, the authority reports a blocker and permits host lobby return from interrupted or committed result states. It never reuses a selected word or authorizes abandoning an uncommitted drawing. Existing commands, public contract fields and SQL schema are retained.

## Protocol and recovery

Bootstrap endpoints are `/api/rooms`, `/api/rooms/:code/join`, and `/api/rooms/:code/resume`. Credentials are bearer tokens and must not be put in URLs. Prompt options are delivered privately to the choosing drawer; the target is withheld from unsolved guessers. The API authorizes each viewer's room events and saved interrupted sketch access.

Drawing acknowledgements report accepted sequence positions separately from the durable watermark. On restart, the saved durable sketch is available read-only via bearer-protected `/api/rooms/:code/interrupted/:canvasId/:generation`. An interrupted turn can be retried at the same position with a fresh prompt; previously committed results remain in PostgreSQL.

The shared TypeScript contracts live in `packages/game-contracts/src`; the web contract files re-export them. The API build compiles those shared sources alongside the server under `apps/api/dist`, and `npm start` runs the compiled server entry point.

## Validation

Run `npm run typecheck`, `npm run lint`, and `npm test`. The test command builds the production server first, then runs engine, fault-injection, HTTP/socket, PostgreSQL, and actual process-restart checks. PostgreSQL integration tests require `TEST_DATABASE_URL` pointing to the isolated `mtmai_test` database at `127.0.0.1:55437`. The restart test also needs free loopback port 3103. Tests delete only records they create; configure test credentials locally and do not commit them.

For the guarded test configuration, exact commands and final local evidence, see [backend validation](../../docs/BACKEND-VALIDATION.md). Hosted CI is distinct from these local checks.

## AI benchmark preparation

The separate ai-benchmark-v1 round result uses the human raw speed formula for an eligible first correct AI answer. Eligible unsolved evaluations earn zero; unavailable/ineligible evaluations have null points. The match summary aggregates only committed eligible results and includes scored/solved/completed prompt counts. Human winners and drawer recognition exclude AI points; human AI modifiers remain zero.

The default Guesser provider reports unavailable. The optional inference configuration uses the browser renderer and an authenticated service on the private network. Internal observations bind job, turn, canvas, generation, sequence, hint and deadline, and results echo the job ID. The engine rejects mismatched, duplicate, late or stale outputs. See the [deployment runbook](../../deploy/README.md) for the smoke-test setup.

AI results/totals extend existing JSON room/result records in the atomic finalization transaction. Older records missing AI fields project unavailable/null/zero scored rounds. No AI-specific database table is added. Synthetic test results are not model-performance evidence.
