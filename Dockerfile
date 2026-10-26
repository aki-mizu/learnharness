# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --include=optional

COPY . .
# Curate the same standalone payload as the desktop build, including prompts,
# native renderers and static assets. The smoke gate uses no provider keys.
RUN npm run build \
    && node scripts/build-server.mjs \
    && node scripts/smoke-server.mjs

FROM node:24-bookworm-slim AS runner
WORKDIR /app

# There is no Electron shell in the container. Generated demos use the existing
# system-Chromium fallback; PDF and SVG rendering use native Node modules.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    CHROME_PATH=/usr/bin/chromium \
    LH_DATA_DIR=/state/data \
    LH_AUTH_FILE=/state/auth.json

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder /app/LICENSE ./LICENSE
COPY --chown=node:node scripts/server-gateway.mjs ./server-gateway.mjs
RUN mkdir -p /state/data .next/cache \
    && chown -R node:node /state .next/cache

USER node
EXPOSE 3000 8080 8081
CMD ["node", "server.js"]
