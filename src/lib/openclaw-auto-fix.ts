/**
 * openclaw-auto-fix.ts
 *
 * Self-healing toolbox for OpenClaw configuration. Everything here is
 * intended to run from the AtlasDeck server (Next.js API routes or
 * deploy.sh) and from inside the deploy script — the user should never
 * need to open a terminal or copy-paste a JSON snippet.
 *
 * Three idempotent fixes are exposed:
 *
 *   1. ensureStreamingConfig()  — patches `~/.openclaw/openclaw.json` so
 *      `agents.defaults.blockStreaming*` enables token-by-token streaming
 *      via WebSocket. Without this, the gateway buffers the entire reply
 *      and the chat bubble looks empty / arrives in one giant blob.
 *
 *   2. ensureHeartbeatRule()   — patches the agent workspace's
 *      `AGENTS.md`/`HEARTBEAT.md` so the cron-only heartbeat workflow
 *      no longer leaks the template "Read HEARTBEAT.md…" into normal
 *      chat replies. Adds a conditional that fires only when the user
 *      message is literally `HEARTBEAT` or `PING`.
 *
 *   3. restartGateway()        — restarts the running OpenClaw gateway
 *      (systemctl --user, fallback to sudo systemctl, fallback to pm2,
 *      fallback to plain process kill). Soft-fails — never throws.
 *
 * Every mutation goes through:
 *
 *   - timestamped backup created in the same directory
 *   - patch written to a `<file>.tmp.<ts>` then atomically `rename`d
 *   - JSON validation pre-rename for openclaw.json
 *
 * All three fixes return a structured report so the UI can show exactly
 * what changed (or "already correct, nothing done"). They are safe to
 * call repeatedly — running them N times produces the same final state.
 */

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getOpenClawDir, getOpenClawWorkspace } from "@/lib/openclaw-config";

const execFileAsync = promisify(execFile);

// ─── small utils ──────────────────────────────────────────────────────────

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function backupCopy(src: string): string | null {
  try {
    const dir = path.dirname(src);
    const base = path.basename(src);
    const backup = path.join(dir, `${base}.bak.${timestamp()}`);
    fs.copyFileSync(src, backup);
    return backup;
  } catch {
    return null;
  }
}

/**
 * Detects the indentation style used in a JSON-ish text. Returns "  " by
 * default so a freshly-created file still looks neat.
 */
function detectIndent(text: string): string {
  const m = text.match(/^([ \t]+)"/m);
  return m ? m[1] : "  ";
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp.${timestamp()}.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// ─── 1. streaming config patcher ─────────────────────────────────────────

export interface StreamingFixReport {
  ok: boolean;
  alreadyCorrect: boolean;
  changed: string[];
  file: string;
  backup: string | null;
  error?: string;
}

/**
 * Forces `agents.defaults.blockStreaming*` to the values that make the
 * OpenClaw gateway stream replies token-by-token.
 *
 * Idempotent: returns `alreadyCorrect: true` when every target field
 * matches and writes nothing. Returns `changed: []` in that case so
 * callers can short-circuit the "you should restart the gateway" prompt.
 */
export function ensureStreamingConfig(): StreamingFixReport {
  const openclawDir = getOpenClawDir();
  const file = path.join(openclawDir, "openclaw.json");

  if (!fs.existsSync(file)) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed: [],
      file,
      backup: null,
      error: `openclaw.json não encontrado em ${file}. Configure o caminho do OpenClaw em Settings.`,
    };
  }

  let raw: string;
  let data: Record<string, unknown>;
  try {
    raw = fs.readFileSync(file, "utf8");
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed: [],
      file,
      backup: null,
      error: `openclaw.json existente não é JSON válido: ${(err as Error).message}`,
    };
  }

  // Walk → agents.defaults, creating the path when missing.
  if (
    !data.agents ||
    typeof data.agents !== "object" ||
    Array.isArray(data.agents)
  ) {
    data.agents = {};
  }
  const agents = data.agents as Record<string, unknown>;
  if (
    !agents.defaults ||
    typeof agents.defaults !== "object" ||
    Array.isArray(agents.defaults)
  ) {
    agents.defaults = {};
  }
  const defaults = agents.defaults as Record<string, unknown>;

  // Target values — same as scripts/_openclaw-streaming-patch.cjs.
  const target: Record<string, unknown> = {
    blockStreamingDefault: "on",
    blockStreamingBreak: "text_end",
    blockStreamingChunk: { minChars: 50, maxChars: 200 },
  };

  const changed: string[] = [];
  for (const key of Object.keys(target)) {
    if (JSON.stringify(defaults[key]) !== JSON.stringify(target[key])) {
      changed.push(key);
      defaults[key] = target[key];
    }
  }

  if (changed.length === 0) {
    return {
      ok: true,
      alreadyCorrect: true,
      changed: [],
      file,
      backup: null,
    };
  }

  const backup = backupCopy(file);
  const indent = detectIndent(raw);
  const next = JSON.stringify(data, null, indent) + "\n";
  // Validate own output before writing (paranoia — catches bugs in
  // JSON.stringify of objects that may have crept in via TypeScript
  // type-widening).
  try {
    JSON.parse(next);
  } catch (err) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed,
      file,
      backup,
      error: `Patch gerou JSON inválido (bug): ${(err as Error).message}`,
    };
  }

  try {
    atomicWrite(file, next);
  } catch (err) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed,
      file,
      backup,
      error: `Falha ao escrever ${file}: ${(err as Error).message}`,
    };
  }

  return { ok: true, alreadyCorrect: false, changed, file, backup };
}

