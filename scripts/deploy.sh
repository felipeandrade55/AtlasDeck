#!/bin/bash
# deploy.sh — Roda no VPS: baixa atualizações do GitHub, build, restart e health check
#
# Uso: ./scripts/deploy.sh [--bidirecional] [--headless] [--with-backup] [--status-file PATH]
#
# Sem flags:        pull destrutivo (GitHub → VPS). Mudanças locais no VPS são descartadas.
# --bidirecional:   antes do pull, commita e dá push em qualquer alteração feita no VPS,
#                   sincronizando VPS → GitHub. Requer PAT com escopo 'repo' (write).
# --headless:       modo não-interativo para CI/automação (sem cores, sem prompts).
# --with-backup:    executa uma fase de backup (tar do data/ + .env + workspace OpenClaw)
#                   antes do pull. Usado pelo update via interface.
# --status-file P:  escreve atualizações JSON de fase em P (consumido pela UI).

set -eo pipefail

# Quick pre-scan for flags
_HEADLESS_PRESCAN=false
_STATUS_FILE=""
_PREV_ARG=""
for _arg in "$@"; do
  [[ "$_arg" == "--headless" ]] && _HEADLESS_PRESCAN=true
  if [[ "$_PREV_ARG" == "--status-file" ]]; then
    _STATUS_FILE="$_arg"
  fi
  _PREV_ARG="$_arg"
done

# ─── AUTO-PRESERVAÇÃO ─────────────────────────────────────────────────────────
# Copia o script para /tmp e re-executa de lá. Sempre, inclusive em headless:
# o git reset --hard pode sobrescrever scripts/deploy.sh enquanto roda.
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
HEADLESS=false
WITH_BACKUP=false
STATUS_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bidirecional|--bidirectional)
      BIDIRECTIONAL=true
      shift
      ;;
    --headless)
      HEADLESS=true
      shift
      ;;
    --with-backup)
      WITH_BACKUP=true
      shift
      ;;
    --status-file)
      STATUS_FILE="$2"
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Uso: $0 [opções]

Opções:
  --bidirecional       Antes de puxar do GitHub, commita e dá push em qualquer
                       alteração local detectada no VPS (sincronização VPS → GitHub).
                       Requer PAT com escopo 'repo' (write).
  --headless           Modo não-interativo para CI/automação. Pula prompts
                       interativos (credenciais, Fail2Ban, UFW) e desabilita
                       cores na saída. Credenciais devem estar pré-configuradas.
  --with-backup        Executa backup (tar) do data/ e workspace antes do pull.
  --status-file PATH   Escreve atualizações JSON de fase no arquivo PATH.
  -h, --help           Exibe esta ajuda.

Sem flags, opera em modo padrão (apenas pull destrutivo: GitHub → VPS).
EOF
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $1 (use --help)" >&2
      exit 1
      ;;
  esac
done
# ─────────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && ! $HEADLESS; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
  RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; CYAN=''
  RED=''; BOLD=''; DIM=''; NC=''
fi

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

# ─── STATUS FILE WRITER ───────────────────────────────────────────────────────
# Escreve uma linha JSON com a fase atual e seu status no arquivo de status.
# Formato: { "phase": "backup", "status": "running", "ts": "...", "durationSec": 0 }
phase_status() {
  local phase="$1"
  local status="$2"
  local duration="${3:-0}"
  local error_msg="${4:-}"

  [[ -z "$STATUS_FILE" ]] && return 0

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  local err_json=""
  if [[ -n "$error_msg" ]]; then
    err_json=",\"error\":$(printf '%s' "$error_msg" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$error_msg\"")"
  fi

  # Append-only newline-delimited JSON for atomic writes
  printf '{"phase":"%s","status":"%s","ts":"%s","durationSec":%d%s}\n' \
    "$phase" "$status" "$ts" "$duration" "$err_json" >> "$STATUS_FILE"
}

