#!/usr/bin/env bash
set -euo pipefail

MODE="--dev"
RESEED=false
for arg in "$@"; do
  case "$arg" in
    --sandbox) MODE="--sandbox" ;;
    --reseed)  RESEED=true ;;
  esac
done

echo "Running setup (mode: $MODE)"

bun install
bun secrets:inject "$MODE"

if [ "$MODE" = "--sandbox" ]; then
  LOCAL_DB="packages/backend/.convex/local/default/convex_local_backend.sqlite3"
  if [ "$RESEED" = false ] && [ -f "$LOCAL_DB" ]; then
    echo "Local database already exists, skipping seed (use --reseed to force)"
  else
    echo "Seeding local Convex from dev deployment..."
    (
      set -a; source packages/backend/.env; set +a
      SEED_ZIP="/tmp/convex-seed-$$.zip"
      npx convex export --path "$SEED_ZIP" \
        && zip -d "$SEED_ZIP" '_components/betterAuth/jwks/*' '_components/betterAuth/session/*' \
        && cd packages/backend \
        && npx convex dev --local --once --run-sh "npx convex import $SEED_ZIP --replace --yes"
      rm -f "$SEED_ZIP"
    ) || echo "[seed] Seed failed (non-fatal), continuing with empty database"
  fi
fi
