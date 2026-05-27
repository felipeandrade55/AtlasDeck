/**
 * Manages the atlasdeck-memory MCP server registration in OpenClaw.
 *
 * OpenClaw reads MCP server definitions from `<openclawDir>/mcp.json`
 * (separate from the strict-schema `openclaw.json`, so adding entries
 * here cannot trigger `openclaw doctor` rollbacks).
 *
 * File shape (claude-desktop / MCP standard convention):
 *   {
 *     "mcpServers": {
 *       "<name>": { "command": "...", "args": [...], "env": { ... } }
 *     }
 *   }
 *
 * We never overwrite servers we don't own — only the "atlasdeck-memory"
 * key is touched. Everything else in the file is preserved.
 */
import fs from "fs";
import path from "path";
import { getOpenClawDir } from "@/lib/openclaw-config";

export const SERVER_NAME = "atlasdeck-memory";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

export interface ExpectedConfig {
  path: string;
  serverName: string;
  entry: McpServerEntry;
}

export function getMcpConfigPath(override?: string): string {
  if (override) return override;
  return path.join(getOpenClawDir(), "mcp.json");
}

/**
 * Build the entry we want OpenClaw to spawn. atlasdeckRoot must be
 * absolute — it's read at runtime by atlasdeck-memory-mcp.ts to
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
    "atlasdeck-memory-mcp.ts",
  );
  return {
    // npx is universally available and finds tsx whether it lives in
    // node_modules/.bin or globally. Avoids hard-coding a path that
    // would break across dev (mac) and prod (vps) checkouts.
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
    path: getMcpConfigPath(),
    serverName: SERVER_NAME,
    entry: buildExpectedEntry(opts),
  };
}

export function readMcpConfig(pathOverride?: string): {
  exists: boolean;
  config: McpConfigFile;
  raw: string | null;
} {
  const filePath = getMcpConfigPath(pathOverride);
  if (!fs.existsSync(filePath)) {
    return { exists: false, config: {}, raw: null };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw) as McpConfigFile;
    return { exists: true, config: parsed, raw };
  } catch {
    // File exists but isn't parseable — treat as empty so we don't
    // destroy whatever's there. The caller can decide whether to
    // overwrite.
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
}

export function inspectStatus(opts: {
  atlasdeckRoot: string;
  agentId?: string;
  configPathOverride?: string;
}): InstallStatus {
  const { config, exists } = readMcpConfig(opts.configPathOverride);
  const expected = buildExpectedEntry(opts);
  const current = config.mcpServers?.[SERVER_NAME] ?? null;
  const otherServers = Object.keys(config.mcpServers ?? {}).filter(
    (n) => n !== SERVER_NAME,
  );
  return {
    configPath: getMcpConfigPath(opts.configPathOverride),
    configExists: exists,
    serverName: SERVER_NAME,
    installed: !!current,
    upToDate: !!current && entriesEqual(current, expected),
    expected,
    current,
    otherServers,
  };
}

export interface InstallResult {
  configPath: string;
  written: boolean;
  backupPath: string | null;
  before: McpServerEntry | null;
  after: McpServerEntry;
  preservedServers: string[];
}

/**
 * Idempotent install: writes / refreshes only the atlasdeck-memory
 * entry, preserves every other server, atomically replaces the file.
 * Creates a one-shot `mcp.json.bak` if the file already existed and
 * the content actually changed.
 */
export function installMcpServer(opts: {
  atlasdeckRoot: string;
  agentId?: string;
  configPathOverride?: string;
}): InstallResult {
  const filePath = getMcpConfigPath(opts.configPathOverride);
  const { config, exists } = readMcpConfig(opts.configPathOverride);
  const expected = buildExpectedEntry(opts);
  const before = config.mcpServers?.[SERVER_NAME] ?? null;
  const preserved = Object.keys(config.mcpServers ?? {}).filter(
    (n) => n !== SERVER_NAME,
  );

  if (before && entriesEqual(before, expected)) {
    return {
      configPath: filePath,
      written: false,
      backupPath: null,
      before,
      after: expected,
      preservedServers: preserved,
    };
  }

  const next: McpConfigFile = {
    ...config,
    mcpServers: {
      ...(config.mcpServers ?? {}),
      [SERVER_NAME]: expected,
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
  };
}

export function uninstallMcpServer(opts: { configPathOverride?: string } = {}): {
  configPath: string;
  removed: boolean;
  preservedServers: string[];
} {
  const filePath = getMcpConfigPath(opts.configPathOverride);
  const { config, exists } = readMcpConfig(opts.configPathOverride);
  if (!exists || !config.mcpServers?.[SERVER_NAME]) {
    return {
      configPath: filePath,
      removed: false,
      preservedServers: Object.keys(config.mcpServers ?? {}),
    };
  }
  const { [SERVER_NAME]: _removed, ...rest } = config.mcpServers;
  void _removed;
  const next: McpConfigFile = { ...config, mcpServers: rest };
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  return {
    configPath: filePath,
    removed: true,
    preservedServers: Object.keys(rest),
  };
}
