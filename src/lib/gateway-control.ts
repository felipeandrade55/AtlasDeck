/**
 * Gateway control: adaptive strategies to restart, inspect and tail logs
 * for the OpenClaw gateway, regardless of how it was launched.
 *
 * Order of preference, each falling through if the previous is unavailable:
 *   1. systemd unit `openclaw-gateway.service` (clean restart via systemctl)
 *   2. PM2 process whose name/script/args mention openclaw
 *   3. Bare process discovered via `pgrep`, killed with SIGTERM/SIGKILL and
 *      respawned detached using the exact argv/cwd/env captured from /proc
 *
 * The same fallback chain backs `/api/recovery/action gateway-restart` and
 * `/api/actions restart-gateway` so the dashboard works on every install
 * style we ship.
 */
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { readFile, readlink, readdir, stat, mkdir } from "fs/promises";
import { openSync } from "fs";
import path from "path";

import { OPENCLAW_DIR } from "./paths";

/**
 * Where we redirect stdout/stderr of any daemon we spawn detached. Without
 * this, `stdio: "ignore"` would route crashes to /dev/null and we'd never
 * see WHY the agent fails to process a message. gatewayLogs() already
 * checks this path in its strategy 3 fallback.
 */
const GATEWAY_LOG = path.join(OPENCLAW_DIR, "logs", "gateway.log");

async function ensureGatewayLog(): Promise<{ out: number; err: number } | null> {
  try {
    await mkdir(path.dirname(GATEWAY_LOG), { recursive: true });
    const out = openSync(GATEWAY_LOG, "a");
    const err = openSync(GATEWAY_LOG, "a");
    return { out, err };
  } catch {
    return null;
  }
}

const execAsync = promisify(exec);

export type GatewayRuntime = "systemd" | "pm2" | "process" | "unknown";

interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function safeExec(cmd: string, timeoutMs = 8000): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      shell: "/bin/bash",
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || String(e),
    };
  }
}

async function hasSystemdUnit(unit = "openclaw-gateway"): Promise<boolean> {
  const r = await safeExec(
    `systemctl show ${unit} --property=LoadState --value 2>/dev/null`,
    3000,
  );
  return r.ok && r.stdout.trim() === "loaded";
}

async function findPm2Name(): Promise<string | null> {
  const r = await safeExec(`pm2 jlist 2>/dev/null`, 5000);
  if (!r.ok || !r.stdout.trim()) return null;
  try {
    const list = JSON.parse(r.stdout) as Array<{
      name?: string;
      pm2_env?: { args?: string[]; script?: string; status?: string };
    }>;
    for (const p of list) {
      const name = p.name || "";
      const args = p.pm2_env?.args || [];
      const script = p.pm2_env?.script || "";
      const haystack = `${name} ${script} ${args.join(" ")}`.toLowerCase();
      // Match the openclaw gateway but skip atlasdeck itself
      if (haystack.includes("openclaw") && !haystack.includes("atlasdeck")) {
        return name;
      }
    }
  } catch {
    // jlist returned non-JSON; pm2 unavailable
  }
  return null;
}