// ─── 1b. backend-auth-bypass fix (device identity required) ─────────────

export interface BackendAuthFixReport {
  ok: boolean;
  alreadyCorrect: boolean;
  changed: string[];
  file: string;
  backup: string | null;
  error?: string;
}

/**
 * Sets `gateway.controlUi.dangerouslyDisableDeviceAuth: true` in the
 * OpenClaw config so backend clients (mode: "backend") on the loopback
 * can connect without device pairing.
 *
 * Background: starting around OpenClaw 2026.3.x the gateway started
 * rejecting WS handshakes from backend clients with "device identity
 * required" — see openclaw/openclaw#40812. The documented break-glass
 * is `dangerouslyDisableDeviceAuth: true` inside `gateway.controlUi`.
 * For a single-user / personal AtlasDeck install this is the right
 * trade-off (you already trust everything on localhost); for multi-
 * tenant setups operators should configure trusted-proxy auth instead.
 *
 * Idempotent like the other fixes.
 */
export function ensureBackendAuthBypass(): BackendAuthFixReport {
  const openclawDir = getOpenClawDir();
  const file = path.join(openclawDir, "openclaw.json");

  if (!fs.existsSync(file)) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed: [],
      file,
      backup: null,
      error: `openclaw.json não encontrado em ${file}.`,
    };
  }

  let raw: string;
  let data: Record<string, unknown>;
  try {
    raw = fs.readFileSync(file, "utf8");
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed: [],
      file,
      backup: null,
      error: `openclaw.json inválido: ${(err as Error).message}`,
    };
  }

  // Walk → gateway.controlUi, creating intermediates.
  if (
    !data.gateway ||
    typeof data.gateway !== "object" ||
    Array.isArray(data.gateway)
  ) {
    data.gateway = {};
  }
  const gateway = data.gateway as Record<string, unknown>;
  if (
    !gateway.controlUi ||
    typeof gateway.controlUi !== "object" ||
    Array.isArray(gateway.controlUi)
  ) {
    gateway.controlUi = {};
  }
  const controlUi = gateway.controlUi as Record<string, unknown>;

  const changed: string[] = [];
  if (controlUi.dangerouslyDisableDeviceAuth !== true) {
    changed.push("dangerouslyDisableDeviceAuth");
    controlUi.dangerouslyDisableDeviceAuth = true;
  }
  // allowInsecureAuth lets the Control UI load over plain HTTP on the
  // same host — common with reverse proxies that terminate TLS. Without
  // this the WS upgrade behind nginx/cloudflared can also trip the
  // device check.
  if (controlUi.allowInsecureAuth !== true) {
    changed.push("allowInsecureAuth");
    controlUi.allowInsecureAuth = true;
  }

  if (changed.length === 0) {
    return {
      ok: true,
      alreadyCorrect: true,
      changed: [],
      file,
      backup: null,
    };
  }

  const backup = backupCopy(file);
  const indent = detectIndent(raw);
  const next = JSON.stringify(data, null, indent) + "\n";
  try {
    JSON.parse(next);
  } catch (err) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed,
      file,
      backup,
      error: `Patch gerou JSON inválido: ${(err as Error).message}`,
    };
  }
  try {
    atomicWrite(file, next);
  } catch (err) {
    return {
      ok: false,
      alreadyCorrect: false,
      changed,
      file,
      backup,
      error: `Falha ao escrever ${file}: ${(err as Error).message}`,
    };
  }
  return { ok: true, alreadyCorrect: false, changed, file, backup };
}

