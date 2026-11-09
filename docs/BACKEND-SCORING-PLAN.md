# Backend scoring implementation plan

## Current milestone precedence — 6 November 2026

Complete Individual play first. Team implementation/acceptance is deferred to its own later plan. Human scoring is `human-v1` below; all human AI modifiers stay zero for this milestone. The older before/after-AI tuning sections describe later inference integration and do not enable those modifiers now.

The implementation adds a separate `ai-benchmark-v1` round result and committed match ledger. First eligible correct AI answers use the same raw speed formula as human solves. Eligible unsolved evaluations earn zero; unavailable/ineligible evaluations have null points. Total points stay null until at least one eligible round commits; scored/solved/completed prompt counts distinguish partial coverage. Void unfinished generations contribute nothing. AI scores never increase drawer recognition or enter human winner selection.

The production provider is unavailable. The versioned provider observation/result port is ready for a later AI service/server adapter; synthetic positive examples are labelled fixtures, not model results. The authority checks bound job identity, accepted time, generation/deadline and deduplication. Keep AI guesses hidden from unsolved humans until reveal. Exact inference scheduling, eligibility/readiness policy and hosting belong to the later AI plan.

## Correction decision — 7 November 2026

Keep `human-v1` unchanged while improving the recap's explanation and hierarchy. For a 60-second drawing, a valid solve at 10 seconds earns 88 points and one at 50 seconds earns 42, even when it is the first solve. Drawer recognition also falls as human solves become later. Green confirmations and ranking bars are presentation changes, not scoring changes. Time scoring encourages clear communication but does not eliminate deliberate point denial based on relative standings, especially in two-player rooms. No unverified skribbl scoring constants are introduced.

## Human scoring baseline - 6 November 2026

The backend implements an initial, unvalidated balance configuration `human-v1`. A first valid human solve earns `round(100 - 70 * clamp(elapsed / duration, 0, 1))` raw speed points. No solve earns zero. The drawer receives `round(60 * sum(raw human solve points) / (100 * eligible guesser count))`, or zero for an empty/no-solve roster. The denominator is frozen for the drawing turn. This avoids scaling the drawer's reward directly with room size or counting an AI answer as human recognition.

No live AI inference provider is connected. Guesser AI adjustments and drawer AI bonuses are therefore zero, and the UI explicitly reports AI unavailable. Earlier proposals for before/after-AI weights of 1.25/0.75 and a 15-point drawer AI cap remain disabled, unvalidated future tuning. The historical AI timing/readiness acceptance scenarios below remain future integration work.

Configured rounds mean total prompt positions. Drawers choose privately from three options before drawing begins. Defaults are a 15-second choice window, 60-second drawing clock and 8-second recap. Authoritative event order resolves accepted guesses; duplicate requests cannot create another solve. Equal final totals produce joint winners.

A missing drawer or all remaining unsolved guessers pauses the affected clock for up to 30 seconds. On expiry retain accepted human solves and close that turn/challenge; no missing person is counted as solved. A restart voids the unfinished generation and its provisional score while retaining committed prior results and the saved interrupted sketch. Required records commit before another prompt begins. The host can reopen the lobby from an interrupted or committed waiting state, preserving already committed records.

Remote Team selection/settings/starts are disabled in this milestone. The preserved shared-target/private-canvas Team design has its [own follow-up plan](TEAM-GAMEPLAY-NEXT-PLAN.md); real inference and any later human AI adjustments have a [separate integration plan](AI-INTEGRATION-NEXT-PLAN.md).

## Retained earlier AI tuning design

The following 4 November proposal preserves design history. Its unimplemented AI weights, readiness checkpoints and unresolved-policy notes do not override the current baseline above.

Confirmed direction: **4 November 2026, Asia/Manila**. This records the user's default-mode clarification and the agreed role-specific AI scoring direction. It is a backend implementation handoff, not an implemented scoring engine or a validated balance formula.

## Default mode is individual

**Use individual free-for-all when the room/match has no explicit mode selection.** One player draws on one shared canvas; all other eligible players guess for their own scores. The drawer and human guessers are individual competitors, not teammates. Do not put everyone in one implicit team or reuse a first-solve team score for this mode. Highest finalized individual total wins.

