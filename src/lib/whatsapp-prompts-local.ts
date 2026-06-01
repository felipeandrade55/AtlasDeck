/**
 * Per-mode messagePrefix (system prompt) overrides for WhatsApp operation modes.
 *
 * Defaults live in whatsapp-accounts-local.ts as code constants. The user can
 * override any mode's prompt via the WhatsApp setup modal; overrides are stored
 * here so they survive `operationModeToChannelConfig()` regenerations and any
 * upstream code changes to the defaults.
 *
 * Storage shape (data/whatsapp-prompts.json):
 *   { "owner": "custom prompt...", "assistant": "...", ... }
 *
 * Missing key → use the built-in default for that mode.
 */
import fs from "fs";
import path from "path";
import type { WhatsappOperationMode } from "./whatsapp-accounts-local";

const LOCAL_PATH = path.join(process.cwd(), "data", "whatsapp-prompts.json");

type Overrides = Partial<Record<WhatsappOperationMode, string>>;

function readAll(): Overrides {
  try {
    const raw = fs.readFileSync(LOCAL_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k as WhatsappOperationMode] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(data: Overrides) {
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getMessagePrefixOverride(mode: WhatsappOperationMode | undefined): string | null {
  if (!mode) return null;
  const all = readAll();
  const v = all[mode];
  return typeof v === "string" ? v : null;
}

export function getAllMessagePrefixOverrides(): Overrides {
  return readAll();
}

export function setMessagePrefixOverride(mode: WhatsappOperationMode, prompt: string): void {
  const all = readAll();
  all[mode] = prompt;
  writeAll(all);
}

export function clearMessagePrefixOverride(mode: WhatsappOperationMode): void {
  const all = readAll();
  if (mode in all) {
    delete all[mode];
    writeAll(all);
  }
}
