# Free Draw

Free Draw is a private solo workspace at `/free-draw/`. It reuses the drawing canvas and configured AI inference, while keeping multiplayer rooms, scoring and prompt privacy separate. Enter from the card below the homepage's room-code controls; no name, avatar or room code is required.

## Drawing and AI controls

The workspace has no rounds, countdown, score or attempt budget. Brush, eraser, fill, undo and redo use the existing canvas. The first visit starts in **No prompt** mode with Guesser and Referee enabled and Heatmap disabled.

**Choose a prompt** exposes the ready Guesser's 345 class labels in a searchable combobox. It does not use the multiplayer game's separate 348-word prompt pool. Typing filters options; only selecting a class commits it. **Random prompt** selects another supported class, enters prompt mode and retains the current drawing.

A top-one prediction solves the selected prompt only when its confidence is **strictly above 50%**. A 50% prediction and a matching runner-up do not solve it. Every top-one prediction, including low-confidence and repeated guesses, remains visible in chronological history until cleared or the visit ends. The history displays confidence and threshold status, plus correctness when a target exists. Its scrolling window keeps long sessions responsive without discarding entries.

| Control | Behavior |
| --- | --- |
| Clear history | Empties history without changing ink, prompt or solved state. |
| Restart Guesser | Clears history and solved state, enables guessing, and rechecks the current drawing. |
| Clear canvas | Clears ink, predictions, attention trail, Referee evidence and solved state; retains the prompt and toggle choices. |
| Change mode/prompt | Retains ink and toggle choices; resets the Guesser attempt. |
| Random prompt | Changes to another supported target and restarts the attempt while retaining ink and toggles. |

The Guesser, Referee and Heatmap toggles are independent. When Guesser is disabled or already solved, Heatmap can continue to obtain new attention maps without recording predictions or solving a target. The existing attention rollout is an approximate focus visualization, not an explanation of model reasoning. The overlay keeps a six-frame trail and four thumbnails in this unlimited workspace. Referee warnings remain advisory, following the multiplayer text threshold of 0.3 and short warning expiry.

Only changed drawing revisions are analyzed, at most once every three seconds. Changes during inference coalesce into the next observation. Successful unchanged drawings are not repeatedly analyzed. Failed features retry with exponential backoff from three to thirty seconds; another role's failure must not duplicate successful predictions. No fake predictions or clean Referee verdicts stand in for unavailable AI. Drawing continues during outages.

## Browser-local recovery

A settled canonical bitmap, mode, prompt, drawing settings and toggle preferences are saved locally. Refresh restores the draft with an empty prediction history, reset solved state and Guesser paused. Undo history does not survive reload. A storage failure leaves drawing available and shows a save-failure message.

Inference pauses in hidden tabs and cancels on exit. Returning resumes eligible features. Clear canvas and undo manipulate ink, while old predictions and solved state are never restored by undo.

## API and inference boundary

Free Draw uses independent ephemeral guest credentials, never multiplayer room authority or persistence.

| Endpoint | Input/output |
| --- | --- |
| `POST /api/free-draw/sessions` | Create an anonymous session; return its bearer token, session ID and capabilities. |
| `GET /api/free-draw/capabilities` | Bearer authentication; return role availability, current model class labels and minimum interval. |
| `POST /api/free-draw/infer` | Bearer authentication; raw `image/png` body and JSON `x-free-draw-observation` header. |
| `DELETE /api/free-draw/sessions/current` | Dispose the bearer session and cancel its work. |

The observation header carries `runId`, `revision`, `requestId` and requested `roles`. Results echo these fields and the session ID, with independent role outcomes. The server generates model-job identities and deadlines using the existing inference adapter and configured HTTP/Redis transport. The prompt and answer hints are never model inputs. Shared types live in `packages/game-contracts/src/free-draw.ts`.

Images must be canonical 1024x768 PNGs no larger than 4 MiB. The inference route has the corresponding scoped Nginx request-body limit. Admission allows one observation per session, a minimum three seconds between accepted observations, and two simultaneous Free Draw role jobs globally. Busy responses are retryable rather than queued indefinitely. Session admission is bounded and idle sessions expire. These limits are operational defaults, not measured capacity claims.

Lifecycle and role identities prevent late, duplicate or superseded outcomes from changing the current attempt. Changes to ink alone do not discard a valid in-flight observation. The client rejects results from old runs, reset attempts or disabled role epochs. The API cancels work on session disposal, premature response close and shutdown.

## Validation

Verified locally on 13 November 2026 (Asia/Manila), using Windows, Node.js 24.19.0 and npm 11.17.0:

| Check | Observed result |
| --- | --- |
| API typecheck, ESLint and production build | Passed |
| Full backend suite with guarded PostgreSQL | 95 passed; 3 skipped (two deferred Team cases and the opt-in real Redis round-trip) |
| Frontend typecheck, ESLint and production export | Passed |
| Full frontend unit suite | 142 passed across 18 files |
| Full local Chrome browser regression suite | 68 passed before the final Free Draw layout refinement |
| Final focused Free Draw Chrome suite | 9 passed, including the added short-desktop viewport checks |
| Actual remote-mode multiplayer Chrome suite | 8 passed; 1 skipped (opt-in Docker/real-model smoke) |

Free Draw browser scenarios exercise profile-free entry, keyboard prompt selection, predictions below/exactly/above the confidence gate, repeat history, restart and clear controls, bitmap recovery, independent heatmap operation, stale prompt results, independent Referee retry/backoff, mobile overflow and usable history at 1366x768/1440x900 during an outage. The API's ten dedicated tests include real localhost HTTP, credentials/origins, payload/metadata validation, concurrency/cooldown limits, idle/session capacity, independent roles, ignored cancellation/deadlines and actual response-close cancellation.

Visual QA identified and corrected a fixed-height history region that could put the latest predictions below the fold. The final layout sizes desktop history to the viewport and observes its height for windowed rendering. Input controls remain disabled until hydration and draft restoration finish, preventing clicks on an unhydrated server-rendered surface from being lost. Recovery checks wait for the actual nonblank saved bitmap before reloading rather than accepting an earlier blank autosave.

Browser AI responses are explicitly mocked; they establish integration behavior, not real-model accuracy or deployment readiness. Real Redis/worker/model and Nginx-container inference checks were not run because Docker is unavailable. These initial local checks required no schema migration or model retraining and preceded publication and deployment.

The remote-mode suite used the actual compiled API on loopback and the guarded PostgreSQL test database. It verified shared pixels/replay overflow, private prompt selection, independent personal solves, refresh/reconnect recovery, seat admission and host transfer. The final local-mode export was preserved before this separate test build and restored afterward.
