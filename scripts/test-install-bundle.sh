#!/usr/bin/env bash
# Check a locally built release candidate as an operator without a checkout.
set -euo pipefail
version=${1:?Pass the version of a locally tagged image, without v}
release="ghcr.io/robdeflop/7tv-discord-sync:$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/client" "$work/install"
host=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' | tr -d '\r')}
unset DOCKER_CONTEXT
export DOCKER_HOST="$host" DOCKER_CONFIG="$work/client"
cd "$work/install"

description=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.description"}}' "$release")
for instruction in "docker create $release" 'docker cp "$cid:/install/." .' 'docker rm "$cid"' 'README.md'; do
  if [[ $description != *"$instruction"* ]]; then
    echo "Public package description lacks: $instruction" >&2
    exit 1
  fi
done

# Use the local candidate in place of a registry pull; create never starts the bot.
cid=$(docker create --pull never "$release" | tr -d '\r')
trap 'docker rm "$cid" >/dev/null; rm -rf "$work"' EXIT
docker cp "$cid:/install/." .
docker rm "$cid" >/dev/null
trap 'rm -rf "$work"' EXIT

test -s README.md
for key in DISCORD_TOKEN POSTGRES_PASSWORD DATABASE_URL; do
  tr -d '\r' < .example.env | grep -Fxq "$key="
done
cp .example.env .env
unset BOT_VERSION COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE
export DISCORD_TOKEN=example-token POSTGRES_PASSWORD=example
unset DATABASE_URL
[[ $(docker compose config --services | tr -d '\r' | sort) == $'bot\ndb' ]]
docker compose config --images | tr -d '\r' | grep -Fx "$release"

unset POSTGRES_PASSWORD
export DATABASE_URL=postgres://operator:example@external.invalid/sync
[[ $(docker compose -f compose.external.yaml config --services | tr -d '\r') == bot ]]
[[ $(docker compose -f compose.external.yaml config --images bot | tr -d '\r') == "$release" ]]
printf 'Verified anonymous bundle for %s (bundled and external PostgreSQL)\n' "$release"
