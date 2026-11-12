# Deploy More Than Meets the AI

Use a host with Docker Engine and the Compose plugin. The GHCR procedure runs from the existing VPS stack directory; the source-build procedures run from `deploy/` in your normal Git checkout.

## Pull prebuilt GHCR images on node1

This is the no-build path for the existing Docker stack at
`/home/yashindo/docker-compose/more-than-meets-the-ai`. Main-branch pushes run
[CI and image publishing](../docs/CI.md); after the **whole** Container images
workflow succeeds, all image references and digests appear in its summary.
The web and API use the same `sha-<full-commit-sha>` tag. The optional Guesser
release also publishes an API `inference` target and a CPU ViT inference image
with that same tag. Model weights remain a separate read-only host artifact. The
workflow publishes images only: it does not SSH into node1, migrate its database
or restart games.

Images are `ghcr.io/gabnash05/more-than-meets-the-ai-web`,
`ghcr.io/gabnash05/more-than-meets-the-ai-api`,
`ghcr.io/gabnash05/more-than-meets-the-ai-api-inference`, and
`ghcr.io/gabnash05/more-than-meets-the-ai-ai`, for `linux/amd64`. The base API
image keeps inference unavailable; the separate `api-inference` target includes
the Chromium renderer required by live inference. The AI image contains the CPU
ViT runtime, not weights. The browser uses same-origin API/socket paths; no
domain, resume credential, model or production database URL is baked in.

### First-time registry switch

Copy `deploy/compose.ghcr.yaml` from the approved checkout to that existing
stack directory as `compose.ghcr.yaml`. Only when enabling the model, also copy
`deploy/compose.ghcr.guesser.yaml` there. Keep its current `compose.yaml` as the
old-release fallback. Do **not** overwrite `runtime/api.env`,
`secrets/postgres-password`, backups or data. The new file retains the project
name `more-than-meets-the-ai`, the `postgres_data` volume mounted at
`/var/lib/postgresql`, the existing database/user `mtmai`, resource/log limits for
web/database and loopback ingress port 10005. The API has no CPU or memory cap;
its PID limit remains. The API and database are not publicly published.
It contains no `build` keys and does not require a repository checkout on the VPS.
Do not use another project name, remove volumes or run `down -v` while switching.

GHCR packages may initially be private. Make every package required by the
selected stack public for anonymous VPS pulls, or configure `docker login
ghcr.io` on the VPS with a user-managed credential restricted to `read:packages`
and an appropriate Docker credential helper. Never put that credential in
Compose, a GitHub workflow file, shell history or chat. Workflow pushes use their
automatic job token; they do not need a VPS login secret. An existing package
must grant this repository Actions access. A public repository does not by itself
guarantee anonymous pulls.

### Deploy a successfully published commit

Choose a maintenance window: replacing the single API process interrupts active
matches. Take and verify a private database backup, retain the previous image
tag/digests and review migration compatibility first. These commands assume the
existing node1 database is healthy and `runtime/api.env` already has its correct
private `DATABASE_URL`. Do not run test-database cleanup on this stack.

From the stack directory, replace the explicitly marked commit placeholder with
the full SHA from the successful run (not a short SHA):

```sh
export IMAGE_TAG=sha-REPLACE_WITH_FULL_SUCCESSFUL_COMMIT_SHA
export WEB_ORIGINS=https://mtmai.yashindo.syn-forge.com

docker compose -f compose.ghcr.yaml config --quiet
docker compose -f compose.ghcr.yaml pull web api
docker compose -f compose.ghcr.yaml run --rm --no-deps --pull never api npm run db:migrate
docker compose -f compose.ghcr.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 120 api
docker compose -f compose.ghcr.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 120 web
docker compose -f compose.ghcr.yaml ps
curl -fsS http://127.0.0.1:10005/api/health
curl -fsS https://mtmai.yashindo.syn-forge.com/api/health
```

Run these one at a time and stop on any failure. `config --quiet` validates without
printing resolved credentials. Pull both images **before** migration/recreation;
`--pull never` prevents a later step from silently choosing other image contents.
Updating API then web with `--no-deps` leaves the running PostgreSQL service alone.
Keep using `-f compose.ghcr.yaml` so a later command does not accidentally select
the old locally loaded images. `IMAGE_PREFIX` can override the default GHCR
owner/repository prefix for a fork; `WEB_BIND` overrides the loopback listener.
The optional `API_ENV_FILE` and `POSTGRES_SECRET_FILE` override private host-file
locations, never image contents.

Verify public HTTPS, authenticated WebSocket upgrades and an isolated two-browser
game after the update; health alone does not establish realtime correctness.
To roll back, select a previously verified matching tag, pull both images and
repeat the API/web recreation only after checking the database is compatible.
Do not delete the persistent volume or automatically run reverse migrations.
For exact content pinning, replace each service's image reference with its
reported `name@sha256:...` digest instead of relying on a rebuildable tag.

