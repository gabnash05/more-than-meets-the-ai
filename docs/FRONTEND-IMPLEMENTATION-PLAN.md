# Approved base frontend implementation plan

Current scope: the approved V10 flow and real Individual backend supersede the temporary canvas-shell boundaries below. This file preserves the earlier base design; use [the Individual milestone](BACKEND-IMPLEMENTATION-PLAN.md), [integration contract](FRONTEND-ROOM-INTEGRATION.md) and [validation report](FRONTEND-VALIDATION.md) for current behavior. Team gameplay and real inference remain separate later milestones.

Approved 4 November 2026, Asia/Manila, through the V2 Lavish review. The user's final feedback was "this all looks good" and they ended the review session. The preview-approval prerequisite is satisfied. The base frontend is now implemented in `apps/web`; see [FRONTEND-VALIDATION.md](FRONTEND-VALIDATION.md) for the verified result.

Execution plan updated 4 November 2026: use one coordinator and three parallel implementation workers. At the user's request, all three bulk-work agents use `gpt-6.1-terra`, including their subsequent verification assignments. The coordinator retains its current model.

## Purpose

Build a fast, locally functional drawing canvas inside a temporary game interface for **More Than Meets the AI**. Use the supplied Lemon Crayon design system and existing paintbrush icon. Make a portable frontend that can be hosted for testing while the backend is developed separately.

Read these together:

- `docs/FRONTEND-BASE-SCOPE.md`: temporary UI, replacement after canvas validation, and base-versus-final persistence.
- `docs/design-system/DESIGN.md`, `tokens.css`, `tokens.json`, `index.html`, and `LOGO.md`: visual foundations and existing assets.
- `docs/design-system/LOGIN_MOTION.md`: motion limited to the login character and decorative wrappers.
- `SYSTEM-DESIGN.md`: imperative browser rendering, operation batching, canonical server ownership, and later multiplayer boundaries.

The V2 HTML preview is retained in the originating chat's visualization folder as `canvas-plan/preview.html`, with `preview-portable.html` as a standalone copy. The HTML is a review artifact, not application source.

## Default-mode backend handoff - 4 November 2026

The default final game is **individual free-for-all, not team play**: one shared canvas, a rotating drawer, independently scoring human guessers and a shared AI guesser. The drawer and guessers are not teammates. Existing sample-team UI is a temporary fixture and must not become a backend default.

Before implementing scoring or live turn lifecycle, read [BACKEND-SCORING-PLAN.md](BACKEND-SCORING-PLAN.md) and [SYSTEM-DESIGN.md](../SYSTEM-DESIGN.md). A first human solve does not end the turn or cancel the remaining AI race; each guesser has their own before/after-AI result, while the drawer has human-recognition points and a smaller capped AI bonus. Team mode requires explicit selection if implemented.

This is a future backend/UI integration requirement. The approved canvas base remains a local fixture shell; this documentation update does not add a local scoring engine or change its code.

## Confirmed scope

- No backend, database, real room lookup, accounts, AI, referee, scoring engine, timed rounds, or multiplayer synchronization in this phase.
- Fixed sample teams and official hints, a sample drawer prompt, placeholder scores/timer/AI status, and locally appended chat messages surround the working canvas. These legacy sample teams are fixtures; the default final game is individual.
- Any nonempty trimmed room code can enter the local room template. Creating a room generates a local code. Both flows make the current user the drawer for testing.
- Remember the local player profile. A refreshed canvas-test build may start with a blank drawing, including when hosted.
- The final game must preserve an active drawing through ordinary refreshes and reconnects. Durable restart/deployment recovery and the older restart/void policy require later backend planning.
- After the user confirms that the canvas works, replace or substantially revise the temporary UI through their UI/UX process. Keep that instruction in documentation, outside the product interface.

## Two screens

### 1. Combined login and room entry: `/`

One playful screen contains the name, character creator, and create/join controls. "Login" here means local guest entry, not account authentication.

