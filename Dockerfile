# Build tooling and runtime are kept in separate stages on purpose. A single
# stage carrying its own build tools produced a 2.3GB image, nearly all of it
# the platform SWC binaries, the TypeScript compiler and the full dependency
# tree, none of which run in production.
#
# Two rules do most of the remaining work, and both are easy to get wrong:
# copy files already owned by the runtime user rather than chown-ing them
# afterwards, and never copy the same directory into an image twice. Layers are
# additive, so a `RUN chown -R /app` writes a second full copy of everything,
# and so does a COPY that lands on a path an earlier COPY already filled.

# ---------------------------------------------------------------------------
# Full install, used only to build.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

# Only the manifests, so this layer stays cached until a dependency changes
# rather than invalidating on every source edit.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

# ---------------------------------------------------------------------------
FROM deps AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN npx prisma generate --schema packages/core/prisma/schema.prisma
RUN npm run build -w @m8x/web

# ---------------------------------------------------------------------------
# Production dependencies only. The worker runs from TypeScript source, so
# unlike the web app it needs a real node_modules at runtime.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

# Scoped to the workspaces the worker loads. A root install would drag in the
# web app's tree, and Next plus its platform binaries are larger than
# everything the worker needs put together.
#
# This only works because no dependency is needed at two different versions.
# When that was not true, npm skipped the nested copy and the worker died at
# startup on a missing export, so the check below guards the arrangement rather
# than trusting it.
RUN npm ci --omit=dev       --workspace @m8x/core       --workspace @m8x/worker       --include-workspace-root

# Resolve from core's own directory, which is where the runtime resolution
# happens and where the missing version showed up.
RUN cd packages/core && node -e "  const p = require('cron-parser');   if (typeof p.parseExpression !== 'function') {     throw new Error('cron-parser resolved to an incompatible version: ' + require('cron-parser/package.json').version);   }   console.log('cron-parser ' + require('cron-parser/package.json').version + ' resolves correctly');"

# Generated here rather than copied from the builder. Copying it in would land
# on top of the @prisma/client this install already wrote, paying for the
# directory twice.
COPY packages/core/prisma packages/core/prisma
RUN npx prisma generate --schema packages/core/prisma/schema.prisma

# ---------------------------------------------------------------------------
# Web: Next.js standalone output, which carries its own traced node_modules.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web
RUN apk add --no-cache libc6-compat openssl \
 && addgroup -g 1001 -S m8x \
 && adduser -u 1001 -S m8x -G m8x
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=builder --chown=m8x:m8x /app/apps/web/.next/standalone ./
COPY --from=builder --chown=m8x:m8x /app/apps/web/.next/static ./apps/web/.next/static
# File tracing does not reliably pick up the Prisma query engine, because it is
# resolved at runtime rather than imported.
COPY --from=builder --chown=m8x:m8x /app/node_modules/.prisma ./node_modules/.prisma

USER m8x
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# Worker: production dependencies plus the TypeScript source it runs.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS worker
RUN apk add --no-cache libc6-compat openssl \
 && addgroup -g 1001 -S m8x \
 && adduser -u 1001 -S m8x -G m8x
WORKDIR /app

ENV NODE_ENV=production

# The whole installed tree, not just the root node_modules. npm nests a
# dependency whenever two workspaces need different versions of it, and core
# needs cron-parser 5 while pg-boss needs 4. Copying only /app/node_modules
# dropped the nested copy, and the worker died on a missing export at startup.
COPY --from=prod-deps --chown=m8x:m8x /app ./

# Real source over the manifests the stage above left behind.
COPY --chown=m8x:m8x packages/core ./packages/core
COPY --chown=m8x:m8x apps/worker ./apps/worker
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/m8x-entrypoint

USER m8x
ENTRYPOINT ["m8x-entrypoint"]
CMD ["npm", "run", "start", "-w", "@m8x/worker"]