# Heartbeat: registra que o processo está vivo
heartbeat() {
  [[ -z "$STATUS_FILE" ]] && return 0
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  printf '{"heartbeat":"%s"}\n' "$ts" >> "$STATUS_FILE"
}
# ─────────────────────────────────────────────────────────────────────────────

# ─── EXIT TRAP ────────────────────────────────────────────────────────────────
# Se o script morrer sem passar pela fase "done" (sigkill por OOM, panic do
# kernel, /tmp limpo, deploy disparado por engano em paralelo, etc.) escrevemos
# um evento terminal de falha. Sem isso a UI fica eternamente em "Compilando…".
_TERMINAL_EMITTED=false
emit_terminal() {
  if [[ "$_TERMINAL_EMITTED" == "true" ]] || [[ -z "$STATUS_FILE" ]]; then
    return 0
  fi
  _TERMINAL_EMITTED=true
  local code="$1"
  if [[ "$code" == "0" ]]; then
    phase_status "done" "ok" "$(elapsed $TOTAL_START)"
  else
    phase_status "done" "fail" "$(elapsed $TOTAL_START)" \
      "deploy.sh saiu com exit code $code antes de chegar ao fim (sinal externo, panic ou erro fatal)"
  fi
}

# Captura EXIT (saída normal + erros) e os sinais comuns de terminação.
# bash não dispara o trap EXIT para SIGKILL — esse caso fica órfão e é
# coberto pela detecção de heartbeat stale na UI (>60s).
trap 'emit_terminal $?' EXIT
trap 'emit_terminal 130' INT
trap 'emit_terminal 143' TERM
# ─────────────────────────────────────────────────────────────────────────────

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

# Cleanup status file
if [[ -n "$STATUS_FILE" ]]; then
  mkdir -p "$(dirname "$STATUS_FILE")"
  : > "$STATUS_FILE"
  phase_status "start" "running"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 0 — BACKUP (opcional)
