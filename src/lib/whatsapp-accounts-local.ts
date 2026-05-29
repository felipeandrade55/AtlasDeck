/**
 * Local storage for WhatsApp account fields that OpenClaw's strict schema
 * doesn't accept inside `channels.whatsapp.accounts.<id>`. Currently:
 *
 *   - `chatId`: AtlasDeck-only — used by proactive alert features (cost/budget
 *     warnings) to know where to send unsolicited messages. OpenClaw's own
 *     channel runtime doesn't need it.
 *
 * Same pattern as the telegram-accounts-local helper to prevent daemon validation errors.
 */
import fs from "fs";
import path from "path";

const LOCAL_PATH = path.join(process.cwd(), "data", "whatsapp-accounts.json");

export interface WhatsappAccountLocal {
  chatId?: string;
  dmPolicy?: string;
}

function readAll(): Record<string, WhatsappAccountLocal> {
  try {
    const raw = fs.readFileSync(LOCAL_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, WhatsappAccountLocal>) : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, WhatsappAccountLocal>) {
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getWhatsappAccountLocal(id: string): WhatsappAccountLocal {
  return readAll()[id] || {};
}

export function setWhatsappAccountLocal(id: string, patch: WhatsappAccountLocal): void {
  if (!id) return;
  const all = readAll();
  const existing = all[id] || {};
  const next: WhatsappAccountLocal = { ...existing };
  if (typeof patch.chatId === "string") {
    const trimmed = patch.chatId.trim();
    if (trimmed) {
      next.chatId = trimmed;
    } else {
      delete next.chatId;
    }
  }
  if (typeof patch.dmPolicy === "string") {
    const trimmed = patch.dmPolicy.trim();
    if (trimmed) {
      next.dmPolicy = trimmed;
    } else {
      delete next.dmPolicy;
    }
  }
  if (Object.keys(next).length === 0) {
    if (id in all) {
      delete all[id];
      writeAll(all);
    }
    return;
  }
  all[id] = next;
  writeAll(all);
}

export function deleteWhatsappAccountLocal(id: string): void {
  if (!id) return;
  const all = readAll();
  if (id in all) {
    delete all[id];
    writeAll(all);
  }
}

/**
 * Whitelist of keys OpenClaw v2026.5.12+ accepts inside
 * channels.whatsapp.accounts.<id>. Anything outside this set causes
 * "must NOT have additional properties" at startup, taking the gateway
 * down hard (we burned an evening on this — see project memory).
 *
 * Keep this list narrow: every entry here must be a key OpenClaw's
 * runtime actually reads. UI-only or AtlasDeck-only fields belong in
 * data/whatsapp-accounts.json via setWhatsappAccountLocal.
 */
const ALLOWED_OPENCLAW_KEYS = new Set([
  "token",
  "phoneNumber",
]);

export function migrateWhatsappAccountsFromConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const root = config as {
    channels?: { whatsapp?: { accounts?: Record<string, Record<string, unknown>> } };
  };
  const accounts = root.channels?.whatsapp?.accounts;
  if (!accounts || typeof accounts !== "object") return false;

  let changed = false;
  for (const [id, acct] of Object.entries(accounts)) {
    if (!acct || typeof acct !== "object") continue;

    // Preserve chatId in local storage before stripping it (legacy migration).
    if (typeof acct.chatId === "string" && acct.chatId.trim()) {
      setWhatsappAccountLocal(id, { chatId: acct.chatId.trim() });
    }

    // Preserve dmPolicy in local storage before stripping it (legacy migration).
    if (typeof acct.dmPolicy === "string" && acct.dmPolicy.trim()) {
      setWhatsappAccountLocal(id, { dmPolicy: acct.dmPolicy.trim() });
    }

    // Whitelist sweep: any key OpenClaw doesn't accept gets deleted.
    // This is the defense against schema drift — if OpenClaw added/removed
    // fields between versions, we strip whatever isn't in ALLOWED.
    for (const key of Object.keys(acct)) {
      if (!ALLOWED_OPENCLAW_KEYS.has(key)) {
        delete acct[key];
        changed = true;
      }
    }
  }
  return changed;
}
