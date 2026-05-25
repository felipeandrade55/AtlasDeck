/**
 * Local storage for cloud LLM provider API keys.
 *
 * OpenClaw's strict schema (2026.5.12+) rejects unknown keys inside
 * openclaw.json — same lesson the agents-ui-local and telegram-accounts-local
 * libs already learned. So provider credentials live in a sibling file
 * (`data/provider-keys.json`, chmod 600) that only AtlasDeck reads.
 *
 * Two consumers:
 *   1. The chat runner — spreads `buildProviderEnv()` into the env when
 *      spawning the OpenClaw CLI, so subprocess calls inherit credentials.
 *   2. The OpenClaw daemon — picked up via `~/.openclaw/.env` which we
 *      keep in sync (idempotently merged so user-managed entries survive).
 */
import fs from "fs";
import path from "path";
import { getOpenClawDir } from "./openclaw-config";

const KEYS_PATH = path.join(process.cwd(), "data", "provider-keys.json");

export type ProviderId = "anthropic" | "openai" | "google";

export const PROVIDER_ENV_VAR: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

interface KeyEntry {
  apiKey: string;
  updatedAt: string;
}

type KeyMap = Partial<Record<ProviderId, KeyEntry>>;

function readAll(): KeyMap {
  try {
    const raw = fs.readFileSync(KEYS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as KeyMap) : {};
  } catch {
    return {};
  }
}

function writeAll(data: KeyMap) {
  fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
  fs.writeFileSync(KEYS_PATH, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(KEYS_PATH, 0o600);
  } catch {
    // chmod may fail on Windows or non-owner-writable filesystems — ignore
  }
}

export function getProviderKey(provider: ProviderId): string | null {
  const entry = readAll()[provider];
  return entry?.apiKey?.trim() || null;
}

export function setProviderKey(provider: ProviderId, apiKey: string): void {
  const trimmed = apiKey.trim();
  const all = readAll();
  if (!trimmed) {
    delete all[provider];
  } else {
    all[provider] = { apiKey: trimmed, updatedAt: new Date().toISOString() };
  }
  writeAll(all);
  syncToDotEnv(all);
}

export function deleteProviderKey(provider: ProviderId): void {
  const all = readAll();
  if (provider in all) {
    delete all[provider];
    writeAll(all);
    syncToDotEnv(all);
  }
}

export interface ProviderKeyInfo {
  provider: ProviderId;
  hasKey: boolean;
  masked: string;
  updatedAt: string | null;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function listProviderKeys(): ProviderKeyInfo[] {
  const all = readAll();
  return (Object.keys(PROVIDER_ENV_VAR) as ProviderId[]).map((provider) => {
    const entry = all[provider];
    return {
      provider,
      hasKey: !!entry?.apiKey,
      masked: entry?.apiKey ? maskKey(entry.apiKey) : "",
      updatedAt: entry?.updatedAt ?? null,
    };
  });
}

/**
 * Returns an env-var map ready to spread into `spawn({ env })`. Only
 * includes entries for providers that actually have a saved key.
 */
export function buildProviderEnv(): Record<string, string> {
  const all = readAll();
  const out: Record<string, string> = {};
  for (const [provider, varName] of Object.entries(PROVIDER_ENV_VAR) as Array<[ProviderId, string]>) {
    const key = all[provider]?.apiKey?.trim();
    if (key) out[varName] = key;
  }
  // Gemini SDK reads GEMINI_API_KEY; mirror GOOGLE_API_KEY so either works.
  if (out.GOOGLE_API_KEY && !out.GEMINI_API_KEY) {
    out.GEMINI_API_KEY = out.GOOGLE_API_KEY;
  }
  return out;
}

/**
 * Keeps `~/.openclaw/.env` in sync with our local key store so a
 * daemon restart (systemd / PM2 / bare) picks up the credentials too.
 * Lines we manage are tagged with `# managed-by: atlasdeck-provider-keys`
 * so user-added entries above/below survive verbatim.
 */
const MARK_BEGIN = "# >>> atlasdeck-provider-keys (managed) >>>";
const MARK_END = "# <<< atlasdeck-provider-keys (managed) <<<";

function syncToDotEnv(all: KeyMap) {
  let dir: string;
  try {
    dir = getOpenClawDir();
  } catch {
    return;
  }
  if (!fs.existsSync(dir)) return;

  const envPath = path.join(dir, ".env");
  let existing = "";
  try {
    existing = fs.readFileSync(envPath, "utf-8");
  } catch {
    existing = "";
  }

  const before = existing.split(MARK_BEGIN)[0].replace(/\n+$/, "");
  const afterRaw = existing.split(MARK_END)[1] ?? "";
  const after = afterRaw.replace(/^\n+/, "");

  const managedLines: string[] = [];
  for (const [provider, varName] of Object.entries(PROVIDER_ENV_VAR) as Array<[ProviderId, string]>) {
    const key = all[provider]?.apiKey?.trim();
    if (key) managedLines.push(`${varName}=${key}`);
  }
  if (managedLines.length > 0 && all.google?.apiKey?.trim()) {
    managedLines.push(`GEMINI_API_KEY=${all.google.apiKey.trim()}`);
  }

  let next = "";
  if (before) next += `${before}\n`;
  if (managedLines.length > 0) {
    next += `${MARK_BEGIN}\n${managedLines.join("\n")}\n${MARK_END}\n`;
  }
  if (after) next += after;

  try {
    fs.writeFileSync(envPath, next, "utf-8");
    fs.chmodSync(envPath, 0o600);
  } catch {
    // best effort — runner-side env injection still covers the AtlasDeck subprocess path
  }
}