# ══════════════════════════════════════════════════════════════════════════════
if $WITH_BACKUP; then
  step "Backup pré-update..."
  T=$(now)
  phase_status "backup" "running"

  # Determina o diretório do projeto. Quando chamado pela UI o cwd já é o VPS_DIR;
  # se for outro caso, tenta VPS_DIR como fallback.
  PROJ_DIR="$(pwd)"
  if [ ! -f "$PROJ_DIR/package.json" ] && [ -d "$VPS_DIR" ]; then
    PROJ_DIR="$VPS_DIR"
  fi

  BACKUP_DIR="$PROJ_DIR/data/backups"
  mkdir -p "$BACKUP_DIR"

  BACKUP_TS=$(date +%Y-%m-%d_%H-%M-%S)
  BACKUP_FILE="$BACKUP_DIR/openclaw-backup_${BACKUP_TS}.tar.gz"

  # Constrói lista de paths para o tar
  BACKUP_LIST=$(mktemp)
  [ -d "$PROJ_DIR/data" ] && echo "$PROJ_DIR/data" >> "$BACKUP_LIST"
  [ -f "$PROJ_DIR/.env" ] && echo "$PROJ_DIR/.env" >> "$BACKUP_LIST"

  # Diretório OpenClaw
  OPENCLAW_BASE="${OPENCLAW_DIR:-$HOME/.openclaw}"
  if [ -d "$OPENCLAW_BASE" ]; then
    [ -f "$OPENCLAW_BASE/openclaw.json" ] && echo "$OPENCLAW_BASE/openclaw.json" >> "$BACKUP_LIST"
    [ -d "$OPENCLAW_BASE/agents" ] && echo "$OPENCLAW_BASE/agents" >> "$BACKUP_LIST"
    [ -d "$OPENCLAW_BASE/skills" ] && echo "$OPENCLAW_BASE/skills" >> "$BACKUP_LIST"
    [ -d "$OPENCLAW_BASE/media" ] && echo "$OPENCLAW_BASE/media" >> "$BACKUP_LIST"
  fi

  PATH_COUNT=$(wc -l < "$BACKUP_LIST" | tr -d ' ')
  info "Compactando $PATH_COUNT path(s) → $(basename "$BACKUP_FILE")"

  # Roda tar em background para emitir heartbeats periódicos
  (
    tar --exclude="node_modules" \
        --exclude=".next" \
        --exclude="data/backups" \
        --exclude=".git" \
        --exclude="*.tar.gz" \
        --exclude="*.log" \
        -czf "$BACKUP_FILE" \
        -T "$BACKUP_LIST" 2>&1
  ) &
  TAR_PID=$!

  # Emite progresso enquanto tar roda
  PROGRESS_COUNTER=0
  while kill -0 $TAR_PID 2>/dev/null; do
    sleep 3
    PROGRESS_COUNTER=$((PROGRESS_COUNTER + 3))
    if [ -f "$BACKUP_FILE" ]; then
      SIZE=$(du -h "$BACKUP_FILE" 2>/dev/null | cut -f1)
      info "Backup em andamento... ${PROGRESS_COUNTER}s (atual: $SIZE)"
    else
      info "Backup em andamento... ${PROGRESS_COUNTER}s"
    fi
    heartbeat
  done

  wait $TAR_PID
  TAR_EXIT=$?
  rm -f "$BACKUP_LIST"

  if [ $TAR_EXIT -eq 0 ] && [ -f "$BACKUP_FILE" ]; then
    chmod 600 "$BACKUP_FILE" 2>/dev/null || true
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    ok "Backup concluído: $(basename "$BACKUP_FILE") ($SIZE)"
    record "Backup pré-update" "ok" "$(elapsed $T)"
    phase_status "backup" "ok" "$(elapsed $T)"

    # Aplica retenção: mantém últimos 5 backups
    cd "$BACKUP_DIR"
    ls -1t openclaw-backup_*.tar.gz 2>/dev/null | tail -n +6 | while IFS= read -r old; do
      rm -f "$old"
      info "Retenção: removido $old"
    done
  else
    err "Backup falhou (exit $TAR_EXIT)"
    record "Backup pré-update" "fail" "$(elapsed $T)"
    phase_status "backup" "fail" "$(elapsed $T)" "tar exit $TAR_EXIT"
    exit 1
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 1 — CREDENCIAIS DO GITHUB
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando credenciais do GitHub..."
T=$(now)
phase_status "credentials" "running"

# Identidade git sempre configurada com os valores fixos do projeto
git config --global credential.helper store
git config --global user.name  "$GH_GIT_NAME"
git config --global user.email "$GH_GIT_EMAIL"

HAS_CREDS=$([ -f ~/.git-credentials ] && grep -q 'github.com' ~/.git-credentials 2>/dev/null && echo yes || echo no)

if [[ "$HAS_CREDS" == "yes" ]]; then
  ok "Credenciais já configuradas ($GH_GIT_EMAIL)"
  record "Credenciais GitHub" "ok" "$(elapsed $T)"
  phase_status "credentials" "ok" "$(elapsed $T)"
else
  if $HEADLESS; then
    warn "Credenciais não encontradas — modo headless, pulando prompt interativo."
    warn "Configure ~/.git-credentials manualmente antes de executar em modo headless."
    record "Credenciais GitHub" "skip" "$(elapsed $T)"
    phase_status "credentials" "skip" "$(elapsed $T)"
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
    phase_status "credentials" "ok" "$(elapsed $T)"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 2 — CLONE OU PULL
