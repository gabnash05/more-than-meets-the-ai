# Real AI inference — later milestone

Status: the optional inference queue transport is implemented and verified with synthetic tests; model readiness, measured throughput and balanced gameplay remain unvalidated. The Individual milestone prepares a provider boundary, `ai-benchmark-v1` scoring and a committed AI ledger. Production currently uses the unavailable adapter unless the Guesser/Referee overlay is deployed. Human AI modifiers remain zero and human winners exclude AI totals.

The VM handoff, model artifact contract and initial guess pacing are specified in the [deployment and AI guessing plan](DEPLOYMENT-AND-AI-PLAN.md).

## Implemented queue transport (November 2026)

The Guesser and Referee roles dispatch through Redis Streams; the Referee fixture remains on its private direct HTTP route for dedicated smoke tests.

- **API settings:** `GUESSER_PROVIDER=queue`, `GUESSER_MODEL_ID`, `REFEREE_PROVIDER=queue`, `REFEREE_MODEL_ID`, `AI_QUEUE_REDIS_URL`, optional `AI_QUEUE_REDIS_USERNAME`, and `AI_QUEUE_REDIS_PASSWORD_FILE`. Credentials are read from files, not URLs or source.
- **Worker settings:** `AI_QUEUE_WORKER=1`, the same Redis URL/user, and the worker password file. One AI container runs one consumer and one inference at a time, dispatching each job to the Guesser or Referee bundle; add replicas to add consumers.
- **Wire contract:** versioned role-tagged `InferenceJobV1`/`InferenceResultV1` envelopes in `packages/game-contracts/src/ai-inference.ts`, mirrored in `apps/ai/ai_service/queue_contract.py`. The PNG lives under `mmtai:ai:payload:<jobId>`; request/results streams, worker group and readiness keys are defined in `apps/api/src/ai/redis-queue.ts` and `apps/ai/ai_service/queue_worker.py`.
- **Scheduling:** every due room is reviewed each pass, but a room/role has at most one queued/active job. Queue wait counts against `AI_REQUEST_TIMEOUT_MS`, so a late result is discarded instead of scoring late.
- **Failure modes:** a malformed, cancelled, expired, missing-payload or model-fault job yields an explicit unavailable result. A broker outage leaves human play intact and the AI unavailable; workers and the API retry connections.
- **Scaling:** Compose can add workers with `docker compose -f deploy/compose.ghcr.yaml -f deploy/compose.ghcr.guesser.yaml up -d --scale ai=3 ai`. This is operator-triggered scaling, not an autoscaler. Redis remains private to the overlay; the API stays a single process because live rooms are in memory.

## Starting point

Keep the trusted provider port and server-owned correctness/timing/deduplication. Observations bind job, turn, canvas, generation, permitted canonical sequence, hint and deadline. Results return a bound guess or unavailable status. Never expose the secret target to inference input or add a browser command that submits AI answers/scores. Reuse the existing Room/TurnResult JSON transaction; no AI-specific SQL table is required for this boundary.

## Work sequence

1. Select and verify a model artifact and its input preprocessing with the model/evaluation owners. Specify the permitted drawing observation and hints. Model accuracy, latency and gameplay balance require measured evidence; the party-game benchmark is separate from the controlled research comparison.
2. Decide rendering, inference cadence, cancellation and resource limits. Choose deployment and transport for the provider without coupling the room engine to a particular host or network protocol. These are future integration decisions, not requirements to add infrastructure now.
3. Implement the provider adapter and trusted scheduling. Bind each result to the reserved observation, ignore stale/duplicate/late jobs, hide answer text until reveal, and cancel work on turn/generation changes. Service failure must preserve human outcomes and report unavailable rather than inventing a zero or a successful guess.
4. Verify correct, wrong, zero, unavailable, partial-coverage and interrupted outcomes across commit failures and actual restart. Preserve earlier committed AI totals and exclude interrupted generations. Add real-provider tests separately from labelled synthetic scorer fixtures.
5. Measure recognition and latency on authorized evaluation inputs, then assess player experience. Any proposal to enable human before/after-AI adjustments or drawer AI bonuses needs a separate explicit scoring decision and versioned tests.

## Acceptance

Run the complete Individual regression suite with the unavailable adapter and real provider. Verify observation/target privacy, server timing, provider failure/recovery, cancellation, duplicate/wrong-job/generation/deadline rejection, eligible zero versus null, committed-only totals, recap/final coverage and actual process restart. Report the tested model/configuration and measured limits without treating game scores as controlled research accuracy or claiming production capacity.

Team gameplay remains a separate milestone and must not become an implicit requirement for this integration.
