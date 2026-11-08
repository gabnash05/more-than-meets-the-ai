#!/bin/sh
set -eu
CDPATH= cd -- "$(dirname -- "$0")"

die() { printf '%s\n' "$*" >&2; exit 2; }
profile=${1:-base}
case "$profile" in
  base|postgres|ai-remote) set -- ;;
  ai-local) set -- --profile ai ;;
  ai-host) set -- -f compose.yaml -f compose.ai-host.yaml --profile ai ;;
  *) die 'Usage: preflight.sh [base|postgres|ai-local|ai-host|ai-remote]' ;;
esac

settings=$(docker compose "$@" config --environment)
value() { printf '%s\n' "$settings" | sed -n "s/^$1=//p"; }

if [ "$profile" = ai-host ]; then
  bind=$(value AI_BIND)
  bind=${bind:-127.0.0.1:8000}
  printf '%s\n' "$bind" | grep -Eq '^(127\.0\.0\.1:|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' \
    || die 'AI_BIND must be a private IPv4 address and port.'
else
  bind=$(value WEB_BIND)
  bind=${bind:-127.0.0.1:8080}
  case "$(value ROOM_STORE)" in
    postgres)
      case "$(value DATABASE_URL)" in
        postgres://*|postgresql://*) ;;
        *) die 'PostgreSQL mode requires DATABASE_URL.' ;;
      esac ;;
    memory|'') [ "$profile" != postgres ] || die 'Set ROOM_STORE=postgres first.' ;;
    *) die 'ROOM_STORE must be memory or postgres.' ;;
  esac
fi

printf '%s\n' "$bind" | grep -Eq '^.+:[0-9]+$' || die 'Set a host address and fixed port.'
port=${bind##*:}
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die 'Choose a host port from 1 to 65535.'

case "$profile" in
  ai-*)
    secrets=$(value AI_SECRETS_DIR)
    [ -r "${secrets:-../.local/ai-secrets}/ai-token" ] || die 'Create the private AI credential file ai-token.'
    if [ "$(value GUESSER_MODEL_ID)" = quickdraw-int8-smoke ]; then
      [ "$(value AI_SMOKE_TEST)" = 1 ] || die 'Set AI_SMOKE_TEST=1 for the private smoke test.'
      if [ "$profile" != ai-host ]; then
        case "$bind" in
          127.0.0.1:*) ;;
          *) die 'Run the smoke match on a private loopback bind.' ;;
        esac
      fi
      if [ "$profile" != ai-remote ]; then
        artifacts=$(value AI_ARTIFACT_DIR)
        [ -r "${artifacts:-../.local/ai-artifacts}/quickdraw-int8-smoke/manifest.json" ] || die 'Fetch the pinned smoke artifact first.'
      fi
    fi ;;
esac

case "$profile" in
  ai-local|ai-remote)
    [ "$(value API_TARGET)" = inference ] || die 'Set API_TARGET=inference for the browser renderer.'
    case "$(value GUESSER_PROVIDER):$(value REFEREE_PROVIDER)" in
      http:*|*:http) ;;
      *) die 'Enable an HTTP provider on the API.' ;;
    esac
    url=$(value AI_SERVICE_URL)
    if [ "$profile" = ai-local ]; then
      [ "$url" = http://ai:8000 ] || die 'Set AI_SERVICE_URL=http://ai:8000.'
    else
      case "$url" in
        https://*) ;;
        http://*) [ "$(value AI_PRIVATE_LINK)" = 1 ] || die 'Use HTTPS or an encrypted private link.' ;;
        *) die 'Set AI_SERVICE_URL to the private inference endpoint.' ;;
      esac
    fi ;;
esac

printf 'Compose configuration is valid (%s).\n' "$profile"
