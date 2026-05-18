#!/bin/bash
# deploy.sh — Roda no VPS: baixa atualizações do GitHub, build, restart e health check
#
# Uso: ./scripts/deploy.sh

set -eo pipefail

# ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
VPS_DIR="/.openclaw/workspace/mission-control"
BRANCH="main"
REPO_URL="https://github.com/felipeandrade55/AtlasDeck.git"
APP_PORT="3000"
APP_NAME="atlasdeck"
HEALTH_TIMEOUT=90
# ─────────────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

TOTAL_START=$(date +%s)
REPORT=()

step()    { echo -e "\n${CYAN}${BOLD}▶ $1${NC}"; }
ok()      { echo -e "  ${GREEN}✓ $1${NC}"; }
warn()    { echo -e "  ${YELLOW}⚠ $1${NC}"; }
err()     { echo -e "  ${RED}✗ $1${NC}"; }
info()    { echo -e "  ${DIM}$1${NC}"; }
now()     { date +%s; }
elapsed() { echo $(( $(date +%s) - $1 )); }
record()  { REPORT+=("$1|$2|$3"); }

print_report() {
  local total=$(elapsed $TOTAL_START)
  local all_ok=true

  echo -e "\n${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║           RELATÓRIO DO UPDATE            ║${NC}"
  echo -e "${BOLD}${CYAN}╠══════════════════════════════════════════╣${NC}"

  for entry in "${REPORT[@]}"; do
    local name="${entry%%|*}"
    local rest="${entry#*|}"
    local status="${rest%%|*}"
    local dur="${rest##*|}"
    case "$status" in
      ok)   echo -e "  ${GREEN}✓${NC}  ${name} ${DIM}(${dur}s)${NC}" ;;
      skip) echo -e "  ${YELLOW}–${NC}  ${name} ${DIM}(pulado)${NC}" ;;
      fail) echo -e "  ${RED}✗${NC}  ${name} ${DIM}(${dur}s)${NC}"; all_ok=false ;;
    esac
  done

  echo -e "${BOLD}${CYAN}╠══════════════════════════════════════════╣${NC}"
  echo -e "  Tempo total: ${BOLD}${total}s${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}"

  $all_ok && return 0 || return 1
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║       AtlasDeck — Update Script          ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

APP_URL="http://localhost:${APP_PORT}"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 1 — CREDENCIAIS DO GITHUB
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando credenciais do GitHub..."
T=$(now)

HAS_CREDS=$([ -f ~/.git-credentials ] && grep -q 'github.com' ~/.git-credentials 2>/dev/null && echo yes || echo no)

if [[ "$HAS_CREDS" == "yes" ]]; then
  ok "Credenciais já configuradas"
  record "Credenciais GitHub" "ok" "$(elapsed $T)"
else
  warn "Credenciais não encontradas — configurando agora"
  echo ""
  echo -e "  ${DIM}Gere um PAT em: github.com → Settings → Developer settings → Personal access tokens${NC}"
  echo -e "  ${DIM}Escopo necessário: 'repo' (read)${NC}"
  echo ""
  read -rp "  GitHub username : " GH_USER
  read -rsp "  GitHub PAT      : " GH_TOKEN
  echo ""

  git config --global credential.helper store
  printf 'https://%s:%s@github.com\n' "$GH_USER" "$GH_TOKEN" > ~/.git-credentials
  chmod 600 ~/.git-credentials
  git config --global user.name "$GH_USER"
  git config --global user.email "${GH_USER}@users.noreply.github.com"

  ok "Credenciais salvas em ~/.git-credentials"
  record "Credenciais GitHub" "ok" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 2 — CLONE OU PULL
# ══════════════════════════════════════════════════════════════════════════════
step "Atualizando código..."
T=$(now)

if [ -d "$VPS_DIR/.git" ]; then
  info "Repositório encontrado — baixando atualizações..."
  cd "$VPS_DIR"
  git fetch origin
  git reset --hard "origin/$BRANCH"
  ok "Código atualizado (branch: $BRANCH)"
