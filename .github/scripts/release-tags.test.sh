#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
actual=$(bash release-tags.sh refs/tags/v1.2.0)
[[ $actual == $'1.2.0\nlatest' ]]

actual=$(bash release-tags.sh refs/tags/v1.3.0-beta.1)
[[ $actual == '1.3.0-beta.1' ]]

for ref in refs/heads/v1.2.0 refs/pull/27/merge refs/tags/1.2.0 refs/tags/vlatest \
  refs/tags/v1.2 refs/tags/v01.2.0 refs/tags/v1.2.0-beta.01 refs/tags/v1.2.0-beta..1 \
  refs/tags/v1.2.0+build refs/tags/v1.2.0-"$(printf '%0130d' 1)a"; do
  if actual=$(bash release-tags.sh "$ref" 2>/dev/null) || [[ -n $actual ]]; then
    echo "Unexpected publication tags for $ref: $actual" >&2
    exit 1
  fi
done
