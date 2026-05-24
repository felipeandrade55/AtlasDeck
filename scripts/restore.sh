#!/bin/bash
# restore.sh — Worker bash detached que executa a restauração de um backup.
#
# Uso (chamado pelo src/lib/restore-trigger.ts):
#   restore.sh \
#     --archive PATH           # caminho absoluto do .tar.gz a restaurar
#     --upload-id ID           # uuid do upload (para cleanup)
#     --status-file PATH       # arquivo JSONL com phase events + heartbeats
#     --log-file PATH          # log textual append-only
#     [--safety-backup]        # criar snapshot pré-restore antes de aplicar
#     [--rollback-from PATH]   # forçar uso desse archive como safety backup
#
# Fases: validate → safety-backup → preview → stop-app → extract
#        → apply-data → apply-env → apply-home → start-app → verify
# Rollback: se uma fase ≥ apply-data falhar e houver safety backup, re-aplica.
#
# Padrões herdados do deploy.sh:
#   - auto-preservação em /tmp (sobrevive a sobrescrita do arquivo)
#   - trap '' HUP PIPE INT  (sobrevive a sinais espúrios)
#   - trap emit_terminal EXIT/TERM (UI nunca fica eternamente em "executando")

set -o pipefail

trap '' HUP PIPE INT

# ─── AUTO-PRESERVAÇÃO ─────────────────────────────────────────────────────────
if [[ "${_RESTORE_SAFE:-}" != "1" ]]; then
  _TMP=$(mktemp /tmp/restore.XXXXXX.sh)
  cp "$0" "$_TMP"
  chmod +x "$_TMP"
  _RESTORE_SAFE=1 exec "$_TMP" "$@"
fi
# ─────────────────────────────────────────────────────────────────────────────

ARCHIVE=""
UPLOAD_ID=""
STATUS_FILE=""
LOG_FILE=""
WITH_SAFETY=false
ROLLBACK_FROM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)        ARCHIVE="$2"; shift 2 ;;
    --upload-id)      UPLOAD_ID="$2"; shift 2 ;;
    --status-file)    STATUS_FILE="$2"; shift 2 ;;
    --log-file)       LOG_FILE="$2"; shift 2 ;;
    --safety-backup)  WITH_SAFETY=true; shift ;;
    --rollback-from)  ROLLBACK_FROM="$2"; shift 2 ;;
    *) echo "Argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$ARCHIVE" ]] && { echo "--archive obrigatório" >&2; exit 2; }
[[ -z "$STATUS_FILE" ]] && { echo "--status-file obrigatório" >&2; exit 2; }
[[ -z "$LOG_FILE" ]] && { echo "--log-file obrigatório" >&2; exit 2; }

PROJ_DIR="$(pwd)"
APP_NAME="atlasdeck"
APP_PORT="3000"
LOCK_FILE="$PROJ_DIR/data/.restore.lock"
STAGING="/tmp/atlasdeck-restore-staging-$(date +%s)-$$"
SAFETY_BACKUP_PATH=""

mkdir -p "$(dirname "$STATUS_FILE")" "$(dirname "$LOG_FILE")"

# ─── LOGGING HELPERS ──────────────────────────────────────────────────────────
log_line() {
  local msg="$1"
  printf "[%s] %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$msg" >> "$LOG_FILE"
}

now()     { date +%s; }
elapsed() { echo $(( $(date +%s) - $1 )); }

phase_status() {
  local phase="$1"
  local status="$2"
  local duration="${3:-0}"
  local error_msg="${4:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  local err_json=""
  if [[ -n "$error_msg" ]]; then
    err_json=",\"error\":$(printf '%s' "$error_msg" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$error_msg\"")"
  fi
  printf '{"phase":"%s","status":"%s","ts":"%s","durationSec":%d%s}\n' \
    "$phase" "$status" "$ts" "$duration" "$err_json" >> "$STATUS_FILE"
}

