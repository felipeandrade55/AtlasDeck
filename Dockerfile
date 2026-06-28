# syntax=docker/dockerfile:1.7
# =============================================================================
# AtlasDeck — imagem all-in-one para deploy CONTAINERIZADO (padrão Coolify).
#
# Empacota AtlasDeck (Next.js) + OpenClaw CLI/Gateway, ambos supervisionados
# por PM2 dentro do mesmo container. O app fala com o gateway em 127.0.0.1:18789.
#
# IMPORTANTE: o modo VPS-NATIVO (como roda hoje no VPS do dono) NÃO usa esta
# imagem — continua via `npm run build && npm start` + systemd/PM2 no host.
# Nada aqui altera aquele caminho.
#
# OpenClaw exige Node >= 22.19 — em node:20 o pacote npm resolve para um
# placeholder vazio. Por isso a base é node:22. Veja docs/DEPLOY-COOLIFY.md.
# =============================================================================
ARG NODE_IMAGE=node:22-bookworm-slim
ARG OPENCLAW_VERSION=latest

# ---- Stage 1: build do Next.js ---------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Toolchain para compilar better-sqlite3 (módulo nativo C++).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# O postinstall (scripts/setup-openwakeword.js) roda durante o `npm ci`, então
# a pasta scripts/ precisa existir ANTES da instalação.
COPY scripts ./scripts
RUN npm ci
COPY . .
# Garante os assets de wake-word no public/ (idempotente — postinstall já roda).
RUN node scripts/setup-openwakeword.js || true
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Stage 2: runtime ------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG OPENCLAW_VERSION
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ATLASDECK_DEPLOY_MODE=coolify \
    PORT=3000 \
    OPENCLAW_DIR=/root/.openclaw \
    OPENCLAW_GATEWAY_PORT=18789

# Runtime: curl (healthcheck), bash, openssl; PM2 + OpenClaw globais.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl bash openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g pm2 "openclaw@${OPENCLAW_VERSION}" \
    && npm cache clean --force

# App buildada + node_modules (inclui better-sqlite3 já compilado p/ esta base).
COPY --from=build /app ./

# Orquestração (PM2 + entrypoint anti-falha + wrapper do gateway).
COPY docker/atlasdeck/ecosystem.config.js ./ecosystem.config.js
COPY docker/atlasdeck/start-gateway.sh ./start-gateway.sh
COPY docker/atlasdeck/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh ./start-gateway.sh

EXPOSE 3000
# Coolify/Docker usam isto para saber quando o app está pronto e para self-heal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
