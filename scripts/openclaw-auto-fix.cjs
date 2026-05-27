#!/usr/bin/env node
/**
 * openclaw-auto-fix.cjs
 *
 * Standalone wrapper around the same patches the AtlasDeck UI exposes
 * via /api/openclaw/auto-fix — but runnable from deploy.sh or by hand
 * without booting Next.js. Ensures fresh installs and re-installs both
 * get the streaming config and the heartbeat guard baked in
 * automatically, with zero terminal commands for the operator.
 *
 * Behaviour:
 *   - Always idempotent: prints "ok: already correct" and exits 0 when
 *     nothing needs to change.
 *   - Soft-fails: missing openclaw.json or workspace just prints a
 *     warning and exits 0, so a deploy where OpenClaw isn't installed
 *     yet (or lives elsewhere) doesn't break.
 *   - Honours OPENCLAW_DIR env var the same way the runtime does.
 *
 * Why CommonJS: deploy.sh runs this against the built node_modules
 * directly, without going through ts-node. The logic mirrors
 * src/lib/openclaw-auto-fix.ts to keep behaviour identical between
 * the deploy-time path and the runtime UI path.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_OPENCLAW_DIR = "/root/.openclaw";

function getOpenClawDir() {
  // Read AtlasDeck's saved-config first (where the UI Settings page
  // writes the path), then env, then default.
  try {
    const saved = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data", "openclaw-config.json"), "utf8"),
    );
    if (typeof saved.openclawDir === "string" && saved.openclawDir.trim()) {
      return saved.openclawDir.trim();
    }
  } catch {
    // file missing or unreadable — fall through
  }
  if (process.env.OPENCLAW_DIR && process.env.OPENCLAW_DIR.trim()) {
    return process.env.OPENCLAW_DIR.trim();
  }
  return DEFAULT_OPENCLAW_DIR;
}

function getOpenClawWorkspace(openclawDir) {
  try {
    const saved = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data", "openclaw-config.json"), "utf8"),
    );
    if (typeof saved.openclawWorkspace === "string" && saved.openclawWorkspace.trim()) {
      return saved.openclawWorkspace.trim();
    }
  } catch {
    // ignore
  }
  if (process.env.OPENCLAW_WORKSPACE && process.env.OPENCLAW_WORKSPACE.trim()) {
    return process.env.OPENCLAW_WORKSPACE.trim();
  }
  return path.join(openclawDir, "workspace", "mission-control");
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function detectIndent(raw) {
  const m = raw.match(/^([ \t]+)"/m);
  return m ? m[1] : "  ";
}

function atomicWrite(file, content) {
  const tmp = file + ".tmp." + timestamp() + "." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function applyStreamingFix() {
  const openclawDir = getOpenClawDir();
  const file = path.join(openclawDir, "openclaw.json");
  if (!fs.existsSync(file)) {
    console.log("[auto-fix] openclaw.json não encontrado em " + file + " — pulando streaming fix");
    return { changed: false, applied: false, file };
  }

  let raw, data;
  try {
    raw = fs.readFileSync(file, "utf8");
    data = JSON.parse(raw);
  } catch (err) {
    console.warn("[auto-fix] openclaw.json inválido: " + err.message + " — pulando");
    return { changed: false, applied: false, file };
  }

  if (!data.agents || typeof data.agents !== "object" || Array.isArray(data.agents)) {
    data.agents = {};
  }
  if (
    !data.agents.defaults ||
    typeof data.agents.defaults !== "object" ||
    Array.isArray(data.agents.defaults)
  ) {
    data.agents.defaults = {};
  }

  const target = {
    blockStreamingDefault: "on",
    blockStreamingBreak: "text_end",
    blockStreamingChunk: { minChars: 50, maxChars: 200 },
  };

  const changed = [];
  for (const key of Object.keys(target)) {
    if (JSON.stringify(data.agents.defaults[key]) !== JSON.stringify(target[key])) {
      changed.push(key);
      data.agents.defaults[key] = target[key];
    }
  }

  if (changed.length === 0) {
    console.log("[auto-fix] streaming: já estava correto (" + file + ")");
    return { changed: false, applied: false, file };
  }

  const backup = file + ".bak." + timestamp();
  try {
    fs.copyFileSync(file, backup);
  } catch (err) {
    console.warn("[auto-fix] não consegui criar backup de " + file + ": " + err.message);
  }

  const indent = detectIndent(raw);
  const next = JSON.stringify(data, null, indent) + "\n";
  try {
    JSON.parse(next);
  } catch (err) {
    console.error("[auto-fix] patch gerou JSON inválido: " + err.message + " — abortando");
    return { changed: false, applied: false, file, error: err.message };
  }

  atomicWrite(file, next);
  console.log("[auto-fix] streaming aplicado em " + file + ". Campos: " + changed.join(", "));
  return { changed: true, applied: true, file, fields: changed };
}

function applyBackendAuthFix() {
  const openclawDir = getOpenClawDir();
  const file = path.join(openclawDir, "openclaw.json");
  if (!fs.existsSync(file)) {
    console.log("[auto-fix] openclaw.json não encontrado em " + file + " — pulando backend-auth fix");
    return { changed: false, applied: false, file };
  }

  let raw, data;
  try {
    raw = fs.readFileSync(file, "utf8");
    data = JSON.parse(raw);
  } catch (err) {
    console.warn("[auto-fix] openclaw.json inválido: " + err.message + " — pulando backend-auth fix");
    return { changed: false, applied: false, file };
  }

  if (!data.gateway || typeof data.gateway !== "object" || Array.isArray(data.gateway)) {
    data.gateway = {};
  }
  if (
    !data.gateway.controlUi ||
    typeof data.gateway.controlUi !== "object" ||
    Array.isArray(data.gateway.controlUi)
  ) {
    data.gateway.controlUi = {};
  }

  const changed = [];
  if (data.gateway.controlUi.dangerouslyDisableDeviceAuth !== true) {
    changed.push("dangerouslyDisableDeviceAuth");
    data.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
  }
  if (data.gateway.controlUi.allowInsecureAuth !== true) {
    changed.push("allowInsecureAuth");
    data.gateway.controlUi.allowInsecureAuth = true;
  }

  if (changed.length === 0) {
    console.log("[auto-fix] backend-auth: já estava correto (" + file + ")");
    return { changed: false, applied: false, file };
  }

  const backup = file + ".bak." + timestamp();
  try {
    fs.copyFileSync(file, backup);
  } catch (err) {
    console.warn("[auto-fix] não consegui criar backup de " + file + ": " + err.message);
  }

  const indent = detectIndent(raw);
  const next = JSON.stringify(data, null, indent) + "\n";
  try {
    JSON.parse(next);
  } catch (err) {
    console.error("[auto-fix] backend-auth patch gerou JSON inválido: " + err.message);
    return { changed: false, applied: false, file, error: err.message };
  }

  atomicWrite(file, next);
  console.log("[auto-fix] backend-auth aplicado em " + file + ". Campos: " + changed.join(", "));
  return { changed: true, applied: true, file, fields: changed };
}

const HEARTBEAT_MARKER = "<!-- atlas:heartbeat-guard:v2 -->";
const HEARTBEAT_OLD_MARKERS = ["<!-- atlas:heartbeat-guard:v1 -->"];

function applyHeartbeatFix() {
  const openclawDir = getOpenClawDir();
  const workspace = getOpenClawWorkspace(openclawDir);

  // Don't create the workspace dir during deploy — the OpenClaw daemon
  // itself creates that lazily on first run. Only patch if it exists.
  if (!fs.existsSync(workspace)) {
    console.log("[auto-fix] workspace não existe (" + workspace + ") — pulando heartbeat fix");
    return { changed: false, applied: false };
  }

  const file = path.join(workspace, "AGENTS.md");
  let content = "";
  let exists = false;
  if (fs.existsSync(file)) {
    try {
      content = fs.readFileSync(file, "utf8");
      exists = true;
    } catch (err) {
      console.warn("[auto-fix] falha lendo " + file + ": " + err.message);
      return { changed: false, applied: false, file };
    }
  }

  if (content.includes(HEARTBEAT_MARKER)) {
    console.log("[auto-fix] heartbeat guard já presente em " + file);
    return { changed: false, applied: false, file };
  }

  // Strip older guard versions before appending the new one to avoid
  // accumulating duplicate blocks each time we bump the marker.
  let cleaned = content;
  for (const oldMarker of HEARTBEAT_OLD_MARKERS) {
    const idx = cleaned.indexOf(oldMarker);
    if (idx === -1) continue;
    const tail = cleaned.slice(idx);
    const stopMatch = tail.search(/\n\n(?!#|$)/);
    const stopAt = stopMatch === -1 ? cleaned.length : idx + stopMatch;
    cleaned = (cleaned.slice(0, idx) + cleaned.slice(stopAt)).replace(/\n{3,}/g, "\n\n");
  }
  content = cleaned;

  const block =
    HEARTBEAT_MARKER + "\n" +
    "## AtlasDeck web session policy (atlas-managed)\n\n" +
    "Estas regras governam mensagens que chegam via `sessionKey` começando\n" +
    "com `agent:*:web:atlasdeck`. Para o briefing matinal de cron e outras\n" +
    "sessions, mantenha o comportamento normal definido no resto do arquivo.\n\n" +
    "### 1) Heartbeat só dispara por ping literal\n\n" +
    "A regra de HEARTBEAT só se aplica quando a mensagem do usuário é\n" +
    "**literalmente** uma das strings de ping, sem outras palavras:\n\n" +
    "- `HEARTBEAT` (case-insensitive)\n" +
    "- `PING`\n\n" +
    "Nesses casos:\n" +
    "  - Leia `HEARTBEAT.md` se existir\n" +
    "  - Se nada precisa de atenção, responda exatamente `HEARTBEAT_OK`\n\n" +
    "Em **qualquer outra mensagem** (saudação, pergunta, comando, código):\n" +
    "  - Ignore completamente o template HEARTBEAT\n" +
    "  - Não leia `HEARTBEAT.md`\n" +
    "  - Responda a pergunta do usuário diretamente, em pt-BR, sem ecoar instruções\n\n" +
    "### 2) Resposta SEMPRE como assistant message item\n\n" +
    "Para sessions `web:atlasdeck`, **JAMAIS** delegue a resposta a uma tool\n" +
    "de roteamento. Em particular, **NÃO chame** nenhuma destas tools quando\n" +
    "o destinatário é o chat web:\n\n" +
    "- `message`\n" +
    "- `send_message`\n" +
    "- `sessions_send`\n" +
    "- `telegram_send` / `telegram`\n" +
    "- `whatsapp_send` / `whatsapp`\n" +
    "- `reply` / `send` / `notify` / `broadcast`\n\n" +
    "Em vez disso, **escreva a resposta como assistant message item direto**\n" +
    "(texto pt-BR no próprio turno). O AtlasDeck escuta o WS `event:agent`\n" +
    "`stream:item` esperando `data.kind:\"message\"` — se você usar uma tool\n" +
    "de envio, o usuário vê o chat vazio e a resposta vai parar em outro\n" +
    "canal (Telegram, etc.), que NÃO é onde ele está olhando.\n\n";

  if (exists) {
    const backup = file + ".bak." + timestamp();
    try {
      fs.copyFileSync(file, backup);
    } catch (err) {
      console.warn("[auto-fix] não consegui criar backup de " + file + ": " + err.message);
    }
  }

  atomicWrite(file, block + (exists ? "\n" + content : ""));
  console.log(
    "[auto-fix] heartbeat guard " +
      (exists ? "anexado em " : "criado em ") +
      file,
  );
  return { changed: true, applied: true, file, created: !exists };
}

function tryRestartGateway() {
  const attempts = [
    { bin: "systemctl", args: ["--user", "restart", "openclaw-gateway"] },
    { bin: "sudo", args: ["-n", "systemctl", "restart", "openclaw-gateway"] },
    { bin: "pm2", args: ["restart", "openclaw-gateway"] },
  ];
  for (const a of attempts) {
    try {
      execFileSync(a.bin, a.args, { stdio: "pipe", timeout: 10000 });
      console.log("[auto-fix] gateway reiniciado via " + a.bin + " " + a.args.join(" "));
      return true;
    } catch {
      // try next
    }
  }
  console.log(
    "[auto-fix] nenhum método disponível pra reiniciar (systemctl --user / sudo systemctl / pm2). " +
      "Reinicie manualmente se quiser que as mudanças entrem em vigor agora.",
  );
  return false;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const wantStreaming = args.size === 0 || args.has("--streaming") || args.has("--all");
  const wantAuth = args.size === 0 || args.has("--auth") || args.has("--all");
  const wantHeartbeat = args.size === 0 || args.has("--heartbeat") || args.has("--all");
  const wantRestart = !args.has("--no-restart");

  let anyChanged = false;
  if (wantStreaming) {
    const r = applyStreamingFix();
    anyChanged = anyChanged || r.applied;
  }
  if (wantAuth) {
    const r = applyBackendAuthFix();
    anyChanged = anyChanged || r.applied;
  }
  if (wantHeartbeat) {
    const r = applyHeartbeatFix();
    anyChanged = anyChanged || r.applied;
  }

  if (anyChanged && wantRestart) {
    tryRestartGateway();
  } else if (!anyChanged) {
    console.log("[auto-fix] nada a fazer — tudo já estava correto");
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("[auto-fix] erro: " + (err && err.message ? err.message : err));
  // Soft-fail so deploy never blocks on this.
  process.exit(0);
}