heartbeat() {
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  printf '{"heartbeat":"%s"}\n' "$ts" >> "$STATUS_FILE"
}

# Background heartbeat loop — emits every 5s while restore is running.
_HB_PID=""
start_heartbeat() {
  (
    while sleep 5; do
      heartbeat
    done
  ) &
  _HB_PID=$!
  disown "$_HB_PID" 2>/dev/null || true
}

stop_heartbeat() {
  if [[ -n "$_HB_PID" ]]; then
    kill "$_HB_PID" 2>/dev/null || true
    _HB_PID=""
  fi
}

# ─── EXIT TRAP ────────────────────────────────────────────────────────────────
_TERMINAL_EMITTED=false
_DONE_REACHED=false
_TOTAL_START=$(now)

emit_terminal() {
  if [[ "$_TERMINAL_EMITTED" == "true" ]]; then return 0; fi
  _TERMINAL_EMITTED=true
  stop_heartbeat
  local code="$1"
  if [[ "$code" == "0" ]] || [[ "$_DONE_REACHED" == "true" ]]; then
    phase_status "done" "ok" "$(elapsed $_TOTAL_START)"
  else
    phase_status "done" "fail" "$(elapsed $_TOTAL_START)" \
      "restore.sh saiu com exit code $code antes do término"
  fi
  # Cleanup
  [[ -d "$STAGING" ]] && rm -rf "$STAGING" 2>/dev/null || true
  rm -f "$LOCK_FILE" 2>/dev/null || true
}

trap 'emit_terminal $?' EXIT
trap 'emit_terminal 143' TERM

# ─── LOCK FILE ────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$LOCK_FILE")"
echo "{\"pid\":$$,\"reason\":\"restore in progress\",\"acquiredAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" > "$LOCK_FILE"

log_line "=== AtlasDeck Restore — started (pid=$$) ==="
log_line "Archive: $ARCHIVE"
log_line "Upload ID: $UPLOAD_ID"
log_line "Staging:  $STAGING"
log_line "Safety backup requested: $WITH_SAFETY"

phase_status "start" "running"
start_heartbeat

# ─── DETECT PM2 ───────────────────────────────────────────────────────────────
PM2_MANAGED=false
if command -v pm2 &>/dev/null; then
  if pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP_NAME\""; then
    PM2_MANAGED=true
  fi
fi
log_line "PM2 manages '$APP_NAME': $PM2_MANAGED"

# ═════════════════════════════════════════════════════════════════════════════
# FASE 1 — VALIDATE
# ═════════════════════════════════════════════════════════════════════════════
T=$(now)
phase_status "validate" "running"
log_line "▶ validate: checking $ARCHIVE"

if [[ ! -f "$ARCHIVE" ]]; then
  phase_status "validate" "fail" "$(elapsed $T)" "Arquivo não encontrado: $ARCHIVE"
  log_line "✗ validate: arquivo não encontrado"
  exit 1
fi

# Magic bytes 1f 8b (gzip)
MAGIC=$(head -c 2 "$ARCHIVE" | od -An -tx1 | tr -d ' \n')
if [[ "$MAGIC" != "1f8b" ]]; then
  phase_status "validate" "fail" "$(elapsed $T)" "Arquivo não é gzip válido (magic bytes: $MAGIC)"
  log_line "✗ validate: magic bytes inválidos ($MAGIC)"
  exit 1
fi

# Contém data/backup-origin.json?
if ! tar -tzf "$ARCHIVE" 2>/dev/null | grep -q "data/backup-origin.json"; then
  phase_status "validate" "fail" "$(elapsed $T)" "Arquivo não contém data/backup-origin.json — não é um backup do AtlasDeck"
  log_line "✗ validate: backup-origin.json ausente"
  exit 1
fi

