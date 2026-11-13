# Free Draw

Free Draw is a private solo workspace at `/free-draw/`. It reuses the drawing canvas and configured AI inference, while keeping multiplayer rooms, scoring and prompt privacy separate. Enter from the card below the homepage's room-code controls; no name, avatar or room code is required.

## Drawing and AI controls

The workspace has no rounds, countdown, score or attempt budget. Brush, eraser, fill, undo and redo use the existing canvas. The first visit starts in **No prompt** mode with Guesser and Referee enabled and Heatmap disabled.

**Choose a prompt** exposes the ready Guesser's 345 class labels in a searchable combobox. It does not use the multiplayer game's separate 348-word prompt pool. Typing filters options; only selecting a class commits it. **Random prompt** selects another supported class, enters prompt mode and retains the current drawing.

A top-one prediction solves the selected prompt only when its confidence is **strictly above 50%**. A 50% prediction and a matching runner-up do not solve it. Every top-one prediction, including low-confidence and repeated guesses, remains visible in chronological history until cleared or the visit ends. The history is tall, vertically resizable and expandable; it is not squeezed to fit the viewport. The history displays confidence and threshold status, plus correctness when a target exists. Its scrolling window keeps long sessions responsive without discarding entries.

| Control | Behavior |
| --- | --- |
| Clear history | Empties history without changing ink, prompt or solved state. |
| Restart Guesser | Clears history and solved state, enables guessing, and rechecks the current drawing. |
| Clear canvas | Clears ink, predictions, attention trail, Referee evidence and solved state; retains the prompt and toggle choices. |
| Change mode/prompt | Retains ink and toggle choices; resets the Guesser attempt. |
| Random prompt | Changes to another supported target and restarts the attempt while retaining ink and toggles. |

The Guesser, Referee and Heatmap toggles are independent. When Guesser is disabled or already solved, Heatmap can continue to obtain new attention maps without recording predictions or solving a target. The existing attention rollout is an approximate focus visualization, not an explanation of model reasoning. The overlay keeps a six-frame trail and four thumbnails in this unlimited workspace. Referee warnings remain advisory, following the multiplayer text threshold of 0.3 and remain visible until a later clear result, canvas clear, or Referee toggle off.

Changed revisions are coalesced at a 100 ms scheduling tick. Guesser/attention observations are admitted at most once every 500 ms per session, and Referee observations at most once every 1,000 ms. Each role has its own request and in-flight slot, so a slow Referee response does not delay a completed Guesser/heatmap result. Held strokes can be observed before pointer release. Successful unchanged drawings are not repeatedly analyzed. Busy responses retry quickly; provider faults back off independently up to ten seconds. No fake predictions or clean Referee verdicts stand in for unavailable AI. Drawing continues during outages.

## Fresh visits and shared game UI

Free Draw stores no drawings, prompts, toggles or prediction history. Every visit and refresh starts with a blank canvas, no prompt, empty history, Guesser and Referee on, and Heatmap off. Exiting disposes the inference session and cancels requests. Back-forward cache restoration restarts the page; legacy `mmtai-free-draw` IndexedDB drafts are deleted without touching multiplayer or player-profile storage.

The mode selector and searchable prompt picker occupy the top of the left sidebar beside the canvas (the multiplayer scoreboard position) on desktop. They appear above the canvas on mobile. The drawing toolbar and Referee warning are the same shared components used by multiplayer, including their labels, palette, custom color control, confidence badge and board glow.

## API and inference boundary

Free Draw uses independent ephemeral guest credentials, never multiplayer room authority or persistence.

| Endpoint | Input/output |
| --- | --- |
| `POST /api/free-draw/sessions` | Create an anonymous session; return its bearer token, session ID and capabilities. |
| `GET /api/free-draw/capabilities` | Bearer authentication; return role availability, current model class labels and minimum interval. |
| `POST /api/free-draw/infer` | Bearer authentication; raw `image/png` body and JSON `x-free-draw-observation` header. |
| `DELETE /api/free-draw/sessions/current` | Dispose the bearer session and cancel its work. |

The observation header carries `runId`, `revision`, `requestId` and requested `roles`. Results echo these fields and the session ID, with independent role outcomes. The server generates model-job identities and deadlines using the existing inference adapter and configured HTTP/Redis transport. The prompt and answer hints are never model inputs. Shared types live in `packages/game-contracts/src/free-draw.ts`.

Images must be canonical 1024x768 PNGs no larger than 4 MiB. The inference route has the corresponding scoped Nginx request-body limit. Admission permits one in-flight request for each role within a session, separate 500/1,000 ms per-role cooldowns, and two simultaneous Free Draw role jobs globally. Busy responses are retryable rather than queued indefinitely. Session admission is bounded and idle sessions expire. These limits are operational defaults, not measured capacity claims.

Lifecycle and role identities prevent late, duplicate or superseded outcomes from changing the current attempt. Changes to ink alone do not discard a valid in-flight observation. The client rejects results from old runs, reset attempts or disabled role epochs. The API cancels work on session disposal, premature response close and shutdown.

## Validation

Follow-up checks on 13 November 2026:

- Frontend typecheck, ESLint, production export and all 142 unit tests passed (17 files).
- API typecheck, ESLint, production build and 47 focused service, inference and game tests passed; two deferred Team cases were skipped.
- All 20 affected Chrome scenarios passed (19 initially, with the corrected toggle test passing on rerun). They cover fresh visits, shared controls, keyboard prompt search, independent model responses during a held stroke, stale results, confidence thresholds, tall history, mobile layout and final round review.

Browser AI responses are mocked; these checks establish UI and scheduling behavior rather than real-model latency or accuracy. The complete database integration and remote multiplayer suites were not rerun for this follow-up; CI runs the backend suite. No migration or model retraining is required.

## Multiplayer prediction privacy

Live multiplayer snapshots never include prediction text or runner-ups, even for the drawer or solved players. The live attention overlay has no prediction labels. Prediction history is revealed only in committed round results; the final match review opens on the last completed round and supports selecting earlier rounds. Revealed history grows in normal page flow with readable confidence, elapsed time and submission status instead of a short nested scroll pane.
