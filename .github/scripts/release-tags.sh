#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
version=${1#refs/tags/v}
number='(0|[1-9][0-9]*)'
identifier="($number|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"
pattern="^$number\\.$number\\.$number(-$identifier(\\.$identifier)*)?$"
# Docker tags cannot represent SemVer build metadata (+) or exceed 128 bytes.
if [[ $1 != refs/tags/v* || ! $version =~ $pattern || ${#version} -gt 128 ]]; then
  echo 'Expected a v-prefixed, Docker-compatible SemVer tag.' >&2
  exit 1
fi
printf '%s\n' "$version"
if [[ $version != *-* ]]; then
  echo latest
fi
