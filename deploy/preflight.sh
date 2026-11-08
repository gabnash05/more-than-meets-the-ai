#!/bin/sh
set -eu
die() { printf '%s\n' "$*" >&2; exit 2; }

profile=${1:-base}
case "$profile" in base|postgres|ai-local|ai-host|ai-remote) ;; *) die 'Usage: preflight.sh [base|postgres|ai-local|ai-host|ai-remote]' ;; esac
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ -f .env ] || die 'Copy deploy/.env.example to deploy/.env.'
compose() { docker compose --env-file .env -f compose.yaml "$@"; }
value() {
  printenv "$1" 2>/dev/null || awk -v key="$1" 'index($0, key "=")==1 {sub(/^[^=]*=/,""); sub(/\r$/,""); print; exit}' .env
}

tag=$(value IMAGE_TAG)
printf '%s' "$tag" | grep -Eq '^[a-f0-9]{40}$' || die 'Set IMAGE_TAG to the full reviewed Git SHA.'
docker info --format '{{.ServerVersion}}' >/dev/null || die 'Docker Engine is unavailable.'
docker compose version >/dev/null || die 'Install the Docker Compose plugin.'

bind_valid() {
  printf '%s\n' "$1" | awk -F '[.:]' 'NF != 5 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || length($i)>3 || $i>255) exit 1; if($5 !~ /^[0-9]+$/ || length($5)>5 || $5<1 || $5>65535) exit 1}'
}
binding_free() {
  if command -v ss >/dev/null 2>&1 && [ "$1" != "$2" ] && ss -ltnH "sport = :${1##*:}" | grep -q .; then
    die 'The requested published port is already listening.'
  fi
}

if [ "$profile" != ai-host ]; then
  bind=$(value WEB_BIND)
  bind=${bind:-127.0.0.1:8080}
  bind_valid "$bind" || die 'WEB_BIND must be an IPv4 address and valid port.'
  binding_free "$bind" "$(compose port web 8080 2>/dev/null || true)"
  origins=$(value WEB_ORIGINS)
  [ -n "$origins" ] || die 'Set WEB_ORIGINS to the exact browser origins.'
  printf '%s\n' "$origins" | grep -Eq '^https?://[^/,]+(,https?://[^/,]+)*$' || die 'WEB_ORIGINS must contain comma-separated HTTP(S) origins.'
  mode=$(value ROOM_STORE)
  case "$mode" in
    postgres) case "$(value DATABASE_URL)" in postgres://*|postgresql://*) ;; *) die 'PostgreSQL mode requires DATABASE_URL.' ;; esac ;;
    memory|'') [ "$profile" != postgres ] || die 'Set ROOM_STORE=postgres first.' ;;
    *) die 'ROOM_STORE must be memory or postgres.' ;;
  esac
fi

case "$profile" in
  ai-*)
    secret_dir=$(value AI_SECRETS_DIR)
    [ -r "${secret_dir:-../.local/ai-secrets}/ai-token" ] || die 'Create the private AI credential file ai-token.'
    if [ "$profile" != ai-host ]; then
      [ "$(value API_TARGET)" = inference ] || die 'Set API_TARGET=inference for the browser renderer.'
      case "$(value GUESSER_PROVIDER):$(value REFEREE_PROVIDER)" in http:*|*:http) ;; *) die 'Enable an HTTP provider on the API.' ;; esac
    fi
    if [ "$(value GUESSER_MODEL_ID)" = quickdraw-int8-smoke ]; then
      [ "$(value AI_SMOKE_TEST)" = 1 ] || die 'Set AI_SMOKE_TEST=1 for the private smoke test.'
      if [ "$profile" != ai-host ]; then
        case "$bind" in 127.0.0.1:*) ;; *) die 'Run the smoke match on a private loopback bind.' ;; esac
      fi
      if [ "$profile" != ai-remote ]; then
        artifact_dir=$(value AI_ARTIFACT_DIR)
        [ -r "${artifact_dir:-../.local/ai-artifacts}/quickdraw-int8-smoke/manifest.json" ] || die 'Fetch the pinned smoke artifact first.'
      fi
    fi ;;
esac

case "$profile" in
  ai-local)
    [ "$(value AI_SERVICE_URL)" = http://ai:8000 ] || die 'Set AI_SERVICE_URL=http://ai:8000.'
    compose --profile ai config --quiet ;;
  ai-host)
    ai_bind=$(value AI_BIND)
    bind_valid "$ai_bind" || die 'Set AI_BIND to a private IPv4 address and port.'
    printf '%s' "$ai_bind" | grep -Eq '^(127\.0\.0\.1:|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' || die 'AI_BIND must be private.'
    binding_free "$ai_bind" "$(compose -f compose.ai-host.yaml --profile ai port ai 8000 2>/dev/null || true)"
    compose -f compose.ai-host.yaml --profile ai config --quiet ;;
  ai-remote)
    case "$(value AI_SERVICE_URL)" in
      https://*) ;;
      http://*) [ "$(value AI_PRIVATE_LINK)" = 1 ] || die 'Use HTTPS or explicitly configure an encrypted private link.' ;;
      *) die 'Set AI_SERVICE_URL to the private inference endpoint.' ;;
    esac
    compose config --quiet ;;
  *) compose config --quiet ;;
esac
printf 'Compose configuration is valid (%s).\n' "$profile"