async function readCmdline(pid: number): Promise<string | null> {
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`);
    return buf.toString("utf8").replace(/\0/g, " ").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns the PIDs that look like a real, *running* OpenClaw gateway daemon.
 *
 * The previous regex (`openclaw.*gateway`) matched too many false positives:
 *  - ephemeral shells like `bash -c "openclaw status gateway"`
 *  - the AI assistant's own `codex exec` reading config that mentions both words
 *  - pgrep racing against itself
 * Then `/proc/<pid>/cmdline` would ENOENT because those processes died between
 * detection and respawn, showing a misleading "you're on macOS" hint.
 *
 * Strategy now:
 *   1. Use a tighter pgrep pattern.
 *   2. For each candidate, re-read /proc/<pid>/cmdline NOW and validate:
 *      - process still exists
 *      - cmdline is not just a shell one-liner
 *      - cmdline actually contains "openclaw" AND "gateway"
 *      - PID is not our own process tree
 */
async function findGatewayPids(): Promise<number[]> {
  const r = await safeExec(
    `pgrep -f 'openclaw[^/[:space:]]*gateway|openclaw-gateway|openclaw[^[:space:]]* gateway' 2>/dev/null || true`,
    3000,
  );
  const candidates = r.stdout
    .trim()
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid && n !== process.ppid);

  const valid: number[] = [];
  for (const pid of candidates) {
    const cmdline = await readCmdline(pid);
    if (!cmdline) continue; // process already gone — skip silently
    // Skip ephemeral shells (e.g. `bash -c "openclaw gateway status"`)
    if (/^(?:[\w/.-]*\/)?(sh|bash|zsh|fish|dash|ksh)\s+-[ic]\s/.test(cmdline)) continue;
    // Skip pgrep itself
    if (/(?:^|\/)pgrep(\s|$)/.test(cmdline)) continue;
    // Skip our own AI assistant processes (codex/claude) reading configs
    if (/(?:^|\/)(codex|claude)(\s|$)/.test(cmdline)) continue;
    const lc = cmdline.toLowerCase();
    if (!lc.includes("openclaw") || !lc.includes("gateway")) continue;
    valid.push(pid);
  }
  return valid;
}

async function isLinuxProc(): Promise<boolean> {
  try {
    await stat("/proc/1/cmdline");
    return true;
  } catch {
    return false;
  }
}

export async function detectGatewayRuntime(): Promise<GatewayRuntime> {
  if (await hasSystemdUnit()) return "systemd";
  if (await findPm2Name()) return "pm2";
  if ((await findGatewayPids()).length > 0) return "process";
  return "unknown";
}

export interface RestartResult {
  success: boolean;
  runtime: GatewayRuntime;
  output: string;
}

/**
 * Standalone start action — used by the `gateway-start` recovery action so the
 * user can explicitly bootstrap without first triggering a restart cycle.
 * Skips the start attempt if a gateway is already alive (use restart for that).
 */
export async function startGateway(): Promise<RestartResult> {
  const log: string[] = [];

  // First check: anything alive? Don't double-start
  const existing = await findGatewayPids();
  if (existing.length > 0) {
    log.push(`✓ Gateway já está rodando (PIDs ${existing.join(", ")})`);
    log.push("Para forçar reinício, use o botão 'Reiniciar Gateway'.");
    return { success: true, runtime: "process", output: log.join("\n") };
  }

  // systemd takes precedence if available
  if (await hasSystemdUnit()) {
    log.push("→ systemd unit detectada — usando `systemctl start openclaw-gateway`");
    const r = await safeExec("systemctl start openclaw-gateway 2>&1", 15000);
    if (r.ok) {
      const check = await safeExec("systemctl is-active openclaw-gateway 2>&1 || echo unknown", 3000);
      const state = check.stdout.trim();
      log.push(`systemctl start: ok · is-active=${state}`);
      return { success: state === "active", runtime: "systemd", output: log.join("\n") };
    }
    log.push(`systemctl start falhou: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    log.push("Tentando bootstrap via CLI…");
  }

  log.push("→ Bootstrap via `openclaw daemon start` detached");
  const boot = await tryStartDaemon(log);
  return {
    success: boot.success,
    runtime: boot.success ? "process" : "unknown",
    output: log.join("\n"),
  };
}

/**
 * Last-resort bootstrap: spawn `openclaw daemon start` detached when nothing
 * is running. Tries multiple command variants since OpenClaw's start command
 * differs between releases. Pushes progress into the shared log array so the
 * caller's output stays coherent.
 */
async function tryStartDaemon(log: string[]): Promise<{ success: boolean }> {
  // Confirm openclaw binary exists
  const whichRes = await safeExec("command -v openclaw 2>/dev/null || true", 2000);
  const bin = whichRes.stdout.trim();
  if (!bin) {
    log.push("  ✗ Binário `openclaw` não está no PATH");
    return { success: false };
  }
  log.push(`  Binário: ${bin}`);

  // Variants to try, in order of likelihood
  const variants: Array<{ args: string[]; label: string }> = [
    { args: ["daemon", "start"], label: "openclaw daemon start" },
    { args: ["gateway", "start"], label: "openclaw gateway start" },
    { args: ["start"], label: "openclaw start" },
  ];

  const logFds = await ensureGatewayLog();
  if (logFds) {
    log.push(`  (stdout/stderr serão capturados em ${GATEWAY_LOG})`);
  }

  for (const v of variants) {
    log.push(`  ▸ Tentando: ${v.label}`);
    try {
      const child = spawn(bin, v.args, {
        cwd: OPENCLAW_DIR,
        detached: true,
        stdio: logFds ? ["ignore", logFds.out, logFds.err] : "ignore",
        env: process.env,
      });
      child.unref();
      log.push(`    ✓ Spawn ok (PID ${child.pid ?? "?"})`);
    } catch (e) {
      log.push(`    ✗ Spawn falhou: ${(e as Error).message}`);
      continue;
    }

    // Wait up to 5s for the gateway to appear
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const alive = await findGatewayPids();
      if (alive.length > 0) {
        log.push(`    ✓ Gateway online (PIDs ${alive.join(", ")}) em ${(i + 1) * 500}ms`);
        return { success: true };
      }
    }
    log.push(`    ⚠ Spawn ok mas gateway não apareceu em 5s — tentando próxima variante`);
  }

  return { success: false };
}

