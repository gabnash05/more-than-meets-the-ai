# More Than Meets the AI — web frontend

The frontend provides the approved room flow: create or join a private room, invite friends, configure the lobby, and view drawing and result states. It uses the Lemon Crayon design system.

## Run locally

Use Node.js 24 and npm. Browser tests require installed Google Chrome.

```sh
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open http://localhost:3000, choose a name and character, and create or join a room. The default transport is a **local demo**: rooms and drawing journals are stored in this browser's IndexedDB, and a refresh can restore the local room, role, and drawing. Room codes do not connect separate browsers. Gameplay and result examples in this adapter are labelled fixtures. This demo does not provide cross-browser multiplayer. Use the remote transport with the separately running NestJS API for real rooms and authoritative scores; actual AI inference remains unavailable.

The separate `/review/` and `/review/canvas/` routes provide room-state and canvas review harnesses.

## Static build and transport configuration

```sh
npm run build
npm run preview
```

Open http://127.0.0.1:3100. The portable static site is written to `out/`; a host must serve directory index files and worker assets from the same origin. Configure a static host with project root `apps/web`, build command `npm run build`, and output directory `out`.

`.env.example` lists `NEXT_PUBLIC_ROOM_TRANSPORT`, `NEXT_PUBLIC_ROOM_API_URL`, and `NEXT_PUBLIC_ROOM_SOCKET_URL`. Transport defaults to `local`; `remote` selects the implemented HTTP/Socket.IO adapter, whose URLs default to the same origin. These `NEXT_PUBLIC_` values are embedded at build time: rebuild the static site after changing them. The compatible NestJS service is in `apps/api`. Start it separately against configured PostgreSQL; the static export does not start the API. See [the integration contract](../../docs/FRONTEND-ROOM-INTEGRATION.md).

## Drawing controls

- Brush, pixel eraser, and region-fill bucket; palette/custom colors and brush size 2–40.
- Undo/redo applies to strokes, erasing, fills, and Clear; history retains up to 20 actions within a 64 MiB bitmap budget.
- B / E / F select a tool. Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes. Text fields retain ordinary editing behavior.
- The canvas uses fixed 1024 × 768 logical coordinates and scales with the viewport.

## Results, chat and modal behavior

Final standings use winner avatars and rank cards with prominent totals, tied competition ranks and a labelled current-player highlight. AI status/total/coverage stays separate from human winners. Recap emphasizes the revealed word, your points and relevant components, round gains and upcoming drawer/countdown. Recaps and final standings share the drawing board's width and center alignment across phone, tablet and desktop layouts. Result content stacks on phones and grows vertically in ordinary page flow.

Correct-message confirmations use dark green text and a checkmark; unsolved players still cannot see the answer. Both chat views follow the latest message, including restored history and arrivals at the 100-message cap, without moving the page or keyboard focus. Modal action groups use 12px gaps and wrap/stack on phones while preserving the invitation flow.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Playwright browser checks use the exported production build and installed Google Chrome. See [frontend validation](../../docs/FRONTEND-VALIDATION.md) for the checks actually performed and their limits.

## Individual remote milestone

Remote mode supports Individual play only: Team selection is disabled and the authority rejects new Team settings/starts. Existing Team fixtures/code and deferred tests remain for a later plan. The corrected invite dialog and approved V10 presentation are preserved.

AI round points/status appear in recap and its committed total/coverage alongside final human standings. The AI does not enter human winners/deltas. The production provider remains unavailable; missing or unavailable AI data renders unavailable rather than a fake incorrect/zero result. An eligible unsolved result is zero, while unavailable is null. Positive AI examples are explicit fixtures, not model results.

Drawing status distinguishes locally queued unaccepted batches from the server-accepted sequence and contiguous durable prefix. Accepted but undurable envelopes remain stored until the watermark covers them. Replay/hydration does not emit drawing again. An unsendable tail is retired with a visible notice and a new client stream.

For remote verification, set `NEXT_PUBLIC_ROOM_TRANSPORT=remote`, `NEXT_PUBLIC_ROOM_API_URL=http://127.0.0.1:3001` and `NEXT_PUBLIC_ROOM_SOCKET_URL=http://127.0.0.1:3001` before `npm run build`. Start the API and `npm run preview` separately, then run `npx playwright test --config playwright.multiplayer.config.ts`. This config uses one Chrome worker and does not start either server. Build local-demo production separately before running the default local browser suite. The isolated database test target is documented in the API README; never print its credentials.

## Free Draw

Open `/free-draw/` directly or use the card beneath the homepage room-code controls. No player profile is required. Free Draw uses `NEXT_PUBLIC_ROOM_API_URL` for its real inference API independently of the multiplayer transport switch; an empty URL uses same-origin `/api/free-draw`. A static preview without an API still permits drawing with fresh state on each visit, with AI shown as unavailable. API URLs are compiled at build time.

See [Free Draw behavior, recovery and validation](../../docs/FREE-DRAW.md). Run its focused Chrome checks with `npx playwright test e2e/free-draw.spec.ts` after a production build. The AI test responses are fixtures, not model-accuracy evidence.
