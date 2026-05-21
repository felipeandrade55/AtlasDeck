import fs from "fs";
import path from "path";

const FALLBACK_AGENTS_CONFIG_PATH = path.join(process.cwd(), "data", "openclaw-fallback.json");

const DEFAULT_AGENTS_CONFIG = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.4-codex",
      },
    },
    list: [
      {
        id: "main",
        name: "Mission Control",
        ui: { emoji: "🤖", color: "#ff6b35" },
        model: { primary: "openai/gpt-5.4" },
        workspace: "./workspace/mission-control",
        subagents: { allowAgents: ["devops", "coder"] },
      },
      {
        id: "devops",
        name: "DevOps Sentinel",
        ui: { emoji: "🛡️", color: "#10b981" },
        model: { primary: "openai/gpt-5.4-mini" },
        workspace: "./workspace/devops",
        subagents: { allowAgents: [] },
      },
      {
        id: "coder",
        name: "Code Architect",
        ui: { emoji: "💻", color: "#3b82f6" },
        model: { primary: "openai/gpt-5.4-codex" },
        workspace: "./workspace/coder",
        subagents: { allowAgents: [] },
      },
    ],
  },
  channels: {
    telegram: {
      dmPolicy: "pairing",
      accounts: {
        main: {
          botToken: "configured_mock_token",
          dmPolicy: "pairing",
        },
      },
    },
  },
};

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
 * Resolves the path to OpenClaw's `openclaw.json` (the runtime config with
 * `agents.list`, `channels`, etc.). Used by `/api/office` and `/api/agents`,
 * which both need a guaranteed-present file even on fresh installs or when
 * the OpenClaw daemon hasn't run yet.
 *
 * Behavior:
 *  - If the configured OpenClaw dir exists, returns `<dir>/openclaw.json` and
 *    seeds it with `DEFAULT_AGENTS_CONFIG` when missing.
 *  - Otherwise falls back to `data/openclaw-fallback.json` inside AtlasDeck,
 *    seeding it on first read.
 *
 * This is *not* the same file as the AtlasDeck-side `data/openclaw-config.json`
 * (which only records where OpenClaw lives).
 */
export function resolveOpenClawAgentsConfigPath(): { path: string; isFallback: boolean } {
  const prodDir = getOpenClawDir();
  const prodPath = path.join(prodDir, "openclaw.json");

  if (fs.existsSync(prodDir)) {
    if (!fs.existsSync(prodPath)) {
      try {
        fs.writeFileSync(prodPath, JSON.stringify(DEFAULT_AGENTS_CONFIG, null, 2), "utf8");
      } catch {}
    }
    return { path: prodPath, isFallback: false };
  }

  if (!fs.existsSync(FALLBACK_AGENTS_CONFIG_PATH)) {
    try {
      fs.mkdirSync(path.dirname(FALLBACK_AGENTS_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(FALLBACK_AGENTS_CONFIG_PATH, JSON.stringify(DEFAULT_AGENTS_CONFIG, null, 2), "utf8");
    } catch {}
  }
  return { path: FALLBACK_AGENTS_CONFIG_PATH, isFallback: true };
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