## GHCR ViT Guesser and Referee canary on node1

This opt-in deployment uses `compose.ghcr.yaml` plus
`compose.ghcr.guesser.yaml`. It keeps web and PostgreSQL on the existing GHCR
stack, pulls the matching `api-inference` and `ai` images, and never publishes
the inference port. The overlay enables both the Guesser and the Referee when
their bundles are present. New rooms on this stack default both roles on, so
use this only when the operator intends to expose the canary to all new rooms.
The AI and API containers have no CPU or memory cgroup limits (PID limits remain);
ViT uses all CPUs visible to its process, and each AI container runs one inference
at a time. Add `ai` replicas to add inference concurrency. This can compete with
PostgreSQL and other node1 services, so monitor host resource use.

The ViT bundle is not in Git or the container image. Select a verified bundle,
copy its complete directory to the VPS under
`$AI_ARTIFACT_DIR/$GUESSER_MODEL_ID`, and make it readable by container UID 1000.
For node1, create the destination outside the checkout, then copy the directory
from the approved local model bundle, for example:

```sh
ssh node1 'install -d -m 0750 /home/yashindo/docker-compose/more-than-meets-the-ai/runtime/ai-artifacts'
scp -r models/guesser/checkpoints/notebook-production-full/bundles/guesser-vit-a-v1 \
  node1:/home/yashindo/docker-compose/more-than-meets-the-ai/runtime/ai-artifacts/
```

The loader checks every bundle file against the manifest's SHA-256 values at
startup; authenticated readiness confirms the exact model ID and label count.
Make the host owner/container UID 1000 able to read the bundle. Keep the artifact
directory outside the checkout and mount it read-only. For this
canary the selected ID is `guesser-vit-a-v1`; its saved validation reports rank A
above B, but this is a gameplay test, not a measured production accuracy claim.

Create the shared service credential once, outside the checkout; retain an
existing token on retries rather than replacing it:

```sh
export AI_SECRETS_DIR=/home/yashindo/docker-compose/more-than-meets-the-ai/secrets/ai
install -d -m 0700 "$AI_SECRETS_DIR"
if [ ! -e "$AI_SECRETS_DIR/ai-token" ]; then
  (umask 077; openssl rand -hex 32 > "$AI_SECRETS_DIR/ai-token")
fi
if [ ! -e "$AI_SECRETS_DIR/redis-api-password" ]; then
  (umask 077; openssl rand -hex 32 > "$AI_SECRETS_DIR/redis-api-password")
fi
if [ ! -e "$AI_SECRETS_DIR/redis-worker-password" ]; then
  (umask 077; openssl rand -hex 32 > "$AI_SECRETS_DIR/redis-worker-password")
fi
if [ ! -e "$AI_SECRETS_DIR/redis-users.acl" ]; then
  (umask 077; {
    echo "user default off"
    echo "user api on >$(cat "$AI_SECRETS_DIR/redis-api-password") ~mmtai:* +@all -@dangerous"
    echo "user worker on >$(cat "$AI_SECRETS_DIR/redis-worker-password") ~mmtai:* +@all -@dangerous"
  } > "$AI_SECRETS_DIR/redis-users.acl")
fi
chmod 0600 "$AI_SECRETS_DIR/ai-token" "$AI_SECRETS_DIR/redis-api-password" \
  "$AI_SECRETS_DIR/redis-worker-password" "$AI_SECRETS_DIR/redis-users.acl"
```

After copying `compose.ghcr.guesser.yaml` beside the base Compose file, set the
full SHA tag from a **successful** Container images workflow and the two host
directories. Then validate and pull before replacing the API. The API restart
can interrupt active matches; no database migration is needed for this overlay.

```sh
export IMAGE_TAG=sha-REPLACE_WITH_FULL_SUCCESSFUL_COMMIT_SHA
export WEB_ORIGINS=https://mtmai.yashindo.syn-forge.com
export GUESSER_MODEL_ID=guesser-vit-a-v1
export AI_ARTIFACT_DIR=/home/yashindo/docker-compose/more-than-meets-the-ai/runtime/ai-artifacts
export AI_SECRETS_DIR=/home/yashindo/docker-compose/more-than-meets-the-ai/secrets/ai

docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml config --quiet
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml pull redis ai api
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 180 redis
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 180 ai
```

Check authenticated model readiness without printing the token, then confirm the worker registration reached Redis:

