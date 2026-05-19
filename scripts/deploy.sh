#!/bin/bash
# deploy.sh — Roda no VPS: baixa atualizações do GitHub, build, restart e health check
#
# Uso: ./scripts/deploy.sh [--bidirecional]
#
# Sem flags:        pull destrutivo (GitHub → VPS). Mudanças locais no VPS são descartadas.
# --bidirecional:   antes do pull, commita e dá push em qualquer alteração feita no VPS,
#                   sincronizando VPS → GitHub. Requer PAT com escopo 'repo' (write).

set -eo pipefail

# ─── AUTO-PRESERVAÇÃO ─────────────────────────────────────────────────────────
# Copia o script para /tmp e re-executa de lá. Assim, o git reset --hard
# pode sobrescrever scripts/deploy.sh no repositório sem interromper a execução.
if [[ "${_DEPLOY_SAFE:-}" != "1" ]]; then
  _TMP=$(mktemp /tmp/deploy.XXXXXX.sh)
  cp "$0" "$_TMP"
  chmod +x "$_TMP"
  _DEPLOY_SAFE=1 exec "$_TMP" "$@"
fi
# ─────────────────────────────────────────────────────────────────────────────

# ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
VPS_DIR="${HOME}/.openclaw/workspace/mission-control"
BRANCH="main"
REPO_URL="https://github.com/felipeandrade55/AtlasDeck.git"
APP_PORT="3000"
APP_NAME="atlasdeck"
HEALTH_TIMEOUT=90
GH_GIT_NAME="felipeandrade55"
GH_GIT_EMAIL="felipeandrade55@gmail.com"
# ─────────────────────────────────────────────────────────────────────────────

# ─── PARSE DE ARGUMENTOS ──────────────────────────────────────────────────────
BIDIRECTIONAL=false
for arg in "$@"; do
  case "$arg" in
    --bidirecional|--bidirectional)
      BIDIRECTIONAL=true
      ;;
    -h|--help)
      cat <<EOF
Uso: $0 [opções]

Opções:
  --bidirecional   Antes de puxar do GitHub, commita e dá push em qualquer
                   alteração local detectada no VPS (sincronização VPS → GitHub).
                   Requer PAT com escopo 'repo' (write).
  -h, --help       Exibe esta ajuda.

Sem flags, opera em modo padrão (apenas pull destrutivo: GitHub → VPS).
EOF
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $arg (use --help)" >&2
      exit 1
      ;;
  esac
done
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

if $BIDIRECTIONAL; then
  echo -e "  ${YELLOW}${BOLD}Modo:${NC} ${YELLOW}BIDIRECIONAL${NC} ${DIM}(VPS → GitHub antes do pull)${NC}\n"
else
  echo -e "  ${DIM}Modo: padrão (GitHub → VPS, sem push)${NC}\n"
fi

APP_URL="http://localhost:${APP_PORT}"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 1 — CREDENCIAIS DO GITHUB
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando credenciais do GitHub..."
T=$(now)

# Identidade git sempre configurada com os valores fixos do projeto
git config --global credential.helper store
git config --global user.name  "$GH_GIT_NAME"
git config --global user.email "$GH_GIT_EMAIL"

HAS_CREDS=$([ -f ~/.git-credentials ] && grep -q 'github.com' ~/.git-credentials 2>/dev/null && echo yes || echo no)

if [[ "$HAS_CREDS" == "yes" ]]; then
  ok "Credenciais já configuradas ($GH_GIT_EMAIL)"
  record "Credenciais GitHub" "ok" "$(elapsed $T)"
else
  warn "Credenciais não encontradas — informe login e PAT"
  echo ""
  echo -e "  ${DIM}PAT em: github.com → Settings → Developer settings → Personal access tokens${NC}"
  echo -e "  ${DIM}Escopo necessário: 'repo' (write para --bidirecional, read para pull simples)${NC}"
  echo ""
  read -rp "  GitHub login : " GH_USER
  read -rsp "  GitHub PAT   : " GH_TOKEN
  echo ""

  printf 'https://%s:%s@github.com\n' "$GH_USER" "$GH_TOKEN" > ~/.git-credentials
  chmod 600 ~/.git-credentials

  ok "Credenciais salvas (~/.git-credentials)"
  record "Credenciais GitHub" "ok" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 2 — CLONE OU PULL
