# Shared base: install once, reuse for both services.
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

COPY . .
RUN npx prisma generate --schema packages/core/prisma/schema.prisma

# ---------------------------------------------------------------------------

FROM base AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @m8x/web
EXPOSE 3000
# `db push` on boot keeps a single-team deployment from needing a separate
# migration step. Swap this for `migrate deploy` once the schema stops moving.
CMD ["sh", "-c", "npx prisma db push --schema packages/core/prisma/schema.prisma --accept-data-loss && npm run start -w @m8x/web"]

# ---------------------------------------------------------------------------

FROM base AS worker
CMD ["npm", "run", "start", "-w", "@m8x/worker"]
