/**
 * Boot-time sweep that strips unknown keys from
 * channels.{telegram,whatsapp}.accounts.<id> in openclaw.json.
 *
 * Runs from instrumentation.ts. Isolated here so Turbopack's static
 * analysis doesn't flag `fs` as an Edge-runtime violation on
 * instrumentation.ts — the function is reached only via dynamic import
 * from the nodejs-runtime guard, and the fs imports live in this file.
 *
 * Why this exists: OpenClaw v2026.5.12+ rejects any unknown property
 * inside channels.*.accounts.<id> with "must NOT have additional
 * properties". When a corrupted field sneaks in, the gateway refuses
 * to boot and the Telegram bot dies. Sanitizing on every AtlasDeck
 * restart gives us self-healing.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "./openclaw-config";
import { migrateTelegramAccountsFromConfig } from "./telegram-accounts-local";
import { migrateWhatsappAccountsFromConfig } from "./whatsapp-accounts-local";

export interface SweepResult {
  ran: boolean;
  changedTelegram: boolean;
  changedWhatsapp: boolean;
  changedGatewayToolsAllow: boolean;
  changedPluginsEnabled: string[];
  configPath: string;
  error?: string;
}

/**
 * Ensure `gateway.tools.allow` contains the keys AtlasDeck needs to drive
 * channel pairing via /tools/invoke. Without this, the gateway's default
 * deny list returns 404 for `whatsapp_login` and pairing from the UI is
 * impossible (the CLI fallback requires a real TTY).
 *
 * Returns true when the config object was mutated.
 */
function ensureGatewayToolsAllow(raw: Record<string, unknown>, required: string[]): boolean {
  const gateway = (raw.gateway && typeof raw.gateway === "object" ? raw.gateway : {}) as Record<string, unknown>;
  const tools = (gateway.tools && typeof gateway.tools === "object" ? gateway.tools : {}) as Record<string, unknown>;
  const allowRaw = Array.isArray(tools.allow) ? (tools.allow as unknown[]) : [];
  const allow = new Set(allowRaw.filter((v): v is string => typeof v === "string"));
  let changed = false;
  for (const t of required) {
    if (!allow.has(t)) {
      allow.add(t);
      changed = true;
    }
  }
  if (!changed) return false;

  raw.gateway = {
    ...gateway,
    tools: {
      ...tools,
      allow: Array.from(allow),
    },
  };
  return true;
}

/**
 * Force `plugins.entries.<id>.enabled = true` for each id passed in.
 * External plugins like @openclaw/whatsapp have `activation.onStartup: false`
 * in their manifest, so they only load when the host config explicitly
 * enables them. Without this, the gateway boots without the WhatsApp
 * runtime and `whatsapp_login` never gets registered (resulting in
 * "Tool not available: whatsapp_login" from /tools/invoke).
 *
 * Returns the list of ids whose entry was actually flipped from absent or
 * false to true.
 */
function ensurePluginsEnabled(raw: Record<string, unknown>, ids: string[]): string[] {
  const plugins = (raw.plugins && typeof raw.plugins === "object" ? raw.plugins : {}) as Record<string, unknown>;
  const entries = (plugins.entries && typeof plugins.entries === "object" ? plugins.entries : {}) as Record<string, unknown>;
  const flipped: string[] = [];
  for (const id of ids) {
    const entry = (entries[id] && typeof entries[id] === "object" ? entries[id] : {}) as Record<string, unknown>;
    if (entry.enabled !== true) {
      entries[id] = { ...entry, enabled: true };
      flipped.push(id);
    }
  }
  if (flipped.length === 0) return flipped;

  raw.plugins = {
    ...plugins,
    entries,
  };
  return flipped;
}

export function sweepOpenClawConfig(): SweepResult {
  const { path: configPath } = resolveOpenClawAgentsConfigPath();
  if (!existsSync(configPath)) {
    return {
      ran: false,
      changedTelegram: false,
      changedWhatsapp: false,
      changedGatewayToolsAllow: false,
      changedPluginsEnabled: [],
      configPath,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const changedTelegram = migrateTelegramAccountsFromConfig(raw);
    const changedWhatsapp = migrateWhatsappAccountsFromConfig(raw);
    const changedGatewayToolsAllow = ensureGatewayToolsAllow(raw, ["whatsapp_login"]);

    // External plugins must be explicitly enabled — whatsapp + acpx both have
    // activation.onStartup=false in their manifests. Without this the gateway
    // boots without their runtimes registered and /tools/invoke returns
    // "Tool not available: whatsapp_login".
    const changedPluginsEnabled = ensurePluginsEnabled(raw, ["whatsapp", "acpx"]);

    if (
      changedTelegram ||
      changedWhatsapp ||
      changedGatewayToolsAllow ||
      changedPluginsEnabled.length > 0
    ) {
      writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
    }
    return {
      ran: true,
      changedTelegram,
      changedWhatsapp,
      changedGatewayToolsAllow,
      changedPluginsEnabled,
      configPath,
    };
  } catch (err) {
    return {
      ran: false,
      changedTelegram: false,
      changedWhatsapp: false,
      changedGatewayToolsAllow: false,
      changedPluginsEnabled: [],
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
