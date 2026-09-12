#!/bin/sh
set -e

# Applies the schema before handing off to the real command.
#
# This lives in the image rather than in a compose service so that running the
# container on its own against an existing Postgres works with no orchestration
# at all:
#
#   docker run -e DATABASE_URL=... ghcr.io/rinukkusu/m8x-web
#
# Exactly one container should do this, or two of them race to run DDL against
# the same database. The app image migrates and the worker image does not,
# because workers are the thing you scale: starting a second one to get through
# a backlog must not touch the schema, and a deployment can run several of them
# with no coordination between them. The app is the one container that is
# always present and always singular, which makes it the right owner.
#
# Each image sets its own default in M8X_AUTO_MIGRATE. Override it to take the
# job away from the app, for anyone applying migrations from their own deploy
# pipeline instead:
#
#   M8X_AUTO_MIGRATE=0   never migrate, whichever image this is
#   M8X_AUTO_MIGRATE=1   migrate, including from a worker container

if [ "${M8X_AUTO_MIGRATE:-0}" = "1" ]; then
  if [ -z "${DATABASE_URL}" ]; then
    echo "[entrypoint] DATABASE_URL is not set" >&2
    exit 1
  fi

  # Invoked by path rather than through npx, which needs npm's bin symlinks.
  # The worker has the CLI in its own node_modules; the web image carries it in
  # a separate prefix so it cannot collide with the traced bundle.
  if [ -f node_modules/prisma/build/index.js ]; then
    PRISMA_CLI="node_modules/prisma/build/index.js"
  elif [ -f /opt/prisma/node_modules/prisma/build/index.js ]; then
    PRISMA_CLI="/opt/prisma/node_modules/prisma/build/index.js"
  else
    echo "[entrypoint] no Prisma CLI in this image; set M8X_AUTO_MIGRATE=0 and migrate elsewhere" >&2
    exit 1
  fi

  echo "[entrypoint] applying the schema"
  node "$PRISMA_CLI" db push \
    --schema packages/core/prisma/schema.prisma \
    --accept-data-loss \
    --skip-generate
  echo "[entrypoint] schema is up to date"
fi

# exec so the worker becomes PID 1 and receives SIGTERM directly. Without it
# the shell would swallow the signal and Docker would kill the container on the
# timeout instead of letting in-flight executions finish.
exec "$@"
