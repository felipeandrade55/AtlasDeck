/**
 * Telegram pairing poll endpoint.
 *
 * GET /api/setup/telegram/poll?nonce=...
 *   → long-polls getUpdates (≤25s) for a /start payload carrying our nonce
 *   → on match: saves bot token to openclaw.json (channels.telegram.accounts.<id>),
 *     persists chatId to AtlasDeck-local store, advances setup_step, returns chatId
 */
import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { resolveOpenClawAgentsConfigPath } from "@/lib/openclaw-config";
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
    from?: { id: number; first_name?: string; username?: string };
  };
}

interface ConfigShape {
  channels?: {
    telegram?: {
      enabled?: boolean;
      dmPolicy?: string;
      accounts?: Record<string, { botToken?: string; dmPolicy?: string }>;
    };
  };
}

const POLL_TIMEOUT_SEC = 25;

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

function persistAccount(accountId: string, botToken: string, chatId: string) {
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
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  setTelegramAccountLocal(accountId, { chatId });
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
    const text = update.message?.text ?? "";
    const chatId = update.message?.chat?.id;
    if (!chatId) continue;
    if (text === `/start ${nonce}` || text.includes(nonce)) {
      const chatIdStr = String(chatId);
      try {
        persistAccount(entry.accountId, entry.botToken, chatIdStr);
      } catch (err) {
        return NextResponse.json(
          {
            status: "error",
            error: `Falha ao gravar config: ${err instanceof Error ? err.message : String(err)}`,
          },
          { status: 500 },
        );
      }
      setSettings({ setup_step: "done" });
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
