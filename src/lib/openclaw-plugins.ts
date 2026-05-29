/**
 * Helpers for inspecting and installing OpenClaw plugins.
 *
 * Why this exists: `openclaw channels login --channel whatsapp` (and other
 * channel commands) require the matching plugin package to be installed via
 * `openclaw plugins install <pkg>`. If the plugin is missing the CLI exits
 * silently with no output, which looks identical to a bug from the UI.
 *
 * The two we care about right now:
 *   - @openclaw/whatsapp — WhatsApp channel (Baileys/WhatsApp Web)
 *   - @openclaw/acpx     — ACP runtime backend (needed for the MCP bridge)
 */
import { spawnSync, spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { readOpenClawConfig } from "./openclaw-config";

export const WHATSAPP_PLUGIN = "@openclaw/whatsapp";
export const ACPX_PLUGIN = "@openclaw/acpx";

/**
 * Build the PATH used to invoke the `openclaw` binary. PM2 strips most env
 * vars on Linux VPS, so we re-derive standard locations + NVM versions.
 */
export function buildOpenClawEnvPath(): string {
  const currentPath = process.env.PATH || "";
  const extra = [
    "/root/.npm-global/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  try {
    const nvmNodeDir = "/root/.nvm/versions/node";
    if (fs.existsSync(nvmNodeDir)) {
      for (const v of fs.readdirSync(nvmNodeDir)) {
        extra.push(path.join(nvmNodeDir, v, "bin"));
      }
    }
  } catch {}
  return [...extra, currentPath].join(":");
}

export interface InstalledPluginsResult {
  ran: boolean;
  packages: string[];
  rawOutput: string;
  exitCode: number | null;
  error?: string;
}

/**
 * Run `openclaw plugins list` and parse the package names it reports. Lines
 * that mention `not installed` are skipped so we only return what's actually
 * available to the runtime.
 */
export function listInstalledPlugins(): InstalledPluginsResult {
  try {
    const { openclawBin, openclawDir } = readOpenClawConfig();
    const result = spawnSync(openclawBin, ["plugins", "list"], {
      cwd: openclawDir,
      env: { ...process.env, PATH: buildOpenClawEnvPath() },
      encoding: "utf-8",
      timeout: 10000,
    });
    const rawOutput = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (result.error) {
      return {
        ran: false,
        packages: [],
        rawOutput,
        exitCode: null,
        error: result.error.message,
      };
    }
    const packages: string[] = [];
    for (const rawLine of rawOutput.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/not installed/i.test(line)) continue;
      const match = line.match(/(@[\w-]+\/[\w.-]+|[\w][\w.-]*)/);
      if (match && match[1].startsWith("@")) {
        packages.push(match[1]);
      }
    }
    return {
      ran: true,
      packages: Array.from(new Set(packages)),
      rawOutput,
      exitCode: result.status,
    };
  } catch (e) {
    return {
      ran: false,
      packages: [],
      rawOutput: "",
      exitCode: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Filesystem check is the source of truth: `openclaw plugins install`
 * unpacks into `<openclawDir>/npm/node_modules/<pkg>`, and that's exactly
 * what the runtime requires/imports. Parsing `openclaw plugins list` is
 * unreliable across versions (column layout changes, "(not installed)"
 * vs warning lines, etc.) and would let us re-trigger install loops.
 *
 * Returns rawOutput from the CLI only as best-effort diagnostic context.
 */
export function isPluginInstalled(pkg: string): { installed: boolean; rawOutput: string; error?: string } {
  try {
    const { openclawDir } = readOpenClawConfig();
    const pluginDir = path.join(openclawDir, "npm", "node_modules", ...pkg.split("/"));
    const pkgJsonPath = path.join(pluginDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      return { installed: true, rawOutput: `[fs] ${pluginDir} present` };
    }
  } catch (e) {
    // Fall through to CLI parse — fs probe failure shouldn't kill detection.
    const err = e instanceof Error ? e.message : String(e);
    const r = listInstalledPlugins();
    return { installed: r.packages.includes(pkg), rawOutput: r.rawOutput, error: err };
  }

  // Filesystem says no — confirm with the CLI in case OpenClaw uses a
  // different layout in some setup.
  const r = listInstalledPlugins();
  if (!r.ran) {
    return { installed: false, rawOutput: r.rawOutput, error: r.error };
  }
  return { installed: r.packages.includes(pkg), rawOutput: r.rawOutput };
}

export interface InstallPluginResult {
  ok: boolean;
  packageName: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/**
 * "plugin already exists: ..." is technically an install failure (exit 1)
 * but for our purpose it means we're done — the plugin is installed. Treat
 * the same way for both sync and streaming installs.
 */
function classifyInstallOutput(exitCode: number | null, output: string, pkg: string): boolean {
  if (exitCode === 0) return true;
  if (/plugin already exists/i.test(output)) return true;
  if (new RegExp(`${pkg.replace("/", "\\/")}.*already`, "i").test(output)) return true;
  return false;
}

/**
 * Run `openclaw plugins install <pkg>` synchronously. Up to 4 minute timeout
 * (npm installs can be slow on cold cache). Returns the captured output so
 * the caller can stream it to the user.
 */
export function installPluginSync(pkg: string, timeoutMs = 240_000): InstallPluginResult {
  const start = Date.now();
  const { openclawBin, openclawDir } = readOpenClawConfig();
  const result = spawnSync(openclawBin, ["plugins", "install", pkg], {
    cwd: openclawDir,
    env: { ...process.env, PATH: buildOpenClawEnvPath() },
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    ok: !result.error && classifyInstallOutput(result.status, output, pkg),
    packageName: pkg,
    exitCode: result.status,
    output,
    durationMs: Date.now() - start,
  };
}

/**
 * Spawn `openclaw plugins install <pkg>` and pipe its output into the
 * provided callback line-by-line. Useful when we want to interleave install
 * progress with the pair CLI output in the WhatsApp modal terminal.
 */
export function installPluginStreaming(
  pkg: string,
  onChunk: (chunk: string) => void,
): { child: ChildProcess; done: Promise<InstallPluginResult> } {
  const { openclawBin, openclawDir } = readOpenClawConfig();
  const start = Date.now();
  let collected = "";

  const child = spawn(openclawBin, ["plugins", "install", pkg], {
    cwd: openclawDir,
    env: { ...process.env, PATH: buildOpenClawEnvPath() },
  });

  const append = (data: Buffer) => {
    const text = data.toString();
    collected += text;
    onChunk(text);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const done = new Promise<InstallPluginResult>((resolve) => {
    child.on("exit", (code) => {
      const output = collected.trim();
      resolve({
        ok: classifyInstallOutput(code, output, pkg),
        packageName: pkg,
        exitCode: code,
        output,
        durationMs: Date.now() - start,
      });
    });
    child.on("error", (err) => {
      resolve({
        ok: false,
        packageName: pkg,
        exitCode: null,
        output: `${collected}\n[Erro ao iniciar install]: ${err.message}`.trim(),
        durationMs: Date.now() - start,
      });
    });
  });

  return { child, done };
}
