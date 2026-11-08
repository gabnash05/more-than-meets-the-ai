# More Than Meets the AI

A multiplayer drawing game for an intelligent-systems class project, with a future transformer AI competitor.

**Implemented Individual milestone (verified 7 November 2026):** real Individual remote play with a separate AI benchmark scorer/ledger and an unavailable provider boundary. Remote Team play is deferred to its own later plan. Real inference, referee serving, research exports and deployment remain separate work. The local browser adapter is a demo; the NestJS remote adapter provides real shared rooms. The AI behaviors described below are the intended later integration, not a claim that a model is connected.

**The default mode is individual free-for-all, not a team game.** One player draws on a shared canvas while every other player guesses for their own score and races the same AI guesser. The drawer and guessers are individual competitors, not teammates. Drawer duty rotates through the room's players; the highest finalized individual total wins.

Each human guesser can solve the prompt independently. A first correct human guess does not end the drawing turn: drawing, remaining human guesses and eligible AI attempts continue. The turn ends when all eligible human guessers have solved or the timer expires. An AI solve stops its own further guessing, while humans can still solve for points. Human and AI guessers receive the same official word-length and revealed-letter hints; AI answer text stays hidden until reveal/replay.

Current human-v1 scoring awards personal raw speed points and capped, normalized drawer recognition from human solves. Human AI modifiers stay zero while inference is unavailable. The separate ai-benchmark-v1 ledger prepares AI round points and a committed total with coverage: eligible no-solve is zero, unavailable is null/unscored, and AI points do not determine human winners or drawer recognition. Future before/after-AI tuning remains disabled and unvalidated. See [the backend scoring implementation plan](docs/BACKEND-SCORING-PLAN.md).

Any visual strategy is allowed; written answer clues are prohibited, while incidental writing on objects is allowed. A separate transformer referee flags suspected written clues. Flags are advisory, and players resolve disputes.

## Canvas frontend

The application is in [apps/web](apps/web). It retains the approved create/invite/join/lobby flow, drawing tools and browser-local demo adapter. Its remote adapter now connects to the [NestJS room backend](apps/api/README.md) for authenticated guest sessions, shared lobby/drawing state, private selection from three words, human scoring, round rotation and final standings. AI inference is unavailable in this milestone. Human scoring remains human-v1 with AI modifiers zero; the prepared AI benchmark records null/unscored unavailable outcomes and exposes committed total/coverage for later real results. Remote Team selection/settings/starts are unavailable; its existing code and shared-target/private-canvas design are retained for a separate plan.

See the [frontend run/build instructions](apps/web/README.md), [implementation plan](docs/FRONTEND-IMPLEMENTATION-PLAN.md), and [temporary UI scope](docs/FRONTEND-BASE-SCOPE.md). Build `apps/web` with `npm run build`; its `out/` directory can be served by a static host. No hosting provider has been configured by this implementation.

The separate follow-up scopes are [Team gameplay](docs/TEAM-GAMEPLAY-NEXT-PLAN.md) and [real AI inference](docs/AI-INTEGRATION-NEXT-PLAN.md). Current local verification is recorded in [the validation report](docs/FRONTEND-VALIDATION.md).

The results/chat correction adds ranked avatar cards, a clearer recap, green correct confirmations and chat following. Fresh matches use private selected-target history with a 348-word catalogue. See [the correction checks and testing notes](docs/FRONTEND-VALIDATION.md).

Deploy the web and room API with Compose in memory mode or with an external PostgreSQL database. The optional AI profile provides a pinned smoke-test Guesser and an independent Referee fixture. [Deployment runbook](deploy/README.md)

## Guesser data and evaluation

The agreed [models layout](models/README.md) separates Guesser data, training, inference, evaluation and checkpoints from Referee work. The [data package](models/guesser/data/README.md) uses Python 3.13 and uv: numbered stages download/clean/sample, prepare splits, optionally preview and export with one data audit. Timed image creation uses the shared foreground/edges preprocessors; no approvals or freeze step are required. See the [runbook](models/guesser/data/RUNBOOK.md).

