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
  changedWhatsappChannelDefaults: boolean;
  configPath: string;
  error?: string;
}

/**
 * Strip tool names from `gateway.tools.allow` that are known not to exist
 * in the running OpenClaw version. Historical AtlasDeck builds (and our
 * own previous sweep iteration) wrote `whatsapp_login` here because we
 * thought the WhatsApp plugin exposed it as an agent tool. It DOES NOT
 * in v2026.5.12 — every plugin we inspected returns `toolNames: []` for
 * pairing. The pairing path is now `openclaw channels login --channel
 * whatsapp` via a PTY. Leaving stale entries triggers a noisy gateway
 * warning every boot:
 *   [tools] tools.profile (messaging) allowlist contains unknown
 *           entries (whatsapp_login). These entries won't match any
 *           tool unless the plugin is enabled.
 *
 * Returns true when the config object was mutated.
 */
function pruneInvalidGatewayTools(raw: Record<string, unknown>): boolean {
  const gateway = (raw.gateway && typeof raw.gateway === "object" ? raw.gateway : {}) as Record<string, unknown>;
  const tools = (gateway.tools && typeof gateway.tools === "object" ? gateway.tools : {}) as Record<string, unknown>;
  const allowRaw = Array.isArray(tools.allow) ? (tools.allow as unknown[]) : [];
  const allowStrings = allowRaw.filter((v): v is string => typeof v === "string");
  // Known phantoms: tools we used to whitelist that don't exist in the
  // current plugin registry. Add new entries here as we discover them.
  const PHANTOM_TOOLS = new Set(["whatsapp_login"]);
  const cleaned = allowStrings.filter((name) => !PHANTOM_TOOLS.has(name));
  if (cleaned.length === allowStrings.length) return false;

  raw.gateway = {
    ...gateway,
    tools: {
      ...tools,
      allow: cleaned,
    },
  };
  return true;
}

/**
 * @openclaw/whatsapp's channelConfigs.whatsapp.schema declares
 *   required: ["dmPolicy", "groupPolicy", "debounceMs", "mediaMaxMb"]
 * Without all four, the WhatsApp plugin fails its channel-config
 * validation at load time and never registers its agent tools
 * (notably whatsapp_login). `openclaw config validate` only runs the
 * top-level schema and won't catch this — the plugin's own validator
 * runs at gateway boot and silently drops the channel runtime.
 *
 * We backfill missing fields with the schema defaults so an existing
 * config that only had `dmPolicy` gets promoted to a fully-loadable
 * channel definition.
 */
function ensureWhatsappChannelDefaults(raw: Record<string, unknown>): boolean {
  const channels = (raw.channels && typeof raw.channels === "object" ? raw.channels : {}) as Record<string, unknown>;
  const wa = (channels.whatsapp && typeof channels.whatsapp === "object" ? channels.whatsapp : {}) as Record<string, unknown>;

  const defaults: Record<string, unknown> = {
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    debounceMs: 0,
    mediaMaxMb: 50,
  };

  let changed = false;
  const next: Record<string, unknown> = { ...wa };
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null) {
      next[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;

  raw.channels = { ...channels, whatsapp: next };
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
/**
 * Delete `plugins.entries.<id>` when present. Used to evict a plugin
 * declaration the gateway can't satisfy (e.g. acpx never installed on
 * disk → "plugin not installed" warning at every boot). Returns true
 * when the entry was actually removed.
 */
function removeOrphanPluginEntry(raw: Record<string, unknown>, id: string): boolean {
  const plugins = (raw.plugins && typeof raw.plugins === "object" ? raw.plugins : null) as
    | Record<string, unknown>
    | null;
  if (!plugins) return false;
  const entries = (plugins.entries && typeof plugins.entries === "object" ? plugins.entries : null) as
    | Record<string, unknown>
    | null;
  if (!entries || !(id in entries)) return false;
  delete entries[id];
  return true;
}

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
      changedWhatsappChannelDefaults: false,
      configPath,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const changedTelegram = migrateTelegramAccountsFromConfig(raw);
    const changedWhatsapp = migrateWhatsappAccountsFromConfig(raw);
    // We used to "ensure" whatsapp_login was in gateway.tools.allow. Turned
    // out the tool doesn't exist in v2026.5.12 (toolNames: []). Now we
    // PRUNE phantom entries instead — sweep heals configs left dirty by
    // previous AtlasDeck builds.
    const changedGatewayToolsAllow = pruneInvalidGatewayTools(raw);

    // External plugins that must be explicitly enabled. Only `whatsapp` —
    // acpx used to be here on the suspicion it was the Codex fallback
    // backend, but `ls ~/.openclaw/npm/node_modules/@openclaw/acpx`
    // confirmed the package is never actually installed, and the user's
    // Codex agent runs fine through the `openai-codex` profile without
    // it. Keeping acpx in the enabled list only produced a recurring
    // "plugin not installed" warning every boot.
    const changedPluginsEnabled = ensurePluginsEnabled(raw, ["whatsapp"]);

    // Belt-and-suspenders: if a previous sweep left `plugins.entries.acpx`
    // around, strip it so the warning goes away. Pure cleanup — has no
    // effect when the entry isn't there.
    const removedAcpxEntry = removeOrphanPluginEntry(raw, "acpx");

    // Backfill required channels.whatsapp fields so the plugin's own
    // channel-config validator passes at load time (it runs INSIDE the
    // plugin's onLoad, not the top-level openclaw config validate, so
    // missing fields silently drop the runtime).
    const changedWhatsappChannelDefaults = ensureWhatsappChannelDefaults(raw);

    if (
      changedTelegram ||
      changedWhatsapp ||
      changedGatewayToolsAllow ||
      changedPluginsEnabled.length > 0 ||
      changedWhatsappChannelDefaults ||
      removedAcpxEntry
    ) {
      writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
    }
    return {
      ran: true,
      changedTelegram,
      changedWhatsapp,
      changedGatewayToolsAllow,
      changedPluginsEnabled,
      changedWhatsappChannelDefaults,
      configPath,
    };
  } catch (err) {
    return {
      ran: false,
      changedTelegram: false,
      changedWhatsapp: false,
      changedGatewayToolsAllow: false,
      changedPluginsEnabled: [],
      changedWhatsappChannelDefaults: false,
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