else
  info "Repositório não encontrado — clonando..."
  mkdir -p "$(dirname "$VPS_DIR")"

  if [ -d "$VPS_DIR" ]; then
    BACKUP="${VPS_DIR}_backup_$(date +%Y%m%d_%H%M%S)"
    mv "$VPS_DIR" "$BACKUP"
    warn "Conteúdo anterior salvo em: $BACKUP"
  fi

  git clone "$REPO_URL" "$VPS_DIR"
  ok "Clone concluído"

  if [ -n "${BACKUP:-}" ] && [ -f "$BACKUP/.env" ]; then
    cp "$BACKUP/.env" "$VPS_DIR/.env"
    ok ".env restaurado do backup"
  elif [ -f "$VPS_DIR/.env.example" ]; then
    cp "$VPS_DIR/.env.example" "$VPS_DIR/.env"
    warn ".env criado do .env.example — revise as variáveis em $VPS_DIR/.env"
  fi
fi

record "Git clone/pull" "ok" "$(elapsed $T)"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 3 — DEPENDÊNCIAS
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando dependências..."
T=$(now)

cd "$VPS_DIR"

NEEDS_INSTALL=false
if [ ! -d "node_modules" ]; then
  info "node_modules ausente"
  NEEDS_INSTALL=true
elif git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -qE "package.*json"; then
  info "package.json modificado"
  NEEDS_INSTALL=true
fi

if $NEEDS_INSTALL; then
  npm install --production=false
  ok "npm install concluído"
  record "npm install" "ok" "$(elapsed $T)"
else
  ok "Sem novas dependências"
  record "npm install" "skip" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 4 — BUILD
# ══════════════════════════════════════════════════════════════════════════════
step "Build..."
T=$(now)

cd "$VPS_DIR"

# Limpa cache do Next.js para garantir build limpo
if [ -d ".next" ]; then
  rm -rf .next
  info "Cache .next removido"
fi

npm run build
ok "Build concluído"
record "Build" "ok" "$(elapsed $T)"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 5 — PM2
# ══════════════════════════════════════════════════════════════════════════════
step "Gerenciando processo ($APP_NAME)..."
T=$(now)

if ! command -v pm2 &>/dev/null; then
  warn "PM2 não encontrado — instalando..."
  npm install -g pm2
  ok "PM2 instalado"
fi

if pm2 list 2>/dev/null | grep -q "$APP_NAME"; then
  pm2 restart "$APP_NAME" --update-env
  ok "PM2: processo reiniciado"
else
  cd "$VPS_DIR"
  pm2 start npm --name "$APP_NAME" -- start
  pm2 save 2>/dev/null || true
  pm2 startup 2>/dev/null | grep -E "^sudo|^env" | bash 2>/dev/null || true
  ok "PM2: processo iniciado"
fi

record "PM2 restart" "ok" "$(elapsed $T)"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 6 — HEALTH CHECK: DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════
step "Health check — aguardando dashboard ($APP_URL)..."
T=$(now)
DASH_OK=false
LAST_CODE="000"

for i in $(seq 1 $HEALTH_TIMEOUT); do
  LAST_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 2 --max-time 4 "$APP_URL" 2>/dev/null || echo "000")

  if [[ "$LAST_CODE" =~ ^(200|301|302|307|308)$ ]]; then
    DASH_OK=true
    echo ""
    ok "Dashboard online — HTTP $LAST_CODE (${i}s)"
    record "Dashboard" "ok" "$(elapsed $T)"
    break
  fi

  printf "\r  ${DIM}Aguardando... [%2ds / %ds]  HTTP: %s${NC}   " \
    "$i" "$HEALTH_TIMEOUT" "$LAST_CODE"
  sleep 1
done

echo ""

