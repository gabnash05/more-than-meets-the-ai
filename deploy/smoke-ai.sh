#!/bin/sh
set -eu
CDPATH= cd -- "$(dirname -- "$0")"
exec docker compose exec -T api node dist/apps/api/src/ai/smoke.js
