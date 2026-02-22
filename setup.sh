#!/bin/bash

# Setup script for new git worktrees
# Copies env files and alchemy state from the main worktree

MAIN_WORKTREE="$(git worktree list | head -1 | awk '{print $1}')"

if [ "$PWD" = "$MAIN_WORKTREE" ]; then
  echo "Already in main worktree, nothing to copy."
  exit 0
fi

# Env files to copy
ENV_FILES=(
  "apps/desktop/.env"
  "apps/server/.env"
  "apps/web/.env"
  "packages/backend/.env.local"
  "packages/infra/.env"
)

for file in "${ENV_FILES[@]}"; do
  src="$MAIN_WORKTREE/$file"
  dest="$PWD/$file"
  if [ -f "$src" ]; then
    cp "$src" "$dest"
    echo "Copied $file"
  else
    echo "Warning: $src not found, skipping"
  fi
done

# Copy alchemy deployment state
ALCHEMY_SRC="$MAIN_WORKTREE/packages/infra/.alchemy"
ALCHEMY_DEST="$PWD/packages/infra/.alchemy"
if [ -d "$ALCHEMY_SRC" ]; then
  cp -r "$ALCHEMY_SRC" "$ALCHEMY_DEST"
  echo "Copied packages/infra/.alchemy/"
else
  echo "Warning: $ALCHEMY_SRC not found, skipping"
fi

echo "Setup complete!"