The [evaluation workspace](models/guesser/evaluation/README.md) now contains the incoming Python 3.12/uv notebook scaffold. It has environment-check code, not an evaluator, inference service, trained checkpoint or accuracy result. Training/batching and serving remain their owners' next work. No full dataset download was run for this refactor.

## Game modes

**Individual is the default when a room or match has no explicit mode selection.** It uses one drawer, one shared canvas, individual solve records and an individual leaderboard. Do not implement it by grouping everyone into one team. The temporary frontend's sample team panels are fixtures, not the default gameplay contract.

Team play is deferred and unavailable in the current remote milestone. Its preserved optional-mode design requires explicit selection when the later plan enables it. The earlier agreed formats remain valid for that mode: `2v2`, `2v2v2`, `3v3`, `3v3v3`, `2v3`, and `3v2v4`. Team mode can retain parallel private canvases and a first-human-solve team result; those rules must not leak into individual mode.

## Recovery and availability

- NestJS accepts live events in memory and broadcasts them immediately; PostgreSQL archival runs asynchronously. A restart voids unfinished drawing turns and retries the same drawer/turn position with a fresh prompt while preserving committed prior results.
- In individual mode, connected players continue after another guesser disconnects. Accepted personal solves remain. If the drawer or every remaining unsolved guesser disconnects, pause for up to 30 seconds; on expiry close the turn with accepted human outcomes retained. Required connected players must return before the next turn.
- If a required AI attempt is unavailable because of a service fault, preserve human-only scoring and neutralize the affected turn's AI-derived bonuses and reductions for all players, including the drawer's AI bonus. Referee outages leave advisory flagging unavailable. Readiness-related missed checkpoints require an explicit individual-mode policy; do not reuse a team-wide bonus penalty by accident.
- Scores remain provisional until required records and results commit to PostgreSQL. Missed guesses, service failures and normal cancellations are distinct. A voided turn does not consume a drawing turn or advance rotation.

## Architecture

The implemented application stack is **Next.js**, a single **NestJS + Socket.IO** authority, and **PostgreSQL + Prisma** persistence. Live matches run in RAM with bounded background drawing archival; a committed watermark distinguishes saved strokes from an accepted live tail. A typed unavailable AI provider boundary leaves the future inference service/server and transport configurable in the later AI plan. Production deployment remains future work. No Redis or load balancer is needed for the selected single-process deployment. See [backend setup](apps/api/README.md), [the implementation milestone](docs/BACKEND-IMPLEMENTATION-PLAN.md), [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md), and the retained [architecture preview](docs/get_the_picture_system_design.png). Local integration checks do not establish production capacity or model performance.

## Research evaluation workspace

`models/guesser/evaluation/` is a uv-managed, cross-platform Python/Jupyter workspace for auditing held-out inputs, evaluating frozen model checkpoints, measuring inference latency, and preparing the live inference interface. The environment and smoke-check notebook are set up; the evaluator, inference service, trained weights, and performance results remain future work. See its [setup, usage, and notebook merge-conflict guide](models/guesser/evaluation/README.md).

## Project focus

The current primary research question is how well humans and a transformer-powered AI identify intended targets from sketches that use shared semantic and cultural visual references. Recognition speed as a sketch develops is secondary.

A separate sketch-focused comparison will examine recognition of the same incomplete drawings, independently of the party game's letter hints and AI guessing handicap. The party game retains those hints and handicaps. Private visual codes remain legal during gameplay but are excluded from the main research comparison.

Target correctness and reference interpretation are distinct outcomes. Detailed interpretation analysis, including collecting and scoring explanations of the visual cue and its connection to the target, is deferred to future work. The current class-project scope should keep player onboarding brief and avoid extensive player training.

The intended AI opponent is credible but beatable, with uncertain race outcomes. These are project aims; recognition performance and gameplay balance have not been validated. The original pitch also asks whether an AI competitor makes play more engaging; increased engagement is not an established result.

## Vocabulary

See [CONTEXT.md](CONTEXT.md) for the domain glossary.
