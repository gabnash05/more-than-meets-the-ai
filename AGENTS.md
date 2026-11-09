# AGENTS.md

## Project

More Than Meets the AI is a CSC173 multiplayer drawing game where humans race a transformer AI to recognize sketches. Research focuses on recognition through shared semantic and cultural visual references.

- `apps/web/`: approved Next.js/TypeScript room/game UI; local demo by default, prepared remote mode now connects to the real room backend. AI fixtures remain confined to review/local demo.
- `models/guesser/evaluation/`: uv-managed Python/Jupyter evaluation environment; model metrics and serving remain future work.
- `apps/api/`: NestJS + Socket.IO room/game authority with PostgreSQL/Prisma. One process holds live matches in memory; no Redis or load balancer. AI/FastAPI integration remains future work. Shared TypeScript contracts live in `packages/game-contracts/src/`.

## Current Individual milestone — 6 November 2026

The accepted Individual-first implementation plan supersedes older Team-completion and AI-marker-only notes. Continue the existing uncommitted draft; preserve unrelated work, the V10 UI and corrected invitation modal.

The Individual milestone is implemented and locally verified as of 7 November. See `docs/BACKEND-VALIDATION.md` and `docs/FRONTEND-VALIDATION.md` for actual checks and limits; Team and inference follow-up scopes are separate documents. Preserve the current implementation rather than restarting it.

- Complete and verify Individual play end to end. Remote Team settings/starts are unavailable; retain Team code/types and explicitly deferred tests for a later plan.
- Prepare the separate `ai-benchmark-v1` round scorer, committed match total and coverage. An eligible unsolved evaluation is zero; unavailable/ineligible is unscored (`null`). The real provider remains unavailable. Positive AI examples are labelled test/review/local-demo fixtures.
- Human AI modifiers stay zero. AI points are a comparison ledger; human totals determine human winners. Never count an AI answer toward drawer recognition.
- Preserve the existing RoomClient, authenticated transport, ordered drawing outbox, contiguous durable watermark, saving holds and interrupted-prefix recovery. Restart retries the same drawer/position with a new generation and fresh choices.
- Use the coordinator plus up to three `gpt-6.1-terra` workers with `fork_turns: "none"`, disjoint ownership and no nested delegation. The coordinator owns documentation and final integrated checks.
- Do not reopen the ended Lavish review or commit, push, deploy, train models or claim measured capacity/model performance without separate authorization.

## Results/chat/prompt correction rules — 7 November 2026

Keep `human-v1` unchanged. Use the existing authoritative result/message fields for the redesigned recap, standings and green correct confirmations. Preserve answer privacy, canvas recovery and the corrected invitation layout. Chat follows new message IDs, including at its history cap, without moving page/focus.

The private optional `selectedPrompts` field is initialized for new matches and excludes chosen targets across prompt positions/retries, including interrupted targets. Missing legacy history must not be fabricated or silently treated as a tracked fresh match. Preserve the 348-word API-owned catalogue and keep model files/runtime separate. Exhaustion permits host return only from interrupted/committed states, never an active uncommitted drawing.

## Read first

- `README.md`, `CONTEXT.md`, `SYSTEM-DESIGN.md`: overview, vocabulary, and current rules.
- `docs/BACKEND-SCORING-PLAN.md`: required before scoring or turn-lifecycle changes. Also read `docs/BACKEND-IMPLEMENTATION-PLAN.md`, `docs/FRONTEND-ROOM-INTEGRATION.md`, and `apps/api/README.md` for the implemented transport, persistence and agreed team selection rule.
- `docs/FRONTEND-BASE-SCOPE.md` and `docs/FRONTEND-IMPLEMENTATION-PLAN.md`: frontend scope and design. Reuse existing drawing libraries and assets in `docs/design-system/`.

## Working rules

- Default to individual free-for-all: one rotating drawer, one shared canvas, and personal solves/scores. A first human solve does not end the turn. Team mode requires explicit selection.
- Keep secret targets and accepted correct answers hidden from unsolved guessers until reveal. Referee flags are advisory; incidental writing on depicted objects is allowed.
- Decide routine implementation details independently. Ask the user about unresolved gameplay or architecture choices before implementing them.
- Explain key reasoning clearly, update affected docs when behavior changes, and distinguish fixtures, planned features, implemented behavior, and verified results.

## Code style

- Python: follow PEP 8, use Ruff for style and Pyright for types, four-space indentation, descriptive snake_case names, explicit imports and one statement per line. Type public interfaces; keep docstrings short.
- TypeScript/React: follow the existing ESLint rules, use specific types and descriptive names, and keep components/functions focused.
- PowerShell: use full cmdlet names, named arguments and readable blocks. JSON uses two-space indentation and a final newline.
- Prefer direct code and existing libraries. Extract helpers for repeated behavior; avoid speculative abstractions, redundant state and defensive checks without a concrete requirement.

## Development and validation

Use Node.js 24 and npm. Run frontend commands from `apps/web/`:

```sh
npm ci
npm run dev
```

For frontend code changes, run the relevant checks: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Use `npm run test:e2e` for affected browser flows; it requires a production build and installed Google Chrome. Report what ran and any validation limits.

Backend commands run from `apps/api`: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Generate Prisma and migrate the configured database first. PostgreSQL integration tests use the explicitly guarded isolated test database described in `apps/api/README.md`; never point destructive test setup at another database. The remote browser suite is `npx playwright test --config playwright.multiplayer.config.ts` from `apps/web`, with a remote production export and a running API.

## Guesser deep learning libraries

For Guesser model work, follow [models/guesser/AGENTS.md](models/guesser/AGENTS.md) and [the library map](models/guesser/LIBRARIES.md). Reuse existing library implementations for standard deep learning operations; custom code should connect them to project-specific data and game rules. Keep the CPU-only data package separate from the model/GPU environment, and manage both with uv.

Use `uv sync --project models/guesser/evaluation --locked` for the separate Python 3.12 notebook environment. Keep its lock and notebook/source workflow; do not install model extras or execute notebooks during directory-only changes.