# ══════════════════════════════════════════════════════════════════════════════
step "Atualizando código..."
T=$(now)

if [ -d "$VPS_DIR/.git" ]; then
  cd "$VPS_DIR"

  if $BIDIRECTIONAL; then
    info "Verificando alterações locais no VPS..."

    if [[ -n "$(git status --porcelain)" ]]; then
      warn "Alterações locais detectadas — enviando para o GitHub antes de puxar"

      git add -A
      git commit -m "auto(vps): sync local changes from $(hostname) [$(date +'%Y-%m-%d %H:%M:%S')]"

      # Tenta push direto; se remoto adiantou-se, faz rebase e tenta de novo
      if ! git push origin "$BRANCH"; then
        warn "Remoto à frente — sincronizando via rebase..."
        if ! git pull --rebase origin "$BRANCH"; then
          err "Conflito durante rebase — abortando para preservar o estado"
          git rebase --abort 2>/dev/null || true
          record "Sync bidirecional" "fail" "$(elapsed $T)"
          exit 1
        fi
        git push origin "$BRANCH"
      fi
      ok "Alterações do VPS publicadas no GitHub"
    else
      info "Sem alterações locais no VPS"
    fi
  else
    info "Repositório encontrado — baixando atualizações..."
  fi

  # Garante que origin aponta para o repositório correto (auto-corrige se necessário)
  _CURRENT_ORIGIN=$(git remote get-url origin 2>/dev/null || echo "")
  if [[ "$_CURRENT_ORIGIN" != "$REPO_URL" ]]; then
    warn "Remote 'origin' incorreto ($_CURRENT_ORIGIN) — corrigindo..."
    git remote set-url origin "$REPO_URL" 2>/dev/null || git remote add origin "$REPO_URL"
    ok "Remote 'origin' corrigido para $REPO_URL"
  fi

  git fetch origin

  # Se .env agora é rastreado no remoto mas ainda existe como arquivo não-rastreado
  # localmente (situação de migração), remove-o para que o git reset possa criá-lo
  # a partir do repositório. O backup garante que credenciais locais não se percam.
  if git ls-tree --name-only "origin/$BRANCH" .env 2>/dev/null | grep -q '^\.env$'; then
    if [ -f .env ] && ! git ls-files --error-unmatch .env 2>/dev/null; then
      ENV_BACKUP=".env.bak.$(date +%Y%m%d_%H%M%S)"
      cp .env "$ENV_BACKUP"
      rm .env
      warn ".env local não-rastreado encontrado — backup em $ENV_BACKUP, usando versão do repositório"
    fi
  fi

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
  if npm ci 2>/dev/null; then
    ok "npm ci concluído"
  else
    warn "npm ci falhou (lock file desatualizado?) — usando npm install..."
    npm install
    ok "npm install concluído"
  fi
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

# Libera a porta se estiver ocupada por processo órfão (fora do PM2)
ORPHAN_PID=$(lsof -ti :"$APP_PORT" 2>/dev/null | head -1)
if [[ -n "$ORPHAN_PID" ]]; then
  PM2_PIDS=$(pm2 list 2>/dev/null | grep -oP '\d+(?=\s+\|)' || true)
  if ! echo "$PM2_PIDS" | grep -qw "$ORPHAN_PID"; then
    warn "Porta $APP_PORT ocupada pelo PID $ORPHAN_PID (fora do PM2) — liberando..."
    kill -9 "$ORPHAN_PID" 2>/dev/null || true
    sleep 1
    ok "Porta $APP_PORT liberada"
  fi
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
# FASE 8 — OPENCLAW GATEWAY
# ══════════════════════════════════════════════════════════════════════════════
step "OpenClaw Gateway..."
T=$(now)

GATEWAY_STATUS=$(systemctl is-active openclaw-gateway 2>/dev/null || echo "unknown")