- Trim and validate a display name of 1–24 characters.
- Proposed original characters combine three silhouettes (Pebble, Droplet, Spark), three expressions (Smile, Wink, Wow), and eight design-system colors: 72 combinations before names.
- Allow each character attribute to be changed and provide whole-character randomization. Keep names visible in roster and chat contexts. Distinguish players through silhouette and expression as well as color.
- Store the profile as `{name, avatar: {shape, expression, color}}`; it is aesthetic information, not authorization.
- Create enters a generated local room; Join requires a nonempty code. Do not validate room existence yet.
- Preserve an incoming room code through guest entry.
- Apply `LOGIN_MOTION.md` to character/decorative wrappers only. Form controls remain static. Respect reduced-motion preferences.

### 2. Drawing room: `/room/?code=...`

- Give the central drawing surface the most space. Keep its tools visible with the canvas on laptop screens.
- Show the current player and local room code/copy action, a drawer prompt and hint example, sample team rosters, local chat, and an AI placeholder.
- Use the plain timer label **Time**, with a static `--:--` value until a backend clock exists.
- Keep all game-room avatars, panels, and canvas controls static; login bobbing does not extend into this screen.
- Existing team/private-canvas presentation is a fixture for the separately selectable team mode. Default individual integration uses one shared canvas and personal standings; do not infer mode from the sample panels.
- On phones, place the canvas/tools first, followed by teams and chat. Preserve the drawing area's aspect ratio.

## Technology and organization

Planned application location: `apps/web` in the game repository, separate from the academic activities repository.

- Next.js App Router and TypeScript, with client components for interactivity.
- Use npm and retain a dependency lockfile. The coordinator owns dependency and build-configuration changes.
- Existing CSS variables, bundled Fredoka/Nunito fonts, and the retained icon. Avoid substituting framework-default visual styling.
- A standalone frontend package is sufficient; no additional monorepo orchestration is needed for this slice.
- Fixed routes with `output: 'export'`; the query-string room code avoids arbitrary dynamic routes that would need static generation.
- Use Next.js's webpack build option for worker bundling. Only the coordinator runs whole-application builds at stable checkpoints.
- Keep profile/room shell state in normal React state. Keep high-frequency drawing and pending points in an imperative adapter and refs.
- Isolate the canvas adapter, history, event types/batcher, and `sendDrawingBatch(batch)` from the replaceable screen layouts and sample data.
- No Next.js API routes, Server Actions, Socket.IO connection, or infrastructure provisioning in this phase.

## Canvas library capability check

Use **Atrament 5.1.0 for brush/eraser rendering** and **q-floodfill 1.3.1 inside a Web Worker for region fill**, as specified in the subsequent parallel implementation plan. Keep fill coordinates and asynchronous completion under the canvas adapter's control. Both core algorithms come from existing libraries; Atrament does not provide a ready-made undo stack.

Before building the styled canvas, Agent B verifies this integration in a Next.js production build coordinated by the lead:

1. Browser-only import and correct fill-worker packaging.
2. Brush, eraser, tap/dot behavior, and touch input.
3. Correct fill location on scaled/high-DPI surfaces and on touch without a previous pointer move.
4. Live segment capture while a stroke remains held down.
5. Fill completion ordering with later strokes, undo, and clear.
6. Reliable capture/restoration for the history strategy.

Source inspection makes the scaling, fill-position, and asynchronous-completion checks material. The production integration and browser capability checks passed on installed Google Chrome; see the validation report for coverage. Fix adapter and packaging failures before continuing the styled canvas. Do not implement a replacement drawing or flood-fill engine.

