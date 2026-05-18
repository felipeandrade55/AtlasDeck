#!/bin/bash
# deploy.sh — Build local, push to GitHub e atualiza o VPS automaticamente
#
# Uso: ./scripts/deploy.sh ["mensagem do commit"]
# Exemplo: ./scripts/deploy.sh "fix: crash no menu Office"

set -e

# ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────
VPS_HOST="root@209.50.245.152"          # ex: root@123.45.67.89 ou user@meudominio.com
VPS_DIR="/.openclaw/workspace/mission-control/"             # caminho do projeto no VPS
BRANCH="main"
# ─────────────────────────────────────────────────────────────────────────────

# Cores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "\n${CYAN}▶ $1${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

COMMIT_MSG="${1:-deploy: update $(date '+%Y-%m-%d %H:%M')}"

echo -e "${CYAN}"
echo "╔═══════════════════════════════════════╗"
echo "║        AtlasDeck — Deploy Script      ║"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Verificar configuração ─────────────────────────────────────────────────
if [[ "$VPS_HOST" == *"SEU_IP_VPS"* ]]; then
  fail "Configure VPS_HOST no topo do script antes de usar."
fi

# ── 2. Commit e push ──────────────────────────────────────────────────────────
step "Verificando alterações locais..."

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  step "Commitando alterações: \"$COMMIT_MSG\""
  git add -A
  git commit -m "$COMMIT_MSG"
  ok "Commit criado"
else
  warn "Nenhuma alteração local para commitar"
fi

step "Enviando para o GitHub (branch: $BRANCH)..."
git push origin "$BRANCH"
ok "Push concluído"

# ── 3. Atualizar VPS ─────────────────────────────────────────────────────────
step "Conectando ao VPS ($VPS_HOST)..."

ssh "$VPS_HOST" bash <<REMOTE
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n\${CYAN}▶ \$1\${NC}"; }
ok()   { echo -e "\${GREEN}✓ \$1\${NC}"; }

step "Atualizando código no VPS..."
cd "$VPS_DIR"
git pull origin "$BRANCH"
ok "git pull concluído"

# Instala dependências só se package.json mudou
if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q "package.json\|package-lock.json"; then
  step "package.json alterado — rodando npm install..."
  npm install --production=false
  ok "npm install concluído"
else
  ok "Sem novas dependências"
fi

step "Fazendo build..."
npm run build
ok "Build concluído"

step "Reiniciando serviço..."
if command -v pm2 &> /dev/null && pm2 list | grep -q "atlasdeck"; then
  pm2 restart atlasdeck
  ok "PM2 reiniciado"
elif systemctl is-active --quiet atlasdeck 2>/dev/null; then
  systemctl restart atlasdeck
  ok "Systemd service reiniciado"
else
  echo ""
  echo "⚠  Nenhum processo gerenciado encontrado (pm2 ou systemd)."
  echo "   Inicie manualmente com:  pm2 start npm --name atlasdeck -- start"
fi

echo ""
echo -e "\${GREEN}╔═══════════════════════════════════════╗\${NC}"
echo -e "\${GREEN}║         Deploy finalizado! ✓          ║\${NC}"
echo -e "\${GREEN}╚═══════════════════════════════════════╝\${NC}"
REMOTE

echo -e "\n${GREEN}╔═══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Tudo certo! VPS atualizado ✓      ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}\n"