# ══════════════════════════════════════════════════════════════════════════════
step "Atualizando código..."
T=$(now)
phase_status "git-pull" "running"

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
          phase_status "git-pull" "fail" "$(elapsed $T)" "rebase conflict"
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
phase_status "git-pull" "ok" "$(elapsed $T)"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 3 — DEPENDÊNCIAS
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando dependências..."
T=$(now)
phase_status "npm-install" "running"

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
  # IMPORTANTE: --include=dev é obrigatório. O deploy.sh é chamado pelo
  # Next.js gerenciado por PM2, que define NODE_ENV=production. Sem o
  # flag, npm ci omite devDependencies — e o build precisa delas (tsx,
  # @tailwindcss/postcss, @types/*). Causava "Cannot find module" no
  # build phase e o app ficava sem .next (apagado antes do build).
  if npm ci --include=dev 2>/dev/null; then
    ok "npm ci concluído (com devDependencies)"
  else
    warn "npm ci falhou (lock file desatualizado?) — usando npm install..."
    npm install --include=dev
    ok "npm install concluído (com devDependencies)"
  fi
  record "npm install" "ok" "$(elapsed $T)"
  phase_status "npm-install" "ok" "$(elapsed $T)"
else
  ok "Sem novas dependências"
  record "npm install" "skip" "$(elapsed $T)"
  phase_status "npm-install" "skip" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 3.5 — SETUP DA MEMÓRIA (Xenova model + SQLite indexes)
# ══════════════════════════════════════════════════════════════════════════════
step "Setup do subsistema de memória..."
T=$(now)
phase_status "setup-memory" "running"

cd "$VPS_DIR"

# Idempotente: cria DBs vazios (se não existirem) e pré-aquece o modelo de
# embeddings (~30MB Xenova/all-MiniLM-L6-v2). Erros não interrompem o deploy.
if npm run setup:memory --silent 2>&1 | tee -a /tmp/setup-memory.log | tail -20; then
  ok "Setup da memória concluído"
  record "Setup memória" "ok" "$(elapsed $T)"
  phase_status "setup-memory" "ok" "$(elapsed $T)"
else
  warn "Setup da memória teve avisos (não bloqueia o deploy)"
  record "Setup memória" "skip" "$(elapsed $T)"
  phase_status "setup-memory" "skip" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 3.6 — OLLAMA (opcional, soft-fail)
# ══════════════════════════════════════════════════════════════════════════════
# Garante que Ollama está instalado para servir como LLM local gratuita
# (alternativa ao OpenClaw). O script oficial já faz systemctl enable +
# start, então fica habilitado no boot automaticamente.
#
# Não baixa modelo aqui — Qwen 2.5 7B são ~5 GB e isso inflaria o deploy
# desnecessariamente. O usuário baixa pelo wizard de boas-vindas quando
# escolher Ollama como provider.
#
# Soft-fail: se o install falhar (sem internet, plataforma não suportada,
# etc.), apenas avisa. O AtlasDeck funciona sem Ollama (OpenClaw cobre).
step "Ollama (LLM local opcional)..."
T=$(now)
phase_status "ollama-install" "running"

if command -v ollama &>/dev/null; then
  OLLAMA_VER=$(ollama --version 2>/dev/null | head -1 | tr -d '\n' || echo "desconhecida")
  ok "Ollama já instalado ($OLLAMA_VER)"
  record "Ollama install" "skip" "$(elapsed $T)"
  phase_status "ollama-install" "skip" "$(elapsed $T)"
elif [[ "$(uname -s)" != "Linux" ]]; then
  warn "Auto-install do Ollama só suportado em Linux — pulando (instale pela UI ou manualmente em ollama.com/download)"
  record "Ollama install" "skip" "$(elapsed $T)"
  phase_status "ollama-install" "skip" "$(elapsed $T)"
