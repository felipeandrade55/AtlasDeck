import fs from "fs";
import path from "path";

export interface OpenClawConfig {
  openclawDir: string;
  openclawBin: string;
  openclawWorkspace: string;
  sources: {
    dir: "saved" | "env" | "default";
    bin: "saved" | "env" | "default";
    workspace: "saved" | "env" | "default";
  };
}

export interface OpenClawConfigInput {
  openclawDir?: string;
  openclawBin?: string;
  openclawWorkspace?: string;
}

const CONFIG_PATH = path.join(process.cwd(), "data", "openclaw-config.json");
const DEFAULT_OPENCLAW_DIR = "/root/.openclaw";
const DEFAULT_OPENCLAW_BIN = "openclaw";

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSavedConfig(): OpenClawConfigInput {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as OpenClawConfigInput;
  } catch {
    return {};
  }
}

function defaultWorkspace(openclawDir: string): string {
  return path.join(openclawDir, "workspace", "mission-control");
}

export function readOpenClawConfig(): OpenClawConfig {
  const saved = readSavedConfig();

  const savedDir = clean(saved.openclawDir);
  const envDir = clean(process.env.OPENCLAW_DIR);
  const openclawDir = savedDir || envDir || DEFAULT_OPENCLAW_DIR;

  const savedBin = clean(saved.openclawBin);
  const envBin = clean(process.env.OPENCLAW_BIN);
  const openclawBin = savedBin || envBin || DEFAULT_OPENCLAW_BIN;

  const savedWorkspace = clean(saved.openclawWorkspace);
  const envWorkspace = clean(process.env.OPENCLAW_WORKSPACE);
  const openclawWorkspace = savedWorkspace || envWorkspace || defaultWorkspace(openclawDir);

  return {
    openclawDir,
    openclawBin,
    openclawWorkspace,
    sources: {
      dir: savedDir ? "saved" : envDir ? "env" : "default",
      bin: savedBin ? "saved" : envBin ? "env" : "default",
      workspace: savedWorkspace ? "saved" : envWorkspace ? "env" : "default",
    },
  };
}

export function writeOpenClawConfig(input: OpenClawConfigInput): OpenClawConfig {
  const current = readOpenClawConfig();
  const requestedDir = clean(input.openclawDir);
  const requestedBin = clean(input.openclawBin);
  const requestedWorkspace = clean(input.openclawWorkspace);

  const next = {
    openclawDir: requestedDir || current.openclawDir,
    openclawBin: requestedBin || current.openclawBin,
    openclawWorkspace: requestedWorkspace || (
      requestedDir && requestedDir !== current.openclawDir
        ? defaultWorkspace(requestedDir)
        : current.openclawWorkspace
    ),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return readOpenClawConfig();
}

export function getOpenClawDir(): string {
  return readOpenClawConfig().openclawDir;
}

export function getOpenClawBin(): string {
  return readOpenClawConfig().openclawBin;
}

export function getOpenClawWorkspace(): string {
  return readOpenClawConfig().openclawWorkspace;
}

export function getOpenClawConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Reads gateway port/token straight from the OpenClaw daemon's `openclaw.json`.
 * That file is the only source of truth — different from `data/openclaw-config.json`
 * (which is *AtlasDeck's* config about where OpenClaw lives, not the gateway settings).
 *
 * Used by health checks and external integrations that need to reach the gateway
 * regardless of how it's being managed (systemd unit, PM2, manual `openclaw daemon`,
 * Docker, etc.). HTTP reachability is the truth — systemd state is just one signal.
 */
export function getOpenClawGatewayInfo(): { port: number; token: string; url: string } {
  const defaultPort = 18789;
  let port = defaultPort;
  let token = "";

  const envPort = Number(process.env.OPENCLAW_GATEWAY_PORT);
  if (Number.isFinite(envPort) && envPort > 0) port = envPort;

  try {
    const openclawDir = getOpenClawDir();
    const raw = fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8");
    const parsed = JSON.parse(raw) as { gateway?: { port?: number; auth?: { token?: string } } };
    if (parsed.gateway?.port && Number.isFinite(parsed.gateway.port)) {
      port = parsed.gateway.port;
    }
    if (parsed.gateway?.auth?.token) {
      token = parsed.gateway.auth.token;
    }
  } catch {
    // openclaw.json may not exist yet (fresh install) — use env / defaults
  }

  if (!token && process.env.OPENCLAW_SERVICE_TOKEN) {
    token = process.env.OPENCLAW_SERVICE_TOKEN;
  }

  return {
    port,
    token,
    url: process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${port}`,
  };
}
