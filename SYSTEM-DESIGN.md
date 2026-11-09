# More Than Meets the AI - System Design

Individual-first scope revised **6 November 2026 (Asia/Manila)**. The active milestone completes Individual multiplayer with Next.js, one NestJS authority and PostgreSQL. Team implementation/acceptance, actual AI serving and deployment are separate later plans. Preserve existing Team code/types and historical design context.

The prepared ai-benchmark-v1 ledger is separate from human totals: eligible first correct AI answers use the human raw speed formula, eligible unsolved evaluations earn zero, unavailable/ineligible is null/unscored, and only committed eligible results enter its total/coverage. AI never contributes drawer recognition or human winner selection. Human before/after-AI and drawer AI modifiers remain zero in this milestone. Real AI inference is unavailable; synthetic tests/review examples establish behavior rather than model performance.

The internal provider port binds job, turn, canvas/generation, canonical observation reference, hints and deadline. The authority owns correctness, timing, deduplication and scoring. The later provider may be a service or server; model hosting, image rendering, cadence and network transport are not fixed by this milestone. Detailed AI/checkpoint sections below describe later design context.

This is the current game/system design reference. The default is **individual free-for-all**. The drawer and the human guessers are separate individual competitors; calling the room "one team" is incorrect. Earlier team language in retained diagrams or fixture UI does not define the default mode.

The frontend and single-process NestJS/PostgreSQL human multiplayer backend are implemented. See [the current implementation milestone](docs/BACKEND-IMPLEMENTATION-PLAN.md) and [backend setup](apps/api/README.md) for the exact scope. AI inference, production capacity and balanced gameplay remain unvalidated. Remote Team entry points are gated for this milestone; the later Team plan retains the approved rotating selector/shared-target/private-canvas design.

## Decision status and precedence

- **Confirmed current milestone:** Individual play, shared canvas/rotating drawer, independent human scores, continued play after first solve, human-v1 with AI modifiers zero, separate nullable AI benchmark ledger, Next.js, one NestJS + Socket.IO authority, RAM live state and PostgreSQL persistence. The typed provider boundary remains unavailable until the later AI plan.
- **Separate optional mode:** the earlier flexible team formats, private parallel canvases and first-solve team scoring. Team play requires explicit selection; it is not a fallback/default and need not be implemented with the first backend slice.
- **Explicitly excluded:** Redis and the earlier distributed journal/lease/failover design. One active game process remains the baseline.
- **Working recommendations:** TypeScript, Tailwind CSS, shadcn/ui, Prisma, Pydantic, PyTorch/Transformers, worker isolation, stable identities, bounded queues and versioned inputs. These do not imply backend packages are installed.
- **Current defaults:** six human seats/six prompt positions; 2–8 seats and 1–20 prompts; 15-second selection, 60-second drawing, eight-second committed recap and 30-second reconnect/host grace. Human-v1 formulas and the separate AI benchmark are fixed in the current implementation plan; authoritative accepted event order and joint human winners apply.
- **Deferred:** enabling Team, real inference scheduling/readiness/hosting, future human AI weights/balance tuning, answer aliases, model/runtime tuning and study protocol.

Latest explicit user decisions take precedence over older documentation and diagrams. The detailed backend handoff is [BACKEND-SCORING-PLAN.md](docs/BACKEND-SCORING-PLAN.md). It must be read before implementing score calculation, solve handling, AI-result handling or turn termination.

## Default individual-mode contract

