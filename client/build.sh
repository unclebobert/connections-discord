# !/bin/bash

# export the environment variable for production/experimental
# the client ID (not client secret) is public and safe to expose
if [ "$CF_PAGES_BRANCH" = "master" ]; then
    export VITE_DISCORD_CLIENT_ID=1506187422281498684
elif [ "$CF_PAGES_BRANCH" = "experimental" ]; then
    export VITE_DISCORD_CLIENT_ID=1507619764284031016
else
    # do not build for other branches
    exit 0
fi
pnpm run build
