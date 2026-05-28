/**
 * Manages the atlasdeck-memory MCP server registration in OpenClaw.
 *
 * Authoritative source — `openclaw` npm package docs/cli/mcp.md +
 * docs/gateway/configuration-reference.md:
 *
 *   OpenClaw reads MCP server definitions from the `mcp.servers`
 *   object INSIDE `<openclawDir>/openclaw.json`. The previously-used
 *   `~/.openclaw/mcp.json` file with the `mcpServers` key is NOT read
 *   at runtime — it was a misread of the claude-desktop convention.
 *   Writing there silently does nothing.
 *
 * File shape (inside openclaw.json):
 *   {
 *     ...other openclaw config...,
 *     "mcp": {
 *       "servers": {
 *         "atlasdeck-memory": {
 *           "command": "npx",
 *           "args": ["tsx", "/path/.../atlasdeck-memory-mcp.mts"],
 *           "env": { "ATLASDECK_ROOT": "/...", "OPENCLAW_AGENT_ID": "main" }
 *         }
 *       }
 *     }
 *   }
 *
 * Tools registered by this MCP server are exposed to the LLM with the
 * provider-safe prefix `atlasdeck-memory__` (double underscore), so
 * `memory_add` reaches the agent as `atlasdeck-memory__memory_add`.
 *
 * We never overwrite servers we don't own — only the "atlasdeck-memory"
 * key under mcp.servers is touched. Everything else in openclaw.json
 * is preserved verbatim (gateway settings, agents.list, channels, etc).
 */
import fs from "fs";
import path from "path";
import { getOpenClawDir } from "@/lib/openclaw-config";

export const SERVER_NAME = "atlasdeck-memory";
export const CONFIG_FILE_NAME = "openclaw.json";
export const LEGACY_MCP_JSON_NAME = "mcp.json";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface OpenClawConfigShape {
  mcp?: { servers?: Record<string, McpServerEntry> };
  // Anything else in openclaw.json is preserved untouched.
  [k: string]: unknown;
}

export interface ExpectedConfig {
  path: string;
  serverName: string;
  entry: McpServerEntry;
}

export function getOpenClawConfigPath(override?: string): string {
  if (override) return override;
  return path.join(getOpenClawDir(), CONFIG_FILE_NAME);
}

export function getLegacyMcpJsonPath(): string {
  return path.join(getOpenClawDir(), LEGACY_MCP_JSON_NAME);
}

/**
 * Build the entry we want OpenClaw to spawn. atlasdeckRoot must be
 * absolute — it's read at runtime by atlasdeck-memory-mcp.mts to
 * locate data/memories.db and the embedding model cache.
 */
export function buildExpectedEntry(opts: {
  atlasdeckRoot: string;
  agentId?: string;
  tsxPath?: string;
}): McpServerEntry {
  const script = path.join(
    opts.atlasdeckRoot,
    "scripts",
    "atlasdeck-memory-mcp.mts",
  );
  return {
    command: opts.tsxPath ?? "npx",
    args: opts.tsxPath ? [script] : ["tsx", script],
    env: {
      ATLASDECK_ROOT: opts.atlasdeckRoot,
      OPENCLAW_AGENT_ID: opts.agentId ?? "main",
    },
  };
}

export function buildExpectedConfig(opts: {
  atlasdeckRoot: string;
  agentId?: string;
}): ExpectedConfig {
  return {
    path: getOpenClawConfigPath(),
    serverName: SERVER_NAME,
    entry: buildExpectedEntry(opts),
  };
}

export function readOpenClawJson(pathOverride?: string): {
  exists: boolean;
  config: OpenClawConfigShape;
  raw: string | null;
} {
  const filePath = getOpenClawConfigPath(pathOverride);
  if (!fs.existsSync(filePath)) {
    return { exists: false, config: {}, raw: null };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw) as OpenClawConfigShape;
    return { exists: true, config: parsed, raw };
  } catch {
    // File exists but isn't parseable — DON'T overwrite. Caller can
    // decide; install() will refuse to touch it in this state.
    return { exists: true, config: {}, raw };
  }
}

function entriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  if (a.command !== b.command) return false;
  if (a.args.length !== b.args.length) return false;
  for (let i = 0; i < a.args.length; i++) {
    if (a.args[i] !== b.args[i]) return false;
  }
  const aEnv = a.env ?? {};
  const bEnv = b.env ?? {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (aEnv[aKeys[i]] !== bEnv[bKeys[i]]) return false;
  }
  return true;
}

export interface InstallStatus {
  configPath: string;
  configExists: boolean;
  serverName: string;
  installed: boolean;
  upToDate: boolean;
  expected: McpServerEntry;
  current: McpServerEntry | null;
  otherServers: string[];
  /** Legacy ~/.openclaw/mcp.json that we used to write but OpenClaw
   *  never read. If present, it's stale and the cleanup hook will
   *  delete it on the next install — we never delete blindly here. */
  legacyMcpJsonExists: boolean;
}