| Topic | Required behavior |
| --- | --- |
| Mode | Default to `individual` when no mode is supplied. Do not create an implicit human team or use a team total. |
| Roles and canvas | One drawer knows the secret target; every other eligible player guesses on the same evolving canvas for their own result. |
| Rotation and winner | Rotate the drawer through the players. Match length is agreed in the room; highest committed individual score wins. Use a distinct drawing-turn identity so a solve cannot accidentally advance the rotation. |
| Prompt | One fresh familiar everyday target per drawing turn. AI familiarity must be checked, not assumed from a training-exposure claim. |
| Human solves | Each player has one accepted correct solve per turn. Incorrect guesses remain uncapped. A solved player cannot earn a second solve or reveal the target to unsolved players. |
| Guesser score | Personal human-v1 raw speed points for the first accepted correct solve; no solve earns zero. AI modifiers remain zero in this milestone; later before/after-AI tuning must keep after-AI rewards positive. |
| Drawer score | Capped, normalized human recognition using the frozen eligible human roster and raw human points. Drawer AI bonus is zero now; the AI itself never contributes ordinary drawer recognition. |
| AI solve | Prepare one eligible first-correct AI benchmark result and committed total/coverage, separate from humans. The real provider is unavailable. Future accepted AI answers do not end remaining humans' turn or backdate earlier accepted human outcomes. |
| First human solve | Mark only that player solved; do not end the turn, freeze the canvas or cancel AI attempts needed by remaining humans. |
| Turn finish | End when all eligible human guessers have solved or the deadline expires. Explicit disconnect/abandonment policy handles absent players; a first human solve is never the completion condition. |
| Hints and budget | Human and AI guessers get the same official word-length and revealed-letter hints. The AI has a fixed guess cap/checkpoints; humans have no fixed guess cap. |
| Visibility | All players see the shared canvas and solve/progress statuses. Keep secret targets and actual AI answer text from unsolved humans until reveal. Correct human answer text must not leak through chat. |
| Points and finalization | Human and AI ledgers remain provisional until required round records commit atomically and idempotently. Human-v1 and ai-benchmark-v1 formulas are fixed for implementation but balance is unvalidated. Human AI modifiers remain zero. |
| Strategies and referee | Visual references and private codes remain legal. Written answer hints are banned; incidental writing is allowed. Referee flags are advisory, with disputes resolved by players. |

A voided drawing turn retries the same drawer and match position with a fresh target and generation. It does not advance rotation or erase prior committed scores.

### Optional team mode: explicit scope boundary

If selected and implemented, team mode retains player-agreed team counts/sizes, including unequal formats such as `2v2`, `2v2v2`, `3v3`, `3v3v3`, `2v3` and `3v2v4`. Each team starts with at least two humans, has one drawer plus the other members guessing, and uses a private canvas for the same shared target as the other teams. Only progress is public across teams. Its first correct teammate solve closes that team's challenge and creates one speed-based team result plus an eligible beat-the-AI bonus. Other teams continue until solved, forfeited or timed out. Drawer duty rotates within each team, and highest committed team total wins. The agreed fixed team-round count need not complete a rotation.

These are team-mode rules only. Individual mode has no team roster requirement, no private parallel team canvases, no first-human-solve shutdown and no shared human score. Keep the mode's lifecycle and scoring policies explicit in the future backend; a team-oriented field must not force individual players into a synthetic team.

### Terms used in this design

- **Drawing turn:** one drawer, one target, one shared canvas, a deadline and independent individual solve outcomes. This is the default scoring/finalization unit.
- **Active unsolved human guesser:** a connected, synchronized non-drawer who is eligible and has not yet solved this turn. A late checkpoint acknowledgement does not by itself remove a connected player from this set.
- **Individual solve:** that player's first correct accepted guess, distinct from all other players' outcomes.
- **AI checkpoint:** a scheduled opportunity to infer from a frozen permitted canvas/hint state within the AI budget.
- **Provisional/finalized result:** a computed personal result before/after its required records and result commit.
- **Team challenge/solve:** optional team-mode terms; they are not synonyms for a default drawing turn or individual solve.

## Design priorities

Responsiveness is the main operational priority. Match state must remain internally consistent even though saved views and archival work can lag behind live play. Human and AI competitors must use the permitted observations; the AI must not knowingly receive a newer drawing/hint version than currently active unsolved human guessers have reported rendering.

Keep ordinary drawing delivery independent of SQL reads, page rendering, image compression and GPU inference. Availability in this baseline means independent matches and sensible client reconnection while the game process runs. A restart interrupts its hosted matches; transparent server failover is outside the selected baseline.

## High-level architecture

![High-level architecture](docs/get_the_picture_system_design.png)

[Editable Excalidraw source](docs/get-the-picture-system-design.excalidraw) · [PNG preview](docs/get_the_picture_system_design.png)

The browser paints immediately and sends small drawing-operation batches over a persistent Socket.IO connection to NestJS. The backend validates and serializes each match's events, updates authoritative state in RAM, and broadcasts role-filtered operations. A bounded background writer archives batches to PostgreSQL. Image rendering and GPU inference run in workers, and AI completions are pushed back to the match engine.