else
  info "Instalando Ollama via script oficial (curl | sh)..."
  if curl -fsSL https://ollama.com/install.sh | sh 2>&1 | tee -a /tmp/ollama-install.log | tail -10; then
    if command -v ollama &>/dev/null; then
      ok "Ollama instalado e habilitado no boot (systemd)"
      info "Modelos são baixados sob demanda pela UI (Memória → Extrator)"
      record "Ollama install" "ok" "$(elapsed $T)"
      phase_status "ollama-install" "ok" "$(elapsed $T)"
    else
      warn "Script rodou mas comando 'ollama' não está no PATH — verifique /tmp/ollama-install.log"
      record "Ollama install" "fail" "$(elapsed $T)"
      phase_status "ollama-install" "fail" "$(elapsed $T)" "binary not found in PATH after install"
    fi
  else
    warn "Falha ao instalar Ollama — continuando sem ele (AtlasDeck funciona com OpenClaw)"
    record "Ollama install" "fail" "$(elapsed $T)"
    phase_status "ollama-install" "fail" "$(elapsed $T)" "install script exit $?"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 4 — BUILD
# ══════════════════════════════════════════════════════════════════════════════
step "Build..."
T=$(now)
phase_status "build" "running"

cd "$VPS_DIR"

# Swap atômico do .next: preservamos o build anterior em .next.prev. Se
# o novo build falhar, restauramos pra que o app continue servindo a
# versão antiga (sem 500 nos chunks). Antes a gente apagava .next aqui
# e, se o build falhasse, a app ficava sem build → 500 em todo chunk.
if [ -d ".next" ]; then
  rm -rf .next.prev 2>/dev/null || true
  mv .next .next.prev
  info ".next anterior preservado em .next.prev (restaurado se build falhar)"
fi

# Build em background para emitir heartbeats periódicos
(npm run build 2>&1) &
BUILD_PID=$!

PROGRESS_COUNTER=0
while kill -0 $BUILD_PID 2>/dev/null; do
  sleep 5
  PROGRESS_COUNTER=$((PROGRESS_COUNTER + 5))
  info "Build em andamento... ${PROGRESS_COUNTER}s"
  heartbeat
done

wait $BUILD_PID
BUILD_EXIT=$?

if [ $BUILD_EXIT -ne 0 ]; then
  err "Build falhou (exit $BUILD_EXIT)"
  # Restaura o build anterior pra app não ficar quebrada
  if [ -d ".next.prev" ]; then
    rm -rf .next 2>/dev/null || true
    mv .next.prev .next
    warn ".next anterior restaurado — app continua servindo a versão antiga"
  fi
  record "Build" "fail" "$(elapsed $T)"
  phase_status "build" "fail" "$(elapsed $T)" "build exit $BUILD_EXIT"
  exit 1
fi

# Build OK — descarta backup do .next anterior
rm -rf .next.prev 2>/dev/null || true

ok "Build concluído"
record "Build" "ok" "$(elapsed $T)"
phase_status "build" "ok" "$(elapsed $T)"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 5 — PM2
# ══════════════════════════════════════════════════════════════════════════════
step "Gerenciando processo ($APP_NAME)..."
T=$(now)
phase_status "pm2-restart" "running"

if ! command -v pm2 &>/dev/null; then
  warn "PM2 não encontrado — instalando..."
  npm install -g pm2
  ok "PM2 instalado"
fi

# Libera a porta se estiver ocupada por processo órfão (fora do PM2)
ORPHAN_PID=$(lsof -ti :"$APP_PORT" 2>/dev/null | head -1 || true)
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
  # Verifica se CWD do processo PM2 bate com $VPS_DIR e se está em modo de produção.
  # Se não bater, faz delete + start para garantir que o servidor enxergue o .next correto.
  EXISTING_INFO=$(pm2 jlist 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);const p=a.find(x=>x.name==='$APP_NAME');process.stdout.write((p?.pm2_env?.pm_cwd||'') + '|' + (p?.pm2_env?.args||[]).join(' '))}catch{}})" \
    2>/dev/null || echo "|")

  EXISTING_CWD="${EXISTING_INFO%%|*}"
  EXISTING_ARGS="${EXISTING_INFO#*|}"

  if [[ "$EXISTING_CWD" != "$VPS_DIR" ]] || [[ "$EXISTING_ARGS" == *"dev"* ]]; then
    warn "PM2 configurado incorretamente (CWD divergente ou modo Dev detectado) — recriando processo para Produção"
    pm2 delete "$APP_NAME" 2>/dev/null || true
    cd "$VPS_DIR"
    pm2 start npm --name "$APP_NAME" -- start
    pm2 save 2>/dev/null || true
    ok "PM2: processo de produção recriado a partir de $VPS_DIR"
  else
    pm2 restart "$APP_NAME" --update-env
    ok "PM2: processo reiniciado"
  fi
