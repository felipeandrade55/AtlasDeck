#!/usr/bin/env bash
# enable-openclaw-streaming.sh
#
# Liga o "block streaming" no OpenClaw para que o gateway envie a resposta
# token-a-token via WebSocket em vez de bufferizar tudo até o final. Sem
# essa config, o AtlasDeck recebe só o frame `final` sem texto e o bubble
# fica vazio.
#
# USO:
#   bash scripts/enable-openclaw-streaming.sh           # interativo
#   bash scripts/enable-openclaw-streaming.sh -y        # sem confirmação
#   bash scripts/enable-openclaw-streaming.sh --dry-run # só mostra diff
#
# Variáveis (opcionais):
#   OPENCLAW_CONFIG  caminho alternativo (default: ~/.openclaw/openclaw.json)
#   SKIP_RESTART=1   pula o systemctl restart no final
#
# Segurança:
#   - backup timestamped antes de tocar no arquivo
#   - patch atômico via node (mv tmp -> final, nunca sobrescreve in-place)
#   - valida JSON pós-patch antes de promover o tmp
#   - idempotente: roda 100x e o resultado é sempre o mesmo

set -euo pipefail

# ── cores (graceful degrade) ───────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  CG=$(tput setaf 2 2>/dev/null || echo "")
  CY=$(tput setaf 3 2>/dev/null || echo "")
  CR=$(tput setaf 1 2>/dev/null || echo "")
  CB=$(tput setaf 4 2>/dev/null || echo "")
  CD=$(tput dim    2>/dev/null || echo "")
  CN=$(tput sgr0   2>/dev/null || echo "")
else
  CG=""; CY=""; CR=""; CB=""; CD=""; CN=""
fi

step()  { printf '%s>%s %s\n' "$CB" "$CN" "$*"; }
ok()    { printf '%sOK%s %s\n' "$CG" "$CN" "$*"; }
warn()  { printf '%s!!%s %s\n' "$CY" "$CN" "$*"; }
err()   { printf '%sXX%s %s\n' "$CR" "$CN" "$*" >&2; }
info()  { printf '%s   %s%s\n' "$CD" "$*" "$CN"; }

# ── flags ──────────────────────────────────────────────────────────────
AUTO_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   AUTO_YES=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    -h|--help)
      sed -n '1,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) err "argumento desconhecido: $arg (use -h)"; exit 2 ;;
  esac
done

# ── 1. localizar o arquivo de config ───────────────────────────────────
CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

step "Procurando openclaw.json..."
if [ ! -f "$CONFIG" ]; then
  err "openclaw.json não encontrado em: $CONFIG"
  info "Tentei: $CONFIG"
  info "Se está em outro lugar, rode com OPENCLAW_CONFIG apontando pra ele:"
  info "  OPENCLAW_CONFIG=/caminho/correto/openclaw.json bash $0"
  exit 1
fi
ok "Encontrado: $CONFIG"

# ── 2. exigir node ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  err "node não está no PATH — necessário para o patch JSON seguro."
  exit 1
fi

# ── 3. backup timestamped ──────────────────────────────────────────────
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="${CONFIG}.bak.${TS}"

step "Backup -> $BACKUP"
cp -p "$CONFIG" "$BACKUP"
ok "Backup criado"

# ── 4. validar JSON original (paranoia) ────────────────────────────────
if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG" 2>/dev/null; then
  err "openclaw.json existente NÃO é JSON válido — abortando sem mexer."
  info "Conserte o arquivo manualmente antes de rodar de novo."
  exit 1
fi

# ── 5. patcher em arquivo separado (mantém o shell limpo) ──────────────
PATCHER_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCHER="${PATCHER_DIR}/_openclaw-streaming-patch.cjs"

if [ ! -f "$PATCHER" ]; then
  err "patcher node não encontrado em: $PATCHER"
  info "Esse arquivo deve estar na mesma pasta do script. Reinstale o repo."
  exit 1
fi

TMP="${CONFIG}.tmp.${TS}.$$"
trap 'rm -f "$TMP" 2>/dev/null || true' EXIT

step "Calculando patch (agents.defaults.blockStreaming*)..."
PATCH_REPORT=$(node "$PATCHER" "$CONFIG" "$TMP")

