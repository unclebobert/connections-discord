#!/bin/bash

set -euo pipefail

branch="${WORKERS_CI_BRANCH:-}"

# (vibed)
# allegedly "normalizes values like origin/experimental or refs/heads/experimental"
if [ -z "$branch" ]; then
    branch="$(git branch --show-current 2>/dev/null || true)"
fi

if [ -z "$branch" ]; then
    branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
fi

branch="${branch#refs/heads/}"
branch="${branch#refs/remotes/origin/}"
branch="${branch#origin/}"

echo "Building branch: ${branch:-unknown}"

# export the environment variable for production/experimental
# the client ID (not client secret) is public and safe to expose
if [ "$branch" = "master" ]; then
    export VITE_DISCORD_CLIENT_ID=1506187422281498684
elif [ "$branch" = "experimental" ]; then
    export VITE_DISCORD_CLIENT_ID=1507619764284031016
else
    # do not build for other branches
    echo "Not building for branch $branch" >&2
    exit 1
fi
pnpm run build
