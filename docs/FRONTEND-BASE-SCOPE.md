# Base frontend scope and replacement plan

Current scope: the approved V10 flow and real Individual backend supersede the temporary canvas-shell boundaries below. This file preserves the earlier base design; use [the Individual milestone](BACKEND-IMPLEMENTATION-PLAN.md), [integration contract](FRONTEND-ROOM-INTEGRATION.md) and [validation report](FRONTEND-VALIDATION.md) for current behavior. Team gameplay and real inference remain separate later milestones.

Updated 4 November 2026, Asia/Manila, from the user's Lavish review.

## Purpose and approval gate

This is a temporary frontend for validating the drawing canvas and outgoing drawing-event batches. It is not the final application UI. The user approved the V2 HTML preview in Lavish on 4 November 2026 with "this all looks good" and ended the review session. The preview-approval prerequisite is satisfied. The base frontend is implemented in `apps/web`. Follow `docs/FRONTEND-IMPLEMENTATION-PLAN.md` for its design contract and `docs/FRONTEND-VALIDATION.md` for the completed checks.

## The UI is deliberately replaceable

**After the user confirms that the canvas works, replace or substantially revise this base UI through the user's UI/UX process.** This includes the login composition, character presentation, room shell, and placement of team, hint, chat, timer, score, and AI panels. They must not become a final-design commitment just because they were implemented first.

The team roster, prompt/hint examples, scores, timer state, AI/referee status, and room entry are local fixtures. Chat only appends local messages. Room codes do not create a shared multiplayer room yet.

Keep the drawing-library adapter, history, logical coordinates, and event batcher independent of these fixtures and screen layouts. Those functional pieces can survive a UI replacement. Do not implement a local game engine to make the fixtures look authoritative.

Keep this replacement guidance in documentation. Do not insert editorial TODOs, architecture notes, implementation explanations, or "will be replaced" banners into the product UI or canvas. Necessary test-build labeling can remain concise.

## Default-mode backend handoff - 4 November 2026

The default final game is **individual free-for-all, not team play**: one shared canvas, a rotating drawer, independently scoring human guessers and a shared AI guesser. The drawer and guessers are not teammates. Existing sample-team UI is a temporary fixture and must not become a backend default.

Before implementing scoring or live turn lifecycle, read [BACKEND-SCORING-PLAN.md](BACKEND-SCORING-PLAN.md) and [SYSTEM-DESIGN.md](../SYSTEM-DESIGN.md). A first human solve does not end the turn or cancel the remaining AI race; each guesser has their own before/after-AI result, while the drawer has human-recognition points and a smaller capped AI bonus. Team mode requires explicit selection if implemented.

This is a future backend/UI integration requirement. The approved canvas base remains a local fixture shell; this documentation update does not add a local scoring engine or change its code.

## Entry flow

The revised preview proposes two screens:

1. One playful login screen containing the character creator, name input, and create/join controls. There is no account login or backend authentication in this base.
2. The drawing room. Both room actions enter it immediately after validating the local name and any required room-code input.

Use `/` and `/room/?code=...` as fixed exportable routes. Preserve an incoming room code through the login screen. The earlier separate `/rooms/` screen is removed from this proposal.

## Character proposal

Use small original paint creatures built from three simple silhouettes (Pebble, Droplet, Spark), three expressions (Smile, Wink, Wow), and the eight supplied crayon colors. This gives 72 combinations before display names, without reproducing skribbl's character editor or artwork.

The player can change shape, face, and color, or randomize the combination. Names remain visible in roster/chat contexts, and shape plus expression distinguish players without relying only on color. This is a proposal for review, not a final avatar design system. No clothing editor, accessory inventory, generative character service, or backend is needed.

Remember the selected local profile as `{name, avatar: {shape, expression, color}}`. This identifier is aesthetic and is not multiplayer authorization.

## Motion

The login character preview and decorative wrappers use the separate `docs/design-system/LOGIN_MOTION.md` specification. Form controls stay static. Game-room avatars, the drawing surface, and all game controls stay static.

## Drawing and event requirements

- Brush color and size, pixel eraser, clicked-region fill, undo, redo, and clear.
- Give the drawing surface the largest central area; reduce surrounding header and panel space.
- Keep the visible timer label exactly `Time`; do not label it `Practice time`.
- Paint immediately; start nonempty outgoing-operation batches at a 33 ms target, with final flushes at stroke boundaries.
- Log the actual batch intervals, operation/point counts, serialized sizes, stable client IDs/sequences, reasons, and inspectable payloads through a console-only transport.
- Do not fabricate backend acceptance, canonical sequence, scoring, AI activity, or multiplayer synchronization.
- Atrament and its fill module remain a candidate subject to a production-build capability check. Core drawing and flood-fill algorithms must come from existing libraries.

## Base versus final-game persistence

For this base, including a hosted canvas-test build, a refresh may reset the drawing. Remember the local profile. Do not confuse publishing the test build with completing the final game.

For the final application, ordinary refreshes and reconnects must preserve the active drawing. Recovery around service restarts or deployments must be addressed during backend design and reconciled with the earlier system-design restart/void policy. Intentional Clear and round transitions remain explicit actions.

## Readiness to replace the shell

The user should first be able to draw, change tools, fill regions, undo and redo edits, resize without losing the current image, and inspect continuous console batches. Once those functions are validated, ask for the user's UI/UX direction and replace this temporary shell while retaining the validated canvas behavior.

> Historical base scope: the approved room-flow implementation and current integration contract supersede the temporary entry, console-only, and blank-refresh descriptions below. See [FRONTEND-ROOM-INTEGRATION.md](FRONTEND-ROOM-INTEGRATION.md).

