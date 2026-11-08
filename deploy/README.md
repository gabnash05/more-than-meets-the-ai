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

Use Linux x86-64 containers for inference. Put the bearer credential in a file named `ai-token` in a private directory outside the checkout. Set `AI_SECRETS_DIR` in `.env` to that directory's absolute path. Give the host operator and container UID 1000 access.

### AI on the game host

For a private Quick, Draw! smoke test, add these settings to `.env`.

```dotenv
API_TARGET=inference
AI_SERVICE_URL=http://ai:8000
GUESSER_PROVIDER=http
GUESSER_MODEL_ID=quickdraw-int8-smoke
AI_SMOKE_TEST=1
```

```sh
sh fetch-smoke-model.sh
sh preflight.sh ai-local
docker compose --profile ai up -d --build --wait
sh smoke-ai.sh
```

The smoke script checks model readiness and drives a private match to a mapped answer. Use `docker compose --profile ai logs --tail 100 ai api` to diagnose failures.

### AI on a separate host

On the inference host, set `AI_BIND` to its private IPv4 address and port, and set `AI_SECRETS_DIR`, `GUESSER_MODEL_ID` and `AI_SMOKE_TEST` for the smoke bundle. Use the same Compose files as the game host.

```sh
sh fetch-smoke-model.sh
sh preflight.sh ai-host
docker compose -f compose.yaml -f compose.ai-host.yaml up -d --build --wait ai
```

On the game host, use the settings from the previous section with the same credential. Set `AI_SERVICE_URL` to the inference host's HTTPS endpoint. For HTTP over an encrypted private link, also set `AI_PRIVATE_LINK=1`.

```sh
sh preflight.sh ai-remote
docker compose up -d --build --wait
sh smoke-ai.sh
```

### Model bundles

`AI_ARTIFACT_DIR` contains one directory per model ID and defaults to `.local/ai-artifacts` in the checkout. `GET /health/live` checks the worker. Authenticated `GET /health/ready` reports each role's status, model ID and artifact revision.

The downloaded INT8 bundle is for private smoke tests. Its hashes verify the model, labels and metadata before installation.

Set `AI_RUNTIME=vit` for the CPU ViT dependencies. The bundle uses `weights.safetensors`, ordered `labels.txt` and `checkpoint-selection.json`. Its version 1 manifest sets role `guesser`, adapter `vit-tiny`, `modelId`, `artifactRevision`, input `[1,3,224,224]`, output `[1,345]`, the selected `preprocessing`, `preprocessingConfigHash` and a filename-to-SHA-256 map in `files`. Confirm evaluation parity with trusted weights before enabling it.

For a private Referee fixture test, set `AI_TEST_FIXTURES=1`, `REFEREE_MODEL_ID=referee-fixture-v1` and `REFEREE_PROVIDER=http`. Its text and number evidence stays internal.