Drawer duty rotates through the room's players. Each drawing turn has its own target, deadline, identity and generation. Match length and the UI's round/turn-count convention need an explicit contract before implementation; a correct guess alone never advances the drawer.

Earlier flexible-team formats remain a separate optional mode requiring explicit selection. Their private parallel canvases, first-human-solve challenge closure and shared team totals apply only there. Implementing team mode is not a prerequisite to the individual backend.

## Earlier proposed role adjustments — future integration

| Role | Ordinary reward | Effect of the AI |
| --- | --- | --- |
| Each human guesser | Personal speed-based points for their first accepted correct answer in the turn | Stronger before/after-AI adjustment to that person's turn earnings: higher before the AI, lower afterward |
| Drawer | Personal recognition points based on humans correctly identifying the drawing | Smaller, capped bonus reflecting how many eligible humans beat the AI; normalize for eligible guesser count |
| AI guesser | Separate raw-speed benchmark points, committed total and scoring coverage when eligible | Its correct answer never counts as a human solve, drawer recognition or human winner |

Keep the ordinary drawer reward based on human communication. Do not reward an unreadable/blank drawing just because neither humans nor AI solved it. At least one valid human solve is required for a positive drawer AI bonus.

The AI's direct effect should be more noticeable for a guesser's own before/after result than for the drawer's evasion bonus. This is a tuning goal, not an assertion that a fixed deduction across roles is fair. There is no universal penalty applied to all players when the AI solves. A correct human solve after the AI still earns positive turn points; failure to solve earns zero solve points. Reduce current-turn earnings rather than subtracting previously earned scores.

Suggested formula structure, with numeric settings deliberately unspecified:

```text
humanBase[player] = configured speed reward for that player's solve

if player did not solve:
    guesserTurnScore[player] = 0
else if AI scoring is ineligible for this turn:
    guesserTurnScore[player] = humanBase[player]
else:
    guesserTurnScore[player] = humanBase[player]
                               * configured beforeAI / afterAI weight

drawerBase = configured, capped/normalized human-recognition reward
             computed from raw human solve data, excluding AI adjustments

drawerAIBonus = smaller capped reward for eligible humans beating the AI
               (zero if no human solved or AI scoring is ineligible)

drawerTurnScore = drawerBase + drawerAIBonus
```

The before-AI weight must exceed the after-AI weight; the after-AI weight stays positive. Numeric values, rounding, maximum role rewards and drawer normalization are open tuning decisions. Compute drawer base from raw human outcomes so a guesser's AI reduction is not accidentally applied to the drawer a second time. Do not derive drawer bonus only from a solved-player denominator that rewards getting one favored player to solve while everyone else fails; use an explicit eligible-roster basis and specify disconnect/late-join handling.

## Turn lifecycle and accepted order

1. Start with one drawer and an explicit eligible human-guesser roster. The drawer knows the answer and cannot score a human guess on their own drawing.
2. Humans can keep trying incorrect answers without an AI-style guess cap. Mark each player's first correct accepted attempt once; stop only that player's further scoring attempts.
3. **A first correct human guess does not end the drawing turn, freeze the canvas or cancel AI checkpoints.** Remaining humans need their own opportunity to solve and race the AI.
4. Route human guesses, AI results and turn closure through the same authoritative serialized NestJS engine. Before/after status uses accepted event order. Record times for speed/replay, but do not backdate an AI win to GPU start/finish time or compare unsynchronized client clocks.
5. The first accepted correct AI answer establishes one shared AI marker. Stop its further guesser jobs; remaining humans continue. An earlier human solve stays before-AI permanently. Keep actual AI answer text hidden from unsolved humans.
6. If the AI never solves before normal turn closure, valid human solves precede any AI solve. Ordinary incorrect AI attempts and normal cancellation at actual closure are not service faults. Required AI work that failed cannot be treated as a fair AI loss.
7. End when all eligible human guessers have solved or the deadline expires. Resolve disconnected/unresolved-player closure through an explicit policy; do not silently count missing players as solved. After closure reveal/replay, persist/finalize once and then rotate the drawer.

Continue AI attempts only while a fair active-unsolved-human race remains. A solved person is outside later observation barriers. At checkpoints freeze canvas/hint versions and require all currently active unsolved guessers to acknowledge them before releasing the image. A missing acknowledgement is not permission to pretend the person disconnected.

