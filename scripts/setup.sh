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

if [ "$MODE" = "--sandbox" ]; then
  echo "Seeding local Convex from dev deployment..."
  (
    set -a; source packages/backend/.env; set +a
    SEED_ZIP="/tmp/convex-seed-$$.zip"
    npx convex export --path "$SEED_ZIP" \
      && (zip -d "$SEED_ZIP" '_components/betterAuth/jwks/*' '_components/betterAuth/session/*' || test $? -eq 12) \
      && cd packages/backend \
      && npx convex dev --local --once --run-sh "npx convex import $SEED_ZIP --replace --yes"
    rm -f "$SEED_ZIP"
  ) || echo "[seed] Seed failed (non-fatal), continuing with empty database"
fi
