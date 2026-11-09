# Real AI inference — later milestone

Status: follow-up scope, not an inference implementation or model-performance result. The Individual milestone prepares a provider boundary, `ai-benchmark-v1` scoring and a committed AI ledger. Production currently uses the unavailable adapter. Human AI modifiers remain zero and human winners exclude AI totals.

The VM handoff, model artifact contract and initial guess pacing are specified in the [deployment and AI guessing plan](DEPLOYMENT-AND-AI-PLAN.md).

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