export async function restartGateway(): Promise<RestartResult> {
  const log: string[] = [];

  // ─── Strategy 1: systemd ──────────────────────────────────────
  if (await hasSystemdUnit()) {
    log.push("→ systemd unit detectada (openclaw-gateway.service)");
    const r = await safeExec(`systemctl restart openclaw-gateway 2>&1`, 15000);
    if (r.ok) {
      const check = await safeExec(
        `systemctl is-active openclaw-gateway 2>&1 || echo unknown`,
        3000,
      );
      const state = check.stdout.trim();
      log.push(`systemctl restart: ok · is-active=${state}`);
      return {
        success: state === "active",
        runtime: "systemd",
        output: log.join("\n"),
      };
    }
    log.push(`systemctl restart falhou: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    log.push("Tentando próxima estratégia…");
  } else {
    log.push("systemd: unit openclaw-gateway.service não encontrada");
  }

  // ─── Strategy 2: PM2 ──────────────────────────────────────────
  const pm2Name = await findPm2Name();
  if (pm2Name) {
    log.push(`→ PM2: processo "${pm2Name}" detectado`);
    const r = await safeExec(`pm2 restart "${pm2Name}" 2>&1`, 20000);
    const tail = (r.stdout || r.stderr).trim().split("\n").slice(-8).join("\n");
    log.push(tail);
    if (r.ok) {
      return { success: true, runtime: "pm2", output: log.join("\n") };
    }
    log.push("PM2 restart falhou, tentando próxima estratégia…");
  } else {
    log.push("PM2: nenhum processo openclaw encontrado em pm2 jlist");
  }

  // ─── Strategy 3: pgrep + /proc respawn ────────────────────────
  log.push("→ pgrep + respawn detached via /proc");

  const onLinux = await isLinuxProc();
  if (!onLinux) {
    log.push("✗ /proc não disponível (não estamos em Linux)");
    log.push("Sugestões:");
    log.push("  - macOS/Windows: rode o gateway via PM2 ou systemd");
    log.push("  - Linux real: este servidor pode estar dentro de um container sem /proc");
    return { success: false, runtime: "unknown", output: log.join("\n") };
  }

  const pids = await findGatewayPids();
  if (pids.length === 0) {
    log.push("✗ Nenhum processo gateway em execução");
    log.push("→ Tentando bootstrap com `openclaw daemon start`…");
    const boot = await tryStartDaemon(log);
    if (boot.success) {
      return { success: true, runtime: "process", output: log.join("\n") };
    }
    log.push("Sugestões manuais:");
    log.push("  - SSH no servidor e rode: `openclaw daemon start`");
    log.push("  - Confirme que `openclaw` está no PATH: `command -v openclaw`");
    log.push("  - Veja o output do start: `openclaw daemon start 2>&1 | head -40`");
    return { success: false, runtime: "unknown", output: log.join("\n") };
  }

  log.push(`Candidatos detectados: ${pids.join(", ")}`);

  // Try each PID in order — first one that survives capture wins
  let lastErr = "";
  for (const pid of pids) {
    log.push(`▸ Tentando PID ${pid}…`);

    let argv: string[];
    let cwd: string;
    let env: Record<string, string> = {};
    try {
      const cmdlineRaw = await readFile(`/proc/${pid}/cmdline`);
      argv = cmdlineRaw
        .toString("utf8")
        .split("\0")
        .filter((s) => s.length > 0);
      if (argv.length === 0) throw new Error("cmdline vazio");
      cwd = await readlink(`/proc/${pid}/cwd`);
      try {
        const envRaw = await readFile(`/proc/${pid}/environ`);
        for (const pair of envRaw.toString("utf8").split("\0")) {
          const i = pair.indexOf("=");
          if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
        }
      } catch {
        env = { ...(process.env as Record<string, string>) };
      }
      log.push(`  argv: ${argv.slice(0, 6).join(" ")}${argv.length > 6 ? " …" : ""}`);
      log.push(`  cwd: ${cwd}`);
    } catch (err) {
      lastErr = `PID ${pid} desapareceu antes do snapshot: ${(err as Error).message}`;
      log.push(`  ✗ ${lastErr}`);
      continue;
    }

    // SIGTERM, then SIGKILL after grace
    try {
      process.kill(pid, "SIGTERM");
      log.push(`  ✓ SIGTERM → ${pid}`);
    } catch (err) {
      lastErr = `SIGTERM falhou: ${(err as Error).message}`;
      log.push(`  ✗ ${lastErr}`);
      continue;
    }

    const grace = 5000;
    const t0 = Date.now();
    while (Date.now() - t0 < grace) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        process.kill(pid, 0);
      } catch {
        log.push(`  ✓ Processo encerrou em ${Date.now() - t0}ms`);
        break;
      }
    }
    try {
      process.kill(pid, 0);
      try {
        process.kill(pid, "SIGKILL");
        log.push("  ⚠ SIGKILL forçado após grace de 5s");
      } catch {
        // already dead between probe and kill
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // already gone
    }

    // Respawn detached so the child outlives this HTTP request. Capture
    // stdout/stderr to gateway.log so we can see crashes.
    try {
      const [cmd, ...args] = argv;
      const logFds = await ensureGatewayLog();
      const child = spawn(cmd, args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        detached: true,
        stdio: logFds ? ["ignore", logFds.out, logFds.err] : "ignore",
      });
      child.unref();
      log.push(`  ✓ Respawn detached, novo PID ${child.pid ?? "?"}${logFds ? ` (logs → ${GATEWAY_LOG})` : ""}`);
    } catch (err) {
      lastErr = `Respawn falhou: ${(err as Error).message}`;
      log.push(`  ✗ ${lastErr}`);
      continue;
    }

    // Verify it came back up
    await new Promise((r) => setTimeout(r, 2000));
    const alive = await findGatewayPids();
    if (alive.length === 0) {
      lastErr = "respawn ok mas nada vivo após 2s";
      log.push(`  ⚠ ${lastErr}`);
      continue;
    }
    log.push(`✓ Gateway online (PIDs ${alive.join(", ")})`);
    return { success: true, runtime: "process", output: log.join("\n") };
  }

  log.push(`✗ Todos os ${pids.length} PID(s) falharam. Último erro: ${lastErr}`);
  log.push("Tente: `openclaw daemon start` ou veja `pgrep -af openclaw`.");
  return { success: false, runtime: "process", output: log.join("\n") };
}

export interface LogsResult {
  source: string;
  output: string;
  found: boolean;
}

export async function gatewayLogs(
  opts: { errorsOnly?: boolean; lines?: number } = {},
): Promise<LogsResult> {
  const lines = opts.lines ?? 200;
  const errOnly = !!opts.errorsOnly;

  // 1. systemd journal
  if (await hasSystemdUnit()) {
    const cmd = errOnly
      ? `journalctl -u openclaw-gateway -n ${lines} --no-pager -p err 2>/dev/null`
      : `journalctl -u openclaw-gateway -n ${lines} --no-pager 2>/dev/null`;
    const r = await safeExec(cmd, 8000);
    const text = (r.stdout || "").trim();
    if (text && !/^-- No entries --$/m.test(text)) {
      return { source: "journalctl (systemd)", output: text, found: true };
    }
  }

  // 2. PM2 logs
  const pm2Name = await findPm2Name();
  if (pm2Name) {
    const logFile = errOnly
      ? `/root/.pm2/logs/${pm2Name}-error.log`
      : `/root/.pm2/logs/${pm2Name}-out.log`;
    const r = await safeExec(`tail -n ${lines} "${logFile}" 2>/dev/null`, 5000);
    const text = (r.stdout || "").trim();
    if (text) {
      return { source: `PM2 ${logFile}`, output: text, found: true };
    }
  }

  // 3. Workspace logs
  const candidates = [
    path.join(OPENCLAW_DIR, "logs", "gateway.log"),
    path.join(OPENCLAW_DIR, "logs", "gateway-error.log"),
    path.join(OPENCLAW_DIR, "gateway.log"),
    "/var/log/openclaw-gateway.log",
  ];
  for (const file of candidates) {
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      const r = await safeExec(`tail -n ${lines} "${file}" 2>/dev/null`, 5000);
      const text = (r.stdout || "").trim();
      if (!text) continue;
      const out = errOnly
        ? text.split("\n").filter((l) => /\b(error|fatal|warn)\b/i.test(l)).join("\n")
        : text;
      return { source: file, output: out || "(sem linhas de erro recentes)", found: true };
    } catch {
      // try next
    }
  }

  // 4. logs directory scan
  const logsDir = path.join(OPENCLAW_DIR, "logs");
  try {
    const files = (await readdir(logsDir)).filter((f) => f.endsWith(".log"));
    if (files.length > 0) {
      const chunks: string[] = [];
      for (const f of files.slice(0, 3)) {
        const r = await safeExec(
          `tail -n ${Math.floor(lines / files.length) || 50} "${path.join(logsDir, f)}" 2>/dev/null`,
          5000,
        );
        if (r.stdout.trim()) {
          chunks.push(`─── ${f} ───`, r.stdout.trim());
        }
      }
      if (chunks.length > 0) {
        const text = chunks.join("\n");
        const out = errOnly
          ? text.split("\n").filter((l) => /^─|\b(error|fatal|warn)\b/i.test(l)).join("\n")
          : text;
        return { source: logsDir, output: out, found: true };
      }
    }
  } catch {
    // dir doesn't exist
  }

  // 5. /proc/<pid>/fd inspection — when openclaw runs as a bare process its
  // stdout/stderr might point to a file the user redirected to (or a tty/pipe
  // with no logging at all). This is the case the previous fallback chain
  // missed entirely, leading to "Nenhuma fonte de logs encontrada".
  const procPids = await findGatewayPids();
  if (procPids.length > 0) {
    const probeReport: string[] = [];
    for (const pid of procPids) {
      probeReport.push(`─── PID ${pid} ───`);
      try {
        const cmdline = await readCmdline(pid);
        if (cmdline) probeReport.push(`cmdline: ${cmdline.slice(0, 200)}`);
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (cwd) probeReport.push(`cwd: ${cwd}`);
      } catch {}

      for (const fd of ["1", "2"] as const) {
        const label = fd === "1" ? "stdout" : "stderr";
        try {
          const target = await readlink(`/proc/${pid}/fd/${fd}`);
          probeReport.push(`${label} → ${target}`);
          // If it points to a real file (not /dev/null, not a pipe/socket), tail it
          if (target.startsWith("/") && !target.startsWith("/dev/") && !target.includes("pipe:") && !target.includes("socket:")) {
            const r = await safeExec(`tail -n ${lines} "${target}" 2>/dev/null`, 5000);
            const text = (r.stdout || "").trim();
            if (text) {
              const out = errOnly
                ? text.split("\n").filter((l) => /\b(error|fatal|warn|exception|traceback)\b/i.test(l)).join("\n")
                : text;
              if (out.trim()) {
                return {
                  source: `/proc/${pid}/fd/${fd} → ${target}`,
                  output: `[capturado de ${label} do PID ${pid}]\n\n${out}`,
                  found: true,
                };
              }
            }
          }
        } catch {
          probeReport.push(`${label}: (sem acesso)`);
        }
      }
    }
    // Add the probe report so the user can manually inspect
    const runtime = await detectGatewayRuntime();
    return {
      source: "diagnóstico /proc",
      output:
        "Não encontrei arquivo de log explícito.\n" +
        `Runtime detectado: ${runtime}\n\n` +
        "Inspeção dos processos OpenClaw:\n" +
        probeReport.join("\n") +
        "\n\n" +
        "Próximos passos:\n" +
        "  - Se stdout/stderr aponta para /dev/null, o openclaw foi iniciado sem logging — reinicie com `openclaw daemon start > /var/log/openclaw.log 2>&1 &` ou configure systemd/PM2\n" +
        "  - Se aponta para pipe:/socket: o pai do processo está consumindo (e provavelmente descartando)\n" +
        "  - Se aponta para um arquivo: rode `tail -F <arquivo>` direto",
      found: false,
    };
  }

  // 6. Truly nothing — last-ditch generic message with actionable commands
  const runtime = await detectGatewayRuntime();
  return {
    source: "n/d",
    output:
      "Nenhuma fonte de logs encontrada.\n" +
      `Runtime detectado: ${runtime}\n\n` +
      "Comandos pra investigar manualmente no servidor:\n" +
      "  pgrep -af openclaw           # confirma se o processo existe\n" +
      "  systemctl status openclaw-gateway  # se houver unit\n" +
      "  pm2 list                     # se rodando via PM2\n" +
      `  ls -la ${OPENCLAW_DIR}/logs   # diretório de logs do openclaw\n` +
      "  journalctl -n 500 | grep -i openclaw   # varredura larga",
    found: false,
  };
}
