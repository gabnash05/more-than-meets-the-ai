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

Routine archival progress is coalesced into at most one full room snapshot per 200 ms window. Canonical drawing operations, lifecycle transitions and archive errors still publish immediately. The optional `game.closing` flag means every drawing group is closed while the authority is still saving/finalizing; it does not mean scores have committed. Archive completion wakes finalization directly rather than waiting for the one-second recovery poll. A last human solve or drawing deadline closes a held stroke on the server before finalization; a failed closing save cannot broadcast or archive an end that was rolled back.

The PostgreSQL adapter bounds connection acquisition at two seconds, statement execution at three seconds and lock waits at one second. PostgreSQL cancels stalled statements itself, so a client-side timer cannot leave a write running after the engine has rolled back. These bounds reduce one cause of the ten-second socket acknowledgement timeout; they cannot guarantee a network acknowledgement or bound an arbitrarily long room command queue. Failed persistence retains the existing rollback/retry behavior. No migration is needed.

Bootstrap endpoints are `/api/rooms`, `/api/rooms/:code/join`, and `/api/rooms/:code/resume`. Credentials are bearer tokens and must not be put in URLs. Prompt options are delivered privately to the choosing drawer; the target is withheld from unsolved guessers. The API authorizes each viewer's room events and saved interrupted sketch access.

Drawing acknowledgements report accepted sequence positions separately from the durable watermark. On restart, the saved durable sketch is available read-only via bearer-protected `/api/rooms/:code/interrupted/:canvasId/:generation`. An interrupted turn can be retried at the same position with a fresh prompt; previously committed results remain in PostgreSQL.

New drawing submissions use the canonical `DrawingPayload` fields without browser-local diagnostics; legacy stored payloads remain accepted and unchanged on retry. Batch ordering, validation, request deduplication and accepted/durable acknowledgement semantics are unchanged. The shared 512-point append limit also bounds newly captured browser chunks before operation IDs are assigned. See the [drawing-sync contract](../../docs/FRONTEND-ROOM-INTEGRATION.md#lossless-drawing-sync-follow-up--10-november-2026).

Room metadata saves omit drawing operation arrays before deep cloning; the geometry stays in its separate journal. Remaining nested metadata is still copied so a store cannot mutate the live room. Command rollback snapshots and database commit barriers remain intact. No SQL migration is required for this follow-up.

The shared TypeScript contracts live in `packages/game-contracts/src`; the web contract files re-export them. The API build compiles those shared sources alongside the server under `apps/api/dist`, and `npm start` runs the compiled server entry point.

## Inference queue

The optional inference transport uses Redis Streams so AI workers can scale independently of the room process. Set `GUESSER_PROVIDER=queue`, `GUESSER_MODEL_ID`, `REFEREE_PROVIDER=queue`, `REFEREE_MODEL_ID`, `AI_QUEUE_REDIS_URL`, optional `AI_QUEUE_REDIS_USERNAME`, and `AI_QUEUE_REDIS_PASSWORD_FILE`. The API writes the rendered PNG to `mmtai:ai:payload:<jobId>`, appends a versioned `InferenceJobV1` envelope tagged with the role to `mmtai:ai:guess:jobs:v1`, and waits for a result bound to the same job/turn/canvas identity. Queue wait counts against `AI_REQUEST_TIMEOUT_MS`; expired jobs become unavailable and late results are discarded.

Workers publish short-lived role-tagged registrations under `mmtai:ai:workers:*`; the API caches the first compatible fresh registration for each role. A broker outage, missing password file or invalid URL keeps the room human-playable and reports that role unavailable instead of failing startup. Redis credentials come from files; do not put them in URLs or source.

At most one queued or active job exists per room and role, but different rooms dispatch independently. Each AI container runs one inference at a time and dispatches each job to the model named by its role, so add replicas to add both Guesser and Referee concurrency. The HTTP Referee fixture remains available as a separate provider for dedicated smoke stacks.

## Validation

Run `npm run typecheck`, `npm run lint`, and `npm test`. The test command builds the production server first, then runs engine, fault-injection, HTTP/socket, PostgreSQL, and actual process-restart checks. PostgreSQL integration tests require `TEST_DATABASE_URL` pointing to the isolated `mtmai_test` database at `127.0.0.1:55437`. The restart test also needs free loopback port 3103. Set `REDIS_URL` to a disposable Redis database (for example `redis://127.0.0.1:6379/15`) to run the real Streams round-trip test; without it, that case is skipped. The Compose overlay test also skips when Docker Compose is unavailable. Tests delete only records/keys they create; configure test credentials locally and do not commit them.

For the guarded test configuration, exact commands and final local evidence, see [backend validation](../../docs/BACKEND-VALIDATION.md). Hosted CI is distinct from these local checks.

## AI benchmark preparation

The separate ai-benchmark-v1 round result uses the human raw speed formula for an eligible first correct AI answer. Eligible unsolved evaluations earn zero; unavailable/ineligible evaluations have null points. The match summary aggregates only committed eligible results and includes scored/solved/completed prompt counts. Human winners and drawer recognition exclude AI points; human AI modifiers remain zero.

The default Guesser provider reports unavailable. The optional inference configuration uses the browser renderer and either the Redis queue or an authenticated private HTTP service. Internal observations bind job, turn, canvas, generation, sequence, hint and deadline, and results echo the job ID. The engine rejects mismatched, duplicate, late or stale outputs. See the [deployment runbook](../../deploy/README.md) for the queue overlay and smoke-test setup.

AI results/totals extend existing JSON room/result records in the atomic finalization transaction. Older records missing AI fields project unavailable/null/zero scored rounds. No AI-specific database table is added. Synthetic test results are not model-performance evidence.

## Starting countdown and AI history

Host Start now enters a server-owned three-second `starting` phase before the first word selection. Later rounds retain their existing selection/recap flow. General chat is available between turns and after authoritative drawing closure; active drawer/solved-player answer protection stays enabled.

The Guesser defaults to a three-second initial delay and three-second cooldown after each completed inference, measured in active drawing time. The authority permits an answer only above 50% confidence. Low-confidence predictions consume the same cooldown/call cap and appear only in revealed history, without solving, scoring or emitting answer pulses. Committed round histories survive PostgreSQL recovery through existing JSON records; no SQL migration is needed. Existing memory-mode restart loss still applies.