```sh
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml exec -T ai python -c '
import json
from pathlib import Path
from urllib.request import Request, urlopen
token = Path("/run/mmtai-secrets/ai-token").read_bytes().strip().decode()
request = Request("http://127.0.0.1:8000/health/ready", headers={"Authorization": "Bearer " + token})
ready = json.load(urlopen(request, timeout=5))["guesser"]
print(json.dumps({"status": ready.get("status"), "modelId": ready.get("modelId"), "artifactRevision": ready.get("artifactRevision"), "labelCount": len(ready.get("labels", []))}))
assert ready.get("status") == "ready" and ready.get("modelId") == "guesser-vit-a-v1" and len(ready.get("labels", [])) == 345
'
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml exec -T redis sh -c '
  redis-cli --user api --pass "$(cat /run/mmtai-secrets/redis-api-password)" \
    --scan --pattern "mmtai:ai:workers:*" | grep -q .
'
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 180 api
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml ps
curl -fsS https://mtmai.yashindo.syn-forge.com/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://mtmai.yashindo.syn-forge.com/room/
```

To turn off the canary, restore the base API image/configuration without the
overlay, then stop (do not remove) the worker and Redis using both Compose files.
This preserves the pinned images, model files and Redis volume for diagnosis or
rollback:

```sh
docker compose -f compose.ghcr.yaml up -d --no-deps --pull never --wait --wait-timeout 120 api
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml stop ai redis
```

### Scale Guesser workers

Each `ai` replica adds one consumer to `guesser-workers-v1`. Scale only the AI service; the API remains the single in-memory room authority.

```sh
docker compose -f compose.ghcr.yaml -f compose.ghcr.guesser.yaml up -d --scale ai=3 ai
```

This is operator-triggered scaling, not an autoscaler. Redis is private to the overlay, has no host port, and persists its AOF under the `redis_data` volume. Queue wait counts against the same 2.5-second request budget; when workers are saturated, a job that cannot finish in time is reported unavailable rather than delivered after the turn deadline.

## Build locally instead

The sections below retain the source-build and optional inference paths. They
are not needed for a normal GHCR update. The source-build Compose file defaults
to memory storage; do not substitute it for the persistent node1 registry stack.

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

New rooms default both the AI Guesser and Referee to on. Hosts can switch either role off in the lobby. Actual inference also requires a ready worker for that role. The Guesser starts after 1.5 seconds of active drawing and tries a changed frame two seconds after the previous attempt settles, up to 24 attempts. It pulses the card when an answer is accepted and shows confidence in the round recap.

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

The test uses two browser sessions in one Individual match. It matches the accepted canvas sequence, the worker's `guesser_prediction`, and the API's `guesser_accepted` to a live pulse. The answer and confidence appear in the committed recap. The Playwright report attaches the matching job and the revealed prediction. During round two the test stops only the worker, verifies the unavailable state and human final standings, and restores the worker at cleanup. Use `docker compose --profile ai logs --tail 100 ai api` from `deploy/` in the same project to investigate a failure.

### Model bundles

`AI_ARTIFACT_DIR` contains one directory per model ID and defaults to `.local/ai-artifacts` in the checkout. `GET /health/live` checks the worker. Authenticated `GET /health/ready` reports each role's status, model ID and artifact revision.

The downloaded INT8 bundle is for private smoke tests. Its hashes verify the model, labels and metadata before installation.

For the later ViT-Tiny swap, set `AI_RUNTIME=vit`, select the bundle's `GUESSER_MODEL_ID`, and set `AI_SMOKE_TEST=0`. The bundle uses `weights.safetensors`, ordered `labels.txt` and `checkpoint-selection.json`. Its version 1 manifest sets role `guesser`, adapter `vit-tiny`, `modelId`, `artifactRevision`, input `[1,3,224,224]`, output `[1,345]`, the selected `preprocessing`, `preprocessingConfigHash` and a filename-to-SHA-256 map in `files`. Confirm evaluation parity with trusted weights before enabling it.

For the Referee, copy the supplied `models/referee/checkpoints/referee-vit-v2/` bundle under `<AI_ARTIFACT_DIR>/referee-vit-v2/` and set `REFEREE_MODEL_ID=referee-vit-v2`, `REFEREE_PROVIDER=queue`, `AI_RUNTIME=vit`, and `AI_TEST_FIXTURES=0`. The manifest uses role `referee`, adapter `vit-tiny-referee`, input `[1,3,224,224]`, output `[1,2]`, label and channel order `[text, number]`, `referee-foreground-v2` preprocessing, and sigmoid scores. The service checks every artifact hash, the revision, preprocessing configuration, and the evaluation record before loading the model. Authenticated `/health/ready` must report the Referee as `ready`; the API readiness cache must also see a fresh `mmtai:ai:workers:*` registration for the Referee. The model's validation report is supplied with the bundle; live gameplay behavior and throughput still need measurement. Referee warnings remain advisory.

For the private Referee fixture smoke test, add `AI_TEST_FIXTURES=1`, `REFEREE_MODEL_ID=referee-fixture-v1`, and `REFEREE_PROVIDER=http` to a dedicated stack instead. Run the browser acceptance command with `ROOM_TEST_AI_REFEREE=1` as well. It draws controlled colors to check that both players see the text warning and that a digits-only response clears it. The fixture is synthetic. Do not enable the fixture on a normal stack.
