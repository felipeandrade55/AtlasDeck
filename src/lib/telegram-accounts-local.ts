/**
 * Local storage for Telegram account fields that OpenClaw's strict schema
 * doesn't accept inside `channels.telegram.accounts.<id>`. Currently:
 *
 *   - `chatId`: AtlasDeck-only — used by proactive alert features (cost/budget
 *     warnings) to know where to send unsolicited messages. OpenClaw's own
 *     channel runtime doesn't need it (it routes by incoming update.from.id).
 *
 * OpenClaw 2026.5.12+ rejects unknown keys with "must NOT have additional
 * properties", preventing the daemon from starting. Same pattern as the
 * agents-ui-local fix.
 */
import fs from "fs";
import path from "path";

const LOCAL_PATH = path.join(process.cwd(), "data", "telegram-accounts.json");

export interface TelegramAccountLocal {
  chatId?: string;
}

function readAll(): Record<string, TelegramAccountLocal> {
  try {
    const raw = fs.readFileSync(LOCAL_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, TelegramAccountLocal>) : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, TelegramAccountLocal>) {
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getTelegramAccountLocal(id: string): TelegramAccountLocal {
  return readAll()[id] || {};
}

export function setTelegramAccountLocal(id: string, patch: TelegramAccountLocal): void {
  if (!id) return;
  const all = readAll();
  const existing = all[id] || {};
  const next: TelegramAccountLocal = { ...existing };
  if (typeof patch.chatId === "string") {
    const trimmed = patch.chatId.trim();
    if (trimmed) {
      next.chatId = trimmed;
    } else {
      delete next.chatId;
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

export function deleteTelegramAccountLocal(id: string): void {
  if (!id) return;
  const all = readAll();
  if (id in all) {
    delete all[id];
    writeAll(all);
  }
}

/**
 * Strip AtlasDeck-only fields from channels.telegram.accounts in openclaw.json
 * (in-place) and move them to local storage. Returns true if the openclaw.json
 * must be persisted because something was migrated. Idempotent.
 */
export function migrateTelegramAccountsFromConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const root = config as {
    channels?: { telegram?: { accounts?: Record<string, Record<string, unknown>> } };
  };
  const accounts = root.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") return false;

  let changed = false;
  for (const [id, acct] of Object.entries(accounts)) {
    if (!acct || typeof acct !== "object") continue;
    if ("chatId" in acct) {
      const chatId = typeof acct.chatId === "string" ? acct.chatId : undefined;
      if (chatId && chatId.trim()) {
        setTelegramAccountLocal(id, { chatId: chatId.trim() });
      }
      delete acct.chatId;
      changed = true;
    }
  }
  return changed;
}