// ─── 2. heartbeat-template-leak fix ──────────────────────────────────────

export interface HeartbeatFixReport {
  ok: boolean;
  alreadyCorrect: boolean;
  changed: boolean;
  files: { file: string; backup: string | null; action: "wrote" | "appended" | "skipped" }[];
  error?: string;
}

// Marker we use to tell whether AGENTS.md already has the conditional
// rule applied. Idempotency hinges on matching this string — keep it
// stable across versions.
const HEARTBEAT_MARKER = "<!-- atlas:heartbeat-guard:v1 -->";

const HEARTBEAT_GUARD_BLOCK = `${HEARTBEAT_MARKER}
## Heartbeat policy (atlas-managed)

A regra de HEARTBEAT só se aplica quando a mensagem do usuário é
**literalmente** uma das strings de ping, sem outras palavras:

- \`HEARTBEAT\` (case-insensitive)
- \`PING\`

Nesses casos:
  - Leia \`HEARTBEAT.md\` se existir
  - Se nada precisa de atenção, responda exatamente \`HEARTBEAT_OK\`

Em **qualquer outra mensagem** (saudação, pergunta, comando, código):
  - Ignore completamente o template HEARTBEAT
  - Não leia \`HEARTBEAT.md\`
  - Responda a pergunta do usuário diretamente, em pt-BR, sem ecoar instruções

`;

/**
 * Injects an explicit "heartbeat only fires for literal HEARTBEAT/PING"
 * guard at the top of the agent workspace's AGENTS.md. The block is
 * marked with an HTML comment sentinel so subsequent runs detect "already
 * applied" and skip without rewriting.
 *
 * The guard works because AGENTS.md is read top-to-bottom by the agent's
 * system prompt assembler; an explicit conditional at the top overrides
 * any later "always do this" instruction that was making the model echo
 * the template back as a reply.
 */
export function ensureHeartbeatRule(): HeartbeatFixReport {
  const workspace = getOpenClawWorkspace();
  const report: HeartbeatFixReport = {
    ok: true,
    alreadyCorrect: true,
    changed: false,
    files: [],
  };

  // We only patch the *main agent* workspace (where AtlasDeck routes the
  // web chat). Sub-agent workspaces are not touched.
  const file = path.join(workspace, "AGENTS.md");

  // If the workspace exists but AGENTS.md doesn't, create it with the
  // guard alone. That way fresh installs are immune to the leak too.
  if (!fs.existsSync(path.dirname(file))) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (err) {
      report.ok = false;
      report.error = `Não consegui criar diretório do workspace ${path.dirname(file)}: ${
        (err as Error).message
      }`;
      return report;
    }
  }

  let content = "";
  let exists = false;
  if (fs.existsSync(file)) {
    exists = true;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (err) {
      report.ok = false;
      report.error = `Falha ao ler ${file}: ${(err as Error).message}`;
      return report;
    }
  }

  if (content.includes(HEARTBEAT_MARKER)) {
    report.files.push({ file, backup: null, action: "skipped" });
    return report;
  }

  const backup = exists ? backupCopy(file) : null;
  const next = exists ? `${HEARTBEAT_GUARD_BLOCK}\n${content}` : HEARTBEAT_GUARD_BLOCK;

  try {
    atomicWrite(file, next);
  } catch (err) {
    report.ok = false;
    report.error = `Falha ao escrever ${file}: ${(err as Error).message}`;
    return report;
  }

  report.alreadyCorrect = false;
  report.changed = true;
  report.files.push({ file, backup, action: exists ? "appended" : "wrote" });
  return report;
}

// ─── 3. gateway restart ──────────────────────────────────────────────────

export interface RestartReport {
  ok: boolean;
  method: "systemctl-user" | "systemctl-system" | "pm2" | "none";
  detail: string;
  error?: string;
}

