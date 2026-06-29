/**
 * SaaS control-plane config — only meaningful on the OWNER's instance
 * (deploy mode "native"). Holds the Coolify API credentials and the fixed
 * provisioning constants (repo, compose path, base domain) used to spin up
 * a new client app.
 *
 * Secrets resolve from process.env first, then a local `data/saas-config.json`
 * (chmod 600, same pattern as provider-keys.ts), so the owner can paste them
 * in the UI without exposing them in the repo.
 */
import fs from "fs";
import path from "path";
import { getBaseDomain } from "@/lib/client-identity";

const CONFIG_PATH = path.join(process.cwd(), "data", "saas-config.json");

// Fixed provisioning constants (mirror scripts/provision-client.mjs).
export const SAAS_REPO = "https://github.com/felipeandrade55/AtlasDeck.git";
export const SAAS_COMPOSE_LOCATION = "/docker-compose.coolify.yml";
export const SAAS_DEFAULT_BRANCH = "main";

interface SaasConfigFile {
  coolify_url?: string;
  coolify_token?: string;
  coolify_server_uuid?: string;
  // Fase B (Mercado Pago) — lidos aqui mas usados só quando a fase for ligada.
  mercadopago_access_token?: string;
  mercadopago_webhook_secret?: string;
}

function readFile(): SaasConfigFile {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as SaasConfigFile;
  } catch {
    return {};
  }
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

export interface CoolifyConfig {
  url: string;
  token: string;
  serverUuid: string | null;
}

/**
 * Returns the Coolify API config, or null when not configured (so the UI can
 * show a "configure o Coolify" state instead of crashing).
 */
export function getCoolifyConfig(): CoolifyConfig | null {
  const file = readFile();
  const url = (clean(process.env.COOLIFY_URL) || clean(file.coolify_url) || "").replace(/\/$/, "");
  const token = clean(process.env.COOLIFY_TOKEN) || clean(file.coolify_token);
  const serverUuid =
    clean(process.env.COOLIFY_SERVER_UUID) || clean(file.coolify_server_uuid) || null;
  if (!url || !token) return null;
  return { url, token, serverUuid };
}

/** Persist Coolify config to the local secrets file (chmod 600). */
export function setCoolifyConfig(patch: Partial<SaasConfigFile>): void {
  const current = readFile();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // chmod may fail on Windows — ignore
  }
}

/** The SaaS base domain (e.g. ih01.atlasdeck.ia.br). */
export function getSaasBaseDomain(): string {
  return getBaseDomain();
}
