/**
 * Telegram pairing poll endpoint.
 *
 * GET /api/setup/telegram/poll?nonce=...
 *   → long-polls getUpdates (≤25s) for a /start payload carrying our nonce
 *   → on match: saves bot token to openclaw.json (channels.telegram.accounts.<id>),
 *     persists chatId to AtlasDeck-local store, advances setup_step, returns chatId
 */
import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { resolveOpenClawAgentsConfigPath, getOpenClawDir } from "@/lib/openclaw-config";
import {
  consumePairing,
  getPairing,
  updatePairingCursor,
} from "@/lib/telegram-pairing";
import { setTelegramAccountLocal } from "@/lib/telegram-accounts-local";
import { setSettings } from "@/lib/memory-db";
import { logActivity } from "@/lib/activities-db";

export const dynamic = "force-dynamic";

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
  };
}

interface ConfigShape {
  commands?: { ownerAllowFrom?: string[] };
  channels?: {
    telegram?: {
      enabled?: boolean;
      dmPolicy?: string;
      accounts?: Record<string, { botToken?: string; dmPolicy?: string }>;
    };
  };
}

// Keep each request SHORT. A 25s server-side long-poll gets cut by the
// reverse proxy (Coolify/Traefik) into a 503 before Telegram replies. The
// client polls in a loop, so a brief hold is enough — 8s catches the
// /start fast while staying well under any proxy idle timeout.
const POLL_TIMEOUT_SEC = Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC || 8);

async function getUpdates(
  token: string,
  offset: number,
): Promise<{ ok: boolean; updates: TelegramUpdate[]; error?: string }> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_TIMEOUT_SEC}&offset=${offset}`,
      { method: "GET" },
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: TelegramUpdate[];
      description?: string;
    };
    if (!data.ok) return { ok: false, updates: [], error: data.description ?? `HTTP ${res.status}` };
    return { ok: true, updates: data.result ?? [] };
  } catch (err) {
    return { ok: false, updates: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function persistAccount(accountId: string, botToken: string, chatId: string, userId: string) {
  const { path: configPath } = resolveOpenClawAgentsConfigPath();
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as ConfigShape;
  if (!config.channels) config.channels = {};
  if (!config.channels.telegram) config.channels.telegram = { dmPolicy: "pairing" };
  if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {};
  const existing = config.channels.telegram.accounts[accountId] ?? {};
  config.channels.telegram.accounts[accountId] = {
    ...existing,
    botToken,
    dmPolicy: existing.dmPolicy ?? "pairing",
  };
  config.channels.telegram.enabled = true;

  // Grant the owner (the person finishing setup) command/owner rights so
  // their messages aren't treated as a stranger's.
  const ownerRef = `telegram:${userId}`;
  if (!config.commands) config.commands = {};
  if (!Array.isArray(config.commands.ownerAllowFrom)) config.commands.ownerAllowFrom = [];
  if (!config.commands.ownerAllowFrom.includes(ownerRef)) {
    config.commands.ownerAllowFrom.push(ownerRef);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  setTelegramAccountLocal(accountId, { chatId });
  approveTelegramSender(accountId, userId);
}

/**
 * Pre-approve the owner in OpenClaw's DM allowlist so dmPolicy:"pairing"
 * lets them through immediately — no "access not configured / pairing
 * code" wall after setup. Mirrors what `openclaw pairing approve` writes
 * to <openclawDir>/credentials/telegram-<account>-allowFrom.json. The
 * gateway keeps walling everyone ELSE, so security is preserved.
 */
function approveTelegramSender(accountId: string, userId: string) {
  try {
    const credDir = path.join(getOpenClawDir(), "credentials");
    mkdirSync(credDir, { recursive: true });
    const allowFile = path.join(credDir, `telegram-${accountId}-allowFrom.json`);
    let store: { version?: number; allowFrom?: string[] } = { version: 1, allowFrom: [] };
    try {
      store = JSON.parse(readFileSync(allowFile, "utf-8")) as { version?: number; allowFrom?: string[] };
    } catch {
      // file doesn't exist yet — start fresh
    }
    if (!Array.isArray(store.allowFrom)) store.allowFrom = [];
    const idStr = String(userId);
    if (!store.allowFrom.includes(idStr)) store.allowFrom.push(idStr);
    store.version = store.version ?? 1;
    writeFileSync(allowFile, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // best-effort: pairing still succeeds; owner can approve manually if needed
  }
}

async function sendConfirmation(token: string, chatId: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "✅ Conectado ao AtlasDeck. Pode mandar mensagens — o agente vai responder daqui em diante.",
      }),
    });
  } catch {
    // confirmation is best-effort
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!nonce) {
    return NextResponse.json({ error: "nonce obrigatório" }, { status: 400 });
  }

  const entry = getPairing(nonce);
  if (!entry) {
    return NextResponse.json({ status: "expired" });
  }

  const result = await getUpdates(entry.botToken, entry.lastUpdateId + 1);
  if (!result.ok) {
    return NextResponse.json({ status: "error", error: result.error });
  }

  let highestUpdateId = entry.lastUpdateId;
  for (const update of result.updates) {
    if (update.update_id > highestUpdateId) highestUpdateId = update.update_id;
    const text = (update.message?.text ?? "").trim();
    const chatId = update.message?.chat?.id;
    if (!chatId) continue;
    // Match the deep-link payload (/start <nonce>) OR a bare /start typed
    // by hand — during the active pairing window only the operator (who
    // owns the bot token) is interacting, so a plain /start is safe to
    // accept and far friendlier than failing silently.
    const isStart = text === "/start" || text.startsWith("/start ") || text.includes(nonce);
    if (isStart) {
      const chatIdStr = String(chatId);
      // In a DM, from.id === chat.id; fall back to chat id just in case.
      const userId = String(update.message?.from?.id ?? chatId);
      try {
        persistAccount(entry.accountId, entry.botToken, chatIdStr, userId);
      } catch (err) {
        return NextResponse.json(
          {
            status: "error",
            error: `Falha ao gravar config: ${err instanceof Error ? err.message : String(err)}`,
          },
          { status: 500 },
        );
      }
      // Capture the owner's real name (first+last) so the UI greets them
      // by name instead of "Usuário". Only set when we actually have one.
      const ownerName = [update.message?.from?.first_name, update.message?.from?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      setSettings(ownerName ? { setup_step: "done", owner_name: ownerName } : { setup_step: "done" });
      await sendConfirmation(entry.botToken, chatIdStr);
      consumePairing(nonce);
      try {
        logActivity(
          "config",
          `Telegram pareado: ${entry.botUsername} → chat ${chatIdStr}`,
          "success",
          { metadata: { accountId: entry.accountId, botUsername: entry.botUsername } },
        );
      } catch {}
      return NextResponse.json({
        status: "paired",
        accountId: entry.accountId,
        botUsername: entry.botUsername,
        chatId: chatIdStr,
        firstName: update.message?.from?.first_name ?? null,
      });
    }
  }

  if (highestUpdateId > entry.lastUpdateId) {
    updatePairingCursor(nonce, highestUpdateId);
  }
  return NextResponse.json({ status: "waiting" });
}
