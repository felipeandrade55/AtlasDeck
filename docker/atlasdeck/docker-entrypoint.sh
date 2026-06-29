#!/usr/bin/env bash
# =============================================================================
# Entrypoint idempotente e anti-falha do container all-in-one (modo Coolify).
#
# Objetivos (cliente leigo, zero terminal):
#   1. Garantir os diretórios persistentes (volumes podem montar vazios).
#   2. Semear segredos no primeiro boot e persistir no volume de dados.
#   3. Criar a config baseline do OpenClaw se faltar (idempotente).
#   4. Validar a config (defensivo contra boot-loop por schema inválido).
#   5. Subir AtlasDeck + OpenClaw Gateway via pm2-runtime (PID 1).
# =============================================================================
set -euo pipefail

DATA_DIR="/app/data"
OC_DIR="${OPENCLAW_DIR:-/root/.openclaw}"
WORKSPACE="${OC_DIR}/workspace/mission-control"
SECRETS_FILE="${DATA_DIR}/.container-secrets.env"

log() { echo "[entrypoint] $*"; }
rand() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }

# 1. Diretórios persistentes -------------------------------------------------
mkdir -p "${DATA_DIR}" "${OC_DIR}" "${WORKSPACE}/memory" "${OC_DIR}/logs"

# 1b. Limpa estado de update in-app herdado do volume. Em container a
# atualização é via rebuild da imagem (Coolify), então qualquer
# "update em andamento/erro" persistido é obsoleto após um (re)deploy —
# senão a UI mostra um box de falha antigo (ex.: deploy.sh exit 127).
rm -f "${DATA_DIR}/update-live-status.json" \
      "${DATA_DIR}/update-current.log" \
      "${DATA_DIR}/update-phase-events.log" 2>/dev/null || true

# 2. First-boot seeding de segredos -----------------------------------------
# Reaproveita segredos já persistidos; só gera o que faltar. Envs vindas do
# Coolify (se definidas) têm precedência e nunca são sobrescritas.
if [ -f "${SECRETS_FILE}" ]; then
  set -a; . "${SECRETS_FILE}"; set +a
fi
NEED_PERSIST=0
if [ -z "${AUTH_SECRET:-}" ]; then AUTH_SECRET="$(rand 32 base64)"; NEED_PERSIST=1; fi
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD="$(rand 18 base64 | tr -d '/+=' | cut -c1-20)"; NEED_PERSIST=1
  log "ADMIN_PASSWORD gerado automaticamente (consulte ${SECRETS_FILE} no volume)."
fi
if [ -z "${PENTEST_TOOLBOX_TOKEN:-}" ]; then PENTEST_TOOLBOX_TOKEN="$(rand 24 hex)"; NEED_PERSIST=1; fi
export AUTH_SECRET ADMIN_PASSWORD PENTEST_TOOLBOX_TOKEN
if [ "${NEED_PERSIST}" = "1" ]; then
  ( umask 077; {
      echo "AUTH_SECRET=${AUTH_SECRET}"
      echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
      echo "PENTEST_TOOLBOX_TOKEN=${PENTEST_TOOLBOX_TOKEN}"
    } > "${SECRETS_FILE}" )
  log "Segredos persistidos em ${SECRETS_FILE}."
fi

# 3. Baseline do OpenClaw (idempotente) -------------------------------------
if [ ! -f "${OC_DIR}/openclaw.json" ]; then
  log "Criando config baseline do OpenClaw…"
  openclaw setup --non-interactive --accept-risk --workspace "${WORKSPACE}" \
    >>"${OC_DIR}/logs/setup.log" 2>&1 \
    || log "aviso: 'openclaw setup' retornou erro (seguindo; gateway sobe com --allow-unconfigured)."
fi

# 4. Validação defensiva da config ------------------------------------------
openclaw config validate >/dev/null 2>&1 \
  || log "aviso: 'openclaw config validate' acusou problema (gateway tentará mesmo assim)."

# 5. Sobe tudo ---------------------------------------------------------------
log "Iniciando AtlasDeck + OpenClaw Gateway via PM2…"
exec pm2-runtime start /app/ecosystem.config.js
