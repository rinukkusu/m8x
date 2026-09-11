#!/bin/sh
set -e

# Applies the schema before handing off to the real command.
#
# This lives in the image rather than in a compose service so that running the
# container on its own against an existing Postgres works with no orchestration
# at all:
#
#   docker run -e DATABASE_URL=... ghcr.io/rinukkusu/m8x-worker
#
# Exactly one container should do this, or two of them race to run DDL against
# the same database. The default reflects that: the worker migrates, and the
# web image does not, unless it is running the worker itself
# (M8X_RUN_WORKER_IN_WEB=1), in which case it is the only container there is.
#
# Set M8X_AUTO_MIGRATE explicitly to override, for anyone who would rather
# apply migrations from their own deploy pipeline.

if [ "${M8X_RUN_WORKER_IN_WEB}" = "1" ]; then
  AUTO_MIGRATE_DEFAULT=1
else
  AUTO_MIGRATE_DEFAULT="${M8X_IS_WORKER:-0}"
fi

if [ "${M8X_AUTO_MIGRATE:-$AUTO_MIGRATE_DEFAULT}" = "1" ]; then
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
