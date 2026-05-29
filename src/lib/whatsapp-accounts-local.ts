/**
 * Local storage for WhatsApp account fields that OpenClaw's strict schema
 * doesn't accept inside `channels.whatsapp.accounts.<id>`. Currently:
 *
 *   - `chatId`: AtlasDeck-only — used by proactive alert features (cost/budget
 *     warnings) to know where to send unsolicited messages.
 *   - `dmPolicy`: per-account override AtlasDeck reads in the UI; OpenClaw
 *     accepts a channel-level dmPolicy but not a per-account one in 2026.5.12+.
 *   - `phoneNumber`: Baileys discovers the sender from the paired session;
 *     OpenClaw 2026.5.12+ rejects this key inside accounts.<id>. We keep it
 *     local as a label/display for the UI and for Cloud-API outbound calls
 *     when a token is present.
 *
 * Same pattern as the telegram-accounts-local helper.
 */
import fs from "fs";
import path from "path";

const LOCAL_PATH = path.join(process.cwd(), "data", "whatsapp-accounts.json");

export interface WhatsappAccountLocal {
  chatId?: string;
  dmPolicy?: string;
  phoneNumber?: string;
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
  if (typeof patch.phoneNumber === "string") {
    const trimmed = patch.phoneNumber.trim();
    if (trimmed) {
      next.phoneNumber = trimmed;
    } else {
      delete next.phoneNumber;
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
 * channels.whatsapp.accounts.<id>. Empty by design: OpenClaw's WhatsApp
 * channel uses Baileys, which discovers the sender from the paired session
 * (`~/.openclaw/credentials/whatsapp/<id>/creds.json`). The schema rejects
 * every property we used to write (`token`, `phoneNumber`, `chatId`,
 * `dmPolicy`) with "must NOT have additional properties" — that kills the
 * gateway and prevents `channels login` from generating a QR code.
 *
 * If a future OpenClaw release accepts a key again, add it here. Until then,
 * every AtlasDeck-side field lives in data/whatsapp-accounts.json via
 * setWhatsappAccountLocal, and openclaw.json carries only `accounts.<id>: {}`.
 */
const ALLOWED_OPENCLAW_KEYS = new Set<string>();

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

    // Preserve known fields in local storage before stripping (legacy migration).
    if (typeof acct.chatId === "string" && acct.chatId.trim()) {
      setWhatsappAccountLocal(id, { chatId: acct.chatId.trim() });
    }
    if (typeof acct.dmPolicy === "string" && acct.dmPolicy.trim()) {
      setWhatsappAccountLocal(id, { dmPolicy: acct.dmPolicy.trim() });
    }
    if (typeof acct.phoneNumber === "string" && acct.phoneNumber.trim()) {
      setWhatsappAccountLocal(id, { phoneNumber: acct.phoneNumber.trim() });
    }

    // Whitelist sweep: every key currently in the schema-rejected set gets
    // deleted. With ALLOWED empty, the resulting `accounts.<id>` is `{}`,
    // which the OpenClaw validator accepts.
    for (const key of Object.keys(acct)) {
      if (!ALLOWED_OPENCLAW_KEYS.has(key)) {
        delete acct[key];
        changed = true;
      }
    }
  }
  return changed;
}
