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

export async function sendTelegramAlert(
  botTokenOverride: string,
  chatIdOverride: string,
  message: string,
): Promise<boolean> {
  let botToken = botTokenOverride;
  let chatId = chatIdOverride;

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
        if (!chatId && mainAccount?.chatId) chatId = mainAccount.chatId;
      }
    } catch (e) {
      console.error("Failed to read openclaw.json fallback for Telegram:", e);
    }
  }

  if (!botToken || !chatId) {
    console.warn("Telegram alert skipped: Bot Token or Chat ID not configured.");
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

    return true;
  } catch (error) {
    console.error("Failed to send Telegram alert:", error);
    return false;
  }
}
