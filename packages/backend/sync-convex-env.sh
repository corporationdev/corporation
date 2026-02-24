#!/bin/sh
# Syncs non-Convex-managed environment variables from .env.local to the Convex deployment.

ENV_FILE="$(dirname "$0")/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env found at $ENV_FILE, skipping env sync."
  exit 0
fi

while IFS= read -r line || [ -n "$line" ]; do
  # Skip empty lines and comments
  case "$line" in
    ""|\#*) continue ;;
  esac

  # Parse KEY=VALUE
  key="${line%%=*}"
  value="${line#*=}"

  # Skip Convex-managed and frontend-prefixed variables
  case "$key" in
    CONVEX_DEPLOYMENT|CONVEX_URL) continue ;;
    NEXT_PUBLIC_*|VITE_*) continue ;;
  esac

  echo "Setting $key"
  bunx convex env set "$key" "$value" || true
done < "$ENV_FILE"