The baseline runs **one active NestJS game process**, which can host multiple matches. A disconnected browser resynchronizes its identity, role and accepted drawing while the process survives. A process restart recovers the committed drawing prefix as an interrupted read-only sketch, voids unfinished competitive outcomes, and retries the same drawer and prompt position with fresh word choices. Prior committed results remain. Accepted but uncommitted tail operations are not promised after a crash. Transparent active-match failover and shared state across replicas remain outside this baseline.

The retained Excalidraw diagram is a high-level architecture sketch. The precise framework choices and behavioral policies in this document take precedence over abbreviated diagram labels. Render and archive workers are responsibilities owned by the game backend; each box does not imply a separate deployed microservice.

## Current stack and ownership

| Component | Stack | Responsibility and owned state |
| --- | --- | --- |
| Browser interface | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui | UI, Canvas 2D renderer, socket client and rendered-version tracking |
| Web application | Next.js App Router | Pages, guest-session interface, lobby and replay views; calls game-owned APIs |
| Game backend | NestJS on Node.js, TypeScript, Socket.IO | Authoritative rooms, explicit mode, player roles, prompts, hints, clocks, per-player solves/scores, attempts and live state |
| Render workers | NestJS-owned worker processes/threads | Canonical drawing snapshots and image compression outside the game event loop |
| AI service | Python, FastAPI, Pydantic | Internal job contracts, bounded admission, deadlines and pushed completions |
| Inference workers | PyTorch, Hugging Face Transformers | Loaded candidate models and bounded GPU scheduling; no direct game-database access |
| Persistence and exports | NestJS services/background workers, Prisma, PostgreSQL | Saved match setup, round events, finalized scores, replay/input artifacts and authorized exports |
| Research runner | Python, pandas, Jupyter, matplotlib | Authorized matched-sketch exports and a separate sketch-focused comparison |
| Observability | Structured logs and metrics; Langfuse optional | Drawing, reconnect, archival, queue and inference timings |