Primary sources: [Atrament documentation](https://github.com/jakubfiala/atrament#readme), [inspected source](https://github.com/jakubfiala/atrament/blob/v5.1.0/src/index.js), [q-floodfill documentation](https://github.com/pavelkukov/q-floodfill#readme), [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports).

## Canvas behavior

- Start with a fixed 1024 × 768 logical drawing space (4:3), scaled to available space. Keep brush size and coordinates consistent through resizing.
- Provide brush size, the supplied palette plus a custom color input, pixel eraser, clicked-region bucket fill, undo, redo, and Clear.
- One completed stroke, erase stroke, fill, or clear is one history action.
- Use bounded bitmap history captured at action boundaries, not per pointer sample. Start with up to 20 retained actions and a 64 MiB bitmap budget. Disable Undo/Redo at their boundaries; a new action after Undo removes the redo branch.
- Serialize asynchronous fill completion with subsequent canvas edits. Capture the completed image, not an intermediate fill state.
- Finish or cancel strokes cleanly on pointer cancellation, release outside the canvas, tab hiding, and tool changes.
- Resize or restore without losing the current image and without emitting duplicate input operations. History restoration must be separate from input capture.
- Drawing should suppress page scrolling only on the drawing surface. Keyboard shortcuts must not intercept typing in text fields.

## Drawing events and console batching

Paint immediately through the library. A separate queue batches newly captured operation data; local ink never waits for the batch timer.

- Start at a **33 ms target** for nonempty interval batches, roughly 30 per second during a continuous stroke. Browser scheduling can delay them; boundary flushes can add batches.
- Flush the final points and stroke end immediately on release. Do not emit empty heartbeat batches.
- Use stable client operation/batch/stroke IDs and monotonically increasing client sequence numbers.
- Capture tool settings, logical coordinates, and relative timing. Send only newly added segments, not the entire accumulated stroke on every flush.
- Flush pending stroke data before ordered fill, history, or clear commands. Proposed names are `stroke.start`, `stroke.append`, `stroke.end`, `fill`, `history.undo`, `history.redo`, and `canvas.clear`.
- `sendDrawingBatch(batch)` writes an inspectable console log in this phase. It is the future Socket.IO integration seam and performs no network requests now.
- Log the batch ID, client sequence range, flush reason, target and actual interval, operation count, point count, serialized byte count, and payload.
- Do not fabricate server acknowledgements, canonical versions, delivery guarantees, or network latency. NestJS owns acceptance and canonical sequence later.
- Compare sustained drawing with logging enabled and disabled. Console instrumentation can affect timing; report measured behavior rather than claiming latency or bandwidth from the preview.

## Shared interfaces before delegation

The coordinator defines these contracts before the workers implement their features:

- `PlayerProfile`: `{name, avatar: {shape, expression, color}}`.
- `DrawingSettings`: selected brush/eraser/fill tool, color, and size; the approved size range is 2-40 with a default of 12.
- `DrawingCanvas`: settings, operation callback, availability/status updates, and commands for `undo`, `redo`, and `clear`. Keep library-specific objects inside Agent B's adapter.
- `CanvasOperation`: the stroke, fill, history, and clear variants listed above, with stable operation/action identities, logical coordinates, timing, and applicable tool settings. History commands identify their target action.
- `createDrawingBatcher`: `enqueue`, `flush`, and `dispose`, plus the console-only `sendDrawingBatch(batch)` transport. Agent B supplies operation/action IDs; Agent C assigns client sequence numbers and batch IDs. Disposal clears timers and flushes remaining operations once.

## Agent models and ownership

Use four concurrent roles: the coordinator and three workers created through `spawn_agent`. Start implementation workers explicitly on `gpt-6.1-terra`; do not let bulk-work agents inherit the coordinator's model accidentally. Keep the same model when reusing them for verification.

| Role | Model | Primary ownership | Required handoff |
| --- | --- | --- | --- |
| Coordinator | Current coordinator model; no override | Scaffold, dependencies/lockfile, shared contracts, routes, global design assets, room layout, toolbar integration, shared test/build configuration | Integrated application, static export, final verification report |
| Agent A: player experience | `gpt-6.1-terra` | Login, character renderer/editor, profile storage, login-only motion | Working entry flow, reusable static avatar component, focused checks |
| Agent B: canvas | `gpt-6.1-terra` | Drawing-library adapter, pointer handling, fill worker, resizing, bitmap history | Canvas implementing the frozen controls/callbacks, focused checks |
| Agent C: drawing events | `gpt-6.1-terra` | Operation batching, console transport, telemetry, batching tests | Tested batcher matching the shared operation contract |

Use `fork_turns: "none"` whenever specifying the worker model. Give each worker a focused brief containing the goal, owned modules, exact approved documentation pointers, relevant shared interfaces, acceptance checks, and the ownership rules. Do not duplicate the full conversation in worker prompts.

Example worker launch during implementation:

```js
spawn_agent({
  task_name: "player_experience",
  model: "gpt-6.1-terra",
  fork_turns: "none",
  message: scopedPlayerExperienceBrief
});
```

Use the same model and context pattern for `canvas` and `drawing_events`. Implementation used this launch pattern for three Terra workers; the coordinator integrated the result and ran the final checks.

Only the coordinator edits shared contracts, dependencies, route wrappers, global styles, and shared test/build configuration. Workers own separate feature modules and local styles. Send shared-interface changes to the coordinator before applying them. Preserve unrelated existing changes in the game checkout.

Keep handoffs concise: changed areas, exported interfaces, checks performed, and concrete remaining defects. Reuse finished Terra workers for focused integration checks and peer review. The coordinator handles cross-module decisions, integration, and final verification.

## Parallel build sequence

### Stage 1: establish the shared foundation

The coordinator sets up `apps/web`, the two routes, static export, design tokens, local fonts/icon, test commands, and shared interfaces. Publish the interfaces and module ownership before assigning implementation work.

### Stage 2: four workstreams concurrently

- Agent A builds the complete character/name/create-or-join entry flow and profile storage.
- Agent B begins with the canvas production-build capability check, then implements tools, logical coordinates, resizing, and bounded history.
- Agent C builds and tests batching against representative operations without waiting for Agent B's canvas.
- The coordinator builds the room layout, sample panels, toolbar, and routing against the shared interfaces, then integrates completed features as they arrive.

Workers run focused checks independently. Coordinate stable checkpoints for whole-application builds; do not run competing builds against the same output directory.

### Stage 3: reuse Terra workers for verification

- Agent A verifies responsive layouts, accessibility, profile handling, and login motion.
- Agent B independently reviews event ordering and batching against actual canvas behavior.
- Agent C independently checks canvas/history integration and console output.
- The coordinator resolves integration findings and runs the complete production checks.

Peer reviews are read-only; fixes return to the owning agent. Reassign workers as features finish so verification proceeds alongside remaining implementation. Retain the four-role concurrency limit instead of creating additional nested workers.

## Acceptance checks

- Both create and join carry the full character/profile into a room; direct room links retain their code through entry.
- Brush/color/size, eraser, bounded-region fill, clear, and undo/redo work in order. Include fill/clear restoration and a new edit after Undo.
- Mouse, touch, dots, cancelled strokes, and resize/orientation changes preserve sensible state and input mapping.
- Logs arrive while drawing, contain final points at release, and remain silent while idle. Restoration/resizing do not duplicate outgoing operations.
- Local chat treats input as text and does not trigger guesses or scoring.
- Login-only motion uses distinct durations/phases; reduced motion stops it. Game-room characters and controls remain static.
- Compare responsive layouts at 360×800, 390×844, 430×932, 600×960, 820×1180, 1024×768, 1366×768, 1440×900, and 1920×1080. Check no horizontal overflow and usable controls.
- Use meaningful unit checks for batch/history ordering and browser checks for actual entry/drawing journeys. Type checking, lint, and the static production build must pass.
- Serve the exported output locally and check fixed-route/deep-link behavior, fonts, and the fill worker.

## Still outside this implementation

Backend room ownership, authorization, actual player membership, synchronized hints/clock, game scoring, guesses, AI/referee behavior, canonical rendering/reconciliation, final drawing persistence, replay/export screens, hosting-provider setup, and the user's final UI/UX pass remain separate work.

> Historical base implementation: the approved room-flow implementation supersedes the temporary entry, console-only, and blank-refresh descriptions below. See [FRONTEND-ROOM-INTEGRATION.md](FRONTEND-ROOM-INTEGRATION.md).