async function tryExec(
  bin: string,
  args: string[],
  timeoutMs = 8000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

/**
 * Tries every common way of restarting the gateway, returning at the
 * first one that succeeds. Soft-fails — caller can decide whether to
 * surface the error or just remind the user to do it manually.
 */
export async function restartGateway(): Promise<RestartReport> {
  // 1) systemd --user — typical install
  const userCheck = await tryExec("systemctl", ["--user", "is-active", "openclaw-gateway"]);
  if (userCheck.ok || /inactive|failed/.test(userCheck.stdout)) {
    const result = await tryExec("systemctl", ["--user", "restart", "openclaw-gateway"]);
    if (result.ok) {
      return {
        ok: true,
        method: "systemctl-user",
        detail: "Reiniciado via systemctl --user restart openclaw-gateway",
      };
    }
    if (!/not-found|No such file/i.test(`${result.stdout}\n${result.stderr}`)) {
      // unit exists but restart failed — return error
      return {
        ok: false,
        method: "systemctl-user",
        detail: "systemctl --user restart falhou",
        error: result.stderr.slice(0, 400),
      };
    }
  }

  // 2) systemd system-wide — needs sudo, typically not present in dev
  const sysCheck = await tryExec("systemctl", ["is-active", "openclaw-gateway"]);
  if (sysCheck.ok || /inactive|failed/.test(sysCheck.stdout)) {
    const result = await tryExec("sudo", ["-n", "systemctl", "restart", "openclaw-gateway"]);
    if (result.ok) {
      return {
        ok: true,
        method: "systemctl-system",
        detail: "Reiniciado via sudo systemctl restart openclaw-gateway",
      };
    }
  }

  // 3) PM2 — if user runs OpenClaw under PM2 instead of systemd
  const pm2Result = await tryExec("pm2", ["restart", "openclaw-gateway"]);
  if (pm2Result.ok) {
    return {
      ok: true,
      method: "pm2",
      detail: "Reiniciado via pm2 restart openclaw-gateway",
    };
  }

  return {
    ok: false,
    method: "none",
    detail:
      "Não consegui reiniciar automaticamente — nenhum método disponível (systemctl --user, sudo systemctl, pm2).",
    error:
      "Reinicie manualmente: systemctl --user restart openclaw-gateway (ou como você gerencia o gateway).",
  };
}

// ─── 4. health check (read-only) ─────────────────────────────────────────

export interface HealthCheckReport {
  streamingOk: boolean;
  heartbeatGuardOk: boolean;
  backendAuthOk: boolean;
  openclawJsonPath: string;
  agentsMdPath: string;
  openclawJsonExists: boolean;
  agentsMdExists: boolean;
}

/**
 * Non-mutating snapshot of the things the auto-fixers care about.
 * Used by the chat page on load to decide whether to nag the user
 * about an inconsistency *before* they hit it in a turn.
 */
export function checkOpenClawHealth(): HealthCheckReport {
  const openclawDir = getOpenClawDir();
  const workspace = getOpenClawWorkspace();
  const openclawJsonPath = path.join(openclawDir, "openclaw.json");
  const agentsMdPath = path.join(workspace, "AGENTS.md");

  let streamingOk = false;
  let backendAuthOk = false;
  let openclawJsonExists = false;
  try {
    if (fs.existsSync(openclawJsonPath)) {
      openclawJsonExists = true;
      const parsed = JSON.parse(fs.readFileSync(openclawJsonPath, "utf8")) as {
        agents?: { defaults?: Record<string, unknown> };
        gateway?: { controlUi?: Record<string, unknown> };
      };
      const d = parsed.agents?.defaults ?? {};
      streamingOk =
        d.blockStreamingDefault === "on" &&
        d.blockStreamingBreak === "text_end" &&
        typeof d.blockStreamingChunk === "object";
      const cui = parsed.gateway?.controlUi ?? {};
      backendAuthOk = cui.dangerouslyDisableDeviceAuth === true;
    }
  } catch {
    streamingOk = false;
    backendAuthOk = false;
  }

  let heartbeatGuardOk = false;
  let agentsMdExists = false;
  try {
    if (fs.existsSync(agentsMdPath)) {
      agentsMdExists = true;
      heartbeatGuardOk = fs.readFileSync(agentsMdPath, "utf8").includes(HEARTBEAT_MARKER);
    } else {
      // No AGENTS.md at all is fine — the leak only happens when there's
      // an existing template that ignores message context.
      heartbeatGuardOk = true;
    }
  } catch {
    heartbeatGuardOk = false;
  }

  return {
    streamingOk,
    heartbeatGuardOk,
    backendAuthOk,
    openclawJsonPath,
    agentsMdPath,
    openclawJsonExists,
    agentsMdExists,
  };
}
