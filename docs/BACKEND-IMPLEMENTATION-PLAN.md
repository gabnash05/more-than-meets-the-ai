# Individual multiplayer implementation

## Current scope and status

The accepted plan on **6 November 2026 (Asia/Manila)** takes precedence over earlier Team-completion requirements. Finish the existing uncommitted NestJS/shared-contract/frontend draft; do not scaffold a second backend. The main milestone is a complete Individual game. Team mode and real AI inference have separate later plans.

Implemented and locally verified on **7 November 2026**: the room authority, authenticated transport, drawing journal/outbox, full Individual lifecycle and separate AI benchmark ledger/provider boundary. Backend checks passed 30 active tests with 2 Team tests explicitly deferred; frontend checks passed 41 unit tests, 36 local browser tests and 7 real multiplayer tests. The actual API-kill browser probe also passed saved-prefix/archive pixels, fresh retry and another lobby game. See [backend evidence and reproduction](BACKEND-VALIDATION.md) and [frontend evidence](FRONTEND-VALIDATION.md). Earlier snapshots are historical; no hosted CI, deployment or inference result is implied.

The separate later scopes are [Team gameplay](TEAM-GAMEPLAY-NEXT-PLAN.md) and [real AI inference](AI-INTEGRATION-NEXT-PLAN.md).

## Follow-up results/chat/prompt correction — 7 November 2026

The follow-up adds rank cards and a clearer recap, green correct confirmations, chat following at the history cap and spaced modal actions. Fresh matches persist private selected targets and exclude them across later drawers and interrupted retries. The API-owned catalogue contains 348 words. Existing matches without saved history retain their legacy behavior, and a new game enables strict non-repetition.

Local checks passed 35 API tests with 2 Team tests deferred, 41 web unit tests, 48 local production browser tests and 7 multiplayer tests. The actual SQL-history and pixel-recovery restart probe passed on retry. The validation guides record the earlier readiness timeout and each run's source context. Implementation and review were delegated to the existing Terra workers, with coordination, documentation and integration handled by the coordinator.

## Architecture and preserved frontend

Use Node.js 24/npm, the Next.js static export, one authoritative NestJS + Socket.IO process and PostgreSQL/Prisma. Each room serializes transitions; live state remains in RAM and bounded asynchronous archival keeps SQL off the immediate drawing path. Socket.IO channels group authorized recipients; they do not authorize or store the match. No Redis, load balancer, replicas or transparent process failover is part of this milestone. The later optional Guesser queue adds Redis Streams as an inference transport only; room authority and live state remain single-process.

Preserve the approved V10 Lemon Crayon UI, profile/avatar behavior, corrected invitation modal, Atrament renderer, fill worker, 1024 × 768 logical canvas, continuous 33 ms batching and bounded history. Components use RoomClient rather than direct HTTP/socket listeners. Local demo/review fixtures remain separate from remote production; remote failures never fall back to demo data.

## Individual room and match rules

- Individual is the default; there is no synthetic human team. Defaults are six human seats and six total prompt positions. Limits are 2–8 seats and 1–20 prompts; a prompt count is not a complete drawer rotation.
- Create opens the lobby and invitation immediately. Only the host starts, with at least two connected people and no Ready step. Everyone sees exact blockers. Remote Team selection/settings/starts are unavailable; preserve its implementation, types and deferred tests.
- The selecting drawer privately receives three choices for 15 seconds. On expiry choose an available option. Start the 60-second drawing clock after selection; hints and pauses use authoritative elapsed time.
- Each eligible human can solve once. A first human solve does not close the turn for remaining humans. Close when all eligible humans solve or the deadline expires, subject to disconnect handling. The drawer cannot guess a known target.
- Commit required records and results exactly once before advancement. Show an eight-second recap, score components and upcoming drawer; rotate through the stable roster, skipping departed/offline players. Final standings identify every tied human winner and have no active drawing labels/running clock. Host return to lobby permits another game.
- Reserve a disconnected host for 30 seconds, then transfer to the longest-connected eligible player using stable ties. Explicit departure transfers immediately; hosting never changes the drawer.
- Pause for up to 30 seconds if the drawer or every remaining unsolved guesser disconnects. On expiry retain accepted solves and close the affected turn; missing players are not counted solved. New arrivals cannot enter active games; existing participants resume their seats. Leave retains outcomes and releases departed seats when the lobby reopens.
- Server-projected canReturnToLobby permits escape from interrupted play or a committed result blocked by absent required players, and normal finished play. It cannot abandon an uncommitted active drawing.

## Scoring and AI preparation

Human scoring remains `human-v1`: valid solve `round(100 - 70 * clamp(elapsed / duration, 0, 1))`; no solve zero. Drawer recognition is `round(60 * sum(raw human points) / (100 * frozen eligible human count))`, or zero without eligible recognition. AI answers never count as human recognition. Human before/after-AI adjustments and drawer AI bonuses remain zero.