NestJS is the application framework. Its Socket.IO gateway receives drawing, guess and status events; HTTP controllers expose room, session, saved replay and research-export APIs. Nest supports Socket.IO gateways and shares application facilities such as providers, guards and validation with them. See [NestJS gateways](https://docs.nestjs.com/websockets/gateways).

Keep a single application-level match registry and one deterministic engine per match. Gateways and controllers call the same engine; async handlers must enter that match's explicit serialized event queue. Framework routing alone does not serialize competing human guesses and AI results. Suggested modules are rooms/players/mode selection, match lifecycle and scoring, AI coordination, persistence, and replay/exports. These are organizational boundaries inside the backend, not new network services.

Next.js Client Components handle browser interactivity. Per-stroke Canvas updates stay in an imperative renderer while React handles lower-frequency UI state. See [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components). Keep image processing and model work away from the realtime event loop; see [Node.js event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop).

Stitch, v0 and Figma remain optional design-authoring choices, not runtime dependencies. No hosting vendor, GPU or production capacity is selected.

## Gameplay and live drawing path

Default gameplay is a single shared drawing turn with individual competitors. Optional parallel team challenges require an explicit mode-specific branch.

1. A guest joins with stable identity. Check room membership and the current role; a room code or transient socket ID is not authorization. An absent mode selection resolves to individual.
2. Save the mode, player roster, scoring-configuration revision, match length and drawer order. Record turn-start metadata and the deadline before play. Send the full target only to the drawer.
3. The drawer paints locally and sends operation batches with stable IDs. The frontend's 33 ms target is a starting point for measurement, not a latency guarantee.
4. The NestJS engine validates operations and enters the turn's serialized state-transition queue. Assign canonical sequence numbers and update RAM.
5. Confirm and broadcast after the in-memory transition; enqueue a copy for background persistence. Live acceptance does not promise the event has already reached durable storage.
6. Human clients apply/deduplicate operations and report rendered versions. The drawer reconciles optimistic local painting against the accepted state.
7. A correct human guess creates exactly one provisional personal solve. Continue drawing, unsolved human attempts, hints and remaining AI opportunities. Route AI results and human guesses through the same ordered engine.
8. The AI's first accepted correct answer establishes the shared comparison marker and stops further AI guesser jobs. Remaining humans can still solve for reduced turn earnings. Later AI output cannot change a human's already-established before-AI ordering.
9. End at all eligible humans solved or the common deadline, subject to an explicit abandoned-turn policy. Close remaining jobs and reveal/replay. A live replay may use RAM while saving is pending. Flush required records, finalize personal guesser/drawer results once and then advance to the next drawer.

Stroke delivery does not invoke a Next.js Server Action, route render, per-stroke SQL read or full-image upload. PostgreSQL writes are batched in the background. Socket.IO preserves ordering but defaults to at-most-once delivery, so stable IDs, retries, gap detection and resynchronization remain application responsibilities. See [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

## Active state and persistence

| Location | Stored information | Purpose |
| --- | --- | --- |
| Browser memory | Rendered canvas, hint version and applied sequence | Painting and rendered-view acknowledgements |
| NestJS process RAM | Match registry; canonical canvas, roles, clock, hints, scores, attempts, dedupe state and recent operations | Authoritative live gameplay and same-process reconnects |
| Bounded in-memory archival queue | Accepted event batches and input artifacts waiting for SQL commit | Keep persistence work off stroke delivery |
| PostgreSQL | Match setup, round-start/finalization records, committed scores, archived events, AI attempts, hints, flags and versioned input artifacts | Saved results, complete replays, research exports and restart bookkeeping |

Use Prisma through game-owned persistence services. Archive by stable event/attempt identity, update the archive watermark only after commit, and make retries idempotent. Use bounded queues and admission/backpressure when the writer cannot keep up; do not silently drop events or declare a replay complete before its required records are saved.

Before finalizing an individual drawing turn, flush its required event batches and artifacts, then commit all personal outcomes with a unique turn/generation identity. Live points and AI adjustments remain provisional until that commit. A voided generation cannot finalize later or count twice. Save enough match setup and rotation metadata to resume the same drawer/turn position after restart. Optional team mode finalizes its team outcomes at its own round boundary.

These are turn-boundary writes, not per-stroke waits. If PostgreSQL is unavailable, finish the current turn within the bounded RAM buffer, then wait for required records and results to commit before starting the next turn. Results remain provisional while saving is pending. Finalized turns have committed replay records; an interrupted turn may have only a partial archive. Do not reconstruct it as a completed competitive turn or promise its unflushed events survived.

Exact input images can initially be stored as versioned game-owned artifacts in PostgreSQL. A separate artifact store can be introduced if measured volume justifies it. Live inference never waits for archival merely to obtain its input.

### Required logical records and identifiers

These are conceptual records; exact route/table names and column types remain implementation choices.

| Record | Information to retain |
| --- | --- |
| Match setup | Match ID, explicit/defaulted mode, stable player IDs, rules/config revision, match length and drawer order; team membership only for selected team mode |
| Drawing turn and generation | Turn ID, match/rotation position, drawer, eligible human roster, server-only target, deadline/hints, generation and started/void/finalized state |
| Human solve state | Per-player unsolved/solved state, first accepted solve sequence/time, base points, AI ordering classification and score components |
| Drawing event | Stable ID, canvas identity, canonical sequence, time, coordinates/tool parameters and erase/undo/clear semantics |
| Human attempt | Stable ID, player/turn/generation, submitted answer, correctness and authoritative acceptance sequence/time |
| AI attempt and solve | Reservation/checkpoint/job IDs, instance/generation, frozen input versions/hash, model/config, timing, outcome and first correct accepted AI sequence |
| Hint or referee event | Hint versions or advisory incident/evidence, associated canvas/input identity and timing; referee flags never directly deduct scores |
| Input artifact | Exact permitted snapshot or tested renderer identity, image hash, hint state and model/prompt/preprocessing revisions |
| Personal score result | Player, role, turn/generation, human-only base, AI adjustment, drawer bonus where applicable, eligibility/reason, config revision and commit identity |
| Optional team result | Separate mode-scoped team challenge/first-solve result; never the default individual ledger |

Stable IDs and per-turn/canvas ordering support deduplication and gap recovery. `serverInstanceId` and generation reject stale work; they do not implement distributed ownership. A canvas/turn ID identifies default AI jobs without a fabricated team ID. Keep target labels separate from actual model input. Individual totals derive from committed personal results, with one result per player/role/turn generation. See [the scoring plan](docs/BACKEND-SCORING-PLAN.md) for result components and acceptance cases.

## Client reconnects and game-server restarts

### Temporary participant disconnect or lag

In individual mode, other players continue after one disconnects. Keep accepted personal solves. A solved player does not return to the unsolved set, and reconnecting cannot grant a second score or reset their before/after-AI classification. A disconnected unsolved guesser becomes inactive for observation checks, but an explicit deadline/eligibility policy must govern their unresolved turn outcome; being disconnected is not a correct solve.

If the drawer or every remaining unsolved guesser disconnects, keep the drawing visible and pause the affected drawing clock for up to 30 seconds. Resume after catch-up if the required participants return; otherwise close that turn/challenge, retaining accepted human solves and neutralizing AI adjustments. Do not promote a guesser into a known-target drawing role. Wait for the required connected roster before the next turn. No AI checkpoint runs against an empty unsolved set.

Returning players reauthenticate, obtain the correct canvas/hints/sequence, and acknowledge catch-up before rejoining active observation checks. A still-active connected guesser's late acknowledgement cannot simply be ignored to release an AI checkpoint. Solved players are outside the unsolved competitor set. Ended/voided turns cannot reopen on reconnect.

In optional team mode, the earlier team-scoped grace remains: a team continues while a human guesser is active; no-guesser grace expiry forfeits that active team challenge only. A returned drawer is never a guesser for a target they already know.

Socket.IO connection-state recovery can help with missed packets, but application synchronization and role checks are still required. See [Socket.IO connection-state recovery](https://socket.io/docs/v4/connection-state-recovery/).

### Game-process restart

Assign a new server-instance identity. Load saved mode, player roster, drawer order and committed prior results. Void the unfinalized drawing turn and its provisional personal results; retry the same drawer/turn position with a fresh prompt and generation. Do not advance rotation. Reject old-instance/generation actions and completions. Prior committed scores remain. In selected team mode, apply the corresponding team-round void/retry policy.

One active NestJS game process is the deployment baseline. Its in-memory registries are not shared across independent replicas. Accepted but unflushed live events can be lost on restart. Every active match hosted in a failed process is interrupted; a normal participant disconnect leaves other matches running.

## Failure and scoring policies by mode

| Situation in default individual mode | Required handling / implementation boundary |
| --- | --- |
| One human solves before the AI | Preserve that personal before-AI result; continue the turn for everyone still unsolved. |
| The AI solves before another human | Apply the configured reduced turn earnings only to that human's later correct solve; do not deduct prior totals or alter earlier solvers. |
| One player disconnects | Keep accepted solves and let others continue. Finalize absent-player outcomes under an explicit individual deadline policy, never a whole-room team forfeit. |
| Required AI guesser work fails | Use human-only scoring for the affected turn: neutralize both positive and negative AI-derived guesser adjustments and the drawer AI bonus for everyone. Do not treat an unavailable attempt as a wrong guess or an AI that humans successfully fooled. |
| A checkpoint cannot run fairly because clients are not ready | Record a readiness miss separately. The individual-mode scoring consequence must be specified before implementation; the old team-only bonus-removal rule cannot decide it. Do not award a fabricated fair AI comparison. |
| Referee fails | Advisory flags unavailable; no automatic score penalty or invented clean verdict. |
| PostgreSQL cannot commit | Finish within bounded RAM buffering, then keep results provisional and wait before starting the next turn. |
| Game restart or unverifiable competitive history | Void the unfinished turn and retry the same drawer with a fresh target; keep committed prior personal results. |

All AI-derived adjustments remain provisional until finalization so fault handling can apply consistently. A service fault may neutralize a turn's AI scoring; a late successful model answer cannot retroactively beat an earlier accepted human solve. Cancellation because all humans solved, the AI solved, the deadline expired or the turn was voided is not itself a service outage. Missed checkpoints expire; reconnecting does not grant overdue attempts.

Optional team mode retains its separate rules: a human-side readiness miss removes only that team's AI bonus; a required AI-service fault removes bonuses across that team round; connected teammates continue and no-guesser grace can forfeit one challenge. These team-scoped outcomes must not be used as the default individual scoring policy.

## AI observations and result acceptance

At each scheduled checkpoint, freeze the default turn's canonical canvas version `V` and official hint version `H`. Render that accepted checkpoint once. Before releasing it for inference, require every currently active unsolved human guesser to acknowledge at least `V` and `H`. At least one such guesser must exist; the empty set never satisfies readiness. The first human solve removes only that solved player from future competitor sets and does not cancel the remaining race.

Serialize active-set changes with checkpoint decisions. Disconnected players become inactive, returning players must acknowledge catch-up, and a still-active client cannot be excluded merely to bypass a late acknowledgement. An acknowledgement reports application-rendered state, not conscious perception or identical arrival time. Record rendering/release differences and use explicit lag/grace bounds. In selected team mode this same observation rule applies separately per private team canvas.

Reserve each AI attempt once in the NestJS engine. Jobs bind match/mode, drawing-turn/canvas/generation, server instance, checkpoint/attempt/job IDs, model role, frozen input versions/hash, capture/release/deadline times and renderer/model/prompt/config revisions. A team ID is relevant only in selected team mode. Model input contains only the image and permitted hints, never the secret target or human answer text.

FastAPI validates internal jobs, bounds inference admission and pushes completions with acknowledgements/retry/deduplication. Periodic polling is not the normal completion path. See [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/).

NestJS checks instance/generation, turn activity, expected job/input identity, deadline and valid unconsumed reservation. Serialize result acceptance with human guesses. Compare the frozen reserved input, not equality with the latest canvas version. Record the first correct accepted AI event as the comparison marker; do not backdate it using GPU start/finish time. Retry cannot double-consume an attempt or score. The final reserved attempt remains valid when unreserved budget reaches zero.

After an individual human solves, retain the drawing and AI schedule for remaining humans. After the AI solves, cancel its remaining guesser work while humans continue. At actual turn closure cancel remaining work; late results cannot score after close, void or restart. Optional team mode can still close its challenge at the first teammate solve. FastAPI never awards scores or directly writes the game database; referee work is independent.

The renderer stays on the AI host in the two-host proposal. Reuse its decoded image for inference, and encode/return the checkpoint PNG for background backend archival. Dataset export reads saved images and records; extra frames are rendered offline. The worker-buffer/IPC mechanism is an implementation choice; the diagram does not imply a shared JavaScript object across hosts.

### Candidate models

- **Guesser:** [Qwen/Qwen3-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct), which supports image/text input. Accuracy and latency for these incomplete, reference-based sketches remain untested.
- **Referee evidence:** [microsoft/Florence-2-base](https://huggingface.co/microsoft/Florence-2-base), which documents OCR with text regions. A detected region does not establish an illegal hint because incidental writing is permitted. Flags remain advisory.

Keep weights loaded, bound GPU concurrency and schedule fairly across active drawing-turn checkpoint jobs. A loaded model can serve multiple drawing-turn jobs and optional team races subject to measured throughput. Referee tasks must not starve guesser checkpoints. Record capture, render-ACK release, enqueue, inference start/finish and backend receipt times; version preprocessing, prompts and generation settings.

## Privacy, replay and research

Full targets go only to the assigned drawer. In default individual mode everyone sees the shared canvas and official hints, but unsolved players cannot see accepted correct answer text from solved players or the AI before reveal. Referee flags remain advisory. Private opposing-canvas evidence is relevant only to optional team mode and must stay private there.

Replay reconstructs strokes, erasure, undo, clear, hints, guesses, solves and advisory flags from canonical events. It can show the AI's first correct guess and mistakes without claiming an internal moment of understanding. Retain exact input artifacts and hashes, or a tested deterministic renderer/revision that can reproduce them; the pilot proposal uses archived input artifacts.

The research runner obtains authorized exports through NestJS APIs, not direct database access. The separate comparison presents matched incomplete sketches without gameplay hints or the AI handicap. Correct target recognition from shared semantic/cultural visual references is primary; timing is secondary. Private visual codes remain legal in gameplay but are excluded from the main study. Explanation-based interpretation analysis remains future work, and player onboarding stays brief. Preserve drawing/session group IDs when analyzing related partial frames.

Use structured logs and metrics first; Langfuse is optional. Keep evaluation labels separate from actual model inputs and avoid leaking secret targets into model-visible traces.

## Deployment and verification still required

Next.js, the single persistent NestJS game process, PostgreSQL and the GPU/FastAPI application are separately restartable components. The GPU host can be separate from the CPU host; place them suitably near players and one another. Keep heavy image work and inference off the realtime event loop.

Measure remote-paint latency, event-loop delay, archival backlog/flush latency, client resynchronization, queue/inference tails and per-turn/model-job scheduling skew. Use a shared clock/test harness or calibrated estimates instead of subtracting unsynchronized client clocks. The earlier regional p95 drawing-visibility example below 100 ms and the 16–33 ms batch interval are provisional targets, not results. A shared canvas and optional team-count flexibility do not imply unlimited capacity; measured player/match/job admission limits are still needed.

### Validation plan

Before backend scoring is enabled, execute the acceptance scenarios in [BACKEND-SCORING-PLAN.md](docs/BACKEND-SCORING-PLAN.md). Verify individual mode is the default; a first human solve preserves the canvas/AI race; each guesser is scored once; AI-first changes only later personal earnings; drawer credit excludes AI recognition; an unreadable image cannot earn an evasion bonus; service faults neutralize all AI adjustments; and results/finalization are idempotent.

Also verify role/target privacy, no solved-answer chat leakage, duplicate/out-of-order/gapped operations, canonical rendering, active-unsolved observation barriers, reconnect versus restart, stale AI jobs, accepted human/AI order, database saving holds and replay/export equivalence. Optional team policies need their own explicit-mode tests.

Vitest, Playwright and pytest are the proposed TypeScript/browser/Python tools. The frontend has its own validation report; no backend scoring, AI training, load or production-recovery verification is claimed by this documentation update.

### Decisions deliberately left for implementation planning

- Visual identity; authoring workflow among the discussed Stitch, v0 and Figma options. A future design system should cover typography, spacing, team/AI status treatment, canvas tools, hints, scores, warnings, replay and disconnected/waiting/reveal states.
- Individual base-score formula, before/after-AI weights, smaller drawer bonus/cap, eligible-roster normalization, answer variants/typos and same-time/tie handling. See the scoring plan; do not copy an illustrative numeric example as a finalized rule.
- Drawing-turn/match-round presentation, numeric time/hints/AI budget/checkpoints/deadlines, reconnect grace, lag bounds, unresolved-player/no-guesser turn closure and individual-mode readiness-miss scoring consequences.
- Batch sizing, canvas/tool limits, buffer/backpressure limits, export retention and data collection/consent details.
- Actual model selection, runtime settings, memory/concurrency/batching and any later fine-tuning; available hardware and hosting/region topology.
- The detailed sketch-study procedure, sample size, comparison baselines and analysis protocol. Correct target recognition remains primary and speed secondary; detailed reference explanations remain future work.

Current Individual formulas, clocks, limits, disconnect behavior and restart semantics are fixed in the implementation milestone. Real-inference readiness/cadence and future AI balance still need the later AI plan. The older team-specific readiness policy applies only when team mode is selected. Database saving holds remain required. Transparent multi-process failover is outside the baseline.

## Decision rationale and finalization record

| Decision | Rationale and accepted consequence |
| --- | --- |
| Default individual free-for-all | One shared canvas, rotating drawer, individual solves and leaderboard. Drawer and guessers compete individually; a one-team representation is incorrect. |
| Stronger personal AI effect for guessers | Compare each person's own solve against the shared AI marker. Someone else's late answer does not undo an earlier player's success. |
| Smaller capped drawer AI bonus | Reward human-readable, AI-challenging drawings while retaining ordinary human-recognition incentives. No credit for the AI itself solving or for nobody understanding the sketch. |
| Continue after first human solve | Preserve every remaining human's chance to solve and compare against the AI. The AI or first human is not a turn-wide winner-takes-all shutdown signal. |
| Team mode is optional | Preserve earlier flexible-team rules under explicit mode selection, isolated from the individual default. |
| NestJS + RAM + PostgreSQL | One authoritative process hosts matches; background archival keeps SQL off strokes. Restart voids unfinished turns and preserves committed prior results. |
| Shared permitted observations | Checkpoints use frozen canvas/hints acknowledged by currently active unsolved humans. Fair observation is distinct from identical physical timing. |
| Human-only fallback for AI-service failure | Remove both AI rewards and reductions for the affected default turn rather than pretending the failed AI lost fairly. |
| Saving holds and separate study | Persist complete results before advancing. Sketch-focused research remains distinct from gameplay hints and AI handicaps. |

The 4 November individual-mode clarification supersedes the earlier team-default contract. Numeric scoring balance is still unvalidated and must be tuned through gameplay, not inferred from role names.

## Retained architecture diagram

- [Editable Excalidraw source](docs/get-the-picture-system-design.excalidraw).
- [PNG preview](docs/get_the_picture_system_design.png).

Edit the source in Excalidraw and export a new PNG when the sketch changes. The source and current preview are retained without changes in this cleanup. The detailed system-design rules and backend scoring plan above are authoritative; the retained sketches do not define the default mode or scoring lifecycle. See also the [dataset-export architecture copy](docs/get-the-picture-system-design-with-dataset-export.excalidraw).
