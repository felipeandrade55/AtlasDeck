/**
 * OpenClaw installer — one-click setup from the welcome wizard.
 *
 * Tries `npm install -g openclaw` first. If npm cannot write to its
 * global prefix (EACCES — common on macOS / non-root Linux), falls back
 * to `npm install --prefix ~/.openclaw-bin openclaw` and persists the
 * resulting bin path via writeOpenClawConfig() so future spawns find it.
 *
 * Streams stdout/stderr line-by-line through the onProgress callback so
 * the UI's mini-terminal stays live during the install.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
import { readOpenClawConfig, writeOpenClawConfig, getOpenClawWorkspace } from "./openclaw-config";

const execFile = promisify(execFileCb);

export type ProgressKind = "stdout" | "stderr" | "info" | "error";
export type ProgressFn = (kind: ProgressKind, line: string) => void;

export interface InstallResult {
  binPath: string;
  version: string;
  installedTo: "global" | "local-prefix";
}

const LOCAL_PREFIX = path.join(os.homedir(), ".openclaw-bin");
const NPM_PACKAGE = "openclaw";

/**
 * Returns the absolute path to `openclaw` if present, by resolving the
 * configured bin name through the user's $PATH (and the local-prefix
 * dir if we previously installed there). Returns null when not found.
 */
export async function detectOpenClaw(): Promise<{ binPath: string; version: string } | null> {
  const candidates: string[] = [];
  const configured = readOpenClawConfig().openclawBin;
  if (configured && configured !== "openclaw") candidates.push(configured);
  candidates.push("openclaw");
  candidates.push(path.join(LOCAL_PREFIX, "node_modules", ".bin", "openclaw"));

  for (const cand of candidates) {
    try {
      const { stdout } = await execFile(cand, ["--version"], {
        timeout: 4000,
        env: enrichedPath(),
      });
      const version = stdout.trim().split(/\s+/).pop() ?? stdout.trim();
      return { binPath: cand, version };
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Augments PATH so spawned npm/openclaw commands also see the local-prefix
 * bin dir, mirroring what writeOpenClawConfig persisted. Without this,
 * a future `npm` invocation would not find `openclaw` after we installed
 * with --prefix because that dir isn't on the user's interactive PATH.
 */
function enrichedPath(extra?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const localBin = path.join(LOCAL_PREFIX, "node_modules", ".bin");
  const parts = [extra, localBin, env.PATH].filter(Boolean) as string[];
  env.PATH = parts.join(":");
  return env;
}

async function runNpm(
  args: string[],
  onProgress: ProgressFn,
  envExtra: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    onProgress("info", `$ npm ${args.join(" ")}`);
    const child = spawn("npm", args, {
      env: { ...enrichedPath(), ...envExtra },
      windowsHide: true,
    });

    let stderrBuf = "";
    let stdoutCarry = "";
    let stderrCarry = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdoutCarry += chunk;
      const lines = stdoutCarry.split(/\r?\n/);
      stdoutCarry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) onProgress("stdout", line);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      stderrCarry += chunk;
      const lines = stderrCarry.split(/\r?\n/);
      stderrCarry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) onProgress("stderr", line);
      }
    });

    child.on("error", (err) => {
      onProgress("error", `Falha ao iniciar npm: ${err.message}`);
      reject(err);
    });
    child.on("close", (code) => {
      if (stdoutCarry) onProgress("stdout", stdoutCarry);
      if (stderrCarry) onProgress("stderr", stderrCarry);
      resolve({ code, stderrTail: stderrBuf.slice(-800) });
    });
  });
}

function isEaccesFailure(stderrTail: string): boolean {
  return (
    /EACCES/i.test(stderrTail) ||
    /permission denied/i.test(stderrTail) ||
    /need sudo/i.test(stderrTail) ||
    /Operation not permitted/i.test(stderrTail)
  );
}

/**
 * Idempotent install. Returns the active bin path + version. If OpenClaw
 * is already present and `--force` was not requested, short-circuits with
 * the detected version.
 */
export async function installOpenClaw(
  onProgress: ProgressFn,
  options: { force?: boolean } = {},
): Promise<InstallResult> {
  if (!options.force) {
    const present = await detectOpenClaw();
    if (present) {
      onProgress("info", `OpenClaw já presente em ${present.binPath} (v${present.version})`);
      return {
        binPath: present.binPath,
        version: present.version,
        installedTo: present.binPath.includes(LOCAL_PREFIX) ? "local-prefix" : "global",
      };
    }
  }

  // Attempt 1: global install
  onProgress("info", "Tentando instalação global (npm install -g openclaw)…");
  let result = await runNpm(["install", "-g", NPM_PACKAGE, "--no-fund", "--no-audit"], onProgress);

  if (result.code === 0) {
    const detected = await detectOpenClaw();
    if (detected) {
      onProgress("info", `Instalado globalmente: ${detected.binPath} (v${detected.version})`);
      ensureWorkspaceDirs(onProgress);
      return { binPath: detected.binPath, version: detected.version, installedTo: "global" };
    }
    onProgress(
      "info",
      "npm reportou sucesso mas o binário não foi encontrado no PATH — usando fallback de prefixo local.",
    );
  } else if (isEaccesFailure(result.stderrTail)) {
    onProgress(
      "info",
      "Sem permissão para instalar globalmente — caindo para prefixo local (~/.openclaw-bin) sem sudo.",
    );
  } else {
    onProgress(
      "info",
      `Instalação global falhou (exit ${result.code}). Tentando prefixo local como recuperação.`,
    );
  }

  // Attempt 2: local prefix (no sudo, isolated to ~/.openclaw-bin)
  fs.mkdirSync(LOCAL_PREFIX, { recursive: true });
  result = await runNpm(
    ["install", "--prefix", LOCAL_PREFIX, NPM_PACKAGE, "--no-fund", "--no-audit"],
    onProgress,
  );
  if (result.code !== 0) {
    throw new Error(
      `Instalação do OpenClaw falhou (exit ${result.code}). Últimas linhas do stderr: ${result.stderrTail.slice(-400)}`,
    );
  }

  const localBin = path.join(LOCAL_PREFIX, "node_modules", ".bin", "openclaw");
  if (!fs.existsSync(localBin)) {
    throw new Error(`npm terminou ok mas ${localBin} não existe.`);
  }

  // Persist the bin path so future runner spawns find it without PATH tweaks
  writeOpenClawConfig({ openclawBin: localBin });
  onProgress("info", `Bin path salvo em data/openclaw-config.json: ${localBin}`);

  const detected = await detectOpenClaw();
  const version = detected?.version ?? "desconhecida";
  ensureWorkspaceDirs(onProgress);
  return { binPath: localBin, version, installedTo: "local-prefix" };
}

/**
 * Make sure the OpenClaw home + default agent workspace exist after a
 * fresh install. Without this the OnboardingWizard fails to write
 * IDENTITY.md/SOUL.md/USER.md to a non-existent memory dir.
 */
function ensureWorkspaceDirs(onProgress: ProgressFn) {
  try {
    const config = readOpenClawConfig();
    fs.mkdirSync(config.openclawDir, { recursive: true });
    fs.mkdirSync(path.join(getOpenClawWorkspace(), "memory"), { recursive: true });
    onProgress("info", `Workspace pronto em ${getOpenClawWorkspace()}`);
  } catch (err) {
    onProgress("stderr", `Aviso: falha ao criar dirs de workspace: ${err instanceof Error ? err.message : String(err)}`);
  }
}
