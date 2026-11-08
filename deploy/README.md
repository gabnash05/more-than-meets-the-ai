# Deploy More Than Meets the AI

Use a Linux host with Docker Engine, the Docker Compose plugin, Git and `curl`. Commands run from the checkout root. The host ingress forwards to `127.0.0.1:8080` by default. Set `WEB_BIND` to the address and port your ingress uses, and set `WEB_ORIGINS` to the exact HTTP or HTTPS browser origins, without trailing slashes. For example, use `http://127.0.0.1:8080,https://game.example.com` for local verification and a public HTTPS site. The deployer configures DNS, TLS and ingress.

## First install

Set `REVIEWED_REVISION` to the full reviewed Git SHA. Copy the environment template once and keep it on the host across updates.

```sh
git clone https://github.com/gabnash05/more-than-meets-the-ai.git
cd more-than-meets-the-ai
git checkout --detach "$REVIEWED_REVISION"
cp deploy/.env.example deploy/.env
export IMAGE_TAG="$(git rev-parse HEAD)"
sh deploy/preflight.sh base
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8080/api/health
```

Keep `ROOM_STORE=memory` for a database-free VM. Refresh and reconnect recover the accepted canvas while the API process lives. Each room retains its latest match. A new match reclaims the earlier archive. The API admits 32 rooms and expires rooms after 30 minutes without a connected player. Replacing the API ends memory-mode sessions. The journal holds up to 1 MiB of encoded operations per canvas and 8 MiB per room. At the limit, players can finish the round using the accepted drawing.

## Check a match

1. Open the same URL in two independent browser sessions. Create a room, join with its invite, and start a one-round Individual match as host.
2. Check for HTTP `101` on `/socket.io/` in the browser Network panel. Choose a prompt, draw and verify that the other browser sees the drawing. Refresh the drawer and check that the accepted drawing returns.
3. Submit the correct guess from the other browser and check the recap and standings. Restart `api`, then refresh or reconnect in the old room. Both browsers should report **Room session ended**. Create a fresh room to verify the restarted proxy path.

## Operate and roll back

Define this shell helper from the checkout root. Keep the previous Git revision and both of its image tags before updating.

```sh
compose() { docker compose --env-file deploy/.env -f deploy/compose.yaml "$@"; }
compose ps
compose logs --tail 100 -f web api
compose stop
```

To update, fetch the reviewed revision, then check out and build the pair together.

```sh
PREVIOUS_REVISION="$(git rev-parse HEAD)"
git fetch origin
git checkout --detach "$REVIEWED_REVISION"
export IMAGE_TAG="$(git rev-parse HEAD)"
sh deploy/preflight.sh base
compose up -d --build --wait
```

To roll back, use the previous Compose configuration and the previously built image pair.

```sh
git checkout --detach "$PREVIOUS_REVISION"
export IMAGE_TAG="$PREVIOUS_REVISION"
compose up -d --no-build --wait
curl -fsS http://127.0.0.1:8080/api/health
```

## External PostgreSQL

To use a persistent store, set `ROOM_STORE=postgres` and `DATABASE_URL` in the host environment file. Supply a reachable PostgreSQL database and keep that file out of Git. Run migrations once against the configured database before starting the stack.

```sh
sh deploy/preflight.sh postgres
compose build web api
compose run --rm --no-deps api npm run db:migrate
compose up -d --no-build --wait
```

PostgreSQL keeps interrupted drawing prefixes and committed results across API restarts. Check migration compatibility with the previous API image before a PostgreSQL rollback.

## Optional inference

Use x86-64 Linux for the AI profile. Run the Quick, Draw! smoke model in an isolated test stack on loopback. It uses the pinned INT8 bundle and 345 ordered labels. The smoke test checks transport and mapping. Run model evaluation separately.

Create a private credential directory outside the checkout. Put the same bearer credential in the file named `ai-token` on each participating host. Restrict access to the host operator and container UID 1000. Set `AI_SECRETS_DIR` to the absolute host directory. Compose mounts it read-only. Keep the credential out of shell history and logs.

### Inference on the game host

Set these values in `deploy/.env`.

```dotenv
API_TARGET=inference
AI_RUNTIME=litert
AI_SERVICE_URL=http://ai:8000
GUESSER_PROVIDER=http
GUESSER_MODEL_ID=quickdraw-int8-smoke
REFEREE_PROVIDER=unavailable
AI_SMOKE_TEST=1
```

```sh
sh deploy/fetch-smoke-model.sh
sh deploy/preflight.sh ai-local
compose --profile ai up -d --build --wait
sh deploy/smoke-ai.sh
compose --profile ai logs --tail 100 ai api
```

The smoke script checks authenticated model readiness, opens a private match through the running NestJS server, sends a fixed drawing and checks that a mapped answer reached the committed recap. Stop `ai` and check that players can still start and complete a human-only match. Include the `ai` profile when operating the three-service stack.

### Separate inference host

On the inference host, use the same Git revision and `AI_RUNTIME`. Set `AI_BIND` to the host's private interface and port. Set `AI_SECRETS_DIR`, `GUESSER_MODEL_ID` and `AI_SMOKE_TEST` as above, then run the following from its checkout.

```sh
sh deploy/fetch-smoke-model.sh
sh deploy/preflight.sh ai-host
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.ai-host.yaml up -d --build --wait ai
```

On the game host, set `AI_SERVICE_URL` to the HTTPS endpoint on the inference host, or use a private HTTP endpoint carried inside an encrypted link and set `AI_PRIVATE_LINK=1`. Use the same secret and selected model ID. Run `sh deploy/preflight.sh ai-remote`, bring up the base stack with `API_TARGET=inference` and run `sh deploy/smoke-ai.sh` from the game host.

### Model bundles

`AI_ARTIFACT_DIR` contains one directory per model ID. The service reports per-role status at authenticated `GET /health/ready`. Its liveness check stays available when a role is disabled or its artifact cannot load.

The INT8 smoke artifact uses light ink on a dark background, following the publisher's training code. Fixed public source bitmaps provide a polarity and label-order check. The bundle includes source attribution and hash-pinned model, labels and metadata.

Set `AI_RUNTIME=vit` to install the optional CPU ViT dependencies. A ViT bundle uses `weights.safetensors`, ordered `labels.txt` and the validation-selected `checkpoint-selection.json`. The version 1 manifest uses role `guesser`, adapter `vit-tiny`, `modelId`, `artifactRevision`, input `[1,3,224,224]`, output `[1,345]`, the training `preprocessing` candidate, `preprocessingConfigHash` and a filename-to-SHA-256 map in `files`. Export the selected backbone state dict from trusted weights and confirm evaluation parity before enabling it.

The synthetic Referee adapter requires `AI_TEST_FIXTURES=1` and `REFEREE_MODEL_ID=referee-fixture-v1`. Enable `REFEREE_PROVIDER=http` to exercise it in a test match. Text and number evidence are evaluated independently and remain internal.