# ── 6. inspecionar resultado ───────────────────────────────────────────
NUM_CHANGES=$(printf '%s' "$PATCH_REPORT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).changes.length)))')

if [ "$NUM_CHANGES" = "0" ]; then
  ok "Config já estava correta — nenhuma mudança necessária."
  rm -f "$BACKUP"
  info "Backup removido (não era necessário)."
  if [ "${SKIP_RESTART:-0}" != "1" ]; then
    echo
    info "Se o chat ainda estiver vazio, reinicie o gateway:"
    info "  systemctl --user restart openclaw-gateway"
  fi
  exit 0
fi

step "Mudanças propostas:"
printf '%s' "$PATCH_REPORT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);for(const c of r.changes){const b=c.before===undefined?"(ausente)":JSON.stringify(c.before);const a=JSON.stringify(c.after);console.log("  - agents.defaults."+c.key+":");console.log("      antes:  "+b);console.log("      depois: "+a)}})'

# Diff de linhas como bônus (se diff(1) existe)
if command -v diff >/dev/null 2>&1; then
  echo
  step "Diff completo:"
  diff -u "$BACKUP" "$TMP" | sed 's/^/    /' || true
fi

# ── 7. dry-run early exit ──────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo
  warn "--dry-run ativo — nada foi aplicado."
  info "Arquivo original intocado em: $CONFIG"
  info "Backup criado mesmo assim em: $BACKUP (pode apagar)"
  exit 0
fi

# ── 8. confirmação ─────────────────────────────────────────────────────
if [ "$AUTO_YES" != "1" ]; then
  echo
  printf 'Aplicar essas mudanças em %s? [s/N] ' "$CONFIG"
  read REPLY
  case "$REPLY" in
    [SsYy]*) ;;
    *)
      warn "Abortado pelo usuário. Nada foi alterado."
      info "Backup criado em: $BACKUP (pode apagar)"
      exit 0
      ;;
  esac
fi

# ── 9. validação pós-patch antes de promover ───────────────────────────
step "Validando JSON patchado..."
if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$TMP" 2>/dev/null; then
  err "JSON patchado é inválido! Não vou substituir o original."
  info "Backup intacto em: $BACKUP"
  info "Tmp do patch quebrado em: $TMP (NÃO foi movido)"
  trap - EXIT
  exit 1
fi
ok "JSON válido"

# ── 10. swap atômico ───────────────────────────────────────────────────
step "Aplicando..."
mv "$TMP" "$CONFIG"
trap - EXIT
ok "Aplicado: $CONFIG"
info "Backup preservado em: $BACKUP"

# ── 11. restart do gateway ─────────────────────────────────────────────
if [ "${SKIP_RESTART:-0}" = "1" ]; then
  echo
  info "SKIP_RESTART=1 — reinicie o gateway manualmente para a config valer:"
  info "  systemctl --user restart openclaw-gateway"
  exit 0
fi

echo
step "Reiniciando openclaw-gateway..."
if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl não encontrado — reinicie o gateway manualmente."
  exit 0
fi

if systemctl --user list-unit-files 2>/dev/null | grep -q "^openclaw-gateway"; then
  if systemctl --user restart openclaw-gateway 2>/dev/null; then
    ok "openclaw-gateway reiniciado (systemd --user)"
  else
    warn "systemctl --user restart falhou — confira: systemctl --user status openclaw-gateway"
  fi
elif systemctl list-unit-files 2>/dev/null | grep -q "^openclaw-gateway"; then
  if sudo systemctl restart openclaw-gateway 2>/dev/null; then
    ok "openclaw-gateway reiniciado (systemd system)"
  else
    warn "sudo systemctl restart falhou — confira: sudo systemctl status openclaw-gateway"
  fi
else
  warn "Unit 'openclaw-gateway' não encontrada — reinicie como você normalmente faz."
  info "Exemplos: pm2 restart openclaw, ou kill + start manual."
fi

echo
ok "Pronto. Teste o chat — agora a resposta deve vir token-a-token."
info "Para reverter se algo der errado:  cp \"$BACKUP\" \"$CONFIG\""
