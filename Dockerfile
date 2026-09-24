# syntax=docker/dockerfile:1

# Node.js 24.21.0 on Debian Bookworm slim; multi-platform index digest.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS fixture
WORKDIR /fixture
COPY fixtures/server.js fixtures/browser-session.js ./
USER node
EXPOSE 3004
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3004/healthz").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "server.js"]

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json index.js stoplight.js providerRegistry.js validateTokenRequest.js ./
COPY adapters ./adapters

ARG VCS_REF=unversioned
LABEL org.opencontainers.image.source="https://github.com/Mentro-PromptAnalyzer/server" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="Mentro server"

USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3001/api/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "index.js"]
