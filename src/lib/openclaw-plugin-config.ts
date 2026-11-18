/**
 * Install / enable / disable the atlasdeck-bridge OpenClaw plugin.
 *
 * Opt-in (button / API), never at boot: a plugin runs inside the gateway
 * that serves the user's bot, so every change is validated and reverted
 * on failure:
 *   1. `openclaw plugins install --link <dir> --force` (docs: /plugins/manage-plugins)
 *   2. merge plugins.entries["atlasdeck-bridge"] into openclaw.json (backup first)
 *   3. `openclaw config validate` — restore the backup if it fails
 *   4. restart the gateway (hooks load at startup)
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readOpenClawConfig } from "@/lib/openclaw-config";
import { getOpenClawConfigPath, readOpenClawJson } from "@/lib/openclaw-mcp-config";
import { getServiceToken } from "@/lib/openclaw-auth";
import { restartGateway } from "@/lib/gateway-control";
import { bridgeLastSeen, isBridgeActive } from "@/lib/bridge-status";

const execFileAsync = promisify(execFile);

export const BRIDGE_PLUGIN_ID = "atlasdeck-bridge";

export interface BridgePluginConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  channels: string[];
  ownerSenderIds: string[];
  allowGroups: boolean;
  inject: boolean;
  capture: boolean;
}

interface PluginEntry {
  enabled?: boolean;
  hooks?: { allowConversationAccess?: boolean; [k: string]: unknown };
  config?: Partial<BridgePluginConfig> & Record<string, unknown>;
  [k: string]: unknown;
}

export function bridgePluginDir(root = process.cwd()): string {
  return path.join(root, "openclaw-plugin", BRIDGE_PLUGIN_ID);
}

function defaultBaseUrl(): string {
  return (process.env.ATLASDECK_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

/** Owner sender ids from commands.ownerAllowFrom ("telegram:123" → "123"). */
function ownerIdsFromConfig(config: Record<string, unknown>): string[] {
  const commands = config.commands as { ownerAllowFrom?: unknown } | undefined;
  const list = Array.isArray(commands?.ownerAllowFrom) ? commands.ownerAllowFrom : [];
  return [...new Set(list.map(String).map((s) => (s.includes(":") ? s.split(":").pop()! : s)).filter(Boolean))];
}

function currentEntry(config: Record<string, unknown>): PluginEntry | null {
  const plugins = config.plugins as { entries?: Record<string, PluginEntry> } | undefined;
  return plugins?.entries?.[BRIDGE_PLUGIN_ID] ?? null;
}

export interface BridgeStatus {
  pluginDir: string;
  pluginDirExists: boolean;
  configPath: string;
  inConfig: boolean;
  enabled: boolean;
  conversationAccess: boolean;
  config: Partial<BridgePluginConfig> | null;
  lastSeen: string | null;
  active: boolean;
}

export function getBridgeStatus(): BridgeStatus {
  const { config } = readOpenClawJson();
  const entry = currentEntry(config as Record<string, unknown>);
  const cfg = entry?.config ? { ...entry.config, token: entry.config.token ? "••••" : undefined } : null;
  return {
    pluginDir: bridgePluginDir(),
    pluginDirExists: fs.existsSync(path.join(bridgePluginDir(), "openclaw.plugin.json")),
    configPath: getOpenClawConfigPath(),
    inConfig: Boolean(entry),
    enabled: entry?.enabled === true,
    conversationAccess: entry?.hooks?.allowConversationAccess === true,
    config: cfg,
    lastSeen: bridgeLastSeen(),
    active: isBridgeActive(15 * 60_000),
  };
}

