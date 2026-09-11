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
# Only the worker image carries the Prisma CLI, so only the worker migrates.
# That also means exactly one container touches the schema, which avoids two
# of them racing to run DDL against the same database on a parallel start.
#
# Set M8X_AUTO_MIGRATE=0 to skip this, for anyone who would rather apply
# migrations from their own deploy pipeline.

if [ "${M8X_AUTO_MIGRATE:-1}" = "1" ]; then
  if [ -z "${DATABASE_URL}" ]; then
    echo "[entrypoint] DATABASE_URL is not set" >&2
    exit 1
  fi

  echo "[entrypoint] applying the schema"
  npx prisma db push \
    --schema packages/core/prisma/schema.prisma \
    --accept-data-loss \
    --skip-generate
  echo "[entrypoint] schema is up to date"
fi

# exec so the worker becomes PID 1 and receives SIGTERM directly. Without it
# the shell would swallow the signal and Docker would kill the container on the
# timeout instead of letting in-flight executions finish.
exec "$@"