Same-time/tie treatment needs an explicit scoring rule before coding. Do not silently use network or GPU timestamps as an unfair tie breaker.

## State and persistence needed by the backend

Suggested concepts/field names below are a contract outline, not a fixed database schema:

- Explicit mode, turn/canvas ID, generation, drawer ID, eligible guesser roster and stable player identities; no required synthetic team ID in individual mode.
- Ordered first-correct human event for each player, base points, role and before/after-AI classification.
- Shared first-correct accepted AI event; checkpoint reservations, outcomes, frozen input hashes/versions, deadlines and model/config revision.
- Separate score components: human-only base, personal AI adjustment, drawer base and drawer AI bonus. Track eligibility/reason so a service-fault fallback can be applied consistently.
- Turn-scoped scoring configuration/version, fixed before play. Retain roster/denominator choices for a reproducible drawer calculation.
- Provisional results in RAM and committed personal results in PostgreSQL. Deduplicate by player/role/turn/generation; replayed attempts, reconnects or repeated finalization never add a second score.

Clients send guesses and drawing actions; they cannot submit authoritative scores. NestJS owns correctness, event ordering and points. FastAPI returns guesses/flags, not score decisions, and does not receive the secret answer as model input.

## Failure boundaries

- A required AI-service failure neutralizes all AI-derived guesser bonuses **and reductions**, plus drawer AI bonuses, for that default turn. Preserve ordinary human and drawer recognition points. Keep AI adjustments provisional until finalization to make this consistent for all players.
- A normally ended race is not an outage: all humans solved, AI solved, timeout, void or a valid cancellation must not fabricate an unavailable attempt.
- Preserve an already accepted personal solve across disconnects. Other humans continue; do not apply a team-wide penalty or reopen a solved player on reconnect.
- Client-readiness misses, no-active-guesser grace, unresolved disconnected players and late joiners need explicit individual-mode eligibility/closure policies before score implementation. Old team-only bonus-removal/forfeit rules do not supply these decisions.
- A game restart/unverifiable turn voids that turn's provisional outcomes and retries the same drawer/position with a fresh target/generation. Preserve prior committed personal results; reject old-generation jobs.
- Commit required records and personal results before advancing. A PostgreSQL saving hold keeps results provisional. Referee flags remain advisory and never directly deduct scores.

## Earlier inference acceptance scenarios — future integration

These are future executable verification cases, not claims that backend tests already exist.

| Scenario | Required observable outcome |
| --- | --- |
| Create/start without a selected mode | Individual mode, one shared canvas, per-player results; no synthesized all-human team |
| Alex solves at 12 s, AI at 20 s, Bea at 28 s, Carlo never solves | Alex retains before-AI credit; Bea earns reduced but positive solve points; Carlo earns zero solve points; drawer earns ordinary credit from two human solves and a smaller capped bonus for Alex beating the AI |
| First human solves while others remain | Canvas/hints continue and remaining eligible AI checkpoints are not cancelled |
| AI solves before any human | Humans keep guessing for individual points; no ordinary drawer credit arises from the AI answer alone |
| AI answers after Alex already solved | Alex's classification remains before-AI; nobody's earlier solve becomes a loss |
| Nobody recognizes a blank/unreadable drawing | Zero human solve points and no positive drawer evasion bonus |
| Duplicate correct guess, retry or reconnect | The player still has exactly one solve/result for that turn |
| AI returns a result from an older generation or after turn close | Result is rejected for competitive scoring |
| Required AI service fails after some provisional solves | All AI bonuses/reductions are neutralized consistently; human-only scoring remains |
| Incorrect AI guess or valid cancellation after actual race closure | No fabricated outage and no extra AI attempt/score |
| Finalization runs twice or restarts after commit | Totals include each committed personal result only once |
| Solved human or AI produces answer text | Unsolved humans do not receive the secret through chat/status payloads |
| Explicit optional team mode selected later | Its separate team policy runs; neither mode silently uses the other's scoring/termination rules |

Before enabling the future AI weights, tune the relative rewards through actual mixed-ability gameplay. The numeric scores used in discussion were illustrations and are not finalized constants. Backend implementation and changes to the temporary frontend fixture UI remain separate tasks.