# Espaço em disco ≥ 3× tamanho do arquivo
ARCHIVE_SIZE=$(stat -f%z "$ARCHIVE" 2>/dev/null || stat -c%s "$ARCHIVE" 2>/dev/null || echo 0)
REQUIRED=$((ARCHIVE_SIZE * 3))
AVAIL=$(df -k "$PROJ_DIR" | awk 'NR==2 {print $4 * 1024}')
if [[ "$AVAIL" -lt "$REQUIRED" ]]; then
  phase_status "validate" "fail" "$(elapsed $T)" "Espaço insuficiente: precisa $REQUIRED bytes, disponível $AVAIL"
  log_line "✗ validate: disco cheio ($AVAIL < $REQUIRED)"
  exit 1
fi

phase_status "validate" "ok" "$(elapsed $T)"
log_line "✓ validate: $(($ARCHIVE_SIZE / 1024)) KB, espaço livre OK"

# ═════════════════════════════════════════════════════════════════════════════
# FASE 2 — SAFETY-BACKUP (opcional)
# ═════════════════════════════════════════════════════════════════════════════
if $WITH_SAFETY; then
  T=$(now)
  phase_status "safety-backup" "running"
  log_line "▶ safety-backup: criando snapshot pré-restore"

  # Roda como subprocess para não vazar exit code via set -e
  if SAFETY_OUT=$(npx tsx -e "
import { runBackup } from './src/lib/backup.ts';
runBackup({ archiveNamePrefix: 'pre-restore' })
  .then(r => { console.log(JSON.stringify(r)); process.exit(r.success ? 0 : 1); })
  .catch(e => { console.error(e); process.exit(1); });
" 2>&1); then
    SAFETY_BACKUP_PATH=$(echo "$SAFETY_OUT" | grep -o '"archivePath":"[^"]*"' | head -1 | sed 's/.*":"//; s/"$//')
    log_line "✓ safety-backup: $SAFETY_BACKUP_PATH"
    phase_status "safety-backup" "ok" "$(elapsed $T)"
  else
    log_line "✗ safety-backup falhou: $SAFETY_OUT"
    phase_status "safety-backup" "fail" "$(elapsed $T)" "Falha ao criar snapshot pré-restore"
    exit 1
  fi
else
  phase_status "safety-backup" "skip" "0"
  log_line "– safety-backup: desabilitado pelo usuário"
fi

# ═════════════════════════════════════════════════════════════════════════════
# FASE 3 — PREVIEW (registra o plano no log)
# ═════════════════════════════════════════════════════════════════════════════
T=$(now)
phase_status "preview" "running"
log_line "▶ preview: lendo backup-origin.json do tar"

OLD_HOME=""
if PREVIEW_OUT=$(npx tsx -e "
import { previewRestore } from './src/lib/backup.ts';
previewRestore('$ARCHIVE')
  .then(p => { console.log(JSON.stringify(p)); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
" 2>&1); then
  OLD_HOME=$(echo "$PREVIEW_OUT" | grep -o '"homeDir":"[^"]*"' | head -1 | sed 's/.*":"//; s/"$//')
  PLATFORM_MISMATCH=$(echo "$PREVIEW_OUT" | grep -o '"platformMismatch":true' || echo "")
  if [[ -n "$PLATFORM_MISMATCH" ]]; then
    log_line "✗ preview: platform mismatch detectado"
    phase_status "preview" "fail" "$(elapsed $T)" "Plataforma do backup difere da atual — restore cross-platform não suportado"
    exit 1
  fi
  log_line "✓ preview: origem homeDir=$OLD_HOME"
  phase_status "preview" "ok" "$(elapsed $T)"
else
  log_line "✗ preview falhou: $PREVIEW_OUT"
  phase_status "preview" "fail" "$(elapsed $T)" "Falha ao ler manifesto do backup"
  exit 1
fi

# ═════════════════════════════════════════════════════════════════════════════
# FASE 4 — STOP-APP (apenas se PM2)
# ═════════════════════════════════════════════════════════════════════════════
T=$(now)
phase_status "stop-app" "running"
if $PM2_MANAGED; then
  log_line "▶ stop-app: pm2 stop $APP_NAME"
  if pm2 stop "$APP_NAME" >/dev/null 2>&1; then
    sleep 3
    log_line "✓ stop-app: aplicação parada"
    phase_status "stop-app" "ok" "$(elapsed $T)"
  else
    log_line "✗ stop-app: pm2 stop falhou"
    phase_status "stop-app" "fail" "$(elapsed $T)" "pm2 stop $APP_NAME retornou erro"
    exit 1
  fi
else
  log_line "– stop-app: PM2 não gerencia atlasdeck; restore aplicará com app rodando (dev local)"
  phase_status "stop-app" "skip" "$(elapsed $T)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# FASE 5 — EXTRACT
# ═════════════════════════════════════════════════════════════════════════════
T=$(now)
phase_status "extract" "running"
log_line "▶ extract: $ARCHIVE → $STAGING"

mkdir -p "$STAGING"
if tar -xzf "$ARCHIVE" -C "$STAGING" 2>>"$LOG_FILE"; then
  log_line "✓ extract: extraído em $STAGING"
  phase_status "extract" "ok" "$(elapsed $T)"
else
  log_line "✗ extract: falha do tar"
  phase_status "extract" "fail" "$(elapsed $T)" "Falha ao extrair $ARCHIVE"
  # Sobe a app de volta se estivermos PM2
  if $PM2_MANAGED; then pm2 start "$APP_NAME" --update-env >/dev/null 2>&1 || true; fi
  exit 1
fi

# ═════════════════════════════════════════════════════════════════════════════
# Helper de rollback automático
# ═════════════════════════════════════════════════════════════════════════════
rollback_from_safety() {
  local reason="$1"
  if [[ -z "$SAFETY_BACKUP_PATH" ]]; then
    log_line "✗ rollback: sem snapshot pré-restore disponível (manual-recovery necessário)"
    phase_status "rollback" "fail" "0" "Sem snapshot disponível — restore falhou e não há rollback automático"
    return 1
  fi

  local RB_T
  RB_T=$(now)
  phase_status "rollback" "running"
  log_line "▶ rollback: re-aplicando $SAFETY_BACKUP_PATH (motivo: $reason)"

  local RB_STAGING="/tmp/atlasdeck-rollback-staging-$(date +%s)-$$"
  mkdir -p "$RB_STAGING"
  if ! tar -xzf "$SAFETY_BACKUP_PATH" -C "$RB_STAGING" 2>>"$LOG_FILE"; then
    log_line "✗ rollback: falha ao extrair $SAFETY_BACKUP_PATH"
    phase_status "rollback" "fail" "$(elapsed $RB_T)" "Falha ao extrair snapshot — intervenção manual necessária"
    rm -rf "$RB_STAGING" 2>/dev/null || true
    return 1
  fi

  npx tsx scripts/restore-apply.ts data --staging "$RB_STAGING" >>"$LOG_FILE" 2>&1 || true
  npx tsx scripts/restore-apply.ts env  --staging "$RB_STAGING" >>"$LOG_FILE" 2>&1 || true
  npx tsx scripts/restore-apply.ts home --staging "$RB_STAGING" --old-home "$OLD_HOME" >>"$LOG_FILE" 2>&1 || true

  if $PM2_MANAGED; then
    pm2 start "$APP_NAME" --update-env >/dev/null 2>&1 || true
  fi

  rm -rf "$RB_STAGING" 2>/dev/null || true
  log_line "✓ rollback: snapshot pré-restore re-aplicado"
  phase_status "rollback" "ok" "$(elapsed $RB_T)"
  return 0
}

apply_phase() {
  local phase="$1"; shift
  local mode="$1"; shift
  local PT
  PT=$(now)
  phase_status "$phase" "running"
  log_line "▶ $phase: restore-apply.ts $mode"
  local out
  if out=$(npx tsx scripts/restore-apply.ts "$mode" --staging "$STAGING" "$@" 2>&1); then
    log_line "  result: $out"
    phase_status "$phase" "ok" "$(elapsed $PT)"
    return 0
  else
    log_line "✗ $phase falhou: $out"
    phase_status "$phase" "fail" "$(elapsed $PT)" "Falha na fase $phase"
    return 1
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
# FASE 6/7/8 — APPLY
# ═════════════════════════════════════════════════════════════════════════════
if ! apply_phase "apply-data" "data"; then
  rollback_from_safety "apply-data failed" || true
  if $PM2_MANAGED; then pm2 start "$APP_NAME" --update-env >/dev/null 2>&1 || true; fi
  exit 1
fi

if ! apply_phase "apply-env" "env"; then
  rollback_from_safety "apply-env failed" || true
  if $PM2_MANAGED; then pm2 start "$APP_NAME" --update-env >/dev/null 2>&1 || true; fi
  exit 1
fi

if ! apply_phase "apply-home" "home" --old-home "$OLD_HOME"; then
  rollback_from_safety "apply-home failed" || true
  if $PM2_MANAGED; then pm2 start "$APP_NAME" --update-env >/dev/null 2>&1 || true; fi
  exit 1
fi

# ═════════════════════════════════════════════════════════════════════════════
# FASE 8.5 — RESTART OPENCLAW GATEWAY (best-effort)
# ═════════════════════════════════════════════════════════════════════════════
# Se o ~/.openclaw/openclaw.json mudou (porta, paths, etc.), o gateway precisa
# ser reiniciado para pegar a nova config. Detectamos via PM2 OU systemd OU
# pula silenciosamente se nada gerencia. Nunca falha o restore — é cosmético.
T=$(now)
phase_status "restart-openclaw" "running"
log_line "▶ restart-openclaw: tentando reiniciar gateway (best-effort)"

OPENCLAW_RESTARTED=false
if command -v pm2 &>/dev/null && pm2 jlist 2>/dev/null | grep -q '"name":"openclaw-gateway"'; then
  if pm2 restart openclaw-gateway --update-env >/dev/null 2>&1; then
    log_line "✓ restart-openclaw: pm2 restart openclaw-gateway OK"
    OPENCLAW_RESTARTED=true
  fi
fi

if ! $OPENCLAW_RESTARTED && command -v systemctl &>/dev/null; then
  if systemctl is-active openclaw-gateway >/dev/null 2>&1; then
    if systemctl restart openclaw-gateway 2>/dev/null \
       || sudo -n systemctl restart openclaw-gateway 2>/dev/null; then
      log_line "✓ restart-openclaw: systemctl restart openclaw-gateway OK"
      OPENCLAW_RESTARTED=true
    fi
  elif systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
    if systemctl --user restart openclaw-gateway 2>/dev/null; then
      log_line "✓ restart-openclaw: systemctl --user restart openclaw-gateway OK"
      OPENCLAW_RESTARTED=true
    fi
  fi
fi

if $OPENCLAW_RESTARTED; then
  phase_status "restart-openclaw" "ok" "$(elapsed $T)"
else
  log_line "– restart-openclaw: nenhum gestor detectado (pm2/systemd) — pulando"
  phase_status "restart-openclaw" "skip" "$(elapsed $T)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# FASE 9 — START-APP
# ═════════════════════════════════════════════════════════════════════════════
T=$(now)
phase_status "start-app" "running"
if $PM2_MANAGED; then
  log_line "▶ start-app: pm2 start $APP_NAME --update-env"
  if pm2 start "$APP_NAME" --update-env >/dev/null 2>&1; then
    # Espera até 90s pela porta
    APP_URL="http://localhost:$APP_PORT"
    WAIT_T=$(now)
    STARTED=false
    for _ in $(seq 1 90); do
      if curl -sf -o /dev/null --max-time 2 "$APP_URL" 2>/dev/null; then
        STARTED=true
        break
      fi
      sleep 1
    done
    if $STARTED; then
      log_line "✓ start-app: app respondendo em ${APP_URL} ($(elapsed $WAIT_T)s)"
      phase_status "start-app" "ok" "$(elapsed $T)"
    else
      log_line "✗ start-app: timeout 90s aguardando $APP_URL"
      phase_status "start-app" "fail" "$(elapsed $T)" "App não respondeu em 90s após pm2 start"
      rollback_from_safety "start-app timeout" || true
      exit 1
    fi
  else
    log_line "✗ start-app: pm2 start falhou"
    phase_status "start-app" "fail" "$(elapsed $T)" "pm2 start $APP_NAME retornou erro"
    rollback_from_safety "pm2 start failed" || true
    exit 1
  fi
else
  log_line "– start-app: PM2 não gerencia atlasdeck — reinicie o servidor manualmente"
  phase_status "start-app" "skip" "$(elapsed $T)" ""
fi

# ═════════════════════════════════════════════════════════════════════════════
# FASE 10 — VERIFY
# ═════════════════════════════════════════════════════════════════════════════
T=$(now)
phase_status "verify" "running"
log_line "▶ verify: health check + dbs"

if $PM2_MANAGED; then
  HEALTH_OUT=$(curl -sf --max-time 5 "http://localhost:$APP_PORT/api/health" 2>/dev/null || echo "")
  # /api/health retorna { status: "healthy" | "degraded" | "critical", checks: [...] }.
  # Critical = mais da metade dos checks down — restauração foi malsucedida.
  # Healthy ou degraded com Mission Control up = OK.
  if [[ -z "$HEALTH_OUT" ]]; then
    log_line "✗ verify: /api/health não respondeu"
    phase_status "verify" "fail" "$(elapsed $T)" "Health check não respondeu após restore"
    rollback_from_safety "verify health unreachable" || true
    exit 1
  fi
  if echo "$HEALTH_OUT" | grep -q '"status":"critical"'; then
    log_line "✗ verify: /api/health status=critical: $HEALTH_OUT"
    phase_status "verify" "fail" "$(elapsed $T)" "Health check retornou status=critical"
    rollback_from_safety "verify health critical" || true
    exit 1
  fi
  log_line "✓ verify: $HEALTH_OUT"
  phase_status "verify" "ok" "$(elapsed $T)"
else
  # Dev local: valida que os arquivos foram aplicados e os DBs abrem
  if VERIFY_OUT=$(npx tsx -e "
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
const dataDir = path.join(process.cwd(), 'data');
const dbs = fs.readdirSync(dataDir).filter(f => f.endsWith('.db'));
const failed = [];
for (const db of dbs) {
  try {
    const conn = new Database(path.join(dataDir, db), { readonly: true, fileMustExist: true });
    conn.prepare('SELECT 1').get();
    conn.close();
  } catch (e) {
    failed.push(db + ': ' + e.message);
  }
}
if (failed.length > 0) { console.error('FAIL:' + failed.join('; ')); process.exit(1); }
console.log('OK:' + dbs.length + ' db(s) opened cleanly');
" 2>&1); then
    log_line "✓ verify (dev): $VERIFY_OUT"
    phase_status "verify" "ok" "$(elapsed $T)"
  else
    log_line "✗ verify (dev): $VERIFY_OUT"
    phase_status "verify" "fail" "$(elapsed $T)" "Verificação dos bancos falhou: $VERIFY_OUT"
    rollback_from_safety "verify dbs failed" || true
    exit 1
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# DONE
# ═════════════════════════════════════════════════════════════════════════════
_DONE_REACHED=true
log_line "=== AtlasDeck Restore — completed in $(elapsed $_TOTAL_START)s ==="
phase_status "done" "ok" "$(elapsed $_TOTAL_START)"
_TERMINAL_EMITTED=true
exit 0