if [[ "$GATEWAY_STATUS" == "active" ]]; then
  ok "openclaw-gateway: active"
  record "OpenClaw Gateway" "ok" "$(elapsed $T)"
else
  warn "openclaw-gateway: $GATEWAY_STATUS — tentando iniciar..."

  if systemctl start openclaw-gateway 2>/dev/null; then
    sleep 3
    GATEWAY_STATUS=$(systemctl is-active openclaw-gateway 2>/dev/null || echo "unknown")

    if [[ "$GATEWAY_STATUS" == "active" ]]; then
      ok "openclaw-gateway iniciado com sucesso"
      record "OpenClaw Gateway" "ok" "$(elapsed $T)"
    else
      err "openclaw-gateway não subiu após start (status: $GATEWAY_STATUS)"
      info "Verifique: journalctl -u openclaw-gateway -n 30 --no-pager"
      record "OpenClaw Gateway" "fail" "$(elapsed $T)"
    fi
  else
    err "Falha ao executar 'systemctl start openclaw-gateway'"
    info "Verifique: journalctl -u openclaw-gateway -n 30 --no-pager"
    record "OpenClaw Gateway" "fail" "$(elapsed $T)"
  fi
fi

# OpenClaw CLI status
if command -v openclaw &>/dev/null; then
  OPENCLAW_OUT=$(openclaw status 2>/dev/null | grep -v '^$' | head -8 || echo "")
  if [[ -n "$OPENCLAW_OUT" ]]; then
    info "openclaw status:"
    echo "$OPENCLAW_OUT" | while IFS= read -r line; do
      echo -e "    ${DIM}$line${NC}"
    done
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 9 — SEGURANÇA: FAIL2BAN
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando Fail2Ban (Proteção contra Brute Force)..."
T=$(now)

if ! command -v fail2ban-client &>/dev/null; then
  echo ""
  read -rp "  Deseja instalar e configurar o Fail2Ban para proteger contra brute force? (y/N): " INSTALL_F2B
  if [[ "$INSTALL_F2B" =~ ^[Yy]$ ]]; then
    info "Instalando fail2ban..."
    sudo apt-get update -qq && sudo apt-get install -y fail2ban
    
    if [ ! -f /etc/fail2ban/jail.local ]; then
      cat <<EOF | sudo tee /etc/fail2ban/jail.local > /dev/null
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
EOF
      sudo systemctl restart fail2ban
    fi
    ok "Fail2Ban instalado e Jail SSH ativa"
    record "Fail2Ban Setup" "ok" "\$(elapsed \$T)"
  else
    warn "Instalação do Fail2Ban ignorada."
    record "Fail2Ban Setup" "skip" "\$(elapsed \$T)"
  fi
else
  ok "Fail2Ban já está instalado e ativo"
  record "Fail2Ban Setup" "ok" "\$(elapsed \$T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 10 — FIREWALL UFW
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando Firewall (UFW)..."
T=$(now)

if ! command -v ufw &>/dev/null; then
  warn "UFW (Firewall) não encontrado no sistema."
  record "Firewall UFW" "skip" "\$(elapsed \$T)"
else
  if sudo ufw status | grep -qi "Status: active"; then
    ok "Firewall UFW já está ativo"
    record "Firewall UFW" "ok" "\$(elapsed \$T)"
  else
    echo ""
    read -rp "  Deseja ativar o Firewall (UFW) com portas padrão (SSH, 80, 443, 3000)? (y/N): " ENABLE_UFW
    if [[ "$ENABLE_UFW" =~ ^[Yy]$ ]]; then
      info "Configurando regras padrão..."
      sudo ufw allow ssh > /dev/null
      sudo ufw allow http > /dev/null
      sudo ufw allow https > /dev/null
      sudo ufw allow 3000/tcp > /dev/null
      sudo ufw --force enable > /dev/null
      ok "Firewall ativado com segurança padrão"
      record "Firewall UFW" "ok" "\$(elapsed \$T)"
    else
      warn "Ativação do Firewall ignorada."
      record "Firewall UFW" "skip" "\$(elapsed \$T)"
    fi
  fi
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
