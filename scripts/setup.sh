#!/usr/bin/env bash
set -euo pipefail

MODE="--dev"
RESEED=false
SYNC=false
for arg in "$@"; do
  case "$arg" in
    --sandbox) MODE="--sandbox" ;;
    --reseed)  RESEED=true ;;
    --sync)    SYNC=true ;;
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
        && (zip -d "$SEED_ZIP" '_components/betterAuth/jwks/*' '_components/betterAuth/session/*' || true) \
        && cd packages/backend \
        && npx convex dev --local --once --run-sh "npx convex import $SEED_ZIP --replace --yes"
      rm -f "$SEED_ZIP"
    ) || echo "[seed] Seed failed (non-fatal), continuing with empty database"
  fi
fi

if [ "$SYNC" = true ]; then
  # Sync environment variables to Convex deployment
  echo "Syncing environment variables to Convex..."
  (
    set -a; source packages/backend/.env; set +a
    cd packages/backend
    if [ "$MODE" = "--sandbox" ]; then
      CONVEX_AGENT_MODE=anonymous npx convex dev --local --once --run-sh 'bun ./sync-convex-env.ts'
    else
      npx convex dev --once --run-sh 'bun ./sync-convex-env.ts'
    fi
  )
fi