if ! $DASH_OK; then
  err "Dashboard não respondeu após ${HEALTH_TIMEOUT}s (último HTTP: $LAST_CODE)"
  warn "Veja os logs: pm2 logs $APP_NAME --lines 80"
  record "Dashboard" "fail" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 7 — HEALTH CHECK: SERVIÇOS VIA /api/health
# ══════════════════════════════════════════════════════════════════════════════
step "Health check — serviços internos (/api/health)..."
T=$(now)

HEALTH_JSON=$(curl -s --connect-timeout 5 --max-time 10 \
  "$APP_URL/api/health" 2>/dev/null || echo "")

if [[ -n "$HEALTH_JSON" ]] && echo "$HEALTH_JSON" | grep -q '"status"'; then
  OVERALL=$(echo "$HEALTH_JSON" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

  case "$OVERALL" in
    healthy)  ok "Status geral: HEALTHY"; record "Serviços (/api/health)" "ok" "$(elapsed $T)" ;;
    degraded) warn "Status geral: DEGRADED"; record "Serviços (/api/health)" "fail" "$(elapsed $T)" ;;
    critical) err "Status geral: CRITICAL"; record "Serviços (/api/health)" "fail" "$(elapsed $T)" ;;
    *)        warn "Status geral: $OVERALL"; record "Serviços (/api/health)" "skip" "$(elapsed $T)" ;;
  esac

  # Exibe cada serviço individualmente
  echo ""
  echo -e "  ${DIM}Detalhes dos serviços:${NC}"
  echo "$HEALTH_JSON" | grep -o '"name":"[^"]*","status":"[^"]*"' | while IFS= read -r line; do
    SVC_NAME=$(echo "$line" | cut -d'"' -f4)
    SVC_STATUS=$(echo "$line" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    case "$SVC_STATUS" in
      up)      echo -e "    ${GREEN}✓${NC} $SVC_NAME" ;;
      down)    echo -e "    ${RED}✗${NC} $SVC_NAME" ;;
      degraded)echo -e "    ${YELLOW}⚠${NC} $SVC_NAME" ;;
      *)       echo -e "    ${DIM}–${NC} $SVC_NAME ($SVC_STATUS)" ;;
    esac
  done
  echo ""
else
  warn "Não foi possível consultar /api/health (dashboard ainda iniciando?)"
  record "Serviços (/api/health)" "skip" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 8 — HEALTH CHECK: OPENCLAW CLI
# ══════════════════════════════════════════════════════════════════════════════
step "Health check — OpenClaw..."
T=$(now)

# Gateway via systemd
GATEWAY_STATUS=$(systemctl is-active openclaw-gateway 2>/dev/null || echo "unknown")
if [[ "$GATEWAY_STATUS" == "active" ]]; then
  ok "openclaw-gateway: active (systemd)"
  record "OpenClaw Gateway" "ok" "$(elapsed $T)"
else
  warn "openclaw-gateway: $GATEWAY_STATUS"
  record "OpenClaw Gateway" "fail" "$(elapsed $T)"
fi

# OpenClaw CLI status
if command -v openclaw &>/dev/null; then
  OPENCLAW_OUT=$(openclaw status 2>/dev/null | head -5 || echo "")
  if [[ -n "$OPENCLAW_OUT" ]]; then
    ok "openclaw status:"
    echo "$OPENCLAW_OUT" | while IFS= read -r line; do
      echo -e "    ${DIM}$line${NC}"
    done
  else
    warn "openclaw status não retornou saída"
  fi
else
  warn "CLI 'openclaw' não encontrada no PATH"
fi

# ══════════════════════════════════════════════════════════════════════════════
# RELATÓRIO FINAL
# ══════════════════════════════════════════════════════════════════════════════
echo ""
if print_report; then
  echo -e "\n  ${GREEN}${BOLD}🚀 Update concluído com sucesso!${NC}"
  echo -e "  ${DIM}Dashboard: ${APP_URL}${NC}\n"
else
  echo -e "\n  ${YELLOW}${BOLD}⚠ Update com problemas — veja o relatório acima.${NC}\n"
fi