async function cli(args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; output: string }> {
  const { openclawBin, openclawDir } = readOpenClawConfig();
  try {
    const { stdout, stderr } = await execFileAsync(openclawBin, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_DIR: openclawDir, NO_COLOR: "1" },
    });
    return { ok: true, output: `${stdout}${stderr}`.trim().slice(0, 4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`.trim().slice(0, 4000) };
  }
}

function writeConfigAtomic(filePath: string, config: unknown): void {
  const tmp = `${filePath}.atlasdeck-bridge.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export interface BridgeStep {
  step: string;
  ok: boolean;
  output?: string;
}

export interface BridgeActionResult {
  ok: boolean;
  steps: BridgeStep[];
  error?: string;
  status: BridgeStatus;
}

/** Merge our entry into openclaw.json, validate, roll back on failure. */
async function applyEntry(mutate: (entry: PluginEntry | null) => PluginEntry, steps: BridgeStep[]): Promise<boolean> {
  const filePath = getOpenClawConfigPath();
  const { config, exists, raw } = readOpenClawJson();
  if (!exists || raw === null) {
    steps.push({ step: "config", ok: false, output: `openclaw.json não encontrado em ${filePath}` });
    return false;
  }
  if (Object.keys(config).length === 0) {
    steps.push({ step: "config", ok: false, output: "openclaw.json não é JSON válido — não vou tocar nele" });
    return false;
  }
  const backup = `${filePath}.bak-atlasdeck-bridge`;
  fs.writeFileSync(backup, raw, "utf8");

  const cfg = config as Record<string, unknown>;
  const plugins = (cfg.plugins as Record<string, unknown> | undefined) ?? {};
  const entries = (plugins.entries as Record<string, PluginEntry> | undefined) ?? {};
  const next = {
    ...cfg,
    plugins: { ...plugins, entries: { ...entries, [BRIDGE_PLUGIN_ID]: mutate(entries[BRIDGE_PLUGIN_ID] ?? null) } },
  };
  writeConfigAtomic(filePath, next);
  steps.push({ step: "config", ok: true, output: `plugins.entries.${BRIDGE_PLUGIN_ID} gravado (backup: ${backup})` });

  const validate = await cli(["config", "validate"], 60_000);
  steps.push({ step: "validate", ok: validate.ok, output: validate.output });
  if (!validate.ok) {
    fs.writeFileSync(filePath, raw, "utf8");
    steps.push({ step: "rollback", ok: true, output: "config original restaurada" });
    return false;
  }
  return true;
}

export async function installBridgePlugin(opts: {
  channels?: string[];
  ownerSenderIds?: string[];
  baseUrl?: string;
  restart?: boolean;
} = {}): Promise<BridgeActionResult> {
  const steps: BridgeStep[] = [];
  const dir = bridgePluginDir();
  if (!fs.existsSync(path.join(dir, "openclaw.plugin.json"))) {
    return { ok: false, steps, error: `plugin não encontrado em ${dir}`, status: getBridgeStatus() };
  }

  let install = await cli(["plugins", "install", "--link", dir, "--force", "--accept-capabilities"]);
  if (!install.ok && /unknown option|unrecognized|accept-capabilities/i.test(install.output)) {
    install = await cli(["plugins", "install", "--link", dir, "--force"]);
  }
  steps.push({ step: "install", ok: install.ok, output: install.output });
  if (!install.ok) {
    return { ok: false, steps, error: "openclaw plugins install falhou", status: getBridgeStatus() };
  }

  const { config } = readOpenClawJson();
  const owners = opts.ownerSenderIds ?? ownerIdsFromConfig(config as Record<string, unknown>);
  const token = getServiceToken() ?? undefined;
  const applied = await applyEntry(
    (prev) => ({
      ...(prev ?? {}),
      enabled: true,
      hooks: { ...(prev?.hooks ?? {}), allowConversationAccess: true },
      config: {
        ...(prev?.config ?? {}),
        baseUrl: opts.baseUrl ?? prev?.config?.baseUrl ?? defaultBaseUrl(),
        ...(token ? { token } : {}),
        timeoutMs: 2500,
        channels: opts.channels ?? prev?.config?.channels ?? ["telegram"],
        ownerSenderIds: owners,
        allowGroups: false,
        inject: true,
        capture: true,
      },
    }),
    steps,
  );
  if (!applied) {
    return { ok: false, steps, error: "configuração rejeitada pelo OpenClaw (revertida)", status: getBridgeStatus() };
  }

  if (opts.restart !== false) {
    const r = await restartGateway();
    steps.push({ step: "restart", ok: r.success, output: r.output.slice(0, 2000) });
    if (!r.success) {
      return { ok: false, steps, error: "gateway não reiniciou — veja o log", status: getBridgeStatus() };
    }
  }
  return { ok: true, steps, status: getBridgeStatus() };
}

/** Disable without uninstalling (keeps config for a quick re-enable). */
export async function disableBridgePlugin(opts: { restart?: boolean } = {}): Promise<BridgeActionResult> {
  const steps: BridgeStep[] = [];
  const applied = await applyEntry((prev) => ({ ...(prev ?? {}), enabled: false }), steps);
  if (!applied) {
    return { ok: false, steps, error: "não foi possível desativar (config revertida)", status: getBridgeStatus() };
  }
  if (opts.restart !== false) {
    const r = await restartGateway();
    steps.push({ step: "restart", ok: r.success, output: r.output.slice(0, 2000) });
  }
  return { ok: true, steps, status: getBridgeStatus() };
}
