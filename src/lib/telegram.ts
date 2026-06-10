/**
 * Telegram alert helper.
 *
 * Sends an HTML message via Telegram Bot API. Falls back to the
 * `channels.telegram.accounts.main` block in openclaw.json when the
 * bot token / chat id aren't passed explicitly. Designed for the
 * costs alerting path and any future memory/notification triggers.
 */
import fs from "fs";
import path from "path";
import { readOpenClawConfig } from "./openclaw-config";

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function previewMessage(s: string, max = 80): string {
  const plain = stripHtml(s);
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

// Logging is best-effort + dynamic import to avoid pulling sqlite into edge
// contexts that import this helper for type info only.
async function logTelegramActivity(
  status: "success" | "error",
  message: string,
  detail?: string,
): Promise<void> {
  try {
    const { logActivity } = await import("./activities-db");
    const preview = previewMessage(message);
    logActivity(
      "message",
      status === "success"
        ? `Telegram: ${preview}`
        : `Telegram falhou${detail ? ` (${detail})` : ""}: ${preview}`,
      status,
      { metadata: { channel: "telegram", preview } },
    );
  } catch {
    // ignore — telegram path must never fail because of activity logging
  }
}

export async function sendTelegramAlert(
  botTokenOverride: string,
  chatIdOverride: string,
  message: string,
): Promise<boolean> {
  let botToken = botTokenOverride;
  let chatId = chatIdOverride;

  // chatId lives in AtlasDeck's LOCAL store (data/telegram-accounts.json) —
  // OpenClaw 2026.5.x strict schema rejects `chatId` inside openclaw.json, so
  // the migration moved it out. Reading only openclaw.json here is why every
  // proactive alert (review notify, watchdog, costs) silently failed with
  // "credenciais ausentes" after that migration.
  if (!chatId) {
    try {
      const { getTelegramAccountLocal } = await import("./telegram-accounts-local");
      const local = getTelegramAccountLocal("main");
      if (local.chatId?.trim()) chatId = local.chatId.trim();
    } catch (e) {
      console.error("Failed to read telegram-accounts-local for chatId:", e);
    }
  }

  if (!botToken || !chatId) {
    try {
      const configPath = path.join(
        readOpenClawConfig().openclawDir,
        "openclaw.json",
      );
      if (fs.existsSync(configPath)) {
        const openclawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const mainAccount = openclawConfig?.channels?.telegram?.accounts?.main;
        if (!botToken && mainAccount?.botToken) botToken = mainAccount.botToken;
        // Legacy pre-migration configs may still carry chatId here.
        if (!chatId && mainAccount?.chatId) chatId = mainAccount.chatId;
      }
    } catch (e) {
      console.error("Failed to read openclaw.json fallback for Telegram:", e);
    }
  }

  if (!botToken || !chatId) {
    console.warn("Telegram alert skipped: Bot Token or Chat ID not configured.");
    void logTelegramActivity("error", message, "credenciais ausentes");
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Telegram API returned status ${res.status}: ${errText}`,
      );
    }

    void logTelegramActivity("success", message);
    return true;
  } catch (error) {
    console.error("Failed to send Telegram alert:", error);
    void logTelegramActivity(
      "error",
      message,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
