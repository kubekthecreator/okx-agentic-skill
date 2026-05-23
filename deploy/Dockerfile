# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the OKX trend-follower bot.
# Final image: node:20-slim (Debian, glibc) — NOT alpine, because the
# onchainos CLI is a glibc binary on Linux.
#
# Build from the REPO ROOT:
#   docker build -f deploy/Dockerfile -t okx-bot:latest .
#
# The onchainos CLI is NOT baked into the image — runtime brings it in
# via bind mount from the host (see docker-compose.yml). This keeps the
# image upgrade-able without rebuilding when OKX ships a new CLI release,
# and keeps wallet credentials (in ~/.onchainos) on the host filesystem
# only.

# ---------- builder ----------
FROM node:20-slim AS builder

WORKDIR /build

# Install production deps first to maximise layer cache hits.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# ---------- runtime ----------
FROM node:20-slim AS runtime

# Bot directories; state.json + logs are bind-mounted at runtime.
WORKDIR /app

# Non-root user. UID/GID 10001 is high enough to never collide with a
# host user account; bind-mounted volumes should chown to match.
ARG APP_UID=10001
ARG APP_GID=10001
RUN groupadd --system --gid ${APP_GID} okxbot \
 && useradd  --system --uid ${APP_UID} --gid ${APP_GID} --create-home \
              --home-dir /home/okxbot --shell /usr/sbin/nologin okxbot

# Copy installed deps from builder, then source.
COPY --chown=okxbot:okxbot --from=builder /build/node_modules ./node_modules
COPY --chown=okxbot:okxbot bot.js execution.js logger.js risk.js signals.js state.js strategy.js tokens.json package.json ./
COPY --chown=okxbot:okxbot scripts ./scripts

# Writable mount points. docker-compose maps these to host paths so state
# survives container restarts.
RUN mkdir -p /app/logs /app/data \
 && chown -R okxbot:okxbot /app/logs /app/data

USER okxbot

# Defaults — overridden by env_file / -e at run time.
ENV NODE_ENV=production \
    DRY_RUN=true \
    LOG_LEVEL=info \
    TICK_INTERVAL_MS=60000 \
    OKX_CHAIN=solana

# Healthcheck: read state.json (should always exist after first tick) and
# confirm it parses as JSON. Honors OKX_BOT_STATE_FILE so it tracks the
# same path the bot writes to (compose sets it to /app/data/state.json).
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "JSON.parse(require('fs').readFileSync(process.env.OKX_BOT_STATE_FILE || '/app/state.json','utf-8'))" || exit 1

# Graceful shutdown: docker stop sends SIGTERM, bot.js handles it.
STOPSIGNAL SIGTERM

CMD ["node", "bot.js"]