The separate `ai-benchmark-v1` scorer uses the same raw speed formula for the first eligible correct AI answer. An eligible evaluation without a correct solve earns zero; unavailable/ineligible is unscored, with nullable points. Match totals aggregate only committed eligible results and remain null until at least one eligible result commits. Preserve zero as a scored result, completed/scored/solved prompt counts and earlier committed totals across restart. Unfinished generations contribute neither points nor coverage.

Shared contracts add AiRoundResult on round results and AiBenchmarkSummary on snapshots. Older JSON lacking these fields projects unavailable/null/zero scored rounds. Keep AI results/totals in the existing Room/TurnResult JSON finalization transaction; no AI-specific SQL table is required. Show round status/points in recap and a separate total/coverage comparison alongside final human standings. Human winners come from human totals; humans rotate roles while AI is a guesser, so game totals are not a controlled model-performance measure.

The provider port binds job/turn/canvas/generation, canonical observation sequence, hints and deadline. Results echo the job identity and return an answer or unavailable status; the authority validates correctness, ordering, deadline/generation and duplicate consumption. The private target stays out of observations. The unavailable adapter is the production default, with no browser command for submitting AI answers or scores. Synthetic inputs are confined to explicit tests/review/local demo. Rendering, inference cadence, model hosting and network transport are deferred to the real-AI plan.

## Delivery, privacy and recovery

Keep the existing create/join/resume routes and socket names, bearer-session authentication, server-side credential hashes, origin checks and one active socket lease per player. Credentials never appear in invitation URLs/public events. Enforce phase/role/capacity/deadline and payload/coordinate limits. Preserve payload-aware request/operation deduplication, expected revisions, canvas generation and client/canonical sequence positions. Reject conflicting ID reuse and late/stale commands. Keep choices, target words and accepted human/AI answer text from unsolved players, including through drawer/solved-player chat.

Persist drawing envelopes in IndexedDB before send, preserve IDs across ambiguous retries and retain accepted envelopes until their durable watermark. Hydrate before input and replay without echo. Respect server-owned closing strokes; retire an unsendable tail with an honest notice and rotate the client stream. Never replay an old generation into a new drawing.

Live acceptance is not crash durability. Broadcast accepted drawing promptly, archive an ordered idempotent journal asynchronously and advance the watermark only across a contiguous committed prefix. Queue limits produce saving holds/backpressure rather than dropping operations. Required round records/results commit before the next prompt.

Refresh restores identity, role and accepted drawing while the process survives. An actual process restart recovers the committed sketch as interrupted/read-only, voids unfinished competitive outcomes and retries the same drawer/prompt position with fresh choices excluding the interrupted target. Prior committed human/AI results remain. No uncommitted tail is promised. Authorized old sketches remain discoverable after retry in a separate read-only canvas.

## Worker ownership and validation

- Foundation: shared contracts/ports, transport/bootstrap, Prisma/storage, API dependencies/config, transport/store tests and common harnesses.
- Game: room engine/scoring, engine tests, failure-boundary and actual process-restart scenarios.
- Frontend: all web application/reexports, client/outbox/canvas/UI, local/review fixtures and browser/unit tests.
- Coordinator: scope/documentation, isolated test setup, interface review and final stable combined checks. Route fixes to owners and reuse workers for read-only peer review.

First integrated gate: two independent browsers share one real room, roster and intermediate/final pixels, including a held stroke before pointer-up; refresh either role without duplicate seat or paint. Complete a multi-round game with at least three humans to prove independent solves, score components, rotation, final ties and return to lobby. Verify every drawing tool/history operation, reconnect/Leave/host transfer, permissions/privacy, final-seat races, ID conflicts, stale generations, durable pruning, saving failures/backpressure and exactly-once totals.

Kill/restart the actual API against guarded isolated PostgreSQL at port 55437. Verify saved-prefix recovery, prior results, same-position retry, lobby escape and old sketch access after retry. Synthetic AI tests establish scorer/ledger/boundary behavior only, including null versus zero, partial coverage, wrong-job/duplicate/late/stale results and interrupted-generation exclusion.

Run backend typecheck, real lint and tests including production build; run web typecheck/lint/unit tests, local-demo production browser regressions, then a remote production export and multiplayer Playwright suite. Inspect phone/tablet/desktop, keyboard, reduced motion, console and actual screenshots. The remote browser configuration does not start API/static servers. Use the ignored isolated runtime configuration without exposing credentials or touching system PostgreSQL; keep task cache/temp on E: when C: is low. Preserve frontend CI coverage, caches and timeouts; local and hosted validation are distinct.

Run/configuration instructions and final local evidence are recorded in the validation guides above. Do not commit, push, deploy, train models or make production-capacity/model-performance claims.
