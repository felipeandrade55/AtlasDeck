/**
 * Self-diagnostic for the atlasdeck-memory MCP server.
 *
 * Walks the full chain a layperson can't see — config file, paths,
 * binaries, script syntax — and tops it off with a "smoke spawn":
 * boots the actual MCP child process for a few seconds, captures
 * its stderr, and reports whether it ever printed the canonical
 * "ready (stdio transport)" line.
 *
 * Output is a structured list of checks so the UI can render the
 * exact same idiom the Telegram doctor uses (✓ ok · ⚠ warn · ✗ fail).
 */
import { promises as fsAsync } from "fs";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  inspectStatus,
  type InstallStatus,
} from "@/lib/openclaw-mcp-config";
import { getOpenClawDir } from "@/lib/openclaw-config";

export type DiagnoseLevel = "ok" | "warn" | "fail";

export interface DiagnoseCheck {
  id: string;
  level: DiagnoseLevel;
  title: string;
  detail: string;
  fix?: string;
}

export interface DiagnoseReport {
  ok: boolean;
  generatedAt: string;
  status: InstallStatus;
  checks: DiagnoseCheck[];
  spawnProbe: SpawnProbeResult;
  summary: { ok: number; warn: number; fail: number };
}

export interface SpawnProbeResult {
  attempted: boolean;
  reachedReady: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  durationMs: number;
  stderrTail: string;
  stdoutTail: string;
  startError: string | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsAsync.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readable(p: string): Promise<boolean> {
  try {
    await fsAsync.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Smoke-spawn the MCP child the same way OpenClaw would, then kill
 * it cleanly. We do NOT send an `initialize` request — getting to
 * "ready (stdio transport)" on stderr is enough to prove the boot
 * sequence passed every guard rail.
 */
async function spawnProbe(
  entry: InstallStatus["expected"],
): Promise<SpawnProbeResult> {
  const start = Date.now();
  let resolved = false;
  return new Promise<SpawnProbeResult>((resolve) => {
    let stderr = "";
    let stdout = "";
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let startError: string | null = null;

    const finish = (reachedReady: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve({
        attempted: true,
        reachedReady,
        exitCode,
        exitSignal,
        durationMs: Date.now() - start,
        stderrTail: stderr.split("\n").slice(-20).join("\n"),
        stdoutTail: stdout.split("\n").slice(-5).join("\n"),
        startError,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(entry.command, entry.args, {
        env: { ...process.env, ...(entry.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
      resolve({
        attempted: false,
        reachedReady: false,
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - start,
        stderrTail: "",
        stdoutTail: "",
        startError,
      });
      return;
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderr += s;
      if (s.includes("ready (stdio transport)")) {
        finish(true);
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      startError = err.message;
      finish(false);
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Give stderr a tick to flush after exit before finalizing.
      setTimeout(() => finish(false), 50);
    });

    // Hard timeout: if we haven't seen "ready" or an exit in 6s,
    // consider the spawn stuck.
    setTimeout(() => finish(stderr.includes("ready (stdio transport)")), 6000);
  });
}

export async function diagnoseMemoryMcp(opts: {
  agentId?: string;
} = {}): Promise<DiagnoseReport> {
  const atlasdeckRoot = process.cwd();
  const agentId = opts.agentId ?? "main";
  const checks: DiagnoseCheck[] = [];

  const status = inspectStatus({ atlasdeckRoot, agentId });

  // ─── 1. OpenClaw dir ────────────────────────────────────────────
  const openclawDir = getOpenClawDir();
  if (await exists(openclawDir)) {
    checks.push({
      id: "openclaw-dir",
      level: "ok",
      title: "Diretório OpenClaw localizado",
      detail: openclawDir,
    });
  } else {
    checks.push({
      id: "openclaw-dir",
      level: "fail",
      title: "Diretório OpenClaw não encontrado",
      detail: `Esperado em ${openclawDir}. Memória não terá onde se registrar.`,
      fix: "Instale o OpenClaw ou ajuste OPENCLAW_DIR.",
    });
    return finalize(checks, status, {
      attempted: false,
      reachedReady: false,
      exitCode: null,
      exitSignal: null,
      durationMs: 0,
      stderrTail: "",
      stdoutTail: "",
      startError: "openclaw dir missing",
    });
  }

  // ─── 2. mcp.json present ────────────────────────────────────────
  if (status.configExists) {
    checks.push({
      id: "mcp-json",
      level: "ok",
      title: "mcp.json presente",
      detail: status.configPath,
    });
  } else {
    checks.push({
      id: "mcp-json",
      level: "warn",
      title: "mcp.json ainda não criado",
      detail: `Será criado em ${status.configPath} ao ativar.`,
      fix: 'Clique em "Ativar memória avançada".',
    });
  }

  // ─── 3. atlasdeck-memory registered ─────────────────────────────
  if (status.installed && status.upToDate) {
    checks.push({
      id: "entry-installed",
      level: "ok",
      title: "Entry atlasdeck-memory registrado e atualizado",
      detail: `${status.serverName} aponta para ${status.expected.args.join(
        " ",
      )}`,
    });
  } else if (status.installed && !status.upToDate) {
    checks.push({
      id: "entry-installed",
      level: "warn",
      title: "Entry presente mas divergente",
      detail:
        "O caminho/env gravado não bate com o que rodaria hoje (provável mudança de checkout).",
      fix: 'Clique em "Atualizar e recarregar".',
    });
  } else {
    checks.push({
      id: "entry-installed",
      level: "fail",
      title: "Entry atlasdeck-memory não registrado",
      detail: "O agente não vê as ferramentas de memória ainda.",
      fix: 'Clique em "Ativar memória avançada".',
    });
  }

  // ─── 4. ATLASDECK_ROOT in entry resolvable ──────────────────────
  const entryRoot = status.expected.env?.ATLASDECK_ROOT;
  if (entryRoot && (await exists(entryRoot))) {
    checks.push({
      id: "atlasdeck-root",
      level: "ok",
      title: "ATLASDECK_ROOT resolvido",
      detail: entryRoot,
    });
  } else {
    checks.push({
      id: "atlasdeck-root",
      level: "fail",
      title: "ATLASDECK_ROOT inválido",
      detail: `Não foi possível acessar ${entryRoot}. O servidor MCP vai falhar no boot.`,
      fix: "Refaça a ativação no host correto.",
    });
  }

  // ─── 5. Script file present and readable ────────────────────────
  const scriptPath = status.expected.args.find((a) =>
    a.includes("atlasdeck-memory-mcp"),
  );
  if (scriptPath && (await readable(scriptPath))) {
    checks.push({
      id: "script-file",
      level: "ok",
      title: "Script do MCP server acessível",
      detail: scriptPath,
    });
  } else {
    checks.push({
      id: "script-file",
      level: "fail",
      title: "Script do MCP server não encontrado",
      detail: `Esperado em ${scriptPath ?? "?"}`,
      fix: "Verifique se o AtlasDeck foi clonado/atualizado no host atual.",
    });
  }

  // ─── 6. data/ dir writable (SQLite + model cache) ──────────────
  const dataDir = path.join(atlasdeckRoot, "data");
  try {
    await fsAsync.mkdir(dataDir, { recursive: true });
    await fsAsync.access(dataDir, fs.constants.W_OK);
    checks.push({
      id: "data-dir",
      level: "ok",
      title: "Pasta data/ gravável",
      detail: dataDir,
    });
  } catch (err) {
    checks.push({
      id: "data-dir",
      level: "fail",
      title: "Pasta data/ não está gravável",
      detail: err instanceof Error ? err.message : String(err),
      fix: "Corrija as permissões do diretório data/.",
    });
  }

  // ─── 7. Spawn probe — boots the MCP child for real ─────────────
  let probe: SpawnProbeResult;
  if (status.installed && entryRoot && (await exists(entryRoot))) {
    probe = await spawnProbe(status.expected);
    if (probe.reachedReady) {
      checks.push({
        id: "spawn-probe",
        level: "ok",
        title: "Servidor MCP sobe e fica pronto",
        detail: `Boot em ${probe.durationMs}ms`,
      });
    } else if (probe.startError) {
      checks.push({
        id: "spawn-probe",
        level: "fail",
        title: "Não foi possível iniciar o servidor MCP",
        detail: probe.startError,
        fix: "Verifique se o comando do entry está no PATH (tsx, npx, node).",
      });
    } else {
      checks.push({
        id: "spawn-probe",
        level: "fail",
        title: "Servidor MCP encerrou sem ficar pronto",
        detail:
          `exitCode=${probe.exitCode} signal=${probe.exitSignal}\n` +
          (probe.stderrTail || "(sem stderr)"),
        fix: "Use o stderr acima — códigos 4/5/6/7 são guardas internos do script.",
      });
    }
  } else {
    probe = {
      attempted: false,
      reachedReady: false,
      exitCode: null,
      exitSignal: null,
      durationMs: 0,
      stderrTail: "",
      stdoutTail: "",
      startError: "skipped: entry missing or root invalid",
    };
    checks.push({
      id: "spawn-probe",
      level: "warn",
      title: "Probe de spawn pulado",
      detail: "Configuração ainda incompleta — corrigir checks acima primeiro.",
    });
  }

  return finalize(checks, status, probe);
}

function finalize(
  checks: DiagnoseCheck[],
  status: InstallStatus,
  spawnResult: SpawnProbeResult,
): DiagnoseReport {
  const summary = {
    ok: checks.filter((c) => c.level === "ok").length,
    warn: checks.filter((c) => c.level === "warn").length,
    fail: checks.filter((c) => c.level === "fail").length,
  };
  return {
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    status,
    checks,
    spawnProbe: spawnResult,
    summary,
  };
}
