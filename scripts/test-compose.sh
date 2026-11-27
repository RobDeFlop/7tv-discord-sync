#!/usr/bin/env bash
# Run from any directory with a local Linux Docker engine and Docker Compose.
set -euo pipefail
cd "$(dirname "$0")/.."

run_id="$(date +%s)-$$-$RANDOM"
project="sync-test-$run_id"
export BOT_VERSION="0.0.0-test.$run_id" DISCORD_TOKEN=invalid-test-token POSTGRES_PASSWORD=test-only
image="ghcr.io/robdeflop/7tv-discord-sync:$BOT_VERSION"
bundled() { docker compose -p "$project" -f install/compose.yaml "$@"; }
external() { docker compose -p "$project-external" -f install/compose.external.yaml "$@"; }
export DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@operator-db:5432/existing"
cleanup() {
  bundled down -v --remove-orphans
  external down -v --remove-orphans
  docker image rm "$image"
}

# Check the same install files operators use. Never pull or push the bot image.
# The example env selects an exact release for either install path.
for file in install/compose{,.external}.yaml; do
  (unset BOT_VERSION; docker compose --env-file install/.example.env -f "$file" config --images) |
    tr -d '\r' | grep -Eq '^ghcr\.io/robdeflop/7tv-discord-sync:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
done
bundled config --quiet
[[ "$(external config --services | tr -d '\r')" == bot ]]
docker build --platform linux/amd64 -t "$image" .
trap cleanup EXIT
docker image inspect postgres:18 >/dev/null 2>&1 || docker pull postgres:18
bundled up -d --pull never

# Startup migrates before Discord login; the dummy token cannot log in.
has_schema() {
  bundled exec -T db psql -U postgres -d "$1" -Atqc "SELECT to_regclass('public.servers')" | tr -d '\r' | grep -qx servers
}
wait_for_schema() {
  for ((i=0; i<60; i++)); do
    if has_schema "$1"; then return 0; fi
    sleep 1
  done
  echo "Bot did not migrate database $1" >&2
  return 1
}
wait_for_schema sync
bundled down
bundled up -d --wait --pull never db
has_schema sync # No bot is running to recreate a lost schema.

# Stand in for an operator's reachable Postgres without publishing a host port.
bundled exec -T db createdb -U postgres existing
external create --pull never
docker network connect --alias operator-db "${project}-external_default" "$(bundled ps -q db | tr -d '\r')"
external up -d --pull never
wait_for_schema existing
