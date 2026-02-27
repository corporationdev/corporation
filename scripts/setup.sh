#!/usr/bin/env bash
set -euo pipefail

MODE="--dev"
for arg in "$@"; do
  case "$arg" in
    --sandbox) MODE="--sandbox" ;;
  esac
done

echo "Running setup (mode: $MODE)"

bun install
bun secrets:inject "$MODE"