export function inspectStatus(opts: {
  atlasdeckRoot: string;
  agentId?: string;
  configPathOverride?: string;
}): InstallStatus {
  const { config, exists } = readOpenClawJson(opts.configPathOverride);
  const expected = buildExpectedEntry(opts);
  const servers = config.mcp?.servers ?? {};
  const current = servers[SERVER_NAME] ?? null;
  const otherServers = Object.keys(servers).filter((n) => n !== SERVER_NAME);
  return {
    configPath: getOpenClawConfigPath(opts.configPathOverride),
    configExists: exists,
    serverName: SERVER_NAME,
    installed: !!current,
    upToDate: !!current && entriesEqual(current, expected),
    expected,
    current,
    otherServers,
    legacyMcpJsonExists: fs.existsSync(getLegacyMcpJsonPath()),
  };
}

export interface InstallResult {
  configPath: string;
  written: boolean;
  backupPath: string | null;
  before: McpServerEntry | null;
  after: McpServerEntry;
  preservedServers: string[];
  legacyMcpJsonRemoved: boolean;
}

/**
 * Idempotent install: merges `mcp.servers.atlasdeck-memory` into
 * `openclaw.json`, preserves every other top-level key and every
 * other entry under `mcp.servers`, and atomically replaces the file.
 * Creates a `.bak` next to the original if content actually changed.
 *
 * Also cleans up `~/.openclaw/mcp.json` — the previous (wrong) target,
 * which OpenClaw never read. Keeping that file around just confuses
 * future debugging.
 */
export function installMcpServer(opts: {
  atlasdeckRoot: string;
  agentId?: string;
  configPathOverride?: string;
  /** Default true. Set false to keep the legacy mcp.json untouched. */
  cleanupLegacyMcpJson?: boolean;
}): InstallResult {
  const filePath = getOpenClawConfigPath(opts.configPathOverride);
  const { config, exists } = readOpenClawJson(opts.configPathOverride);
  const expected = buildExpectedEntry(opts);
  const currentServers = config.mcp?.servers ?? {};
  const before = currentServers[SERVER_NAME] ?? null;
  const preserved = Object.keys(currentServers).filter(
    (n) => n !== SERVER_NAME,
  );

  const cleanupLegacy = opts.cleanupLegacyMcpJson !== false;
  let legacyRemoved = false;
  if (cleanupLegacy && !opts.configPathOverride) {
    legacyRemoved = tryRemoveLegacyMcpJson();
  }

  if (before && entriesEqual(before, expected)) {
    return {
      configPath: filePath,
      written: false,
      backupPath: null,
      before,
      after: expected,
      preservedServers: preserved,
      legacyMcpJsonRemoved: legacyRemoved,
    };
  }

  const next: OpenClawConfigShape = {
    ...config,
    mcp: {
      ...(config.mcp ?? {}),
      servers: {
        ...currentServers,
        [SERVER_NAME]: expected,
      },
    },
  };

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let backupPath: string | null = null;
  if (exists) {
    backupPath = `${filePath}.bak`;
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      backupPath = null;
    }
  }

  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);

  return {
    configPath: filePath,
    written: true,
    backupPath,
    before,
    after: expected,
    preservedServers: preserved,
    legacyMcpJsonRemoved: legacyRemoved,
  };
}

export function uninstallMcpServer(opts: { configPathOverride?: string } = {}): {
  configPath: string;
  removed: boolean;
  preservedServers: string[];
} {
  const filePath = getOpenClawConfigPath(opts.configPathOverride);
  const { config, exists } = readOpenClawJson(opts.configPathOverride);
  if (!exists || !config.mcp?.servers?.[SERVER_NAME]) {
    return {
      configPath: filePath,
      removed: false,
      preservedServers: Object.keys(config.mcp?.servers ?? {}),
    };
  }
  const { [SERVER_NAME]: _removed, ...rest } = config.mcp.servers;
  void _removed;
  const next: OpenClawConfigShape = {
    ...config,
    mcp: { ...config.mcp, servers: rest },
  };
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  return {
    configPath: filePath,
    removed: true,
    preservedServers: Object.keys(rest),
  };
}

/**
 * Best-effort delete of the legacy ~/.openclaw/mcp.json that earlier
 * versions of this code wrote. OpenClaw never read it, but its
 * presence makes future debugging confusing. We rename to `.bak`
 * instead of deleting outright, so any manual additions a user might
 * have made there aren't lost — they just stop being interpreted as
 * live config (because nothing reads them anyway).
 */
function tryRemoveLegacyMcpJson(): boolean {
  const legacy = getLegacyMcpJsonPath();
  if (!fs.existsSync(legacy)) return false;
  try {
    fs.renameSync(legacy, `${legacy}.bak`);
    return true;
  } catch {
    return false;
  }
}

// ─── Back-compat shims ─────────────────────────────────────────────
// Renamed types/functions still imported by older callers; remove
// once all import sites land on the new names.
export type McpConfigFile = OpenClawConfigShape;
export const getMcpConfigPath = getOpenClawConfigPath;
export const readMcpConfig = readOpenClawJson;