else
  cd "$VPS_DIR"
  pm2 start npm --name "$APP_NAME" -- start
  pm2 save 2>/dev/null || true
  pm2 startup 2>/dev/null | grep -E "^sudo|^env" | bash 2>/dev/null || true
  ok "PM2: processo iniciado"
fi

record "PM2 restart" "ok" "$(elapsed $T)"
phase_status "pm2-restart" "ok" "$(elapsed $T)"

# ══════════════════════════════════════════════════════════════════════════════
# FASE 6 — HEALTH CHECK: DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════
step "Health check — aguardando dashboard ($APP_URL)..."
T=$(now)
phase_status "health-check" "running"
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
  # Heartbeat every 5 seconds during health check
  if (( i % 5 == 0 )); then
    heartbeat
  fi
  sleep 1
done

echo ""

if ! $DASH_OK; then
  err "Dashboard não respondeu após ${HEALTH_TIMEOUT}s (último HTTP: $LAST_CODE)"
  warn "Veja os logs: pm2 logs $APP_NAME --lines 80"
  record "Dashboard" "fail" "$(elapsed $T)"
  phase_status "health-check" "fail" "$(elapsed $T)" "dashboard timeout (HTTP $LAST_CODE)"
else
  phase_status "health-check" "ok" "$(elapsed $T)"
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
  if $HEADLESS; then
    warn "Fail2Ban não encontrado — modo headless, pulando instalação."
    record "Fail2Ban Setup" "skip" "$(elapsed $T)"
  else
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
      record "Fail2Ban Setup" "ok" "$(elapsed $T)"
    else
      warn "Instalação do Fail2Ban ignorada."
      record "Fail2Ban Setup" "skip" "$(elapsed $T)"
    fi
  fi
else
  ok "Fail2Ban já está instalado e ativo"
  record "Fail2Ban Setup" "ok" "$(elapsed $T)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE 10 — FIREWALL UFW
# ══════════════════════════════════════════════════════════════════════════════
step "Verificando Firewall (UFW)..."
T=$(now)

if ! command -v ufw &>/dev/null; then
  warn "UFW (Firewall) não encontrado no sistema."
  record "Firewall UFW" "skip" "$(elapsed $T)"
else
  if sudo ufw status | grep -qi "Status: active"; then
    ok "Firewall UFW já está ativo"
    record "Firewall UFW" "ok" "$(elapsed $T)"
  else
    if $HEADLESS; then
      warn "Firewall UFW inativo — modo headless, pulando ativação."
      record "Firewall UFW" "skip" "$(elapsed $T)"
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
        record "Firewall UFW" "ok" "$(elapsed $T)"
      else
        warn "Ativação do Firewall ignorada."
        record "Firewall UFW" "skip" "$(elapsed $T)"
      fi
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# RELATÓRIO FINAL
# ══════════════════════════════════════════════════════════════════════════════
echo ""
# Não emitimos phase_status "done" aqui — o trap EXIT cuida disso baseado no
# exit code, evitando duplicação e cobrindo também saídas inesperadas.
if print_report; then
  echo -e "\n  ${GREEN}${BOLD}🚀 Update concluído com sucesso!${NC}"
  echo -e "  ${DIM}Dashboard: ${APP_URL}${NC}\n"
  exit 0
else
  echo -e "\n  ${YELLOW}${BOLD}⚠ Update com problemas — veja o relatório acima.${NC}\n"
  exit 1
fi
