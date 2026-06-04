#!/bin/bash

branch="$(git branch --show-current)"

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
