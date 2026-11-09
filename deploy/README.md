# Deploy More Than Meets the AI

Use a host with Docker Engine and the Compose plugin. Run the commands below from `deploy/` in your normal Git checkout.

## Start the game

For public hosting, copy `.env.example` to `.env` and set `WEB_ORIGINS` to the exact browser origin, such as `https://game.example.com`. Separate multiple origins with commas and omit trailing slashes. Point the HTTPS ingress at `127.0.0.1:8080`. Set `WEB_BIND` if the ingress uses a different bind address or port. The defaults work for a local launch.

```sh
sh preflight.sh
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:8080/api/health
```

The game starts in memory mode. Play a match in two browser sessions and check shared drawing, refresh recovery and final standings. The browser's Network panel should show HTTP `101` for `/socket.io/`. Restarting the API ends memory-mode rooms.

## Status and updates

```sh
docker compose ps
docker compose logs --tail 100 -f web api
```

Update your branch with `git pull --ff-only`. To keep images for rollback, set a unique release tag such as `IMAGE_TAG=demo-1` in `.env` before building and keep the previous images.

```sh
sh preflight.sh
docker compose build --pull
docker compose up -d --no-build --wait
```

To roll back, set the previous tag and run `docker compose up -d --no-build --wait`. Use the previous Compose file if its service settings changed. Add `--profile ai` after `docker compose` when operating a stack with local inference.

## PostgreSQL

Set `ROOM_STORE=postgres` and `DATABASE_URL` in `.env`. Run the migration against the configured database before starting the services.

```sh
sh preflight.sh postgres
docker compose build web api
docker compose run --rm --no-deps api npm run db:migrate
docker compose up -d --no-build --wait
```

PostgreSQL keeps interrupted drawing prefixes and committed results across API restarts. Check migration compatibility before rolling back the API.

## Optional AI

Use Linux x86-64 containers for inference. Generate a shared bearer token with `openssl rand -hex 32` and save it as `ai-token` in a private directory outside the checkout. Set `AI_SECRETS_DIR` to that directory's absolute path. Give the operator and container UID 1000 read access.

### AI on the game host

This is the default cloud layout and the local test layout. The worker uses the internal Compose network. For the private Quick, Draw! smoke test, set these values in `.env` and use the default loopback web bind and memory store.

```dotenv
WEB_ORIGINS=http://127.0.0.1:8080
API_TARGET=inference
AI_SERVICE_URL=http://ai:8000
GUESSER_PROVIDER=http
GUESSER_MODEL_ID=quickdraw-int8-smoke
AI_SMOKE_TEST=1
AI_SECRETS_DIR=/absolute/path/to/private/secrets
```

```sh
sh fetch-smoke-model.sh
sh preflight.sh ai-local
docker compose --profile ai up -d --build --wait
sh smoke-ai.sh
```

The smoke script checks authenticated model readiness and drives a private match to a mapped answer. Keep smoke mode off public ingress. For a private cloud check, use `ssh -N -L 8080:127.0.0.1:8080 operator@game-host` and open the local forwarded address.

### AI on a separate cloud host

Use this layout when the game host cannot run the worker. Join both hosts to the same Tailscale network and allow only the game host to reach TCP 8000 on the worker. On the worker set `AI_SECRETS_DIR`, `GUESSER_MODEL_ID` and `AI_SMOKE_TEST` as above with the same token. Set `AI_BIND=127.0.0.1:8000`. [Tailscale grants](https://tailscale.com/docs/features/access-control/grants)

```sh
sh fetch-smoke-model.sh
sh preflight.sh ai-host
docker compose -f compose.yaml -f compose.ai-host.yaml --profile ai up -d --build --wait ai
sudo tailscale serve --bg --tcp=8000 tcp://127.0.0.1:8000
tailscale ip -4
```

On the game host keep the game settings and point `AI_SERVICE_URL=http://<worker-tailnet-ip>:8000` at the address from `tailscale ip -4`. Set `AI_PRIVATE_LINK=1` for this encrypted connection. Switch between matches because updating the API ends memory-mode rooms. Stop the old local worker with `docker compose --profile ai stop ai` if it was running. [Tailscale TCP forwarding](https://tailscale.com/docs/reference/tailscale-cli/serve#use-a-tcp-forwarder)

```sh
sh preflight.sh ai-remote
docker compose up -d --build --wait
sh smoke-ai.sh
```

### Laptop worker fallback

Use the same worker-only settings and Compose command on the laptop, with Docker Desktop in Linux-container mode and WSL for the shell scripts on Windows. Instead of the background forward, run `tailscale serve --tcp=8000 tcp://127.0.0.1:8000` in a Windows Administrator terminal while the fallback is needed. Point the game host at the laptop's tailnet IP using the separate-host settings. Press Ctrl+C to close the forward when finished. [Docker Desktop with WSL](https://docs.docker.com/desktop/features/wsl/) · [Tailscale Serve](https://tailscale.com/docs/reference/examples/serve)

### Local browser acceptance

Use a dedicated local Compose project and leave port 8080 free for Nginx. Set `COMPOSE_PROJECT_NAME=mmtai-ai-smoke` in the shell before running the game-host launch above. Run the browser check with the same project name from `apps/web/` using Node.js 24 and Google Chrome.

```sh
npm ci
COMPOSE_PROJECT_NAME=mmtai-ai-smoke ROOM_TEST_AI_SMOKE=1 ROOM_TEST_BASE_URL=http://127.0.0.1:8080 \
  npx playwright test --config playwright.multiplayer.config.ts ai-smoke.spec.ts
```

The test uses two browser sessions in one Individual match. It verifies the accepted canvas sequence and matches the worker's `guesser_prediction` to the API's `guesser_accepted` before submitting the human answer. The guess appears in the committed recap. The Playwright report attaches the matching job and the revealed answer. During round two the test stops only the worker, verifies the unavailable state and human final standings, and restores the worker at cleanup. Use `docker compose --profile ai logs --tail 100 ai api` from `deploy/` in the same project to investigate a failure.

### Model bundles

`AI_ARTIFACT_DIR` contains one directory per model ID and defaults to `.local/ai-artifacts` in the checkout. `GET /health/live` checks the worker. Authenticated `GET /health/ready` reports each role's status, model ID and artifact revision.

The downloaded INT8 bundle is for private smoke tests. Its hashes verify the model, labels and metadata before installation.

For the later ViT-Tiny swap, set `AI_RUNTIME=vit`, select the bundle's `GUESSER_MODEL_ID`, and set `AI_SMOKE_TEST=0`. The bundle uses `weights.safetensors`, ordered `labels.txt` and `checkpoint-selection.json`. Its version 1 manifest sets role `guesser`, adapter `vit-tiny`, `modelId`, `artifactRevision`, input `[1,3,224,224]`, output `[1,345]`, the selected `preprocessing`, `preprocessingConfigHash` and a filename-to-SHA-256 map in `files`. Confirm evaluation parity with trusted weights before enabling it.

For a private Referee fixture test, set `AI_TEST_FIXTURES=1`, `REFEREE_MODEL_ID=referee-fixture-v1` and `REFEREE_PROVIDER=http`. Its text and number evidence stays internal.
