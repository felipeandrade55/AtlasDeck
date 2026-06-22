import fs from "fs";
import os from "os";
import path from "path";

const FALLBACK_AGENTS_CONFIG_PATH = path.join(process.cwd(), "data", "openclaw-fallback.json");

// NOTE: agents in this default seed do NOT carry a `ui` field. OpenClaw 2026.5.12+
// rejects unknown keys in agents.list[] with "Unrecognized key: ui", which blocks
// the daemon from booting. Emoji + color live in AtlasDeck-local storage
// (data/agents-ui.json) — see src/lib/agents-ui-local.ts.
export const DEFAULT_AGENTS_CONFIG = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.5",
      },
    },
    list: [
      {
        id: "main",
        name: "Mission Control",
        model: { primary: "openai/gpt-5.5" },
        workspace: "./workspace/mission-control",
        subagents: { allowAgents: ["devops", "coder"] },
      },
      {
        id: "devops",
        name: "DevOps Sentinel",
        model: { primary: "openai/gpt-5.5-mini" },
        workspace: "./workspace/devops",
        subagents: { allowAgents: [] },
      },
      {
        id: "coder",
        name: "Code Architect",
        model: { primary: "openai/gpt-5.5" },
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
/**
 * Resolve the on-disk workspace path for a specific OpenClaw agent
 * by reading openclaw.json — the single source of truth that the
 * daemon itself uses. This bypasses AtlasDeck's own `openclawWorkspace`
 * setting (which can drift when auto-fix or a manual config edit changes
 * it) and asks the daemon's actual config: where does THIS agent read
 * MEMORY.md from?
 *
 * Returns null if the agent isn't declared or the file can't be parsed.
 * Falls back to <openclawDir>/<workspace> (relative path resolution)
 * to match how the daemon itself interprets these values.
 */
/**
 * Resolve an agent `workspace` value to an absolute path **the same way the
 * OpenClaw gateway does**.
 *
 * This is the crux of writing to the file the agent actually reads. The gateway
 * runs with cwd/HOME = the user home (e.g. `/root`) and resolves a RELATIVE
 * workspace (`./workspace/mission-control`) against HOME — NOT against the
 * OpenClaw state dir (`/root/.openclaw`). Resolving against the state dir lands
 * inside AtlasDeck's OWN app folder (`<state>/workspace/mission-control`), which
 * is a different directory the agent never reads — the historical "split-brain"
 * where injected MEMORY.md never reached the agent.
 *
 * We mirror the gateway: absolute → as-is; relative → prefer the HOME-based
 * path, fall back to the state-dir path only if the home-based one doesn't
 * exist, and default to the home-based rule otherwise.
 */
export function resolveWorkspaceLikeGateway(workspace: string): string {
  if (path.isAbsolute(workspace)) return workspace;
  const homeBased = path.resolve(os.homedir(), workspace);
  const dirBased = path.resolve(getOpenClawDir(), workspace);
  try {
    if (fs.existsSync(homeBased)) return homeBased;
    if (fs.existsSync(dirBased)) return dirBased;
  } catch {
    /* fall through to the gateway's default rule */
  }
  return homeBased;
}

export function getAgentWorkspacePath(agentId: string): string | null {
  try {
    const openclawDir = getOpenClawDir();
    const cfgPath = path.join(openclawDir, "openclaw.json");
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };
    const list = parsed.agents?.list;
    if (!Array.isArray(list)) return null;
    const entry = list.find((a) => a?.id === agentId);
    if (!entry?.workspace || typeof entry.workspace !== "string") return null;
    // Resolve like the gateway (HOME-based for relative paths), NOT against
    // openclawDir — see resolveWorkspaceLikeGateway.
    return resolveWorkspaceLikeGateway(entry.workspace);
  } catch {
    return null;
  }
}

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
